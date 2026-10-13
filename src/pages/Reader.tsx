import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { api, type Book, type Bookmark, type Notebook, type OcrData } from '../types';
import { loadBookmarks } from '../pdf';
import { type NoteView, layout, noteForPage, normalizeNotebook } from '../notes';
import PdfViewer, { type PdfViewerHandle } from '../components/PdfViewer';
import NotesPanel from '../components/NotesPanel';
import BookmarksPanel, { currentBookmark } from '../components/BookmarksPanel';
import { isMod, shortcut } from '../platform';

const SPLIT_KEY = 'reader.split';
const FOLLOW_KEY = 'reader.follow';
const BOOKMARKS_KEY = 'reader.bookmarks';

export default function Reader({ bookId, onClose }: { bookId: string; onClose(): void }) {
  const [book, setBook] = useState<Book | null>(null);
  const [data, setData] = useState<Uint8Array | null>(null);
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [split, setSplit] = useState(() => Number(localStorage.getItem(SPLIT_KEY)) || 0.38);
  const [follow, setFollow] = useState(() => localStorage.getItem(FOLLOW_KEY) !== '0');
  const [showNotes, setShowNotes] = useState(true);
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [showBookmarks, setShowBookmarks] = useState(() => localStorage.getItem(BOOKMARKS_KEY) === '1');
  const [pageCount, setPageCount] = useState(0);
  const [ocr, setOcr] = useState<OcrData | null>(null);
  const viewer = useRef<PdfViewerHandle>(null);
  const body = useRef<HTMLDivElement>(null);

  // ----- load -----
  useEffect(() => {
    (async () => {
      const books = await api().listBooks();
      const b = books.find((x) => x.id === bookId) ?? null;
      setBook(b);
      if (!b) return;
      const start = b.lastPage || 1;
      setPage(start);
      const [bytes, raw] = await Promise.all([api().readBook(bookId), api().listNotes(bookId)]);
      const nb = normalizeNotebook(raw);
      setNotebook(nb);
      setActiveId(noteForPage(layout(nb.segments), start, null));
      setData(bytes);
      api().updateBook(bookId, { openedAt: Date.now() });
    })();
  }, [bookId]);

  // ----- hosted OCR text, reloaded when a run for this book finishes -----
  useEffect(() => {
    api().loadOcr(bookId).then(setOcr);
    return api().onOcrProgress((id, p) => {
      if (id === bookId && p?.state === 'done') api().loadOcr(bookId).then(setOcr);
    });
  }, [bookId]);
  const ocrLines = useCallback((p: number) => ocr?.pages[p]?.lines, [ocr]);

  // ----- persist notes and reading position -----
  // Writes are debounced, and whatever is still pending is flushed when leaving
  // the book or closing the window.
  const pending = useRef<Notebook | null>(null);
  const pendingPage = useRef<number | null>(null);
  const flush = useCallback(() => {
    const writes: Promise<unknown>[] = [];
    if (pending.current) writes.push(api().saveNotes(bookId, pending.current));
    if (pendingPage.current !== null) writes.push(api().updateBook(bookId, { lastPage: pendingPage.current }));
    pending.current = null;
    pendingPage.current = null;
    return Promise.all(writes);
  }, [bookId]);
  useEffect(() => () => void flush(), [flush]);
  useEffect(() => api().onBeforeClose(flush), [flush]);

  useEffect(() => {
    if (!book) return;
    pendingPage.current = page;
    const t = setTimeout(flush, 600);
    return () => clearTimeout(t);
  }, [page, book, flush]);

  // Only user edits mark notes dirty, so loading them never triggers a write.
  const dirty = useRef(false);
  const edit = useCallback((next: Notebook, nextActive?: string | null) => {
    dirty.current = true;
    setNotebook(next);
    if (nextActive !== undefined) setActiveId(nextActive);
  }, []);
  useEffect(() => {
    if (!dirty.current || !notebook) return;
    pending.current = notebook;
    const t = setTimeout(flush, 400);
    return () => clearTimeout(t);
  }, [notebook, flush]);

  // ----- follow the PDF -----
  const views = useMemo(() => layout(notebook?.segments ?? []), [notebook]);
  const viewsRef = useRef<NoteView[]>([]);
  viewsRef.current = views;
  useEffect(() => {
    if (follow) setActiveId((id) => noteForPage(viewsRef.current, page, id));
  }, [page, follow]);

  // ----- note actions -----
  const selectNote = useCallback(
    (id: string) => {
      setActiveId(id);
      const v = views.find((x) => x.seg.id === id);
      // Bring the note's pages into view unless we're already inside its range.
      if (v?.range && (page < v.range.start || page > v.last)) viewer.current?.goTo(v.range.start);
    },
    [views, page],
  );

  const goTo = useCallback((p: number) => viewer.current?.goTo(p), []);

  const onLoad = useCallback(
    (doc: PDFDocumentProxy) => {
      setPageCount(doc.numPages);
      if (book && book.pageCount !== doc.numPages) api().updateBook(bookId, { pageCount: doc.numPages });
      loadBookmarks(bookId, doc).then(setBookmarks);
    },
    [book, bookId],
  );

  // ----- bookmarks (saved right away; they change rarely) -----
  const changeBookmarks = useCallback(
    (next: Bookmark[]) => {
      setBookmarks(next);
      api().saveBookmarks(bookId, next);
      api().updateBook(bookId, { bookmarkCount: next.length });
    },
    [bookId],
  );

  const toggleBookmarks = useCallback(() => {
    setShowBookmarks((s) => {
      localStorage.setItem(BOOKMARKS_KEY, s ? '0' : '1');
      return !s;
    });
  }, []);

  const changeFollow = (f: boolean) => {
    setFollow(f);
    localStorage.setItem(FOLLOW_KEY, f ? '1' : '0');
    if (f) setActiveId((id) => noteForPage(viewsRef.current, page, id));
  };

  // ----- split divider -----
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = body.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      setSplit(Math.min(0.7, Math.max(0.2, (ev.clientX - rect.left) / rect.width)));
    };
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSplit((r) => {
        localStorage.setItem(SPLIT_KEY, String(r));
        return r;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ⌘\ / Ctrl+\ toggles the notes pane, ⌘B / Ctrl+B the bookmarks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMod(e) && e.key === '\\') {
        e.preventDefault();
        setShowNotes((s) => !s);
      }
      if (isMod(e) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleBookmarks();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleBookmarks]);

  const section = bookmarks?.[currentBookmark(bookmarks, page)];
  const startPages = views.flatMap((v) => (v.range ? [v.range.start] : []));
  const cutPages = views.flatMap((v) => (v.range?.end != null ? [v.range.end] : []));

  return (
    <div className="reader">
      <div className="titlebar reader-titlebar">
        <button className="link back" onClick={onClose}>
          ← 书库
        </button>
        <div className="reader-title">{book?.title}</div>
        <button className="link" onClick={() => setShowNotes((s) => !s)} title={shortcut('\\')}>
          {showNotes ? '隐藏笔记' : '显示笔记'}
        </button>
      </div>

      <div className="reader-body" ref={body}>
        {showNotes && notebook && (
          <>
            <section className="pane pane-notes" style={{ width: `${split * 100}%` }}>
              <NotesPanel
                notebook={notebook}
                activeId={activeId}
                currentPage={page}
                views={views}
                follow={follow}
                onFollowChange={changeFollow}
                onSelect={selectNote}
                onEdit={edit}
                onGoTo={goTo}
              />
            </section>
            <div className="divider" onPointerDown={startDrag} />
          </>
        )}
        <section className="pane pane-pdf">
          {showBookmarks && bookmarks && (
            <BookmarksPanel
              bookmarks={bookmarks}
              currentPage={page}
              pageCount={pageCount}
              onChange={changeBookmarks}
              onGoTo={goTo}
            />
          )}
          {data && book ? (
            <PdfViewer
              ref={viewer}
              data={data}
              initialPage={book.lastPage || 1}
              startPages={startPages}
              cutPages={cutPages}
              ocrLines={ocrLines}
              onLoad={onLoad}
              barStart={
                <button className={`link${showBookmarks ? ' on' : ''}`} onClick={toggleBookmarks} title={shortcut('B')}>
                  书签<span className="count-badge">{String(bookmarks?.length ?? 0).padStart(2, '0')}</span>
                </button>
              }
              barCenter={section?.title}
              onPageChange={setPage}
            />
          ) : (
            <div className="loading muted">加载中…</div>
          )}
        </section>
      </div>
    </div>
  );
}
