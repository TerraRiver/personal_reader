import { useState } from 'react';
import Library from './pages/Library';
import Reader from './pages/Reader';

export default function App() {
  const [bookId, setBookId] = useState<string | null>(null);

  return bookId ? (
    <Reader key={bookId} bookId={bookId} onClose={() => setBookId(null)} />
  ) : (
    <Library onOpen={setBookId} />
  );
}
