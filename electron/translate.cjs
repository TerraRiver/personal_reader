// Translation: an OpenAI-compatible model translates the blocks of a finished parse
// (see parse.cjs), paragraph by paragraph.
//
//   glossary  terms from the start of the whole text, so every part is translated alike
//   ranges    long PDFs are translated a page range at a time; the ranges asked for are
//             kept, and a paragraph belongs to the page it starts on
//   batches   paragraphs in those ranges that have no translation yet
//
// Everything lives in <library>/translations/<id>.json and is saved after each
// batch, so finished paragraphs show right away and a run resumes after a restart.
// Translations are kept as Markdown per piece; `edit` holds the reader's own
// wording, which a later machine run never overwrites.

const { BrowserWindow, net } = require('electron');

class TranslateError extends Error {
  constructor(message, { retry = false } = {}) {
    super(message);
    this.retry = retry;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retry || i >= tries) throw err;
      await sleep(2000 * 2 ** i);
    }
  }
}

// net.fetch goes through Chromium's network stack, so it follows the system proxy.
async function request(url, init = {}, timeout = 60_000) {
  try {
    return await net.fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new TranslateError(`网络错误：${err.cause?.code ?? err.message}`, { retry: true });
  }
}

/** [id, text, kind, page] for everything the model translates. References stay in the original. */
function pieces(blocks) {
  const out = [];
  for (const b of blocks) {
    const page = b.parts[0].page;
    if (['para', 'heading', 'note', 'quote'].includes(b.kind)) out.push([b.id, b.text, b.kind, page]);
    else if (b.kind === 'list') b.items.forEach((t, j) => out.push([`${b.id}.${j}`, t, 'list', page]));
    else if (b.kind === 'image' || b.kind === 'table') {
      if (b.caption) out.push([`${b.id}.caption`, b.caption, 'caption', page]);
      if (b.footnote) out.push([`${b.id}.footnote`, b.footnote, 'caption', page]);
      if (b.html) out.push([`${b.id}.html`, b.html, 'table', page]);
    }
  }
  return out;
}

// ---------- page ranges ----------

/** Ranges as sorted, merged [from, to] pairs, with `range` added. */
function addRange(ranges = [], range) {
  const out = [];
  for (const [from, to] of [...ranges, range].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}
const inRanges = (ranges = [], page) => ranges.some(([from, to]) => page >= from && page <= to);
const pagesIn = (ranges = [], total) =>
  ranges.reduce((n, [from, to]) => n + Math.max(0, Math.min(to, total || to) - from + 1), 0);

// ---------- LLM ----------

async function chat(cfg, system, user, maxTokens = 8000) {
  if (!cfg.llmBaseUrl || !cfg.llmModel || !cfg.llmKey) throw new TranslateError('还没有设置翻译模型，请在「设置」中填写');
  const url = `${cfg.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  return withRetry(async () => {
    const res = await request(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.llmKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.llmModel,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
      },
      5 * 60_000,
    );
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Gateway error pages.
    }
    const msg = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new TranslateError(`翻译模型拒绝了密钥：${msg}`);
    if (res.status === 429 || res.status >= 500) throw new TranslateError(`翻译模型暂不可用：${msg}`, { retry: true });
    if (!res.ok) throw new TranslateError(`翻译模型出错：${msg}`);
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new TranslateError('翻译模型返回格式异常', { retry: true });
    return text;
  });
}

/** One tiny request. Returns an error message, or null. */
async function checkLlm(cfg) {
  try {
    await chat(cfg, 'Reply with OK.', 'ping', 5);
    return null;
  } catch (err) {
    return err.message;
  }
}

const GLOSSARY_PROMPT = `你是学术论文翻译的术语专家。下面是一篇英文学术论文的正文。请：
1. 用一句中文概括论文所属学科与主题（field）。
2. 提取需要全文统一译法的术语：核心概念、理论与学派名称、反复出现的专有表达，以及文中出现的重要人名。人名使用中文学界通行译法。
3. 不要收录普通词汇；数量以 20–60 个为宜。

只按下面的格式输出，不要任何其他文字：
FIELD: 一句话概括
securitization ||| 安全化
speech act ||| 言语行为
…（每行一个术语）`;

function parseGlossary(text) {
  let field = '';
  const terms = [];
  for (let line of text.split('\n')) {
    line = line.trim().replace(/^[-* ]+/, '');
    if (/^FIELD:/i.test(line)) field = line.slice(6).trim();
    else if (line.includes('|||')) {
      const [en, zh] = line.split('|||').map((s) => s.trim());
      if (en && zh) terms.push({ en, zh });
    }
  }
  return { field, terms };
}

const translatePrompt = (field, terms) => `你是资深学术译者，把英文学术论文译成中文。论文领域：${field}

要求：
- 忠实、完整，不增不减，不加解释；用规范、流畅的中文学术语体。
- 严格使用术语表中的译法。
- 脚注标记 <sup>…</sup> 以及其他 HTML 标签原样保留，放在译文中对应的位置。
- LaTeX 公式（$…$ 或 $$…$$）原样保留。但原文来自 OCR 识别，若某处 $…$ 明显不是数学公式（例如被误识别成公式的引号、撇号、脚注序号等乱码），请按上下文还原成正常文字，脚注序号写成 <sup>n</sup>。
- 引号统一用中文引号“”和‘’。
- 人名用通行中文译名；括号内的文献引用（如 Buzan et al., 1998: 32）保持原文不译。
- 书名、期刊名、文章名译成中文并加书名号《》，其后括注原文，例如：《我们共同的未来》（Our Common Future）。
- 每段单独翻译，不要合并或拆分段落。
- kind="note" 的段落是注释：说明性的文字译成中文；书目信息（作者、书名、篇名、期刊名、出版地、出版社、年份、卷期、页码）保留原文，不译、不加书名号。注释开头的“Note 12:”写成“注 12：”。
- kind="table" 是 HTML 表格：只翻译单元格里的文字，标签原样保留。

术语表：
${terms.map((t) => `- ${t.en} → ${t.zh}`).join('\n')}

输入格式：<context> 中是前文，仅供理解，不要翻译；每个待译段落放在 <seg id="…" kind="…"> 和 </seg> 之间。
输出格式：对每个输入段落，按原顺序输出 <seg id="同一个 id">译文</seg>，每段一个，不要任何其他文字。`;

const SEG = /<seg id="([^"]+)"[^>]*>([\s\S]*?)<\/seg>/g;
const supCount = (t) => (t.match(/<sup>/g) ?? []).length;
// Stored as Markdown: footnote markers become ^12^. Models don't always follow the
// rule on Chinese quotes, so paired ASCII double quotes in Chinese text become “”.
function toMarkdown(t, kind) {
  if (kind === 'table') return t;
  t = t.replace(/<sup>\s*([^<]*?)\s*<\/sup>/g, '^$1^');
  if (/[一-鿿]/.test(t) && (t.match(/"/g) ?? []).length % 2 === 0) t = t.replace(/"([^"\n]*)"/g, '“$1”');
  return t;
}

function batches(list, maxChars = 3500, maxItems = 12) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const p of list) {
    if (cur.length && (size + p[1].length > maxChars || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p[1].length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Translate one batch. Returns { id: { mt, flag? } } for the pieces that came back. */
async function translateBatch(cfg, state, batch, context) {
  const payload =
    `<context>${context}</context>\n\n` +
    batch.map(([id, text, kind]) => `<seg id="${id}" kind="${kind}">${text}</seg>`).join('\n\n');
  const reply = await chat(cfg, translatePrompt(state.field, state.terms), payload);
  const got = Object.fromEntries([...reply.matchAll(SEG)].map((m) => [m[1], m[2].trim()]));
  const out = {};
  for (const [id, text, kind] of batch) {
    const t = got[id];
    if (typeof t !== 'string' || !t) continue;
    // Footnote markers must survive, except where garbled $…$ in the source was restored.
    const flag = supCount(t) !== supCount(text) && !text.includes('$') ? '脚注标记与原文数量不一致' : undefined;
    out[id] = { mt: toMarkdown(t, kind), ...(flag && { flag }) };
  }
  return out;
}


// ---------- runner ----------

const fresh = () => ({ version: 2, pieces: {}, ranges: [] });
const norm = (t = '') => t.replace(/\s+/g, ' ').trim();

/**
 * @param deps.translationFile(id) path of the result file
 * @param deps.getParsed(id) the finished parse ({ blocks, total }), or null
 * @param deps.getConfig() settings.translateConfig()
 * @param deps.readJson / writeJson / getBook / updateBook  storage helpers from main
 */
function createTranslator(deps) {
  const { translationFile, readJson, writeJson, getBook, updateBook, getConfig, getParsed } = deps;
  const waiting = [];
  const progress = new Map();
  const cancelled = new Set();
  const again = new Set(); // asked for more pages while running
  let running = null;

  // Every change to a translation file goes through here, one at a time per book,
  // so the runner's batches and the reader's edits never overwrite each other.
  const chains = new Map();
  function serial(bookId, task) {
    const next = (chains.get(bookId) ?? Promise.resolve()).then(task);
    chains.set(bookId, next.catch(() => {}));
    return next;
  }
  /** `fallback` is the state to start from when the file doesn't exist yet. */
  const update = (bookId, fn, fallback = null) =>
    serial(bookId, async () => {
      const state = await readJson(translationFile(bookId), fallback);
      const result = await fn(state);
      if (state) await writeJson(translationFile(bookId), state);
      return result;
    });

  const report = (bookId, p) => {
    progress.set(bookId, p);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('translate:progress', bookId, p);
  };

  async function run(bookId) {
    const book = await getBook(bookId);
    if (!book) return;
    const parsed = await getParsed(bookId);
    if (!parsed) throw new TranslateError('翻译前需要先解析');
    const cfg = await getConfig();
    if (!cfg.llmBaseUrl || !cfg.llmModel || !cfg.llmKey) throw new TranslateError('还没有设置翻译模型，请在「设置」中填写');
    const pageCount = parsed.total || book.pageCount;
    await updateBook(bookId, { translation: { state: 'running' } });
    const stop = () => cancelled.has(bookId);

    let state = await update(
      bookId,
      async (s) => {
        if (!s.ranges?.length) s.ranges = [[1, pageCount]];
        return s;
      },
      fresh(),
    );
    const all = pieces(parsed.blocks);
    const list = all.filter((p) => inRanges(state.ranges, p[3]));
    const total = list.length;
    const done = () => list.filter(([id]) => state.pieces[id]?.mt != null).length;
    const tell = () => report(bookId, { state: 'translating', done: done(), total });
    tell();

    // 1. Glossary, from the start of the whole text, shared by every range.
    if (!state.terms) {
      const text = all.filter(([, , k]) => k !== 'table').map(([, t]) => t).join('\n\n').slice(0, 120_000);
      const g = parseGlossary(await chat(cfg, GLOSSARY_PROMPT, text));
      if (stop()) return;
      state = await update(bookId, async (s) => Object.assign(s, g, { model: cfg.llmModel }));
    }

    // 2. Paragraphs in the ranges, several batches at once.
    const order = all.map(([id]) => id);
    const textOf = Object.fromEntries(all.map(([id, t]) => [id, t]));
    const context = (id) => {
      const i = order.indexOf(id);
      return i > 0 ? textOf[order[i - 1]].slice(-600) : '';
    };
    const save = (got) =>
      update(bookId, async (s) => {
        for (const [id, v] of Object.entries(got)) s.pieces[id] = { ...s.pieces[id], ...v };
        state = s;
      });

    const queue = batches(list.filter(([id]) => state.pieces[id]?.mt == null));
    const workers = Math.max(1, Math.min(32, Number(cfg.llmWorkers) || 8));
    let failure = null;
    const worker = async () => {
      while (queue.length && !stop() && !failure) {
        const batch = queue.shift();
        try {
          const got = await translateBatch(cfg, state, batch, context(batch[0][0]));
          await save(got);
          // Pieces the reply left out: one at a time.
          for (const p of batch.filter(([id]) => !got[id])) {
            if (stop()) return;
            await save(await translateBatch(cfg, state, [p], context(p[0])));
          }
          tell();
        } catch (err) {
          failure = err;
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    if (stop()) return;
    if (failure) throw failure;
    const missing = total - done();
    if (missing) throw new TranslateError(`有 ${missing} 段没有译出，点「重试」补上`);

    const at = Date.now();
    await update(bookId, async (s) => Object.assign(s, { finishedAt: at }));
    await updateBook(bookId, { translation: { state: 'done', at, pages: Math.min(pageCount, pagesIn(state.ranges, pageCount)) } });
    report(bookId, { state: 'done', done: total, total });
  }

  async function pump() {
    if (running) return;
    while (waiting.length) {
      const bookId = (running = waiting.shift());
      cancelled.delete(bookId);
      try {
        await run(bookId);
      } catch (err) {
        if (!cancelled.has(bookId)) {
          const error = err instanceof TranslateError ? err.message : `出错了：${err.message}`;
          await updateBook(bookId, { translation: { state: 'failed', error } });
          report(bookId, { state: 'failed', error });
        }
      }
      if (again.delete(bookId) && !cancelled.has(bookId)) waiting.push(bookId);
    }
    running = null;
  }

  return {
    /** Translate `range` ([from, to] pages) too, or carry on with the ranges asked for before. */
    async start(bookId, range) {
      if (range) {
        const [from, to] = range.map((n) => Math.max(1, Math.round(Number(n)))).sort((a, b) => a - b);
        await update(bookId, async (s) => Object.assign(s, { ranges: addRange(s.ranges, [from, to]) }), fresh());
      }
      if (running === bookId) return void again.add(bookId);
      if (waiting.includes(bookId)) return;
      waiting.push(bookId);
      report(bookId, { state: 'queued' });
      pump();
    },
    cancel(bookId) {
      cancelled.add(bookId);
      const i = waiting.indexOf(bookId);
      if (i >= 0) waiting.splice(i, 1);
      progress.delete(bookId);
    },
    status: () => Object.fromEntries(progress),
    resume(books) {
      for (const b of books) if (b.translation?.state === 'running') this.start(b.id);
    },
    /** The parse's blocks with their translations, waiting for pending writes; null before a parse. */
    async load(bookId) {
      const parsed = await getParsed(bookId);
      const t = await update(bookId, async (s) => s);
      if (!parsed && !t) return null;
      return { ...fresh(), ...t, blocks: parsed?.blocks };
    },
    /** What translating pages from–to would take: pieces and characters still to do, pieces done. */
    async estimate(bookId, from, to) {
      const parsed = await getParsed(bookId);
      if (!parsed) return null;
      const t = await readJson(translationFile(bookId), null);
      const list = pieces(parsed.blocks).filter(([, , , page]) => page >= from && page <= to);
      const todo = list.filter(([id]) => t?.pieces?.[id]?.mt == null);
      return { pieces: todo.length, chars: todo.reduce((n, [, text]) => n + text.length, 0), done: list.length - todo.length };
    },
    /** The reader's own wording for a piece; null goes back to the machine translation. */
    edit: (bookId, id, text) =>
      update(bookId, async (s) => {
        if (!s) return null;
        const p = { ...s.pieces[id] };
        if (text == null || text === p.mt) delete p.edit;
        else p.edit = text;
        s.pieces[id] = p;
        return p;
      }),
    /** Ask the model again for one piece. The new machine wording replaces any edit. */
    async retranslate(bookId, id) {
      const parsed = await getParsed(bookId);
      const s = await update(bookId, async (st) => st);
      const list = pieces(parsed?.blocks ?? []);
      const i = list.findIndex(([pid]) => pid === id);
      if (i < 0 || !s?.terms) throw new TranslateError('这段还不能重译');
      const got = await translateBatch(await getConfig(), s, [list[i]], i > 0 ? list[i - 1][1].slice(-600) : '');
      if (!got[id]) throw new TranslateError('模型没有返回这一段');
      return update(bookId, async (st) => {
        st.pieces[id] = got[id];
        return st.pieces[id];
      });
    },
    /**
     * A new parse renumbered the blocks: carry each translation (and the reader's edits)
     * over to the piece with the same source text. Pieces that don't match are untranslated.
     */
    remap: (bookId, before, after) =>
      update(bookId, async (s) => {
        if (!s) return;
        const byText = new Map(pieces(after).map(([id, text]) => [norm(text), id]));
        const next = {};
        for (const [id, text] of pieces(before)) {
          const to = byText.get(norm(text));
          if (to && s.pieces[id] && !next[to]) next[to] = s.pieces[id];
        }
        s.pieces = next;
      }),
  };
}

module.exports = { createTranslator, checkLlm, pieces, addRange, pagesIn };
