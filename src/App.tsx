import { useState } from 'react';
import Library from './pages/Library';
import Reader from './pages/Reader';
import Settings from './pages/Settings';

type View = { page: 'library' } | { page: 'reader'; bookId: string } | { page: 'settings' };

export default function App() {
  const [view, setView] = useState<View>({ page: 'library' });
  const toLibrary = () => setView({ page: 'library' });

  if (view.page === 'reader') return <Reader key={view.bookId} bookId={view.bookId} onClose={toLibrary} />;
  if (view.page === 'settings') return <Settings onClose={toLibrary} />;
  return (
    <Library onOpen={(bookId) => setView({ page: 'reader', bookId })} onOpenSettings={() => setView({ page: 'settings' })} />
  );
}
