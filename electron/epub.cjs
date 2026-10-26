// EPUB import: an EPUB is laid out once as an A5 PDF, so the rest of the app
// (notes by page, annotations, bookmarks, parsing, translation) works unchanged.
//
// The book is unzipped in memory and served from the `epub:` scheme in a session
// of its own, where every other request is cancelled: nothing in a book can reach
// the network or local files. Chapters are printed one by one in a hidden window
// with JavaScript off, then joined with pdf-lib.

const { BrowserWindow, protocol, session } = require('electron');
const crypto = require('node:crypto');
const { unzipSync, strFromU8 } = require('fflate');
const { PDFDocument, PDFName, PDFDict, PDFArray } = require('pdf-lib');

// Must run before the app is ready. `standard` makes relative links resolve.
protocol.registerSchemesAsPrivileged([{ scheme: 'epub', privileges: { standard: true } }]);

// Font obfuscation, not DRM: books using only these still open.
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

const TYPES = {
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};
const typeOf = (name) => TYPES[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

// Margins in inches around an A5 page (148 × 210 mm).
const PRINT = {
  pageSize: 'A5',
  margins: { top: 0.6, bottom: 0.6, left: 0.55, right: 0.55 },
  printBackground: true,
  // The outline gives the pages of headings; Chromium only writes it into a tagged PDF.
  generateDocumentOutline: true,
  generateTaggedPDF: true,
};

// Defaults for books with little or no CSS; the book's own styles win, except
// for the !important rules that keep content inside the page.
const BASE_CSS = `
  html { font-family: serif; font-size: 11pt; line-height: 1.65; }
  body { margin: 0 !important; padding: 0 !important; }
  img, svg, video { max-width: 100% !important; max-height: 185mm !important; object-fit: contain; }
  pre { white-space: pre-wrap !important; }
  table { max-width: 100% !important; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
`;

/** Unzipped books being printed, by the host their URLs use. */
const open = new Map();

let ses;
function convertSession() {
  if (ses) return ses;
  ses = session.fromPartition('epub-convert');
  ses.protocol.handle('epub', (req) => {
    const url = new URL(req.url);
    const book = open.get(url.host);
    const name = decodeURIComponent(url.pathname.slice(1));
    const data = book?.files[name];
    if (!data) return new Response(null, { status: 404 });
    return new Response(data, { headers: { 'content-type': book.types.get(name) ?? typeOf(name) } });
  });
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(epub|data|about):/.test(details.url) }));
  return ses;
}

async function withWindow(javascript, fn) {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1100,
    webPreferences: { session: convertSession(), sandbox: true, contextIsolation: true, javascript },
  });
  try {
    return await fn(win);
  } finally {
    // Wait until it's really gone: a window opened right after destroy() fails to load (ERR_FAILED).
    await new Promise((done) => {
      win.once('closed', done);
      win.close();
    });
  }
}

/**
 * Runs in a blank page (JavaScript on, but no book content loaded), only for its
 * DOMParser: the main process has no XML parser. Parsed documents never run scripts.
 */
function readXml(kind, text) {
  let doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
  const all = (root, name) => [...root.getElementsByTagNameNS('*', name)];
  const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

  if (kind === 'container') return all(doc, 'rootfile')[0]?.getAttribute('full-path') ?? null;
  if (kind === 'encryption') return all(doc, 'EncryptionMethod').map((e) => e.getAttribute('Algorithm') ?? '');
  if (kind === 'opf') {
    return {
      title: clean(all(doc, 'title')[0]?.textContent),
      manifest: all(doc, 'item').map((e) => ({
        id: e.getAttribute('id'),
        href: e.getAttribute('href'),
        type: e.getAttribute('media-type') ?? '',
        props: (e.getAttribute('properties') ?? '').split(/\s+/),
      })),
      spine: all(doc, 'itemref').map((e) => ({ idref: e.getAttribute('idref'), linear: e.getAttribute('linear') !== 'no' })),
      ncx: all(doc, 'spine')[0]?.getAttribute('toc') ?? null,
    };
  }
  const out = [];
  if (kind === 'nav') {
    const type = (n) => n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || n.getAttribute('epub:type') || '';
    const navs = all(doc, 'nav');
    const nav = navs.find((n) => type(n).split(/\s+/).includes('toc')) ?? navs[0];
    const walk = (ol, level) => {
      for (const li of kids(ol, 'li')) {
        const a = kids(li, 'a')[0];
        const href = a?.getAttribute('href');
        if (href) out.push({ title: clean(a.textContent), href, level });
        for (const sub of kids(li, 'ol')) walk(sub, href ? level + 1 : level);
      }
    };
    const ol = nav && all(nav, 'ol')[0];
    if (ol) walk(ol, 0);
  } else if (kind === 'ncx') {
    const walk = (el, level) => {
      for (const p of kids(el, 'navPoint')) {
        const href = all(p, 'content')[0]?.getAttribute('src');
        if (href) out.push({ title: clean(all(p, 'text')[0]?.textContent), href, level });
        walk(p, href ? level + 1 : level);
      }
    };
    const map = all(doc, 'navMap')[0];
    if (map) walk(map, 0);
  }
  return out;
}

/** A zip path from `href`, relative to the file at `base`; the #fragment comes apart. */
function resolve(base, href) {
  const url = new URL(href, `epub://b/${encodeURI(base)}`);
  return { name: decodeURIComponent(url.pathname.slice(1)), hash: url.hash };
}

/** The outline Chromium made from a chapter's headings: { title, page (0-based), level }. */
function headingsOf(pdf) {
  const out = [];
  try {
    const pages = pdf.getPages().map((p) => p.ref);
    const walk = (item, level) => {
      for (; item; item = item.lookupMaybe(PDFName.of('Next'), PDFDict)) {
        const dest =
          item.lookupMaybe(PDFName.of('Dest'), PDFArray) ??
          item.lookupMaybe(PDFName.of('A'), PDFDict)?.lookupMaybe(PDFName.of('D'), PDFArray);
        const page = dest ? pages.indexOf(dest.get(0)) : -1;
        const title = item.lookup(PDFName.of('Title'))?.decodeText?.().trim();
        if (page >= 0 && title) out.push({ title, page, level });
        walk(item.lookupMaybe(PDFName.of('First'), PDFDict), level + 1);
      }
    };
    walk(pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)?.lookupMaybe(PDFName.of('First'), PDFDict), 0);
  } catch {
    // An outline pdf-lib can't follow only costs the exact pages of headings.
  }
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * Lays out an EPUB as an A5 PDF.
 * Resolves to { pdf: Uint8Array, title, pageCount, bookmarks: [{ title, page, level }] }.
 * Throws with a message for the reader when the book can't be converted.
 */
async function convertEpub(bytes) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('不是有效的 EPUB 文件');
  }
  const text = (name) => (files[name] ? strFromU8(files[name]) : null);
  const host = crypto.randomUUID().replace(/-/g, '');
  const book = { files, types: new Map() };
  open.set(host, book);
  try {
    // 1. Read the package: spine, manifest, table of contents.
    const pkg = await withWindow(true, async (win) => {
      await win.loadURL('about:blank');
      const read = (kind, src) => win.webContents.executeJavaScript(`(${readXml})(${JSON.stringify(kind)}, ${JSON.stringify(src)})`);
      const enc = text('META-INF/encryption.xml');
      if (enc && (await read('encryption', enc)).some((a) => !FONT_OBFUSCATION.has(a))) {
        throw new Error('这本 EPUB 有 DRM 加密，无法导入');
      }
      const container = text('META-INF/container.xml');
      const opfPath = container && (await read('container', container));
      if (!opfPath || !files[opfPath]) throw new Error('找不到 EPUB 的内容清单（OPF）');
      const opf = await read('opf', text(opfPath));
      const items = new Map(opf.manifest.filter((m) => m.id && m.href).map((m) => [m.id, { ...m, ...resolve(opfPath, m.href) }]));
      for (const m of items.values()) if (m.type) book.types.set(m.name, m.type);
      const nav = [...items.values()].find((m) => m.props.includes('nav'));
      const ncx = items.get(opf.ncx) ?? [...items.values()].find((m) => m.type === 'application/x-dtbncx+xml');
      const tocFile = (nav && files[nav.name] && nav) || (ncx && files[ncx.name] && ncx);
      const toc = tocFile ? await read(tocFile === nav ? 'nav' : 'ncx', text(tocFile.name)) : [];
      return {
        title: opf.title,
        // Items outside the reading order (linear="no") go after it.
        spine: [...opf.spine.filter((s) => s.linear), ...opf.spine.filter((s) => !s.linear)]
          .map((s) => items.get(s.idref))
          .filter((m) => m && files[m.name] && /html|svg/.test(m.type || typeOf(m.name))),
        toc: toc.map((t) => ({ ...t, ...resolve(tocFile.name, t.href) })),
      };
    });
    if (!pkg.spine.length) throw new Error('EPUB 里没有可显示的正文');

    // 2. Print each chapter, recording where it starts and the pages of its headings.
    const out = await PDFDocument.create();
    const chapters = new Map(); // zip path → { start (1-based), headings }
    await withWindow(false, async (win) => {
      for (const item of pkg.spine) {
        await win.loadURL(`epub://${host}/${encodeURI(item.name)}`);
        await win.webContents.insertCSS(BASE_CSS, { cssOrigin: 'user' });
        const pdf = await PDFDocument.load(await win.webContents.printToPDF(PRINT));
        const start = out.getPageCount() + 1;
        chapters.set(item.name, { start, headings: headingsOf(pdf).map((h) => ({ ...h, page: start + h.page })) });
        for (const page of await out.copyPages(pdf, pdf.getPageIndices())) out.addPage(page);
      }
    });

    // 3. Bookmarks from the table of contents. A link into the middle of a chapter
    //    gets the page of the heading with the same text, else the chapter's start.
    const bookmarks = [];
    const after = new Map(); // zip path → index of the last heading used
    for (const t of pkg.toc) {
      const ch = chapters.get(t.name);
      if (!ch) continue;
      let page = ch.start;
      if (t.hash && t.title) {
        const from = (after.get(t.name) ?? -1) + 1;
        const key = norm(t.title);
        const i = ch.headings.findIndex((h, j) => j >= from && key && (norm(h.title) === key || norm(h.title).startsWith(key)));
        if (i >= 0) {
          page = ch.headings[i].page;
          after.set(t.name, i);
        }
      }
      bookmarks.push({ id: crypto.randomUUID(), title: t.title || '未命名', page, level: t.level });
    }
    // No table of contents: the headings themselves.
    if (!bookmarks.length) {
      for (const ch of chapters.values()) {
        for (const h of ch.headings) bookmarks.push({ id: crypto.randomUUID(), title: h.title, page: h.page, level: h.level });
      }
    }

    if (pkg.title) out.setTitle(pkg.title);
    return { pdf: await out.save(), title: pkg.title, pageCount: out.getPageCount(), bookmarks };
  } finally {
    open.delete(host);
  }
}

module.exports = { convertEpub };
