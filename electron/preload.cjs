const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Callbacks that save pending edits before the window closes.
const flushers = new Set();
ipcRenderer.on('app:flush', async () => {
  await Promise.allSettled([...flushers].map((fn) => fn()));
  ipcRenderer.send('app:flushed');
});

contextBridge.exposeInMainWorld('api', {
  listBooks: () => ipcRenderer.invoke('library:list'),
  importBooks: () => ipcRenderer.invoke('library:import'),
  importFiles: (files) =>
    ipcRenderer.invoke('library:importPaths', files.map((f) => webUtils.getPathForFile(f))),
  updateBook: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
  readBook: (id) => ipcRenderer.invoke('book:data', id),
  listNotes: (bookId) => ipcRenderer.invoke('notes:list', bookId),
  saveNotes: (bookId, notebook) => ipcRenderer.invoke('notes:save', bookId, notebook),
  listBookmarks: (bookId) => ipcRenderer.invoke('bookmarks:list', bookId),
  saveBookmarks: (bookId, bookmarks) => ipcRenderer.invoke('bookmarks:save', bookId, bookmarks),
  startOcr: (bookId) => ipcRenderer.invoke('ocr:start', bookId),
  ocrStatus: () => ipcRenderer.invoke('ocr:status'),
  loadOcr: (bookId) => ipcRenderer.invoke('ocr:load', bookId),
  ocrTokenInfo: () => ipcRenderer.invoke('settings:ocrToken'),
  saveOcrToken: (token) => ipcRenderer.invoke('settings:saveOcrToken', token),
  clearOcrToken: () => ipcRenderer.invoke('settings:clearOcrToken'),
  onOcrProgress: (fn) => {
    const listener = (_e, bookId, progress) => fn(bookId, progress);
    ipcRenderer.on('ocr:progress', listener);
    return () => ipcRenderer.removeListener('ocr:progress', listener);
  },
  onBeforeClose: (fn) => {
    flushers.add(fn);
    return () => flushers.delete(fn);
  },
});
