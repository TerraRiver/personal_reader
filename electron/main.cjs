const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createOcr, checkToken } = require('./ocr.cjs');
const { exportOcrPdf } = require('./ocr-pdf.cjs');
const { createParser, checkMineru } = require('./parse.cjs');
const { createTranslator, checkLlm } = require('./translate.cjs');
const { convertEpub } = require('./epub.cjs');
const createSettings = require('./settings.cjs');

const DEV_URL = 'http://localhost:5173';

// Lets development/testing point at a throwaway data directory.
if (process.env.READER_DATA_DIR) app.setPath('userData', process.env.READER_DATA_DIR);

// ---------- storage ----------
// <userData>/library/library.json   book metadata and folders
// <userData>/library/books/<id>.pdf copied pdf files (for an EPUB, the A5 PDF made from it)
// <userData>/library/books/<id>.epub the original of an imported EPUB
// <userData>/library/notes/<id>.json notes of one book
// <userData>/library/bookmarks/<id>.json bookmarks of one book
// <userData>/library/ocr/<id>.json       hosted OCR results of one book
// <userData>/library/annotations/<id>.json  highlights and stamps of one book
// <userData>/library/parsed/<id>/        MinerU parse: state.json, chunk content lists, images
// <userData>/library/translations/<id>.json translations of the parsed blocks

const root = () => path.join(app.getPath('userData'), 'library');
const libraryFile = () => path.join(root(), 'library.json');

// Ids come from the page. Only ids made here (UUIDs) may name a file, so no
// id can point outside the library, e.g. with "../".
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileOf = (dir, ext) => (id) => {
  if (!ID.test(id)) throw new Error(`无效的编号：${id}`);
  return path.join(root(), dir, ext ? `${id}.${ext}` : id);
};
const bookFile = fileOf('books', 'pdf');
const epubFile = fileOf('books', 'epub');
const notesFile = fileOf('notes', 'json');
const bookmarksFile = fileOf('bookmarks', 'json');
const ocrFile = fileOf('ocr', 'json');
const annotationsFile = fileOf('annotations', 'json');
const translationFile = fileOf('translations', 'json');
const parsedDir = fileOf('parsed');

// Missing files fall back to the default. A file that exists but can't be parsed
// is moved aside first, so the next save can never overwrite the only copy.
// Other read errors propagate, which also blocks the save that would follow.
async function readJson(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, backup);
    warn('数据文件已损坏', `无法读取 ${path.basename(file)}，原文件已备份为：\n${backup}`);
    return fallback;
  }
}

// Attached to the window as a sheet, so it never blocks the app.
function warn(message, detail) {
  const win = BrowserWindow.getAllWindows()[0];
  const opts = { type: 'warning', message, detail };
  if (win) dialog.showMessageBox(win, opts);
  else dialog.showMessageBox(opts);
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// Serialize every write so concurrent IPC calls never clobber each other.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

// One list of books; each can sit in a folder.
const loadLibrary = async () => {
  const lib = await readJson(libraryFile(), {});
  // Other fields (the format version) are kept, so saving never drops them.
  return { ...lib, books: lib.books ?? [], folders: lib.folders ?? [] };
};
const loadBooks = async () => (await loadLibrary()).books;
const loadFolders = async () => (await loadLibrary()).folders;
async function saveBooks(books) {
  const lib = await loadLibrary();
  await writeJson(libraryFile(), { ...lib, books });
}
async function saveFolders(folders) {
  const lib = await loadLibrary();
  await writeJson(libraryFile(), { ...lib, folders });
}

/** `target` says where new files go: { folder?: id }. */
async function importPaths(paths, target = {}) {
  // EPUBs are laid out as PDFs first, outside the write queue: that can take a while.
  const items = [];
  const failed = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    const title = path.basename(p, path.extname(p));
    if (ext === '.pdf') items.push({ src: p, title });
    if (ext !== '.epub') continue;
    try {
      const epub = await convertEpub(await fs.readFile(p));
      items.push({ src: p, title: epub.title || title, epub });
    } catch (err) {
      failed.push(`${path.basename(p)}：${err.message}`);
    }
  }
  if (failed.length) warn('有 EPUB 没能导入', failed.join('\n'));
  return serial(async () => {
    const books = await loadBooks();
    await fs.mkdir(path.join(root(), 'books'), { recursive: true });
    for (const { src, title, epub } of items) {
      const id = crypto.randomUUID();
      if (epub) {
        await fs.writeFile(bookFile(id), epub.pdf);
        await fs.copyFile(src, epubFile(id));
        await writeJson(bookmarksFile(id), epub.bookmarks);
      } else {
        await fs.copyFile(src, bookFile(id));
      }
      books.unshift({
        id,
        title,
        pageCount: epub?.pageCount ?? 0,
        lastPage: 1,
        addedAt: Date.now(),
        openedAt: null,
        // An EPUB has no printed page numbers: citations use the PDF's.
        ...(epub ? { format: 'epub', bodyStart: 1 } : {}),
        ...(target.folder ? { folder: target.folder } : {}),
      });
    }
    await saveBooks(books);
    return books;
  });
}

function updateBook(id, patch) {
  return serial(async () => {
    const books = await loadBooks();
    const book = books.find((b) => b.id === id);
    if (book) Object.assign(book, patch);
    await saveBooks(books);
    return books;
  });
}

const settings = createSettings({ readJson, writeJson, serial });

const ocr = createOcr({
  getToken: async () => (await settings.ocrToken()).token,
  ocrFile,
  bookFile,
  readJson,
  writeJson,
  getBook: async (id) => (await loadBooks()).find((b) => b.id === id),
  updateBook,
});

const translator = createTranslator({
  getConfig: () => settings.translateConfig(),
  getParsed: (id) => parser.load(id),
  translationFile,
  readJson,
  writeJson,
  getBook: async (id) => (await loadBooks()).find((b) => b.id === id),
  updateBook,
});

const parser = createParser({
  getConfig: () => settings.translateConfig(),
  dir: parsedDir,
  bookFile,
  readJson,
  writeJson,
  getBook: async (id) => (await loadBooks()).find((b) => b.id === id),
  updateBook,
  onReparsed: (id, before, after) => translator.remap(id, before, after),
});

/**
 * Library format 2: books and papers in one list. Books from the old book shelf go
 * into a folder 「书籍」; parses made inside the translation step move to parsed/<id>/.
 * Runs once, before the window opens.
 */
async function migrateLibrary() {
  const lib = await readJson(libraryFile(), {});
  if (lib.version >= 2) return;
  const books = lib.books ?? [];
  const folders = lib.folders ?? [];
  const shelved = books.filter((b) => b.kind !== 'paper');
  if (shelved.length) {
    let folder = folders.find((f) => f.name === '书籍');
    if (!folder) folders.push((folder = { id: crypto.randomUUID(), name: '书籍' }));
    for (const b of shelved) b.folder = folder.id;
  }
  // Each step can run again safely, should an earlier attempt have stopped halfway.
  for (const b of books) {
    delete b.kind;
    const t = await readJson(translationFile(b.id), null);
    if (t?.blocks) {
      await parser.adopt(b.id, t.blocks, t.parsedAt);
      const { blocks, mineruBatch, parsedAt, ...rest } = t;
      const pages = b.pageCount || Math.max(1, ...blocks.flatMap((x) => x.parts.map((p) => p.page)));
      await writeJson(translationFile(b.id), { ...rest, version: 2, ranges: [[1, pages]] });
      if (b.translation?.state === 'done') b.translation.pages = pages;
    } else if (t && t.version !== 2) {
      // Stopped while MinerU was still parsing: that run can't be resumed in the new layout.
      await fs.rm(translationFile(b.id), { force: true });
      delete b.translation;
    }
    const parsed = await parser.load(b.id);
    if (parsed) b.parse = { state: 'done', at: parsed.parsedAt, ...(parsed.legacy && { legacy: true }) };
  }
  await writeJson(libraryFile(), { ...lib, version: 2, books, folders });
}

// ---------- ipc ----------
ipcMain.handle('library:list', () => loadBooks());

ipcMain.handle('library:import', async (e, target) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Import PDF / EPUB',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF / EPUB', extensions: ['pdf', 'epub'] }],
  });
  if (res.canceled) return loadBooks();
  return importPaths(res.filePaths, target);
});

ipcMain.handle('library:importPaths', (_e, paths, target) => importPaths(paths, target));

ipcMain.handle('library:update', (_e, id, patch) => updateBook(id, patch));

ipcMain.handle('library:remove', (_e, id) => {
  ocr.cancel(id);
  parser.cancel(id);
  translator.cancel(id);
  return serial(async () => {
    const books = (await loadBooks()).filter((b) => b.id !== id);
    await saveBooks(books);
    await fs.rm(bookFile(id), { force: true });
    await fs.rm(epubFile(id), { force: true });
    await fs.rm(notesFile(id), { force: true });
    await fs.rm(bookmarksFile(id), { force: true });
    await fs.rm(ocrFile(id), { force: true });
    await fs.rm(annotationsFile(id), { force: true });
    await fs.rm(translationFile(id), { force: true });
    await parser.remove(id);
    return books;
  });
});

// ---------- export ----------

const fileName = (title) => String(title).replace(/[/\\:*?"<>|]/g, '_').trim() || 'export';

/**
 * Asks where to save, then writes what `make()` returns there.
 * Resolves to { path }, { canceled: true }, or { error } with a message for the page.
 */
async function exportFile(e, name, filter, make) {
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [filter],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    await fs.writeFile(res.filePath, await make());
    return { path: res.filePath };
  } catch (err) {
    return { error: err.message };
  }
}

ipcMain.handle('export:pdf', async (e, bookId) => {
  const book = (await loadBooks()).find((b) => b.id === bookId);
  const data = await readJson(ocrFile(bookId), null);
  if (!book || !data?.finishedAt) return { error: '这本书还没有完成 OCR' };
  return exportFile(e, `${fileName(book.title)}（OCR）.pdf`, { name: 'PDF', extensions: ['pdf'] }, async () =>
    exportOcrPdf(await fs.readFile(bookFile(bookId)), data, (done, total) =>
      e.sender.send('export:progress', bookId, { done, total }),
    ),
  );
});

ipcMain.handle('export:md', async (e, bookId) => {
  const book = (await loadBooks()).find((b) => b.id === bookId);
  if (!book) return { error: '找不到这本书' };
  // Checked before the save dialog, so nobody picks a place for a file that can't be made.
  const parsed = await parser.load(bookId);
  if (!parsed) return { error: '还没有解析' };
  if (parsed.legacy) return { error: '这份解析结果是旧版本生成的，没有保存图片，需要重新解析才能导出' };
  const name = fileName(book.title);
  return exportFile(e, `${name}.zip`, { name: 'ZIP', extensions: ['zip'] }, () => parser.exportZip(bookId, name));
});

ipcMain.handle('folders:list', () => loadFolders());

ipcMain.handle('folders:add', (_e, name) =>
  serial(async () => {
    const folders = await loadFolders();
    folders.push({ id: crypto.randomUUID(), name: String(name).trim() || '未命名' });
    await saveFolders(folders);
    return folders;
  }),
);

ipcMain.handle('folders:rename', (_e, id, name) =>
  serial(async () => {
    const folders = await loadFolders();
    const folder = folders.find((f) => f.id === id);
    if (folder && String(name).trim()) folder.name = String(name).trim();
    await saveFolders(folders);
    return folders;
  }),
);

// Papers in a removed folder become uncategorized; the files stay.
ipcMain.handle('folders:remove', (_e, id) =>
  serial(async () => {
    const lib = await loadLibrary();
    const folders = lib.folders.filter((f) => f.id !== id);
    for (const b of lib.books) if (b.folder === id) delete b.folder;
    await writeJson(libraryFile(), { ...lib, folders });
    return { books: lib.books, folders };
  }),
);

ipcMain.handle('book:data', (_e, id) => fs.readFile(bookFile(id)));

ipcMain.handle('notes:list', (_e, bookId) => readJson(notesFile(bookId), null));

ipcMain.handle('notes:save', (_e, bookId, notebook) =>
  serial(() => writeJson(notesFile(bookId), notebook)),
);

ipcMain.handle('bookmarks:list', (_e, bookId) => readJson(bookmarksFile(bookId), null));

ipcMain.handle('bookmarks:save', (_e, bookId, bookmarks) =>
  serial(() => writeJson(bookmarksFile(bookId), bookmarks)),
);

ipcMain.handle('annotations:list', (_e, bookId) => readJson(annotationsFile(bookId), null));

ipcMain.handle('annotations:save', (_e, bookId, annotations) =>
  serial(() => writeJson(annotationsFile(bookId), annotations)),
);

ipcMain.handle('ocr:start', (_e, bookId) => ocr.start(bookId));
ipcMain.handle('ocr:status', () => ocr.status());
ipcMain.handle('ocr:load', (_e, bookId) => readJson(ocrFile(bookId), null));

ipcMain.handle('settings:ocrToken', () => settings.ocrTokenInfo());
// Saved only after the service accepts it. Resolves to an error message, or null.
ipcMain.handle('settings:saveOcrToken', async (_e, token) => {
  const t = String(token ?? '').trim();
  if (!t) return '请先粘贴令牌';
  try {
    const error = await checkToken(t);
    if (error) return error;
    await settings.saveOcrToken(t);
    return null;
  } catch (err) {
    return err.message;
  }
});
ipcMain.handle('settings:clearOcrToken', () => settings.clearOcrToken());

ipcMain.handle('parse:start', (_e, bookId, opts) => parser.start(bookId, opts));
ipcMain.handle('parse:status', () => parser.status());

// `range`: [from, to] pages to translate as well; none carries on with the ranges asked for before.
ipcMain.handle('translate:start', (_e, bookId, range) => translator.start(bookId, range));
ipcMain.handle('translate:estimate', (_e, bookId, from, to) => translator.estimate(bookId, from, to));
ipcMain.handle('translate:status', () => translator.status());
ipcMain.handle('translate:load', (_e, bookId) => translator.load(bookId));
ipcMain.handle('translate:edit', (_e, bookId, id, text) => translator.edit(bookId, id, text));
// Resolves to { piece } or { error }, so the message reaches the page intact.
ipcMain.handle('translate:retranslate', (_e, bookId, id) =>
  translator.retranslate(bookId, id).then((piece) => ({ piece }), (err) => ({ error: err.message })),
);
ipcMain.handle('settings:translateInfo', () => settings.translateInfo());
ipcMain.handle('settings:saveTranslate', async (_e, patch) => {
  try {
    await settings.saveTranslate(patch);
    return null;
  } catch (err) {
    return err.message;
  }
});
// Checks the saved settings, or `draft` values typed but not saved yet. Resolves to an error message, or null.
ipcMain.handle('settings:checkTranslate', async (_e, which, draft = {}) => {
  const saved = await settings.translateConfig();
  const cfg = { ...saved, ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v)) };
  if (which === 'mineru') return cfg.mineruKey ? checkMineru(cfg.mineruKey) : '请先填写 MinerU 密钥';
  if (!cfg.llmBaseUrl || !cfg.llmModel || !cfg.llmKey) return '请先填写接口地址、模型和密钥';
  return checkLlm(cfg);
});

// ---------- window ----------
let quitting = false;
app.on('before-quit', () => (quitting = true));

// Before a window closes, let the page save its debounced edits, then wait for
// every queued write to land on disk.
function flushBeforeClose(win) {
  let flushing = false;
  let ready = false;
  win.on('close', (e) => {
    if (ready) return;
    e.preventDefault();
    if (flushing) return;
    flushing = true;
    const done = () => {
      clearTimeout(timer);
      ipcMain.removeListener('app:flushed', onFlushed);
      queue.finally(() => {
        ready = true;
        win.destroy();
        if (quitting) app.quit();
      });
    };
    const onFlushed = (ev) => ev.sender === win.webContents && done();
    const timer = setTimeout(done, 3000); // never let a stuck page keep the window open
    ipcMain.on('app:flushed', onFlushed);
    win.webContents.send('app:flush');
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : // Windows / Linux: hidden title bar, native controls drawn over the top right.
        { titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#0a0a0a', height: 52 } }),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(DEV_URL) && !url.startsWith('file:')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  flushBeforeClose(win);

  // Undo / redo go to the page, which decides between text fields (native undo)
  // and annotations. Taken here so the Edit menu can't handle them as well.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    if (!(process.platform === 'darwin' ? input.meta : input.control)) return;
    const key = input.key.toLowerCase();
    const action =
      key === 'z' ? (input.shift ? 'redo' : 'undo') : key === 'y' && process.platform !== 'darwin' ? 'redo' : null;
    if (!action) return;
    event.preventDefault();
    win.webContents.send('edit:history', action);
  });

  if (app.isPackaged || process.env.READER_PROD) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    win.loadURL(DEV_URL);
  }
}

app.whenReady().then(async () => {
  // Packaged builds get the icon from the bundle; show it in the Dock during development too.
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  await serial(migrateLibrary).catch((err) =>
    dialog.showErrorBox('书库升级失败', `${err.message}\n\n可以稍后重新打开应用再试，已经升级的部分不会重复处理。`),
  );
  createWindow();
  loadBooks().then((books) => {
    ocr.resume(books);
    parser.resume(books);
    translator.resume(books);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
