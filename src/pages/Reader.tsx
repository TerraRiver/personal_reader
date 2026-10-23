import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  api,
  type Annotations,
  type Book,
  type Bookmark,
  type MarkColor,
  type Notebook,
  type OcrData,
  type PaperBlock,
  type ParseProgress,
  type PaperTranslation,
  type StampType,
  type TranslatedPiece,
  type TranslationProgress,
} from '../types';
import { STAMP_SIZE, autoCopyEnabled, isNumberStamp, normalizeAnnotations } from '../annotations';
import { AnnotationOverlay, MarksUnderlay } from '../components/Annotations';
import StampPalette from '../components/StampPalette';
import { setHistoryHandler } from '../history';
import { loadBookmarks } from '../pdf';
import { type NoteView, layout, noteForPage, normalizeNotebook } from '../notes';
import PdfViewer, { type PdfViewerHandle } from '../components/PdfViewer';
import NotesPanel from '../components/NotesPanel';
import BookmarksPanel, { currentBookmark } from '../components/BookmarksPanel';
import TranslationPanel from '../components/TranslationPanel';
import { isMod, shortcut } from '../platform';

const FOLLOW_KEY = 'reader.follow';
const BOOKMARKS_KEY = 'reader.bookmarks';
const STAMP_COLOR_KEY = 'reader.stampColor';
const TRANSLATION_KEY = 'reader.translation';
const TRANSLATION_FOLLOW_KEY = 'reader.translationFollow';

export default function Reader({ bookId, onClose }: { bookId: string; onClose(): void }) {
  const [book, setBook] = useState<Book | null>(null);
  const [data, setData] = useState<Uint8Array | null>(null);
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [follow, setFollow] = useState(() => localStorage.getItem(FOLLOW_KEY) !== '0');
  const [showNotes, setShowNotes] = useState(true);
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [showBookmarks, setShowBookmarks] = useState(() => localStorage.getItem(BOOKMARKS_KEY) === '1');
  const [pageCount, setPageCount] = useState(0);
  const [ocr, setOcr] = useState<OcrData | null>(null);
  const viewer = useRef<PdfViewerHandle>(null);

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

  // ----- hosted OCR text, reloaded whenever a running OCR saves more pages -----
  useEffect(() => {
    let saved = -1;
    const load = () => api().loadOcr(bookId).then((next) => setOcr((prev) => keepPages(prev, next)));
    load();
    return api().onOcrProgress((id, p) => {
      if (id !== bookId || p?.saved == null || p.saved === saved) return;
      saved = p.saved;
      load();
    });
  }, [bookId]);
  const ocrLines = useCallback((p: number) => ocr?.pages[p]?.lines, [ocr]);

  // ----- translation, reloaded as a parse finishes or a running translation saves more -----
  // The translation sits beside the PDF, in the right pane; notes keep the left.
  // Opens by itself only for books that have a translation (unless turned off); the button
  // opens it on any book, e.g. to start parsing.
  const [translationOn, setTranslationOn] = useState<boolean | null>(null);
  const showTranslation =
    !!book && (translationOn ?? (!!book.translation && localStorage.getItem(TRANSLATION_KEY) !== '0'));
  const [translation, setTranslation] = useState<PaperTranslation | null>(null);
  const [tProgress, setTProgress] = useState<TranslationProgress | undefined>();
  const [parseProgress, setParseProgress] = useState<ParseProgress | undefined>();
  const [tFollow, setTFollow] = useState(() => localStorage.getItem(TRANSLATION_FOLLOW_KEY) !== '0');
  const [picked, setPicked] = useState<PaperBlock | null>(null);
  useEffect(() => {
    const load = () => api().loadTranslation(bookId).then(setTranslation);
    const reloadBook = () => api().listBooks().then((books) => setBook((b) => books.find((x) => x.id === bookId) ?? b));
    load();
    api().translationStatus().then((all) => setTProgress(all[bookId]));
    api().parseStatus().then((all) => setParseProgress(all[bookId]));
    const offTranslation = api().onTranslationProgress((id, p) => {
      if (id !== bookId) return;
      setTProgress(p);
      load();
      if (p?.state === 'done' || p?.state === 'failed') reloadBook();
    });
    const offParse = api().onParseProgress((id, p) => {
      if (id !== bookId) return;
      setParseProgress(p);
      if (p?.state === 'done') load();
      if (p?.state === 'done' || p?.state === 'failed') reloadBook();
    });
    return () => {
      offTranslation();
      offParse();
    };
  }, [bookId]);
  const toggleTranslation = () => {
    localStorage.setItem(TRANSLATION_KEY, showTranslation ? '0' : '1');
    setTranslationOn(!showTranslation);
  };
  const pickBlock = useCallback((b: PaperBlock) => {
    setPicked(b);
    viewer.current?.goTo(b.parts[0].page);
  }, []);
  const changePiece = useCallback((id: string, piece: TranslatedPiece) => {
    setTranslation((t) => (t ? { ...t, pieces: { ...t.pieces, [id]: piece } } : t));
  }, []);

  // ----- annotations (saved right away, like bookmarks) -----
  const [annotations, setAnnotations] = useState<Annotations | null>(null);
  const annRef = useRef<Annotations | null>(null);
  useEffect(() => {
    api()
      .listAnnotations(bookId)
      .then((raw) => {
        annRef.current = normalizeAnnotations(raw);
        setAnnotations(annRef.current);
      });
  }, [bookId]);
  const commitAnnotations = useCallback(
    (next: Annotations) => {
      annRef.current = next;
      setAnnotations(next);
      api().saveAnnotations(bookId, next);
    },
    [bookId],
  );

  // Undo history for this reading session. Changes sharing a `group` in quick
  // succession (typing a stamp number digit by digit) undo as one step.
  const history = useRef({ past: [] as Annotations[], future: [] as Annotations[], group: '', at: 0 });
  const changeAnnotations = useCallback(
    (fn: (a: Annotations) => Annotations, group = '') => {
      const prev = annRef.current;
      if (!prev) return;
      const next = fn(prev);
      if (next === prev) return;
      const h = history.current;
      const now = performance.now();
      if (!group || group !== h.group || now - h.at > 1500) {
        h.past.push(prev);
        if (h.past.length > 200) h.past.shift();
      }
      h.future = [];
      h.group = group;
      h.at = now;
      commitAnnotations(next);
    },
    [commitAnnotations],
  );

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1400);
    return () => clearTimeout(t);
  }, [toast]);

  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    setHistoryHandler((action) => {
      const h = history.current;
      const cur = annRef.current;
      const from = action === 'undo' ? h.past : h.future;
      const to = action === 'undo' ? h.future : h.past;
      const target = from.pop();
      if (!cur || !target) {
        setToast(action === 'undo' ? '没有可撤销的操作' : '没有可重做的操作');
        return;
      }
      to.push(cur);
      h.group = '';
      commitAnnotations(target);
      // Show the page the change happened on.
      const p = changedPage(cur, target);
      if (p && p !== pageRef.current) viewer.current?.goTo(p);
      setToast(action === 'undo' ? '已撤销' : '已重做');
    });
    return () => setHistoryHandler(null);
  }, [commitAnnotations]);

  const [placing, setPlacing] = useState<StampType | null>(null);
  const [stampColor, setStampColorState] = useState<MarkColor>(() => {
    try {
      return (localStorage.getItem(STAMP_COLOR_KEY) as MarkColor) || 'red';
    } catch {
      return 'red';
    }
  });
  const setStampColor = (c: MarkColor) => {
    setStampColorState(c);
    try {
      localStorage.setItem(STAMP_COLOR_KEY, c);
    } catch {
      // Remembering the color is a convenience only.
    }
  };
  const [showStamps, setShowStamps] = useState(false);
  const [autoCopy] = useState(autoCopyEnabled);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPlacing(null);
        setShowStamps(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const underlay = useCallback(
    (p: number, w: number, h: number) =>
      annotations && <MarksUnderlay marks={annotations.marks.filter((m) => m.page === p)} width={w} height={h} />,
    [annotations],
  );

  // The translated block picked last, outlined on its page(s); boxes are on a 0–1000 grid.
  const pickedBoxes = useCallback(
    (p: number, w: number, h: number) =>
      picked?.parts
        .filter((part) => part.page === p)
        .map(({ bbox: [x0, y0, x1, y1] }, i) => (
          <div
            key={`pick${i}`}
            className="picked-block"
            style={{ left: (x0 / 1000) * w, top: (y0 / 1000) * h, width: ((x1 - x0) / 1000) * w, height: ((y1 - y0) / 1000) * h }}
          />
        )),
    [picked],
  );

  const annotationOverlay = useCallback(
    (p: number, w: number, h: number) =>
      annotations && (
        <AnnotationOverlay
          key={p}
          page={p}
          width={w}
          height={h}
          marks={annotations.marks.filter((m) => m.page === p)}
          stamps={annotations.stamps.filter((s) => s.page === p)}
          placing={placing}
          autoCopy={autoCopy}
          onAddMark={(m) =>
            changeAnnotations((a) => ({
              ...a,
              marks: [...a.marks, { ...m, id: crypto.randomUUID(), page: p, createdAt: Date.now() }],
            }))
          }
          onUpdateMark={(id, patch) =>
            changeAnnotations((a) => ({ ...a, marks: a.marks.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))
          }
          onDeleteMark={(id) => changeAnnotations((a) => ({ ...a, marks: a.marks.filter((m) => m.id !== id) }))}
          counters={annotations.counters}
          stampColor={stampColor}
          onStampColor={setStampColor}
          onPlaceStamp={(type, x, y) =>
            changeAnnotations((a) => {
              const n = isNumberStamp(type) ? a.counters[type] : undefined;
              return {
                ...a,
                stamps: [
                  ...a.stamps,
                  {
                    id: crypto.randomUUID(),
                    page: p,
                    type,
                    x,
                    y,
                    size: STAMP_SIZE,
                    n,
                    color: stampColor,
                    createdAt: Date.now(),
                  },
                ],
                counters: isNumberStamp(type) ? { ...a.counters, [type]: a.counters[type] + 1 } : a.counters,
              };
            })
          }
          onUpdateStamp={(id, patch, group) =>
            changeAnnotations((a) => {
              const stamps = a.stamps.map((s) => (s.id === id ? { ...s, ...patch } : s));
              // Renumbering the newest stamp of a style moves the sequence along with it.
              const st = stamps.find((s) => s.id === id);
              const newest = st && [...stamps].reverse().find((s) => s.type === st.type);
              const counters =
                st && patch.n && isNumberStamp(st.type) && newest?.id === id
                  ? { ...a.counters, [st.type]: patch.n + 1 }
                  : a.counters;
              return { ...a, stamps, counters };
            }, group)
          }
          onDeleteStamp={(id) => changeAnnotations((a) => ({ ...a, stamps: a.stamps.filter((s) => s.id !== id) }))}
        />
      ),
    [annotations, placing, stampColor, autoCopy, changeAnnotations],
  );
  const overlay = useCallback(
    (p: number, w: number, h: number) => (
      <>
        {annotationOverlay(p, w, h)}
        {showTranslation && pickedBoxes(p, w, h)}
      </>
    ),
    [annotationOverlay, pickedBoxes, showTranslation],
  );

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
  // A jump made from a note (a citation or page link) keeps that note on
  // screen; following resumes with the next page turn.
  const holdNote = useRef(false);
  useEffect(() => {
    if (holdNote.current) {
      holdNote.current = false;
      return;
    }
    if (follow) setActiveId((id) => noteForPage(viewsRef.current, page, id));
  }, [page, follow]);

  // ----- note actions -----
  const selectNote = useCallback(
    (id: string) => {
      setActiveId(id);
      // Following works both ways: with it off, picking a note leaves the PDF alone.
      if (!follow) return;
      const v = views.find((x) => x.seg.id === id);
      // Bring the note's pages into view unless we're already inside its range.
      if (v?.range && (page < v.range.start || page > v.last)) viewer.current?.goTo(v.range.start);
    },
    [views, page, follow],
  );

  const goTo = useCallback((p: number) => viewer.current?.goTo(p), []);
  const pageNow = useRef(page);
  pageNow.current = page;
  const goToFromNote = useCallback(
    (p: number) => {
      const target = Math.min(Math.max(1, p), pageCount || p);
      if (target !== pageNow.current) holdNote.current = true;
      viewer.current?.goTo(target);
    },
    [pageCount],
  );

  const updateBook = useCallback(
    (patch: Partial<Book>) => {
      setBook((b) => (b ? { ...b, ...patch } : b));
      api().updateBook(bookId, patch);
    },
    [bookId],
  );

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
          ← 图书馆
        </button>
        <div className="reader-title">{book?.title}</div>
        <div className="titlebar-actions">
          <button className="link" onClick={() => setShowNotes((s) => !s)} title={shortcut('\\')}>
            {showNotes ? '隐藏笔记' : '显示笔记'}
          </button>
          <button className="link" onClick={toggleTranslation} title="在 PDF 右侧并排显示译文">
            {showTranslation ? '隐藏译文' : '显示译文'}
          </button>
        </div>
      </div>

      <div className="reader-body">
        {showNotes && notebook && book && (
          <>
            {/* Equal shares, not adjustable: a third each with the translation open, otherwise a half. */}
            <section className="pane pane-notes" style={{ width: showTranslation ? `${100 / 3}%` : '50%' }}>
              <NotesPanel
                notebook={notebook}
                activeId={activeId}
                currentPage={page}
                views={views}
                follow={follow}
                onFollowChange={changeFollow}
                onSelect={selectNote}
                onEdit={edit}
                onGoTo={goToFromNote}
                book={book}
                onUpdateBook={updateBook}
              />
            </section>
            <div className="pane-rule" />
          </>
        )}
        <section className="pane pane-pdf">
          {toast && <div className="toast">{toast}</div>}
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
              underlay={underlay}
              overlay={overlay}
              onLoad={onLoad}
              barStart={
                <>
                  <button className={`link${showBookmarks ? ' on' : ''}`} onClick={toggleBookmarks} title={shortcut('B')}>
                    书签<span className="count-badge">{String(bookmarks?.length ?? 0).padStart(2, '0')}</span>
                  </button>
                  <span className="stamp-anchor">
                    <button
                      className={`link stamp-toggle${showStamps || placing ? ' on' : ''}`}
                      onClick={() => {
                        setShowStamps((s) => !s);
                        if (showStamps) setPlacing(null);
                      }}
                    >
                      图章
                    </button>
                    {showStamps && annotations && (
                      <StampPalette
                        counters={annotations.counters}
                        placing={placing}
                        color={stampColor}
                        onColor={setStampColor}
                        onPick={setPlacing}
                        onCounter={(t, n) =>
                          changeAnnotations(
                            (a) => ({ ...a, counters: { ...a.counters, [t]: Math.max(1, n) } }),
                            `counter:${t}`,
                          )
                        }
                        onClose={() => {
                          setShowStamps(false);
                          setPlacing(null);
                        }}
                      />
                    )}
                  </span>
                </>
              }
              barCenter={section?.title}
              onPageChange={setPage}
            />
          ) : (
            <div className="loading muted">加载中…</div>
          )}
          {showTranslation && book && (
            <>
              <div className="pane-rule" />
              <section className="pane-translation">
                <TranslationPanel
                  book={book}
                  translation={translation}
                  progress={tProgress}
                  parseProgress={parseProgress}
                  currentPage={page}
                  follow={tFollow}
                  onFollowChange={(f) => {
                    setTFollow(f);
                    localStorage.setItem(TRANSLATION_FOLLOW_KEY, f ? '1' : '0');
                  }}
                  selected={picked?.id ?? null}
                  onSelect={pickBlock}
                  onPiece={changePiece}
                />
              </section>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** The page of the first mark or stamp that differs between two states. */
function changedPage(a: Annotations, b: Annotations): number | null {
  for (const key of ['marks', 'stamps'] as const) {
    const before = new Map<string, { page: number }>(a[key].map((x) => [x.id, x]));
    const after = new Map<string, { page: number }>(b[key].map((x) => [x.id, x]));
    for (const [id, x] of before) if (!after.has(id) || after.get(id) !== x) return x.page;
    for (const [id, x] of after) if (!before.has(id)) return x.page;
  }
  return null;
}

/**
 * The new OCR data, reusing the line lists of pages already loaded, so pages
 * on screen aren't redrawn (and a selection on them survives) as more arrive.
 */
function keepPages(prev: OcrData | null, next: OcrData | null): OcrData | null {
  if (!prev || !next) return next;
  const pages = { ...next.pages };
  for (const k of Object.keys(pages)) if (prev.pages[k]) pages[k] = prev.pages[k];
  return { ...next, pages };
}
