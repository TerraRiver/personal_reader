import { useEffect, useState } from 'react';
import { listenForHistory } from './history';
import Library, { type Shelf } from './pages/Library';
import Reader from './pages/Reader';
import Settings from './pages/Settings';

const SHELF_KEY = 'reader.shelf';
const FOLDER_KEY = 'reader.shelfFolder';

type View = { page: 'library' } | { page: 'reader'; bookId: string } | { page: 'settings' };

export default function App() {
  const [view, setView] = useState<View>({ page: 'library' });
  // Kept here so closing a book returns to the shelf and folder it was opened from.
  const [shelf, setShelf] = useState<Shelf>(() => ({
    kind: localStorage.getItem(SHELF_KEY) === 'paper' ? 'paper' : 'book',
    folder: localStorage.getItem(FOLDER_KEY) || 'all',
  }));
  const changeShelf = (next: Shelf) => {
    setShelf(next);
    localStorage.setItem(SHELF_KEY, next.kind);
    localStorage.setItem(FOLDER_KEY, next.folder);
  };
  const toLibrary = () => setView({ page: 'library' });
  useEffect(listenForHistory, []);

  if (view.page === 'reader') return <Reader key={view.bookId} bookId={view.bookId} onClose={toLibrary} />;
  if (view.page === 'settings') return <Settings onClose={toLibrary} />;
  return (
    <Library
      shelf={shelf}
      onShelfChange={changeShelf}
      onOpen={(bookId) => setView({ page: 'reader', bookId })} onOpenSettings={() => setView({ page: 'settings' })} />
  );
}
