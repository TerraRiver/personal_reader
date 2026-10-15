const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Callbacks that save pending edits before the window closes.
const flushers = new Set();
ipcRenderer.on('app:flush', async () => {
  await Promise.allSettled([...flushers].map((fn) => fn()));
  ipcRenderer.send('app:flushed');
});

contextBridge.exposeInMainWorld('api', {
  listBooks: () => ipcRenderer.invoke('library:list'),
  importBooks: (target) => ipcRenderer.invoke('library:import', target),
  importFiles: (files, target) =>
    ipcRenderer.invoke('library:importPaths', files.map((f) => webUtils.getPathForFile(f)), target),
  updateBook: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
  listFolders: () => ipcRenderer.invoke('folders:list'),
  addFolder: (name) => ipcRenderer.invoke('folders:add', name),
  renameFolder: (id, name) => ipcRenderer.invoke('folders:rename', id, name),
  removeFolder: (id) => ipcRenderer.invoke('folders:remove', id),
  readBook: (id) => ipcRenderer.invoke('book:data', id),
  listNotes: (bookId) => ipcRenderer.invoke('notes:list', bookId),
  saveNotes: (bookId, notebook) => ipcRenderer.invoke('notes:save', bookId, notebook),
  listBookmarks: (bookId) => ipcRenderer.invoke('bookmarks:list', bookId),
  saveBookmarks: (bookId, bookmarks) => ipcRenderer.invoke('bookmarks:save', bookId, bookmarks),
  listAnnotations: (bookId) => ipcRenderer.invoke('annotations:list', bookId),
  saveAnnotations: (bookId, annotations) => ipcRenderer.invoke('annotations:save', bookId, annotations),
  startOcr: (bookId) => ipcRenderer.invoke('ocr:start', bookId),
  ocrStatus: () => ipcRenderer.invoke('ocr:status'),
  loadOcr: (bookId) => ipcRenderer.invoke('ocr:load', bookId),
  ocrTokenInfo: () => ipcRenderer.invoke('settings:ocrToken'),
  saveOcrToken: (token) => ipcRenderer.invoke('settings:saveOcrToken', token),
  clearOcrToken: () => ipcRenderer.invoke('settings:clearOcrToken'),
  startTranslation: (bookId) => ipcRenderer.invoke('translate:start', bookId),
  translationStatus: () => ipcRenderer.invoke('translate:status'),
  loadTranslation: (bookId) => ipcRenderer.invoke('translate:load', bookId),
  editTranslation: (bookId, id, text) => ipcRenderer.invoke('translate:edit', bookId, id, text),
  retranslatePiece: (bookId, id) => ipcRenderer.invoke('translate:retranslate', bookId, id),
  translateInfo: () => ipcRenderer.invoke('settings:translateInfo'),
  saveTranslateSettings: (patch) => ipcRenderer.invoke('settings:saveTranslate', patch),
  checkTranslateSettings: (which, draft) => ipcRenderer.invoke('settings:checkTranslate', which, draft),
  onTranslationProgress: (fn) => {
    const listener = (_e, bookId, progress) => fn(bookId, progress);
    ipcRenderer.on('translate:progress', listener);
    return () => ipcRenderer.removeListener('translate:progress', listener);
  },
  onOcrProgress: (fn) => {
    const listener = (_e, bookId, progress) => fn(bookId, progress);
    ipcRenderer.on('ocr:progress', listener);
    return () => ipcRenderer.removeListener('ocr:progress', listener);
  },
  onEditHistory: (fn) => {
    const listener = (_e, action) => fn(action);
    ipcRenderer.on('edit:history', listener);
    return () => ipcRenderer.removeListener('edit:history', listener);
  },
  onBeforeClose: (fn) => {
    flushers.add(fn);
    return () => flushers.delete(fn);
  },
});
