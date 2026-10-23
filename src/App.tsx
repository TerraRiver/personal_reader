import { useEffect, useState } from 'react';
import { listenForHistory } from './history';
import Library, { type FolderView } from './pages/Library';
import Reader from './pages/Reader';
import Settings from './pages/Settings';

const FOLDER_KEY = 'reader.shelfFolder';

type View = { page: 'library' } | { page: 'reader'; bookId: string } | { page: 'settings' };

export default function App() {
  const [view, setView] = useState<View>({ page: 'library' });
  // Kept here so closing a book returns to the folder it was opened from.
  const [folder, setFolder] = useState<FolderView>(() => localStorage.getItem(FOLDER_KEY) || 'all');
  const changeFolder = (next: FolderView) => {
    setFolder(next);
    localStorage.setItem(FOLDER_KEY, next);
  };
  const toLibrary = () => setView({ page: 'library' });
  useEffect(listenForHistory, []);

  if (view.page === 'reader') return <Reader key={view.bookId} bookId={view.bookId} onClose={toLibrary} />;
  if (view.page === 'settings') return <Settings onClose={toLibrary} />;
  return (
    <Library
      folder={folder}
      onFolderChange={changeFolder}
      onOpen={(bookId) => setView({ page: 'reader', bookId })} onOpenSettings={() => setView({ page: 'settings' })} />
  );
}
