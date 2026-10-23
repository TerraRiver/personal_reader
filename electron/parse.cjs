// Structured parsing: MinerU turns a PDF into blocks in reading order (headings,
// paragraphs, notes, references, lists, formulas, tables, figures).
//
//   MinerU  POST /file-urls/batch -> PUT the file -> GET /extract-results/batch/{id}
//           -> zip with *_content_list.json (blocks in reading order, 0–1000 page boxes) and images/
//   chunks  MinerU takes at most 200 pages and 200 MB per file, so longer PDFs are split
//           with pdf-lib, parsed chunk by chunk, and their content lists joined with page offsets
//   build   joined content list -> reading-order blocks: running headers, cover pages and
//           misfiled notes fixed, paragraphs cut by a page break (or a chunk boundary) joined again
//
// Everything lives in <library>/parsed/<id>/: state.json (the chunks, then the blocks),
// chunk-<from>.json (each chunk's content list, pages already offset) and images/.
// Each finished chunk is saved, so a run resumes after a restart. The .md export is
// generated from the blocks, never by joining MinerU's own full.md files: those end on
// the last word of a chunk and would split a paragraph in two.

const { BrowserWindow, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');
const { PDFDocument } = require('pdf-lib');

const MINERU = 'https://mineru.net/api/v4';
const MAX_PAGES = 200;
const MAX_BYTES = 200 * 1024 * 1024;
// Longer PDFs go in chunks of this many pages; a failed chunk costs only its own pages again.
const CHUNK_PAGES = 100;

class ParseError extends Error {
  /** `retry`: worth trying the same request again. `resubmit`: the MinerU task failed; only a new one can help. */
  constructor(message, { retry = false, resubmit = false } = {}) {
    super(message);
    this.retry = retry;
    this.resubmit = resubmit;
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
    throw new ParseError(`网络错误：${err.cause?.code ?? err.message}`, { retry: true });
  }
}

// ---------- MinerU ----------

async function mineruCall(key, urlPath, init = {}) {
  const res = await request(`${MINERU}${urlPath}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 401 || res.status === 403) throw new ParseError('MinerU 密钥无效，请在「设置」中检查');
  if (res.status === 429 || res.status >= 500) throw new ParseError(`MinerU 暂不可用（${res.status}）`, { retry: true });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Gateway error pages.
  }
  if (!body) throw new ParseError(`MinerU 返回格式异常（${res.status}）`, { retry: res.status >= 500 });
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

async function mineruSubmit(cfg, dataId, bytes) {
  const body = await mineruCall(cfg.mineruKey, '/file-urls/batch', {
    method: 'POST',
    body: JSON.stringify({
      files: [{ name: 'document.pdf', data_id: dataId }],
      model_version: cfg.mineruModel || 'vlm',
      enable_formula: true,
      enable_table: true,
    }),
  });
  if (body.code !== 0) throw new ParseError(`MinerU 拒绝了任务：${body.msg}`);
  const { batch_id: batchId, file_urls: urls } = body.data;
  // The signed upload URL rejects a Content-Type header.
  const put = await request(urls[0], { method: 'PUT', body: bytes }, 10 * 60_000);
  if (!put.ok) throw new ParseError(`上传 PDF 失败（${put.status}）`, { retry: put.status >= 500 });
  return batchId;
}

/**
 * Polls until the parse is done. Returns { content, images } (images: name -> bytes),
 * 'expired' when the task is gone, or null when cancelled. `onPages(done)` reports progress.
 */
async function mineruResult(cfg, batchId, onPages, isCancelled) {
  let wait = 3000;
  for (;;) {
    if (isCancelled()) return null;
    const body = await withRetry(() => mineruCall(cfg.mineruKey, `/extract-results/batch/${batchId}`));
    if (body.code === -60012) return 'expired';
    if (body.code !== 0) throw new ParseError(`MinerU：${body.msg}`);
    const r = body.data.extract_result?.[0];
    if (r?.state === 'failed') throw new ParseError(`解析失败：${r.err_msg || '未知原因'}`, { resubmit: true });
    if (r?.state === 'done') {
      const res = await withRetry(() => request(r.full_zip_url, {}, 5 * 60_000));
      if (!res.ok) throw new ParseError(`下载解析结果失败（${res.status}）`, { retry: res.status >= 500 });
      const files = unzipSync(new Uint8Array(await res.arrayBuffer()), {
        filter: (f) => /(^|\/)[^/]*_content_list\.json$/.test(f.name) || /(^|\/)images\/[^/]+$/.test(f.name),
      });
      const listName = Object.keys(files).find((n) => n.endsWith('_content_list.json'));
      if (!listName) throw new ParseError('解析结果里没有内容列表');
      const images = {};
      for (const [name, bytes] of Object.entries(files)) if (name !== listName) images[path.basename(name)] = bytes;
      return { content: JSON.parse(strFromU8(files[listName])), images };
    }
    if (r?.extract_progress?.total_pages) onPages(r.extract_progress.extracted_pages ?? 0);
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
        img: b.img_path || undefined,
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

// ---------- .md export ----------

/** The blocks as Markdown; figures and table images point into images/. */
function toMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind === 'heading') out.push(`${'#'.repeat(Math.min(6, Math.max(1, b.level ?? 1)))} ${b.text}`);
    else if (b.kind === 'quote') out.push(`> ${b.text}`);
    else if (b.kind === 'list') out.push(b.items.map((t) => `- ${t}`).join('\n'));
    else if (b.kind === 'equation') {
      const latex = b.latex.trim().replace(/^\$\$|\$\$$/g, '').trim();
      if (latex) out.push(`$$\n${latex}\n$$`);
    } else if (b.kind === 'image' || b.kind === 'table') {
      if (b.caption) out.push(b.caption);
      if (b.html) out.push(b.html);
      else if (b.img) out.push(`![](${b.img})`);
      if (b.footnote) out.push(b.footnote);
    } else if (b.kind !== 'skipped' && b.text) out.push(b.text);
  }
  return out.join('\n\n') + '\n';
}

// ---------- runner ----------

/**
 * @param deps.dir(id) the book's directory under parsed/
 * @param deps.bookFile(id) path of the stored pdf
 * @param deps.getConfig() settings.translateConfig()
 * @param deps.onReparsed(id, before, after) blocks replaced by a new parse
 * @param deps.readJson / writeJson / getBook / updateBook  storage helpers from main
 */
function createParser(deps) {
  const { dir, bookFile, readJson, writeJson, getBook, updateBook, getConfig, onReparsed } = deps;
  const stateFile = (id) => path.join(dir(id), 'state.json');
  const chunkFile = (id, from) => path.join(dir(id), `chunk-${from}.json`);
  const imageDir = (id) => path.join(dir(id), 'images');

  const waiting = [];
  const progress = new Map();
  const cancelled = new Set();
  let running = null;

  const report = (bookId, p) => {
    progress.set(bookId, p);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('parse:progress', bookId, p);
  };

  /** Split into chunks MinerU accepts: one when it fits, otherwise CHUNK_PAGES each. */
  async function plan(bytes, knownPages) {
    if (knownPages && knownPages <= MAX_PAGES && bytes.length <= MAX_BYTES)
      return { total: knownPages, chunks: [{ from: 1, to: knownPages }] };
    let total;
    try {
      total = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
    } catch (err) {
      // pdf-lib can't read every PDF. One that fits is uploaded whole instead.
      if (bytes.length <= MAX_BYTES && (!knownPages || knownPages <= MAX_PAGES))
        return { total: knownPages, chunks: [{ from: 1, to: knownPages || 1 }], whole: true };
      throw new ParseError(`无法拆分这个 PDF：${err.message}`);
    }
    if (total <= MAX_PAGES && bytes.length <= MAX_BYTES) return { total, chunks: [{ from: 1, to: total }] };
    const bySize = Math.floor((total * MAX_BYTES * 0.85) / bytes.length);
    const per = Math.max(1, Math.min(CHUNK_PAGES, bySize));
    const chunks = [];
    for (let from = 1; from <= total; from += per) chunks.push({ from, to: Math.min(total, from + per - 1) });
    return { total, chunks };
  }

  /** The upload for chunk i; splits the chunk in the plan while it is still too large. */
  async function chunkBytes(state, i, getDoc, whole) {
    for (;;) {
      const c = state.chunks[i];
      if (state.whole || (c.from === 1 && c.to === state.total && whole.length <= MAX_BYTES)) return whole;
      const src = await getDoc();
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from - 1 + k));
      pages.forEach((p) => out.addPage(p));
      const bytes = await out.save();
      if (bytes.length <= MAX_BYTES || c.from === c.to) return bytes;
      const mid = Math.floor((c.from + c.to) / 2);
      state.chunks.splice(i, 1, { from: c.from, to: mid }, { from: mid + 1, to: c.to });
    }
  }

  async function run(bookId, force) {
    const book = await getBook(bookId);
    if (!book) return;
    const cfg = await getConfig();
    if (!cfg.mineruKey) throw new ParseError('还没有设置 MinerU 密钥，请在「设置」中填写');
    const stop = () => cancelled.has(bookId);

    const whole = await fs.readFile(bookFile(bookId));
    let state = await readJson(stateFile(bookId), null);
    if (!state || (state.parsedAt && force)) {
      // A new parse; blocks from an earlier one are kept until the new ones replace them.
      const previous = state?.blocks ?? state?.previous;
      state = { version: 1, ...(await plan(whole, book.pageCount)), ...(previous && { previous }) };
      await fs.rm(dir(bookId), { recursive: true, force: true });
      await writeJson(stateFile(bookId), state);
    }
    if (state.parsedAt) {
      await updateBook(bookId, { parse: { state: 'done', at: state.parsedAt, ...(state.legacy && { legacy: true }) } });
      report(bookId, { state: 'done', done: state.total, total: state.total });
      return;
    }
    await updateBook(bookId, { parse: { state: 'running' } });

    let src = null;
    const getDoc = async () => (src ??= await PDFDocument.load(whole, { ignoreEncryption: true, updateMetadata: false }));
    const pagesDone = () => state.chunks.filter((c) => c.done).reduce((s, c) => s + c.to - c.from + 1, 0);
    const tell = (extra = 0) => report(bookId, { state: 'parsing', done: pagesDone() + extra, total: state.total });
    tell();

    // Submit every chunk up front; MinerU works on them side by side.
    for (let i = 0; i < state.chunks.length; i++) {
      if (state.chunks[i].done || state.chunks[i].batch) continue;
      const bytes = await chunkBytes(state, i, getDoc, whole); // may split chunk i
      const c = state.chunks[i];
      c.batch = await withRetry(() => mineruSubmit(cfg, `${bookId}-${c.from}`, bytes));
      if (stop()) return;
      await writeJson(stateFile(bookId), state); // a restart resumes polling this task
    }

    for (const c of state.chunks) {
      if (c.done) continue;
      let result;
      try {
        result = await mineruResult(cfg, c.batch, (n) => tell(n), stop);
      } catch (err) {
        // Polling a failed task only fails again: forget it, so a retry submits the chunk anew.
        if (err.resubmit) {
          c.batch = null;
          await writeJson(stateFile(bookId), state);
        }
        throw err;
      }
      if (stop() || result == null) return;
      if (result === 'expired') {
        // The task is gone: forget it and start over, which submits this chunk again.
        c.batch = null;
        await writeJson(stateFile(bookId), state);
        return run(bookId, false);
      }
      await fs.mkdir(imageDir(bookId), { recursive: true });
      for (const [name, bytes] of Object.entries(result.images)) await fs.writeFile(path.join(imageDir(bookId), name), bytes);
      const content = result.content.map((b) => ({ ...b, page_idx: b.page_idx + c.from - 1 }));
      await writeJson(chunkFile(bookId, c.from), content);
      c.done = true;
      delete c.batch;
      await writeJson(stateFile(bookId), state);
      tell();
    }

    // Joined first, then cleaned, so headers and paragraphs across chunk boundaries are handled.
    const content = [];
    for (const c of state.chunks) content.push(...(await readJson(chunkFile(bookId, c.from), [])));
    const blocks = build(content);
    const { previous, ...rest } = state;
    const total = state.total || Math.max(0, ...content.map((b) => b.page_idx + 1));
    state = { ...rest, total, blocks, parsedAt: Date.now() };
    await writeJson(stateFile(bookId), state);
    if (previous) await onReparsed(bookId, previous, blocks);
    await updateBook(bookId, { parse: { state: 'done', at: state.parsedAt } });
    report(bookId, { state: 'done', done: total, total });
  }

  const forced = new Set();
  async function pump() {
    if (running) return;
    while (waiting.length) {
      const bookId = (running = waiting.shift());
      cancelled.delete(bookId);
      try {
        await run(bookId, forced.delete(bookId));
      } catch (err) {
        if (cancelled.has(bookId)) continue;
        const error = err instanceof ParseError ? err.message : `出错了：${err.message}`;
        await updateBook(bookId, { parse: { state: 'failed', error } });
        report(bookId, { state: 'failed', error });
      }
    }
    running = null;
  }

  /** The finished parse ({ blocks, total, legacy? }), or null. */
  async function load(bookId) {
    const state = await readJson(stateFile(bookId), null);
    return state?.parsedAt ? state : null;
  }

  return {
    /** `force` parses again even when a parse is done (old parses lack images). */
    start(bookId, { force = false } = {}) {
      if (running === bookId || waiting.includes(bookId)) return;
      if (force) forced.add(bookId);
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
      for (const b of books) if (b.parse?.state === 'running') this.start(b.id);
    },
    load,
    /** Blocks from a parse made before parsing was its own step: no chunks, no images. */
    adopt: (bookId, blocks, parsedAt) =>
      writeJson(stateFile(bookId), { version: 1, legacy: true, blocks, parsedAt: parsedAt ?? Date.now() }),
    remove: (bookId) => fs.rm(dir(bookId), { recursive: true, force: true }),
    /** The parse as a zip of <name>.md and the images it uses. Throws when parsing again is needed. */
    async exportZip(bookId, name) {
      const state = await load(bookId);
      if (!state) throw new ParseError('还没有解析');
      if (state.legacy) throw new ParseError('这份解析结果是旧版本生成的，没有保存图片，需要重新解析才能导出');
      const files = { [`${name}.md`]: strToU8(toMarkdown(state.blocks)) };
      for (const b of state.blocks) {
        if (!b.img || b.html || files[b.img]) continue;
        try {
          files[b.img] = await fs.readFile(path.join(imageDir(bookId), path.basename(b.img)));
        } catch {
          // A missing image leaves a broken link rather than failing the export.
        }
      }
      // Images are already compressed.
      return zipSync(files, { level: 6, mtime: new Date() });
    },
  };
}

module.exports = { createParser, checkMineru, build, toMarkdown, ParseError };
