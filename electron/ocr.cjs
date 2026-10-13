// OCR through PaddleOCR's hosted job API (AI Studio).
//
//   POST {BASE}             multipart: file, model, optionalPayload  -> data.jobId
//   GET  {BASE}/{jobId}     data.state: pending | running | done | failed
//                           data.extractProgress: { totalPages, extractedPages }
//                           data.resultUrl.jsonUrl: JSON Lines, one record per batch of pages
//
// Results go to <library>/ocr/<id>.json, and are written after every chunk so
// a run can resume after a restart and finished pages are usable right away.
// Line coordinates are stored as fractions of the page, which is how both the
// text layer and later annotations position things.

const { BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const { PDFDocument } = require('pdf-lib');

const BASE = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';
const MODEL = 'PP-OCRv6';
const OPTIONS = {
  useDocOrientationClassify: true, // scans are often rotated by 90° / 180°
  useDocUnwarping: false,
  useTextlineOrientation: false,
  visualize: false,
};
const MAX_UPLOAD = 45 * 1024 * 1024; // the API takes 50 MB; leave room for multipart overhead
const MAX_PAGES = 1000;
// Small chunks make the first pages usable soon after starting; a few are
// submitted ahead so the service works on them in parallel.
const CHUNK_PAGES = 30;
const AHEAD = 3;

// ---------- http ----------
class OcrError extends Error {
  /** `retry`: worth trying the same request again later. */
  constructor(message, { retry = false, code } = {}) {
    super(message);
    this.retry = retry;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, init, timeout) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new OcrError(`网络错误：${err.cause?.code ?? err.message}`, { retry: true });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error pages from gateways.
  }
  const code = body?.code;
  const msg = body?.msg || body?.errorMsg || body?.data?.errorMsg || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new OcrError('令牌无效，请在「设置」中检查访问令牌', { code });
  if (code === 12001) throw new OcrError('今日 OCR 额度已用完，明天再试', { code });
  if (res.status === 429 || code === 12002) throw new OcrError('请求过于频繁', { retry: true, code });
  if (code === 10010) throw new OcrError('服务端提交队列已满', { retry: true, code });
  if (res.status >= 500) throw new OcrError(`服务暂不可用（${res.status}）`, { retry: true, code });
  if (!res.ok || (code !== 0 && code != null)) throw new OcrError(`请求失败：${msg}`, { code });
  if (!body?.data) throw new OcrError('服务返回格式异常');
  return body.data;
}

/** Retries transient failures with backoff; anything else is thrown at once. */
async function withRetry(fn, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retry || i >= tries) throw err;
      await sleep(Math.min(60_000, 2000 * 2 ** i));
    }
  }
}

async function submit(token, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'book.pdf');
  form.append('model', MODEL);
  form.append('optionalPayload', JSON.stringify(OPTIONS));
  const data = await call(BASE, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }, 10 * 60_000);
  if (!data.jobId) throw new OcrError('服务没有返回任务编号');
  return data.jobId;
}

const jobStatus = (token, jobId) =>
  call(`${BASE}/${jobId}`, { headers: { Authorization: `Bearer ${token}` } }, 30_000);

/**
 * Checks a token without using any quota: looking up a job that doesn't exist
 * answers 11001 for a valid token and 401 otherwise. Returns an error message, or null.
 */
async function checkToken(token) {
  try {
    await jobStatus(token, '0'.repeat(18));
    return null;
  } catch (err) {
    if (err.code === 11001) return null;
    if (err instanceof OcrError && err.retry) return `暂时无法验证：${err.message}`;
    if (err instanceof OcrError && (err.code === 401 || /令牌无效/.test(err.message)))
      return '飞桨没有接受这个令牌，请确认是否完整复制';
    if (err instanceof OcrError) return err.message;
    throw err;
  }
}

async function fetchLines(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  } catch (err) {
    throw new OcrError(`下载结果失败：${err.message}`, { retry: true });
  }
  if (!res.ok) throw new OcrError(`下载结果失败（${res.status}）`, { retry: res.status >= 500 });
  return (await res.text())
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------- results ----------
const round = (n) => Math.round(n * 10000) / 10000;

/** Upright (u, v) -> page (x, y), by the angle the service turned the page. */
const UNTURN = {
  0: (u, v) => [u, v],
  90: (u, v) => [1 - v, u],
  180: (u, v) => [1 - u, 1 - v],
  270: (u, v) => [v, 1 - u],
};

/**
 * One chunk's JSONL records -> { [page]: { lines } }. Pages are numbered from
 * `from`, in the order the service returns them. Each line is
 * [text, x0, y0, x1, y1, x2, y2, x3, y3]: the polygon's corners clockwise from
 * the top left, as fractions of the page size.
 */
function parseChunk(records, from) {
  const pages = {};
  let n = from;
  for (const rec of records) {
    const { ocrResults = [], dataInfo } = rec.result ?? {};
    ocrResults.forEach((item, i) => {
      const size = dataInfo?.pages?.[i] ?? dataInfo;
      const r = item.prunedResult ?? {};
      // With orientation correction, coordinates refer to the page after the
      // service turned it upright by `angle`; map them back onto the page as shown.
      const angle = r.doc_preprocessor_res?.angle ?? 0;
      const turned = angle === 90 || angle === 270;
      const w = turned ? size?.height : size?.width;
      const h = turned ? size?.width : size?.height;
      const toPage = UNTURN[angle] ?? UNTURN[0];
      const lines = [];
      (r.rec_texts ?? []).forEach((text, j) => {
        const poly = r.rec_polys?.[j];
        if (!text || !poly || !w || !h) return;
        lines.push([text, ...poly.flatMap(([x, y]) => toPage(x / w, y / h).map(round))]);
      });
      pages[n++] = { lines };
    });
  }
  return pages;
}

// ---------- runner ----------

/**
 * @param deps.ocrFile(id) path of the result file
 * @param deps.bookFile(id) path of the stored pdf
 * @param deps.getToken() the access token, or null
 * @param deps.readJson / writeJson / getBook / updateBook  storage helpers from main
 */
function createOcr(deps) {
  const { ocrFile, bookFile, readJson, writeJson, getBook, getToken, updateBook } = deps;
  const waiting = []; // book ids, run one at a time
  const progress = new Map(); // id -> { state, done, total, error }
  const cancelled = new Set();
  let running = null;

  const notify = (bookId) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ocr:progress', bookId, progress.get(bookId));
  };
  const report = (bookId, p) => {
    progress.set(bookId, p);
    notify(bookId);
  };

  /** Split the book into chunks of at most CHUNK_PAGES pages, each under the upload limit. */
  async function plan(bytes, knownPages) {
    let total;
    try {
      total = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
    } catch (err) {
      // pdf-lib can't read every PDF. A small enough file is uploaded whole instead.
      if (bytes.length > MAX_UPLOAD || !knownPages || knownPages > MAX_PAGES)
        throw new OcrError(`无法拆分这个 PDF：${err.message}`);
      return { total: knownPages, chunks: [{ from: 1, to: knownPages }] };
    }
    const bySize = Math.floor((total * MAX_UPLOAD * 0.85) / bytes.length);
    const per = Math.max(1, Math.min(CHUNK_PAGES, MAX_PAGES, bySize));
    const chunks = [];
    for (let from = 1; from <= total; from += per) chunks.push({ from, to: Math.min(total, from + per - 1) });
    return { total, chunks };
  }

  /** The upload for chunk i; splits the chunk in the plan while it is still too large. */
  async function chunkBytes(state, i, getDoc, whole) {
    for (;;) {
      const c = state.chunks[i];
      if (c.from === 1 && c.to === state.total && whole.length <= MAX_UPLOAD) return whole;
      const src = await getDoc();
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from - 1 + k));
      pages.forEach((p) => out.addPage(p));
      const bytes = await out.save();
      if (bytes.length <= MAX_UPLOAD || c.from === c.to) return bytes;
      const mid = Math.floor((c.from + c.to) / 2);
      state.chunks.splice(i, 1, { from: c.from, to: mid }, { from: mid + 1, to: c.to });
    }
  }

  async function run(bookId) {
    const book = await getBook(bookId);
    if (!book) return;
    const token = await getToken();
    if (!token) throw new OcrError('还没有设置访问令牌，请在「设置」中填写');

    const whole = await fs.readFile(bookFile(bookId));
    let state = await readJson(ocrFile(bookId), null);
    if (!state || state.finishedAt || state.model !== MODEL) {
      state = { version: 1, model: MODEL, ...(await plan(whole, book.pageCount)), pages: {}, finishedAt: null, error: null };
    }
    state.error = null;
    await updateBook(bookId, { ocr: { state: 'running' } });

    let src = null;
    const getDoc = async () => (src ??= await PDFDocument.load(whole, { ignoreEncryption: true, updateMetadata: false }));
    const doneBefore = (i) => state.chunks.slice(0, i).reduce((s, c) => s + c.to - c.from + 1, 0);

    const saved = () => Object.keys(state.pages).length;

    /** Make sure chunks i .. i + AHEAD - 1 are submitted. Returns false when cancelled. */
    async function submitAhead(i) {
      for (let j = i; j < Math.min(state.chunks.length, i + AHEAD); j++) {
        if (state.chunks[j].done || state.chunks[j].jobId) continue;
        const bytes = await chunkBytes(state, j, getDoc, whole); // may split chunk j
        const jobId = await withRetry(() => submit(token, bytes));
        if (cancelled.has(bookId)) return false;
        state.chunks[j].jobId = jobId;
        await writeJson(ocrFile(bookId), state); // a restart resumes polling this job
      }
      return true;
    }

    for (let i = 0; i < state.chunks.length; i++) {
      if (state.chunks[i].done) continue;
      report(bookId, { state: 'running', done: doneBefore(i), total: state.total, saved: saved() });
      if (!(await submitAhead(i))) return;
      const c = state.chunks[i];

      let wait = 3000;
      for (;;) {
        if (cancelled.has(bookId)) return;
        let data;
        try {
          data = await withRetry(() => jobStatus(token, c.jobId));
        } catch (err) {
          // Unknown (11001) or expired (11002) job, e.g. after a long break: submit again.
          if (err.code === 11001 || err.code === 11002) {
            c.jobId = null;
            i--;
            break;
          }
          throw err;
        }
        if (data.state === 'failed') {
          c.jobId = null; // retrying submits this chunk again
          await writeJson(ocrFile(bookId), state);
          throw new OcrError(`识别失败：${data.errorMsg || '未知原因'}`);
        }
        if (data.state === 'done') {
          const records = await withRetry(() => fetchLines(data.resultUrl.jsonUrl));
          if (cancelled.has(bookId)) return;
          Object.assign(state.pages, parseChunk(records, c.from));
          c.done = true;
          await writeJson(ocrFile(bookId), state);
          // Readers pick up the new pages right away.
          report(bookId, { state: 'running', done: doneBefore(i + 1), total: state.total, saved: saved() });
          break;
        }
        const ep = data.extractProgress;
        report(bookId, {
          state: 'running',
          done: doneBefore(i) + (ep?.extractedPages ?? 0),
          total: state.total,
          saved: saved(),
        });
        await sleep(wait);
        wait = Math.min(15_000, wait * 1.5);
      }
    }

    if (cancelled.has(bookId)) return;
    state.finishedAt = Date.now();
    await writeJson(ocrFile(bookId), state);
    await updateBook(bookId, { ocr: { state: 'done', model: MODEL, at: state.finishedAt } });
    report(bookId, { state: 'done', done: state.total, total: state.total, saved: saved() });
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
        const error = err instanceof OcrError ? err.message : `出错了：${err.message}`;
        const state = await readJson(ocrFile(bookId), null).catch(() => null);
        if (state) await writeJson(ocrFile(bookId), { ...state, error });
        await updateBook(bookId, { ocr: { state: 'failed', error } });
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
    /** Stops polling; the hosted job itself can't be cancelled. */
    cancel(bookId) {
      cancelled.add(bookId);
      const i = waiting.indexOf(bookId);
      if (i >= 0) waiting.splice(i, 1);
      progress.delete(bookId);
    },
    status: () => Object.fromEntries(progress),
    /** Resume runs that were interrupted by quitting. */
    resume(books) {
      for (const b of books) if (b.ocr?.state === 'running') this.start(b.id);
    },
  };
}

module.exports = { createOcr, checkToken };
