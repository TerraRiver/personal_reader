import { useEffect, useRef, useState } from 'react';
import {
  api,
  type Book,
  type ExportResult,
  type Folder,
  type OcrProgress,
  type ParseProgress,
  type TextLayerKind,
  type TranslationProgress,
} from '../types';
import { analyzeBook } from '../pdf';
import { ConfirmDialog, RANGE_PAGES, TranslateDialog, startTranslation } from '../components/RunDialogs';

const pad = (n: number) => String(n).padStart(2, '0');

const TEXT_LABEL: Record<TextLayerKind, string> = { native: '原生文字', ocr: '已 OCR', none: '未 OCR' };
const TEXT_HINT: Record<TextLayerKind, string> = {
  native: '电子版 PDF，文字可选中、可搜索',
  ocr: '扫描版，已有 OCR 文字层，可选中、可搜索',
  none: '扫描版，没有文字层，文字无法选中或搜索',
};

function formatDate(ts: number | null) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/** The text column: what the PDF has, or the state of a hosted OCR run. */
function TextCell({
  book,
  live,
  detectFailed,
  hasToken,
  onOpenSettings,
}: {
  book: Book;
  live?: OcrProgress;
  detectFailed: boolean;
  hasToken: boolean;
  onOpenSettings(): void;
}) {
  // Without a token, OCR leads to the settings, where the guide is.
  const start = () => (hasToken ? api().startOcr(book.id) : onOpenSettings());
  if (live?.state === 'queued') return <span className="muted">等待 OCR…</span>;
  if (live?.state === 'running' || (!live && book.ocr?.state === 'running'))
    return (
      <span className="muted ocr-progress">
        OCR 中 {live?.total ? `${live.done ?? 0}/${live.total}` : '…'}
      </span>
    );
  if (book.ocr?.state === 'done' && live?.state !== 'failed')
    return (
      <span className="tag tag-ocr" title={`${book.ocr.model ?? '飞桨'} 识别，文字可选中、复制`}>
        已 OCR
      </span>
    );
  if (live?.state === 'failed' || book.ocr?.state === 'failed') {
    const error = live?.error ?? book.ocr?.error ?? '';
    return (
      <>
        <span className="ocr-failed" title={error}>
          OCR 失败
        </span>
        {/令牌/.test(error) ? (
          <button className="link small" onClick={onOpenSettings} title={error}>
            设置令牌
          </button>
        ) : (
          <button className="link small" onClick={start} title="从中断处继续">
            重试
          </button>
        )}
      </>
    );
  }
  if (!book.textLayer) return <span className="muted">{detectFailed ? '无法检测' : '检测中…'}</span>;
  return (
    <>
      <span
        className={`tag tag-${book.textLayer}`}
        title={book.format === 'epub' ? '由 EPUB 排成的 A5 PDF，文字可选中、可搜索' : TEXT_HINT[book.textLayer]}
      >
        {TEXT_LABEL[book.textLayer]}
      </span>
      {book.textLayer === 'none' && (
        <button
          className="link small"
          onClick={start}
          title={hasToken ? '用飞桨 PP-OCRv6 识别文字，让扫描页可选中、复制' : '需要先设置飞桨访问令牌'}
        >
          OCR
        </button>
      )}
    </>
  );
}

/** The structure column: a MinerU parse, its progress, or the button to start one. */
function ParseCell({ book, live, onStart }: { book: Book; live?: ParseProgress; onStart(): void }) {
  if (live?.state === 'queued') return <span className="muted">等待解析…</span>;
  if (live?.state === 'parsing' || (!live && book.parse?.state === 'running'))
    return (
      <span className="muted ocr-progress">
        解析中 {live?.total ? `${live.done ?? 0}/${live.total} 页` : '…'}
      </span>
    );
  if (book.parse?.state === 'done' && live?.state !== 'failed')
    return (
      <span
        className="tag tag-ocr"
        title={book.parse.legacy ? '旧版本解析的结果，没有保存图片；导出 .md 前需要重新解析' : 'MinerU 解析出标题、段落、注释、表格、公式和图片'}
      >
        已解析
      </span>
    );
  if (live?.state === 'failed' || book.parse?.state === 'failed') {
    const error = live?.error ?? book.parse?.error ?? '';
    return (
      <>
        <span className="ocr-failed" title={error}>
          解析失败
        </span>
        <button className="link small" onClick={() => api().startParse(book.id)} title={`${error}\n从中断处继续`}>
          重试
        </button>
      </>
    );
  }
  return (
    <button className="link small" onClick={onStart} title="用 MinerU 解析出标题、段落、注释、表格、公式和图片">
      解析
    </button>
  );
}

/** The translation column: start it, how far it got, or carry on with more pages. */
function TranslateCell({
  book,
  live,
  onStart,
  onMore,
  onOpen,
}: {
  book: Book;
  live?: TranslationProgress;
  onStart(): void;
  onMore(): void;
  onOpen(): void;
}) {
  if (live?.state === 'queued') return <span className="muted">等待翻译…</span>;
  if (live?.state === 'translating')
    return <span className="muted ocr-progress">翻译中 {live.done ?? 0}/{live.total ?? '…'}</span>;
  if (!live && book.translation?.state === 'running') return <span className="muted">翻译中…</span>;
  if (live?.state === 'done' || (book.translation?.state === 'done' && live?.state !== 'failed')) {
    const pages = book.translation?.pages ?? 0;
    const partial = book.pageCount > 0 && pages > 0 && pages < book.pageCount;
    return (
      <>
        <button className="tag tag-ocr tag-button" onClick={onOpen} title="打开阅读器查看译文">
          {partial ? `已译 ${pages}/${book.pageCount} 页` : '已翻译'}
        </button>
        {partial && (
          <button className="link small" onClick={onMore} title="选择接下来要翻译的页">
            继续
          </button>
        )}
      </>
    );
  }
  if (live?.state === 'failed' || book.translation?.state === 'failed') {
    const error = live?.error ?? book.translation?.error ?? '';
    return (
      <>
        <span className="ocr-failed" title={error}>
          翻译失败
        </span>
        <button className="link small" onClick={() => api().startTranslation(book.id)} title={`${error}\n从中断处继续`}>
          重试
        </button>
      </>
    );
  }
  return (
    <button className="link small" onClick={onStart} title="大模型逐段翻译成中文；翻译前需要先解析">
      翻译
    </button>
  );
}

/** Which folder is shown: all, uncategorized, or a folder id. */
export type FolderView = 'all' | 'none' | string;

/** Set on rows dragged onto a folder; files dragged in from outside carry 'Files' instead. */
const BOOK_MIME = 'application/x-reader-book';

const MinusIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** A writing brush: handle, ferrule and a pointed tuft. */
const BrushIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M14.2 1.8 8.6 7.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="m7.6 7.1 1.3 1.3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    <path d="M7.2 8.8c-1.7-.2-3 .9-3.2 2.6-.1 1-.6 1.8-2.2 2.6 3.3.6 6.4-.7 6.7-3.6l-1.3-1.6Z" fill="currentColor" />
  </svg>
);

/** The folders. Rows are dragged onto a folder to file them. */
function FolderList({
  books,
  folders,
  current,
  onSelect,
  onFolders,
  onBooks,
  onDropFiles,
  draggingRow,
}: {
  books: Book[];
  folders: Folder[];
  current: FolderView;
  onSelect(folder: FolderView): void;
  onFolders(folders: Folder[]): void;
  onBooks(books: Book[]): void;
  onDropFiles(e: React.DragEvent, folder: string | null): void;
  /** A row of the list is being dragged. */
  draggingRow: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // A delete is armed by the first click on the minus and done by the second.
  const [armedId, setArmedId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const known = new Set(folders.map((f) => f.id));
  const count = (folder: FolderView) =>
    folder === 'all'
      ? books.length
      : folder === 'none'
        ? books.filter((p) => !p.folder || !known.has(p.folder)).length
        : books.filter((p) => p.folder === folder).length;

  const add = async (name: string) => {
    setAdding(false);
    if (!name.trim()) return;
    const next = await api().addFolder(name);
    onFolders(next);
    onSelect(next[next.length - 1].id);
  };
  const rename = async (id: string, name: string) => {
    setEditingId(null);
    if (name.trim()) onFolders(await api().renameFolder(id, name));
  };
  const remove = async (id: string) => {
    setArmedId(null);
    const res = await api().removeFolder(id);
    onFolders(res.folders);
    onBooks(res.books);
    if (current === id) onSelect('all');
  };

  // Dropping a row files it; dropping PDFs from outside imports them straight into the folder.
  const dropProps = (folder: FolderView) =>
    folder === 'all'
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(BOOK_MIME) && !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setOver(folder);
          },
          onDragLeave: () => setOver((o) => (o === folder ? null : o)),
          onDrop: async (e: React.DragEvent) => {
            setOver(null);
            e.preventDefault();
            e.stopPropagation();
            const target = folder === 'none' ? null : folder;
            const id = e.dataTransfer.getData(BOOK_MIME);
            if (id) onBooks(await api().updateBook(id, { folder: target }));
            else onDropFiles(e, target);
          },
        };

  const item = (folder: FolderView, label: React.ReactNode, tools?: React.ReactNode) => (
    <li
      key={folder}
      className={`folder${current === folder ? ' on' : ''}${over === folder ? ' over' : ''}${armedId === folder ? ' armed' : ''}`}
      onClick={() => onSelect(folder)}
      onMouseLeave={() => setArmedId((a) => (a === folder ? null : a))}
      {...dropProps(folder)}
    >
      <span className="folder-name">{label}</span>
      <span className="folder-count">{count(folder)}</span>
      {tools}
    </li>
  );

  return (
    <nav className="folders">
      <div className="folders-head">
        <span>分类</span>
        <button className="folder-add" onClick={() => setAdding(true)} title="新建分类。把书拖到分类上即可归类">
          +
        </button>
      </div>
      <ul>
        {item('all', '全部')}
        {/* Shown when it holds something, or as a drop target while a book is dragged out of a folder. */}
        {(count('none') > 0 || draggingRow || current === 'none') && item('none', '未分类')}
        {folders.length > 0 && <li className="folders-gap" aria-hidden />}
        {folders.map((f) =>
          editingId === f.id ? (
            <li key={f.id} className="folder on">
              <input
                className="folder-input"
                autoFocus
                defaultValue={f.name}
                onBlur={(e) => rename(f.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditingId(null);
                }}
              />
            </li>
          ) : (
            item(
              f.id,
              f.name,
              <>
                <button
                  className="folder-tool folder-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (armedId === f.id) remove(f.id);
                    else setArmedId(f.id);
                  }}
                  title={armedId === f.id ? '再点一次删除；其中的书移到「未分类」' : '删除分类'}
                  aria-label="删除分类"
                >
                  <MinusIcon />
                </button>
                <button
                  className="folder-tool folder-rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(f.id);
                  }}
                  title="重命名"
                  aria-label="重命名分类"
                >
                  <BrushIcon />
                </button>
              </>,
            )
          ),
        )}
        {adding && (
          <li className="folder on">
            <input
              className="folder-input"
              autoFocus
              placeholder="分类名称"
              onBlur={(e) => add(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
          </li>
        )}
      </ul>
    </nav>
  );
}

/** A dialog the library is showing for one book. */
type Dialog = { kind: 'translate' | 'parse' | 'reparse'; book: Book } | null;

export default function Library({
  folder: shownFolder,
  onFolderChange,
  onOpen,
  onOpenSettings,
}: {
  folder: FolderView;
  onFolderChange(folder: FolderView): void;
  onOpen(id: string): void;
  onOpenSettings(): void;
}) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [dragging, setDragging] = useState(false);
  const [draggingRow, setDraggingRow] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const dragDepth = useRef(0);
  // EPUBs take a while to lay out, so the import button says so meanwhile.
  const [importing, setImporting] = useState(false);
  const runImport = async (load: () => Promise<Book[]>) => {
    setImporting(true);
    try {
      setBooks(await load());
    } finally {
      setImporting(false);
    }
  };

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    api().listBooks().then(setBooks);
    api().listFolders().then(setFolders);
  }, []);

  // Inspect new books one at a time in the background: text layer and bookmarks.
  const analyzing = useRef(new Set<string>());
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    const next = books?.find((b) => !b.textLayer && !analyzing.current.has(b.id));
    if (!next) return;
    analyzing.current.add(next.id);
    analyzeBook(next.id)
      .then(setBooks)
      .catch(() => setFailed((f) => [...f, next.id]));
  }, [books]);

  // Live progress of OCR, parse and translation runs; the book record changes when one ends.
  const [ocr, setOcr] = useState<Record<string, OcrProgress>>({});
  const [parsing, setParsing] = useState<Record<string, ParseProgress>>({});
  const [translating, setTranslating] = useState<Record<string, TranslationProgress>>({});
  const [hasToken, setHasToken] = useState(true);
  const [hasMineru, setHasMineru] = useState(true);
  useEffect(() => {
    const track =
      <P extends { state: string }>(set: React.Dispatch<React.SetStateAction<Record<string, P>>>) =>
      (id: string, p: P | undefined) => {
        set(({ [id]: _, ...rest }) => (p ? { ...rest, [id]: p } : rest));
        if (p?.state === 'done' || p?.state === 'failed') api().listBooks().then(setBooks);
      };
    api().ocrStatus().then(setOcr);
    api().parseStatus().then(setParsing);
    api().translationStatus().then(setTranslating);
    api().ocrTokenInfo().then((t) => setHasToken(!!t.source));
    api().translateInfo().then((t) => setHasMineru(!!t.mineruKey.source));
    const offs = [
      api().onOcrProgress(track(setOcr)),
      api().onParseProgress(track(setParsing)),
      api().onTranslationProgress(track(setTranslating)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Exports: which book is being written, and how far a PDF has got.
  const [exporting, setExporting] = useState<{ id: string; done?: number; total?: number } | null>(null);
  useEffect(
    () => api().onExportProgress((id, p) => setExporting((x) => (x?.id === id ? { id, ...p } : x))),
    [],
  );
  const runExport = async (b: Book, kind: 'pdf' | 'md' | 'translation' | 'bilingual') => {
    setExportId(null);
    if (kind === 'md' && b.parse?.legacy) return setDialog({ kind: 'reparse', book: b });
    setExporting({ id: b.id });
    const res: ExportResult = await (kind === 'pdf'
      ? api().exportPdf(b.id)
      : kind === 'md'
        ? api().exportMd(b.id)
        : api().exportTranslationPdf(b.id, kind === 'bilingual'));
    setExporting(null);
    if ('error' in res) setToast(`导出失败：${res.error}`);
    else if ('path' in res) setToast(`已导出：${res.path.split(/[/\\]/).pop()}`);
  };

  const parse = (b: Book) => {
    if (!hasMineru) return onOpenSettings();
    if ((b.pageCount || 0) > RANGE_PAGES) setDialog({ kind: 'parse', book: b });
    else api().startParse(b.id);
  };
  const translate = (b: Book) => {
    const hint = startTranslation(b, () => setDialog({ kind: 'translate', book: b }));
    if (hint) setToast(hint);
  };

  const known = new Set(folders.map((f) => f.id));
  const nameOf = (id?: string | null) => (id && folders.find((f) => f.id === id)?.name) || null;
  // A folder that no longer exists shows everything.
  const folder = shownFolder === 'all' || shownFolder === 'none' || known.has(shownFolder) ? shownFolder : 'all';
  const folderName = nameOf(folder);
  const all = books ?? [];
  const shown = all.filter(
    (b) => folder === 'all' || (folder === 'none' ? !b.folder || !known.has(b.folder) : b.folder === folder),
  );
  const sorted = shown.sort((a, b) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt));
  // New books land in the folder being viewed.
  const target = (into: string | null = folderName ? folder : null) => ({ folder: into });

  /** Drops on the window import into the current folder; drops on a folder in the sidebar, into that one. */
  const importDropped = async (e: React.DragEvent, into?: string | null) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => /\.(pdf|epub)$/i.test(f.name));
    if (files.length) await runImport(() => api().importFiles(files, target(into)));
  };

  const rename = async (id: string, title: string) => {
    setEditingId(null);
    const t = title.trim();
    if (t) setBooks(await api().updateBook(id, { title: t }));
  };

  return (
    <div
      className="library"
      onDragEnter={(e) => {
        // Rows dragged onto a folder aren't imports.
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        if (--dragDepth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => importDropped(e)}
    >
      {/* Empty, but it's the strip the window is dragged by. */}
      <div className="titlebar library-titlebar" />

      <header className="library-header">
        <h1>图书馆</h1>
        <div className="library-header-meta">
          <span className="count">{pad(shown.length)}</span>
          <span className="label">份 PDF</span>
        </div>
        <div className="library-actions">
          <button className="btn btn-primary" onClick={onOpenSettings}>
            设置
          </button>
          <button
            className="btn btn-primary"
            disabled={importing}
            onClick={() => runImport(() => api().importBooks(target()))}
            title="PDF 或 EPUB；EPUB 会排成 A5 大小的 PDF"
          >
            {importing ? '导入中…' : <>导入 PDF <span className="plus">+</span></>}
          </button>
        </div>
      </header>

      <div className="library-body with-folders">
        <FolderList
          books={all}
          folders={folders}
          current={folder}
          onSelect={onFolderChange}
          onFolders={setFolders}
          onBooks={setBooks}
          onDropFiles={importDropped}
          draggingRow={draggingRow}
        />
        {books && shown.length === 0 ? (
          <div className="library-empty">
            {all.length === 0 ? (
              <p>图书馆还是空的。</p>
            ) : (
              <p>{folderName ? `「${folderName}」里还没有 PDF。` : '没有未分类的 PDF。'}</p>
            )}
            <p className="muted">
              点击「导入 PDF」，或直接把文件拖进窗口
              {folderName ? `，会放进「${folderName}」` : ''}。
              {all.length > 0 && ' 也可以把其他分类里的书拖到左侧的分类上。'}
            </p>
          </div>
        ) : (
          <div className="book-list">
            <div className="book-line book-list-head">
              <span>序号</span>
              <span>书名</span>
              <span className="num">页数</span>
              <span className="num">书签</span>
              <span>进度</span>
              <span className="book-date">上次阅读</span>
            </div>
            {sorted.map((b, i) => {
              const progress = b.pageCount ? Math.round((b.lastPage / b.pageCount) * 100) : 0;
              const canPdf = b.ocr?.state === 'done';
              const canMd = b.parse?.state === 'done';
              const canTranslation = canMd && !!b.translation;
              // A row keeps its tools open while something there needs attention.
              const busy = (s?: string) => s === 'queued' || s === 'running' || s === 'parsing' || s === 'translating';
              const attention =
                [ocr[b.id]?.state, parsing[b.id]?.state, translating[b.id]?.state].some((s) => busy(s) || s === 'failed') ||
                [b.ocr?.state, b.parse?.state, b.translation?.state].some((s) => s === 'running' || s === 'failed');
              const open =
                attention || editingId === b.id || confirmId === b.id || exportId === b.id || exporting?.id === b.id;
              return (
                <div
                  key={b.id}
                  className={`book-row${open ? ' open' : ''}`}
                  onClick={() => editingId !== b.id && onOpen(b.id)}
                  draggable={editingId !== b.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(BOOK_MIME, b.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggingRow(true);
                  }}
                  onDragEnd={() => setDraggingRow(false)}
                >
                  <div className="book-line">
                    <span className="book-no">{pad(i + 1)}</span>
                    {editingId === b.id ? (
                      <input
                        className="rename-input"
                        autoFocus
                        defaultValue={b.title}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => rename(b.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                    ) : (
                      <span className="book-title" title={b.title}>
                        {b.title}
                      </span>
                    )}
                    <span className="num">{b.pageCount || '—'}</span>
                    <span className="num">{b.bookmarkCount || '—'}</span>
                    <span className="book-progress">
                      <span className="progress">
                        <span className="progress-bar" style={{ width: `${progress}%` }} />
                      </span>
                      {progress}%
                    </span>
                    <span className="book-date">{formatDate(b.openedAt)}</span>
                  </div>

                  <div className="book-tools" onClick={(e) => e.stopPropagation()}>
                    <div className="book-tools-inner">
                      <div className="book-tools-bar">
                        <span className="tool">
                          <span className="tool-label">文字</span>
                          <TextCell
                            book={b}
                            live={ocr[b.id]}
                            detectFailed={failed.includes(b.id)}
                            hasToken={hasToken}
                            onOpenSettings={onOpenSettings}
                          />
                        </span>
                        <span className="tool">
                          <span className="tool-label">结构</span>
                          <ParseCell book={b} live={parsing[b.id]} onStart={() => parse(b)} />
                        </span>
                        <span className="tool">
                          <span className="tool-label">译文</span>
                          <TranslateCell
                            book={b}
                            live={translating[b.id]}
                            onStart={() => translate(b)}
                            onMore={() => setDialog({ kind: 'translate', book: b })}
                            onOpen={() => {
                              // Open with the translation beside the PDF.
                              localStorage.setItem('reader.translation', '1');
                              onOpen(b.id);
                            }}
                          />
                        </span>
                        <span className="book-actions">
                          {folder === 'all' && nameOf(b.folder) && <span className="book-folder">{nameOf(b.folder)}</span>}
                          {exporting?.id === b.id ? (
                            <span className="muted ocr-progress">
                              导出中{exporting.total ? ` ${exporting.done ?? 0}/${exporting.total} 页` : '…'}
                            </span>
                          ) : confirmId === b.id ? (
                            <>
                              <button
                                className="link small danger"
                                onClick={async () => {
                                  setConfirmId(null);
                                  setBooks(await api().removeBook(b.id));
                                }}
                              >
                                确认移除
                              </button>
                              <button className="link small" onClick={() => setConfirmId(null)}>
                                取消
                              </button>
                            </>
                          ) : exportId === b.id ? (
                            <>
                              <button
                                className="link small"
                                disabled={!canPdf}
                                onClick={() => runExport(b, 'pdf')}
                                title={canPdf ? '带 OCR 文字层的 PDF，在其他阅读器里也能选中、搜索' : '在这里完成 OCR 后才能导出'}
                              >
                                导出 PDF
                              </button>
                              <button
                                className="link small"
                                disabled={!canMd}
                                onClick={() => runExport(b, 'md')}
                                title={canMd ? '解析结果：.md 和图片，打包成 .zip' : '解析后才能导出'}
                              >
                                导出 .md
                              </button>
                              <button
                                className="link small"
                                disabled={!canTranslation}
                                onClick={() => runExport(b, 'translation')}
                                title={canTranslation ? '译文按原书大小重新排版，没翻译的部分保留原文' : '翻译后才能导出'}
                              >
                                译文 PDF
                              </button>
                              <button
                                className="link small"
                                disabled={!canTranslation}
                                onClick={() => runExport(b, 'bilingual')}
                                title={canTranslation ? '每段译文下附原文' : '翻译后才能导出'}
                              >
                                对照 PDF
                              </button>
                              <button className="link small" onClick={() => setExportId(null)}>
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              {(canPdf || canMd) && (
                                <button className="link small" onClick={() => setExportId(b.id)}>
                                  导出
                                </button>
                              )}
                              <button className="link small" onClick={() => setEditingId(b.id)}>
                                重命名
                              </button>
                              <button className="link small" onClick={() => setConfirmId(b.id)}>
                                移除
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dialog?.kind === 'translate' && <TranslateDialog book={dialog.book} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'parse' && (
        <ConfirmDialog
          title="开始解析？"
          confirm="开始解析"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            api().startParse(dialog.book.id);
            setDialog(null);
          }}
        >
          这份 PDF 共 {dialog.book.pageCount} 页，解析会用掉同样多的 MinerU 额度（每个账号每天 1,000 页高优先级额度）。超过 200
          页会拆成几块分别解析，再拼接起来。
        </ConfirmDialog>
      )}
      {dialog?.kind === 'reparse' && (
        <ConfirmDialog
          title="需要重新解析"
          confirm="重新解析"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            api().startParse(dialog.book.id, { force: true });
            setDialog(null);
          }}
        >
          这份解析结果是旧版本生成的，没有保存图片，无法导出 .md。重新解析会用掉 {dialog.book.pageCount || '这份 PDF 的页数那么多'}{' '}
          页 MinerU 额度；已有的译文和修改会按原文对应到新的解析结果上，对不上的段落标为未翻译。
        </ConfirmDialog>
      )}

      {toast && <div className="toast toast-fixed">{toast}</div>}

      {dragging && (
        <div className="drop-overlay beside-folders">
          <span>{`松开以导入${folderName ? `到「${folderName}」` : ' PDF'}`}</span>
        </div>
      )}
    </div>
  );
}
