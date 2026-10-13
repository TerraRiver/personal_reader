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
  onBeforeClose: (fn) => {
    flushers.add(fn);
    return () => flushers.delete(fn);
  },
});
