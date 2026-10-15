// Paper translation: MinerU parses the PDF into blocks, an OpenAI-compatible
// model translates them paragraph by paragraph.
//
//   MinerU  POST /file-urls/batch -> PUT the file -> GET /extract-results/batch/{id}
//           -> zip with *_content_list.json (blocks in reading order, 0–1000 page boxes)
//   build   content list -> reading-order blocks: running headers, cover pages and
//           misfiled notes fixed, paragraphs cut by a page break joined again
//   LLM     a glossary from the whole paper, then batches of paragraphs
//
// Everything lives in <library>/translations/<id>.json and is saved after each
// batch, so finished paragraphs show right away and a run resumes after a restart.
// Translations are kept as Markdown per piece; `edit` holds the reader's own
// wording, which a later machine run never overwrites.

const { BrowserWindow, net } = require('electron');
const fs = require('node:fs/promises');
const { unzipSync, strFromU8 } = require('fflate');

const MINERU = 'https://mineru.net/api/v4';
const MAX_PAGES = 200;
const MAX_BYTES = 200 * 1024 * 1024;

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

// ---------- MinerU ----------

async function mineruCall(key, path, init = {}) {
  const res = await request(`${MINERU}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 401 || res.status === 403) throw new TranslateError('MinerU 密钥无效，请在「设置」中检查');
  if (res.status === 429 || res.status >= 500) throw new TranslateError(`MinerU 暂不可用（${res.status}）`, { retry: true });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Gateway error pages.
  }
  if (!body) throw new TranslateError(`MinerU 返回格式异常（${res.status}）`, { retry: res.status >= 500 });
  return body;
}

/** Checks a key without using quota: an unknown task answers -60012 to a valid key, 401 otherwise. */
async function checkMineru(key) {
  try {
    const body = await mineruCall(key, '/extract-results/batch/00000000-0000-0000-0000-000000000000');
    return body.code === 0 || body.code === -60012 ? null : `MinerU：${body.msg}`;
  } catch (err) {
    return err.message;
  }
}

async function mineruSubmit(cfg, name, bytes) {
  const body = await mineruCall(cfg.mineruKey, '/file-urls/batch', {
    method: 'POST',
    body: JSON.stringify({
      files: [{ name: 'paper.pdf', data_id: name }],
      model_version: cfg.mineruModel || 'vlm',
      enable_formula: true,
      enable_table: true,
    }),
  });
  if (body.code !== 0) throw new TranslateError(`MinerU 拒绝了任务：${body.msg}`);
  const { batch_id: batchId, file_urls: urls } = body.data;
  // The signed upload URL rejects a Content-Type header.
  const put = await request(urls[0], { method: 'PUT', body: bytes }, 10 * 60_000);
  if (!put.ok) throw new TranslateError(`上传 PDF 失败（${put.status}）`, { retry: put.status >= 500 });
  return batchId;
}

/** Polls until the parse is done; returns the content list. `onPages(done, total)` reports progress. */
async function mineruResult(cfg, batchId, onPages, isCancelled) {
  let wait = 3000;
  for (;;) {
    if (isCancelled()) return null;
    const body = await withRetry(() => mineruCall(cfg.mineruKey, `/extract-results/batch/${batchId}`));
    if (body.code === -60012) return 'expired';
    if (body.code !== 0) throw new TranslateError(`MinerU：${body.msg}`);
    const r = body.data.extract_result?.[0];
    if (r?.state === 'failed') throw new TranslateError(`解析失败：${r.err_msg || '未知原因'}`);
    if (r?.state === 'done') {
      const res = await withRetry(() => request(r.full_zip_url, {}, 5 * 60_000));
      if (!res.ok) throw new TranslateError(`下载解析结果失败（${res.status}）`, { retry: res.status >= 500 });
      const files = unzipSync(new Uint8Array(await res.arrayBuffer()), {
        filter: (f) => f.name.endsWith('_content_list.json'),
      });
      const list = Object.values(files)[0];
      if (!list) throw new TranslateError('解析结果里没有内容列表');
      return JSON.parse(strFromU8(list));
    }
    const p = r?.extract_progress;
    if (p?.total_pages) onPages(p.extracted_pages ?? 0, p.total_pages);
    await sleep(wait);
    wait = Math.min(10_000, wait * 1.3);
  }
}

// ---------- build: content list -> reading-order blocks ----------

const SKIP = new Set(['header', 'footer', 'page_number', 'aside_text', 'page_header', 'page_footer']);
// Ends a sentence, allowing closing quotes/brackets and a footnote marker after it.
const SENTENCE_END = /[.!?:;…]['"’”)\]]*\s*(<sup>[^<]*<\/sup>)?\s*$/;
const NOTE_MARK = /^\s*(<sup>|\d+[\s.)]|[*†‡§])/;
// Publisher boilerplate that MinerU files as footnotes.
const BOILERPLATE = /^http|Copyright|©|Downloaded from/i;
// Cover pages that databases and repositories put in front of a paper.
const COVER = new RegExp(
  [
    'Downloaded from', 'Permissions:', 'Published by', 'Citation:', 'Subscriptions:', 'Reprints:',
    'Email Alerts', 'Additional services', 'institutional repository', 'made available online',
    'final version of this paper', 'Terms (of use|and Conditions)', 'JSTOR', 'For more information',
    'This article (was|is) downloaded', 'Citations?:\\s*http', 'online version of this article',
  ].join('|'),
  'i',
);
// Endnotes written out as body text: "Note 69: …".
const ENDNOTE = /^(Note|Notes?)\s*\d+\s*[:.]|^注\s*\d+/;
// A bibliography entry: "Surname, F. … (2000) …".
const REF_LIKE = /^[A-ZÀ-Ž][\p{L}\p{N}_'’-]+(,| and| &)\s.*\b(1[89]|20)\d\d[a-z]?\b/u;

// Lost italics leave a space before punctuation: "security ." -> "security."
const clean = (t = '') =>
  t.replace(/([\p{L}\p{N}_]) ([.,;:!?)])/gu, '$1$2').replace(/[ \t]+/g, ' ').trim();

function build(content) {
  // Running headers MinerU sometimes reads as body text: the same short line on 3+ pages.
  const pagesOf = new Map();
  for (const b of content) {
    const t = clean(b.text);
    if (b.type === 'text' && t && t.length < 120) {
      if (!pagesOf.has(t)) pagesOf.set(t, new Set());
      pagesOf.get(t).add(b.page_idx);
    }
  }
  const running = new Set([...pagesOf].filter(([, p]) => p.size >= 3).map(([t]) => t));

  const blocks = [];
  content.forEach((b, i) => {
    const kind = b.type;
    const block = { id: `b${String(i).padStart(4, '0')}`, parts: [{ page: b.page_idx + 1, bbox: b.bbox }] };
    const text = clean(b.text);
    if (SKIP.has(kind)) Object.assign(block, { kind: 'skipped', label: kind, text });
    else if (kind === 'text' && !text) Object.assign(block, { kind: 'skipped', label: 'empty', text: '' });
    else if (kind === 'text' && running.has(text)) Object.assign(block, { kind: 'skipped', label: 'header', text });
    else if (kind === 'text' && b.text_level) Object.assign(block, { kind: 'heading', level: b.text_level, text });
    else if (kind === 'text') Object.assign(block, { kind: 'para', text });
    else if (kind === 'list') Object.assign(block, { kind: 'list', items: (b.list_items ?? []).map(clean) });
    else if (kind === 'ref_text') Object.assign(block, { kind: 'ref', text });
    else if (kind === 'page_footnote') {
      const prev = [...blocks].reverse().find((x) => x.kind === 'para');
      if (BOILERPLATE.test(text)) Object.assign(block, { kind: 'skipped', label: 'footer', text });
      // A long indented quotation, introduced by "…:", mistaken for a footnote.
      else if (!NOTE_MARK.test(text) && prev?.text.trimEnd().endsWith(':')) Object.assign(block, { kind: 'quote', text });
      else Object.assign(block, { kind: 'note', text });
    } else if (kind === 'equation') Object.assign(block, { kind: 'equation', latex: b.text ?? '' });
    else if (kind === 'code') Object.assign(block, { kind: 'equation', latex: b.code_body ?? '' });
    else if (kind === 'image' || kind === 'table' || kind === 'chart')
      Object.assign(block, {
        kind: kind === 'table' ? 'table' : 'image',
        html: b.table_body || undefined,
        caption: clean((b.image_caption ?? b.table_caption ?? []).join(' ')) || undefined,
        footnote: clean((b.image_footnote ?? b.table_footnote ?? []).join(' ')) || undefined,
      });
    else Object.assign(block, { kind: 'para', text });
    blocks.push(block);
  });
  reclassify(blocks);
  return mergeAcrossPages(blocks);
}

/** Fix what MinerU's block types get wrong, in place. */
function reclassify(blocks) {
  const page = (b) => b.parts[0].page;
  // Cover pages: among the first two, a page with several publisher lines.
  const hits = {};
  for (const b of blocks) if (page(b) <= 2 && COVER.test(b.text ?? '')) hits[page(b)] = (hits[page(b)] ?? 0) + 1;
  for (const b of blocks) {
    if (b.kind !== 'skipped' && hits[page(b)] >= 2) Object.assign(b, { kind: 'skipped', label: 'cover' });
    else if (b.kind === 'para' && COVER.test(b.text) && b.text.length < 200) Object.assign(b, { kind: 'skipped', label: 'footer' });
  }

  const body = blocks.filter((b) => b.kind !== 'skipped');
  let section = null;
  body.forEach((b, i) => {
    if (b.kind === 'heading') {
      const t = b.text.trim().toLowerCase();
      section = /^(end)?notes?$/.test(t) ? 'notes' : /^(references|bibliography|works cited|literature)$/.test(t) ? 'refs' : null;
      return;
    }
    // Endnotes ("12. See also …") that MinerU filed as references or body text. MinerU's own
    // reference calls are trusted unless numbered; a heading isn't enough on its own, since
    // one paper's bibliography is headed "Notes".
    const numbered = /^\d{1,3}\.\s/.test(b.text ?? '');
    if (
      section !== 'refs' &&
      ((b.kind === 'ref' && numbered) ||
        (b.kind === 'para' && (numbered || (section === 'notes' && !REF_LIKE.test(b.text)))))
    ) {
      Object.assign(b, { kind: 'note', endnote: true });
      return;
    }
    if (b.kind !== 'para') return;
    if (ENDNOTE.test(b.text)) Object.assign(b, { kind: 'note', endnote: true });
    else if (REF_LIKE.test(b.text)) {
      // A bibliography entry MinerU missed: it sits among recognized ones.
      const near = [...body.slice(Math.max(0, i - 2), i), ...body.slice(i + 1, i + 3)];
      if (near.filter((x) => x.kind === 'ref').length >= 2) b.kind = 'ref';
    }
  });
}

/**
 * Join a paragraph cut at a page end with its continuation on a later page: the last
 * paragraph (or endnote) before a page change that doesn't end a sentence, or whose
 * continuation starts in lowercase. Headers, footers, footnotes and figures between are skipped.
 */
function mergeAcrossPages(blocks) {
  const out = [];
  let open = null;
  for (const b of blocks) {
    if (b.kind === 'para') {
      const prev = open != null ? out[open] : null;
      if (prev && b.parts[0].page > prev.parts.at(-1).page &&
          (!SENTENCE_END.test(prev.text) || /^[a-z(“"‘'—–-]/.test(b.text))) {
        const hyphen = prev.text.endsWith('-') && !prev.text.endsWith('--');
        prev.text = (hyphen ? prev.text.slice(0, -1) : prev.text + ' ') + b.text;
        prev.parts.push(...b.parts);
        continue;
      }
      out.push(b);
      open = out.length - 1;
    } else {
      out.push(b);
      if (b.endnote) open = out.length - 1;
      else if (!['skipped', 'note', 'image', 'table', 'equation'].includes(b.kind)) open = null;
    }
  }
  return out;
}

/** [id, text, kind] for everything the model translates. References stay in the original. */
function pieces(blocks) {
  const out = [];
  for (const b of blocks) {
    if (['para', 'heading', 'note', 'quote'].includes(b.kind)) out.push([b.id, b.text, b.kind]);
    else if (b.kind === 'list') b.items.forEach((t, j) => out.push([`${b.id}.${j}`, t, 'list']));
    else if (b.kind === 'image' || b.kind === 'table') {
      if (b.caption) out.push([`${b.id}.caption`, b.caption, 'caption']);
      if (b.footnote) out.push([`${b.id}.footnote`, b.footnote, 'caption']);
      if (b.html) out.push([`${b.id}.html`, b.html, 'table']);
    }
  }
  return out;
}

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

/**
 * @param deps.translationFile(id) path of the result file
 * @param deps.bookFile(id) path of the stored pdf
 * @param deps.getConfig() settings.translateConfig()
 * @param deps.readJson / writeJson / getBook / updateBook  storage helpers from main
 */
function createTranslator(deps) {
  const { translationFile, bookFile, readJson, writeJson, getBook, updateBook, getConfig } = deps;
  const waiting = [];
  const progress = new Map();
  const cancelled = new Set();
  let running = null;

  // Every change to a translation file goes through here, one at a time per book,
  // so the runner's batches and the reader's edits never overwrite each other.
  const chains = new Map();
  function update(bookId, fn) {
    const next = (chains.get(bookId) ?? Promise.resolve()).then(async () => {
      const state = await readJson(translationFile(bookId), null);
      const result = await fn(state);
      if (state) await writeJson(translationFile(bookId), state);
      return result;
    });
    chains.set(bookId, next.catch(() => {}));
    return next;
  }
  const create = (bookId, state) => update(bookId, async () => writeJson(translationFile(bookId), state));

  const report = (bookId, p) => {
    progress.set(bookId, p);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('translate:progress', bookId, p);
  };

  async function run(bookId) {
    const book = await getBook(bookId);
    if (!book) return;
    const cfg = await getConfig();
    if (!cfg.mineruKey) throw new TranslateError('还没有设置 MinerU 密钥，请在「设置」中填写');
    if (!cfg.llmBaseUrl || !cfg.llmModel || !cfg.llmKey) throw new TranslateError('还没有设置翻译模型，请在「设置」中填写');
    await updateBook(bookId, { translation: { state: 'running' } });
    const stop = () => cancelled.has(bookId);

    // 1. Parse (resumes polling a task submitted before a restart).
    let state = await readJson(translationFile(bookId), null);
    if (!state?.blocks) {
      if (book.pageCount > MAX_PAGES) throw new TranslateError(`MinerU 一次最多解析 ${MAX_PAGES} 页`);
      const bytes = await fs.readFile(bookFile(bookId));
      if (bytes.length > MAX_BYTES) throw new TranslateError('PDF 超过 200 MB，MinerU 无法解析');
      for (;;) {
        let batchId = state?.mineruBatch;
        if (!batchId) {
          report(bookId, { state: 'parsing', done: 0, total: book.pageCount || 0 });
          batchId = await withRetry(() => mineruSubmit(cfg, bookId, bytes));
          if (stop()) return;
          state = { version: 1, mineruBatch: batchId, pieces: {} };
          await create(bookId, state);
        }
        const content = await mineruResult(
          cfg,
          batchId,
          (done, total) => report(bookId, { state: 'parsing', done, total }),
          stop,
        );
        if (stop() || content == null) return;
        if (content === 'expired') {
          state.mineruBatch = null; // the task is gone: submit again
          continue;
        }
        const blocks = build(content);
        state = await update(bookId, async (s) => Object.assign(s, { blocks, mineruBatch: null, parsedAt: Date.now() }));
        break;
      }
    }
    state = await readJson(translationFile(bookId), null);
    const list = pieces(state.blocks);
    const total = list.length;
    const done = () => list.filter(([id]) => state.pieces[id]?.mt != null).length;
    const tell = () => report(bookId, { state: 'translating', done: done(), total });
    tell();

    // 2. Glossary.
    if (!state.terms) {
      const text = list.filter(([, , k]) => k !== 'table').map(([, t]) => t).join('\n\n').slice(0, 120_000);
      const g = parseGlossary(await chat(cfg, GLOSSARY_PROMPT, text));
      if (stop()) return;
      state = await update(bookId, async (s) => Object.assign(s, g, { model: cfg.llmModel }));
    }

    // 3. Paragraphs, several batches at once.
    const order = list.map(([id]) => id);
    const textOf = Object.fromEntries(list.map(([id, t]) => [id, t]));
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

    await update(bookId, async (s) => Object.assign(s, { finishedAt: Date.now() }));
    await updateBook(bookId, { translation: { state: 'done', at: Date.now() } });
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
        if (cancelled.has(bookId)) continue;
        const error = err instanceof TranslateError ? err.message : `出错了：${err.message}`;
        await updateBook(bookId, { translation: { state: 'failed', error } });
        report(bookId, { state: 'failed', error });
      }
    }
    running = null;
  }

  return {
    start(bookId) {
      if (running === bookId || waiting.includes(bookId)) return;
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
    /** Waits for pending writes, then reads. */
    load: (bookId) => update(bookId, async (s) => s),
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
      const s = await this.load(bookId);
      const list = pieces(s?.blocks ?? []);
      const i = list.findIndex(([pid]) => pid === id);
      if (i < 0 || !s.terms) throw new TranslateError('这段还不能重译');
      const got = await translateBatch(await getConfig(), s, [list[i]], i > 0 ? list[i - 1][1].slice(-600) : '');
      if (!got[id]) throw new TranslateError('模型没有返回这一段');
      return update(bookId, async (st) => {
        st.pieces[id] = got[id];
        return st.pieces[id];
      });
    },
  };
}

module.exports = { createTranslator, checkMineru, checkLlm, build, pieces };
