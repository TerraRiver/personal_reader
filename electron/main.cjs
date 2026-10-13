const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const DEV_URL = 'http://localhost:5173';

// Lets development/testing point at a throwaway data directory.
if (process.env.READER_DATA_DIR) app.setPath('userData', process.env.READER_DATA_DIR);

// ---------- storage ----------
// <userData>/library/library.json   book metadata
// <userData>/library/books/<id>.pdf copied pdf files
// <userData>/library/notes/<id>.json notes of one book
// <userData>/library/bookmarks/<id>.json bookmarks of one book

const root = () => path.join(app.getPath('userData'), 'library');
const libraryFile = () => path.join(root(), 'library.json');
const bookFile = (id) => path.join(root(), 'books', `${id}.pdf`);
const notesFile = (id) => path.join(root(), 'notes', `${id}.json`);
const bookmarksFile = (id) => path.join(root(), 'bookmarks', `${id}.json`);

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

const loadBooks = async () => (await readJson(libraryFile(), { books: [] })).books;
const saveBooks = (books) => writeJson(libraryFile(), { books });

async function importPaths(paths) {
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
      });
    }
    await saveBooks(books);
    return books;
  });
}

// ---------- ipc ----------
ipcMain.handle('library:list', () => loadBooks());

ipcMain.handle('library:import', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Import PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled) return loadBooks();
  return importPaths(res.filePaths);
});

ipcMain.handle('library:importPaths', (_e, paths) => importPaths(paths));

ipcMain.handle('library:update', (_e, id, patch) =>
  serial(async () => {
    const books = await loadBooks();
    const book = books.find((b) => b.id === id);
    if (book) Object.assign(book, patch);
    await saveBooks(books);
    return books;
  }),
);

ipcMain.handle('library:remove', (_e, id) =>
  serial(async () => {
    const books = (await loadBooks()).filter((b) => b.id !== id);
    await saveBooks(books);
    await fs.rm(bookFile(id), { force: true });
    await fs.rm(notesFile(id), { force: true });
    await fs.rm(bookmarksFile(id), { force: true });
    return books;
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
