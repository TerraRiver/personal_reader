const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createOcr, checkToken } = require('./ocr.cjs');
const { createTranslator, checkMineru, checkLlm } = require('./translate.cjs');
const createSettings = require('./settings.cjs');

const DEV_URL = 'http://localhost:5173';

// Lets development/testing point at a throwaway data directory.
if (process.env.READER_DATA_DIR) app.setPath('userData', process.env.READER_DATA_DIR);

// ---------- storage ----------
// <userData>/library/library.json   book and paper metadata, paper folders
// <userData>/library/books/<id>.pdf copied pdf files
// <userData>/library/notes/<id>.json notes of one book
// <userData>/library/bookmarks/<id>.json bookmarks of one book
// <userData>/library/ocr/<id>.json       hosted OCR results of one book
// <userData>/library/annotations/<id>.json  highlights and stamps of one book
// <userData>/library/translations/<id>.json paper translation: parsed blocks and their translations

const root = () => path.join(app.getPath('userData'), 'library');
const libraryFile = () => path.join(root(), 'library.json');

// Ids come from the page. Only ids made here (UUIDs) may name a file, so no
// id can point outside the library, e.g. with "../".
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileOf = (dir, ext) => (id) => {
  if (!ID.test(id)) throw new Error(`无效的编号：${id}`);
  return path.join(root(), dir, `${id}.${ext}`);
};
const bookFile = fileOf('books', 'pdf');
const notesFile = fileOf('notes', 'json');
const bookmarksFile = fileOf('bookmarks', 'json');
const ocrFile = fileOf('ocr', 'json');
const annotationsFile = fileOf('annotations', 'json');
const translationFile = fileOf('translations', 'json');

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
    // Attached to the window as a sheet, so it never blocks the app.
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      type: 'warning',
      message: '数据文件已损坏',
      detail: `无法读取 ${path.basename(file)}，原文件已备份为：\n${backup}`,
    };
    if (win) dialog.showMessageBox(win, opts);
    else dialog.showMessageBox(opts);
    return fallback;
  }
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

// Books and papers share one list (`kind` tells them apart); papers can sit in a folder.
const loadLibrary = async () => {
  const lib = await readJson(libraryFile(), {});
  return { books: lib.books ?? [], folders: lib.folders ?? [] };
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

/** `target` says where new files go: { kind: 'book' | 'paper', folder?: id }. */
async function importPaths(paths, target = {}) {
  const kind = target.kind === 'paper' ? 'paper' : 'book';
  return serial(async () => {
    const books = await loadBooks();
    await fs.mkdir(path.join(root(), 'books'), { recursive: true });
    for (const p of paths) {
      if (path.extname(p).toLowerCase() !== '.pdf') continue;
      const id = crypto.randomUUID();
      await fs.copyFile(p, bookFile(id));
      books.unshift({
        id,
        title: path.basename(p, path.extname(p)),
        pageCount: 0,
        lastPage: 1,
        addedAt: Date.now(),
        openedAt: null,
        kind,
        ...(kind === 'paper' && target.folder ? { folder: target.folder } : {}),
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
  translationFile,
  bookFile,
  readJson,
  writeJson,
  getBook: async (id) => (await loadBooks()).find((b) => b.id === id),
  updateBook,
});

// ---------- ipc ----------
ipcMain.handle('library:list', () => loadBooks());

ipcMain.handle('library:import', async (e, target) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Import PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled) return loadBooks();
  return importPaths(res.filePaths, target);
});

ipcMain.handle('library:importPaths', (_e, paths, target) => importPaths(paths, target));

ipcMain.handle('library:update', (_e, id, patch) => updateBook(id, patch));

ipcMain.handle('library:remove', (_e, id) => {
  ocr.cancel(id);
  translator.cancel(id);
  return serial(async () => {
    const books = (await loadBooks()).filter((b) => b.id !== id);
    await saveBooks(books);
    await fs.rm(bookFile(id), { force: true });
    await fs.rm(notesFile(id), { force: true });
    await fs.rm(bookmarksFile(id), { force: true });
    await fs.rm(ocrFile(id), { force: true });
    await fs.rm(annotationsFile(id), { force: true });
    await fs.rm(translationFile(id), { force: true });
    return books;
  });
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

ipcMain.handle('translate:start', (_e, bookId) => translator.start(bookId));
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

app.whenReady().then(() => {
  // Packaged builds get the icon from the bundle; show it in the Dock during development too.
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  createWindow();
  loadBooks().then((books) => {
    ocr.resume(books);
    translator.resume(books);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
