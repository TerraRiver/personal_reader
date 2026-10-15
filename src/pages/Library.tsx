import { useEffect, useRef, useState } from 'react';
import { api, type Book, type Folder, type OcrProgress, type ShelfKind, type TextLayerKind, type TranslationProgress } from '../types';
import { analyzeBook } from '../pdf';

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
      <span className={`tag tag-${book.textLayer}`} title={TEXT_HINT[book.textLayer]}>
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

/** The paper translation column: start it, or how far it got. */
function TranslateCell({ book, live, onOpen }: { book: Book; live?: TranslationProgress; onOpen(): void }) {
  const start = () => api().startTranslation(book.id);
  if (live?.state === 'queued') return <span className="muted">等待翻译…</span>;
  if (live?.state === 'parsing')
    return <span className="muted ocr-progress">解析中 {live.total ? `${live.done ?? 0}/${live.total}` : '…'}</span>;
  if (live?.state === 'translating')
    return <span className="muted ocr-progress">翻译中 {live.done ?? 0}/{live.total ?? '…'}</span>;
  if (!live && book.translation?.state === 'running') return <span className="muted">翻译中…</span>;
  if (live?.state === 'done' || (book.translation?.state === 'done' && live?.state !== 'failed'))
    return (
      <button className="tag tag-ocr tag-button" onClick={onOpen} title="打开阅读器查看译文">
        已翻译
      </button>
    );
  if (live?.state === 'failed' || book.translation?.state === 'failed') {
    const error = live?.error ?? book.translation?.error ?? '';
    return (
      <>
        <span className="ocr-failed" title={error}>
          翻译失败
        </span>
        <button className="link small" onClick={start} title={`${error}\n从中断处继续`}>
          重试
        </button>
      </>
    );
  }
  return (
    <button className="link small" onClick={start} title="MinerU 解析版面，大模型逐段翻译成中文">
      翻译
    </button>
  );
}

/** Which shelf is shown, and on the paper shelf, which folder: all, uncategorized, or a folder id. */
export interface Shelf {
  kind: ShelfKind;
  folder: 'all' | 'none' | string;
}

const kindOf = (b: Book): ShelfKind => b.kind ?? 'book';

/** Set on rows dragged onto a folder; files dragged in from outside carry 'Files' instead. */
const PAPER_MIME = 'application/x-reader-paper';

/** The paper library's folders. Papers are dragged onto a folder to file them. */
function FolderList({
  papers,
  folders,
  current,
  onSelect,
  onFolders,
  onBooks,
  onDropFiles,
}: {
  papers: Book[];
  folders: Folder[];
  current: Shelf['folder'];
  onSelect(folder: Shelf['folder']): void;
  onFolders(folders: Folder[]): void;
  onBooks(books: Book[]): void;
  onDropFiles(e: React.DragEvent, folder: string | null): void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const known = new Set(folders.map((f) => f.id));
  const count = (folder: Shelf['folder']) =>
    folder === 'all'
      ? papers.length
      : folder === 'none'
        ? papers.filter((p) => !p.folder || !known.has(p.folder)).length
        : papers.filter((p) => p.folder === folder).length;

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
    setConfirmId(null);
    const res = await api().removeFolder(id);
    onFolders(res.folders);
    onBooks(res.books);
    if (current === id) onSelect('all');
  };

  // Dropping a paper files it; dropping PDFs from outside imports them straight into the folder.
  const dropProps = (folder: Shelf['folder']) =>
    folder === 'all'
      ? {}
      : {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(PAPER_MIME) && !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setOver(folder);
          },
          onDragLeave: () => setOver((o) => (o === folder ? null : o)),
          onDrop: async (e: React.DragEvent) => {
            setOver(null);
            e.preventDefault();
            e.stopPropagation();
            const target = folder === 'none' ? null : folder;
            const id = e.dataTransfer.getData(PAPER_MIME);
            if (id) onBooks(await api().updateBook(id, { folder: target }));
            else onDropFiles(e, target);
          },
        };

  const item = (folder: Shelf['folder'], label: React.ReactNode, extra?: React.ReactNode) => (
    <li
      key={folder}
      className={`folder${current === folder ? ' on' : ''}${over === folder ? ' over' : ''}`}
      onClick={() => onSelect(folder)}
      {...dropProps(folder)}
    >
      <span className="folder-name">{label}</span>
      <span className="folder-count">{count(folder)}</span>
      {extra}
    </li>
  );

  return (
    <nav className="folders">
      <div className="folders-label">分类</div>
      <ul>
        {item('all', '全部')}
        {item('none', '未分类')}
      </ul>
      <ul>
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
              <span className="folder-actions" onClick={(e) => e.stopPropagation()}>
                {confirmId === f.id ? (
                  <>
                    <button className="link small danger" onClick={() => remove(f.id)} title="其中的论文移到「未分类」">
                      删除
                    </button>
                    <button className="link small" onClick={() => setConfirmId(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button className="link small" onClick={() => setEditingId(f.id)}>
                      重命名
                    </button>
                    <button className="link small" onClick={() => setConfirmId(f.id)}>
                      删除
                    </button>
                  </>
                )}
              </span>,
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
      {!adding && (
        <button className="link small folder-add" onClick={() => setAdding(true)}>
          + 新建分类
        </button>
      )}
      <p className="folders-hint muted">把论文拖到分类上即可归类。</p>
    </nav>
  );
}

export default function Library({
  shelf,
  onShelfChange,
  onOpen,
  onOpenSettings,
}: {
  shelf: Shelf;
  onShelfChange(shelf: Shelf): void;
  onOpen(id: string): void;
  onOpenSettings(): void;
}) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [dragging, setDragging] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const isPaper = shelf.kind === 'paper';

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

  // Paper translations: live progress from the main process.
  const [translating, setTranslating] = useState<Record<string, TranslationProgress>>({});
  useEffect(() => {
    api().translationStatus().then(setTranslating);
    return api().onTranslationProgress((id, p) => {
      setTranslating(({ [id]: _, ...rest }) => (p ? { ...rest, [id]: p } : rest));
      if (p?.state === 'done' || p?.state === 'failed') api().listBooks().then(setBooks);
    });
  }, []);

  // Hosted OCR runs: live progress from the main process.
  const [ocr, setOcr] = useState<Record<string, OcrProgress>>({});
  const [hasToken, setHasToken] = useState(true);
  useEffect(() => {
    api().ocrStatus().then(setOcr);
    api().ocrTokenInfo().then((t) => setHasToken(!!t.source));
    return api().onOcrProgress((id, p) => {
      setOcr(({ [id]: _, ...rest }) => (p ? { ...rest, [id]: p } : rest));
      // The book record changes when a run ends.
      if (p?.state === 'done' || p?.state === 'failed') api().listBooks().then(setBooks);
    });
  }, []);

  const known = new Set(folders.map((f) => f.id));
  const nameOf = (id?: string | null) => (id && folders.find((f) => f.id === id)?.name) || null;
  // A folder that no longer exists shows everything.
  const folder = shelf.folder === 'all' || shelf.folder === 'none' || known.has(shelf.folder) ? shelf.folder : 'all';
  const folderName = isPaper ? nameOf(folder) : null;
  const onShelf = (books ?? []).filter((b) => kindOf(b) === shelf.kind);
  const shown = onShelf.filter(
    (b) =>
      !isPaper ||
      folder === 'all' ||
      (folder === 'none' ? !b.folder || !known.has(b.folder) : b.folder === folder),
  );
  const sorted = shown.sort((a, b) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt));
  // New papers land in the folder being viewed.
  const target = (into: string | null = folderName ? folder : null) => ({ kind: shelf.kind, folder: into });

  /** Drops on the window import into the current folder; drops on a folder in the sidebar, into that one. */
  const importDropped = async (e: React.DragEvent, into?: string | null) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) setBooks(await api().importFiles(files, target(into)));
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
      <div className="titlebar library-titlebar">
        <button className="link" onClick={onOpenSettings}>
          设置
        </button>
      </div>

      <header className="library-header">
        <h1 className="shelves">
          <button className={shelf.kind === 'book' ? 'on' : ''} onClick={() => onShelfChange({ ...shelf, kind: 'book' })}>
            书库
          </button>
          <button className={isPaper ? 'on' : ''} onClick={() => onShelfChange({ ...shelf, kind: 'paper' })}>
            论文库
          </button>
        </h1>
        <div className="library-header-meta">
          <span className="count">{pad(shown.length)}</span>
          <span className="label">{isPaper ? '篇论文' : '本书'}</span>
        </div>
        <button className="btn btn-primary" onClick={async () => setBooks(await api().importBooks(target()))}>
          导入 PDF <span className="plus">+</span>
        </button>
      </header>

      <div className={isPaper ? 'library-body with-folders' : 'library-body'}>
      {isPaper && (
        <FolderList
          papers={onShelf}
          folders={folders}
          current={folder}
          onSelect={(f) => onShelfChange({ ...shelf, folder: f })}
          onFolders={setFolders}
          onBooks={setBooks}
          onDropFiles={importDropped}
        />
      )}
      {books && shown.length === 0 ? (
        <div className="library-empty">
          {!isPaper ? (
            <p>书库还是空的。</p>
          ) : onShelf.length === 0 ? (
            <p>论文库还是空的。</p>
          ) : (
            <p>{folderName ? `「${folderName}」里还没有论文。` : '没有未分类的论文。'}</p>
          )}
          <p className="muted">
            点击「导入 PDF」，或直接把文件拖进窗口
            {folderName ? `，会放进「${folderName}」` : ''}。
            {isPaper && onShelf.length > 0 && ' 也可以把其他分类的论文拖到左侧的分类上。'}
          </p>
        </div>
      ) : (
        <table className="book-table">
          <thead>
            <tr>
              <th className="col-no">序号</th>
              <th>{isPaper ? '标题' : '书名'}</th>
              <th className="col-num">页数</th>
              <th className="col-tag">文字</th>
              {isPaper ? <th className="col-tag">译文</th> : <th className="col-tag">书签</th>}
              <th className="col-progress">进度</th>
              <th className="col-date">上次阅读</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((b, i) => {
              const progress = b.pageCount ? Math.round((b.lastPage / b.pageCount) * 100) : 0;
              return (
                <tr
                  key={b.id}
                  onClick={() => editingId !== b.id && onOpen(b.id)}
                  draggable={isPaper && editingId !== b.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PAPER_MIME, b.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  <td className="col-no">{pad(i + 1)}</td>
                  <td className="col-title">
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
                      b.title
                    )}
                    {isPaper && folder === 'all' && nameOf(b.folder) && (
                      <span className="title-folder">{nameOf(b.folder)}</span>
                    )}
                  </td>
                  <td className="col-num">{b.pageCount || '—'}</td>
                  <td className="col-tag" onClick={(e) => e.stopPropagation()}>
                    <TextCell
                      book={b}
                      live={ocr[b.id]}
                      detectFailed={failed.includes(b.id)}
                      hasToken={hasToken}
                      onOpenSettings={onOpenSettings}
                    />
                  </td>
                  {isPaper && (
                    <td className="col-tag" onClick={(e) => e.stopPropagation()}>
                      <TranslateCell
                        book={b}
                        live={translating[b.id]}
                        onOpen={() => {
                          // Open straight onto the translation.
                          localStorage.setItem('reader.leftPane', 'translation');
                          onOpen(b.id);
                        }}
                      />
                    </td>
                  )}
                  {!isPaper && <td className="col-tag">
                    {b.bookmarkCount === undefined ? (
                      <span className="muted">—</span>
                    ) : b.bookmarkCount > 0 ? (
                      <span className="tag">{b.bookmarkCount} 个</span>
                    ) : (
                      <span className="muted">无</span>
                    )}
                  </td>}
                  <td className="col-progress">
                    <div className="progress">
                      <div className="progress-bar" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="progress-num">{progress}%</span>
                  </td>
                  <td className="col-date">{formatDate(b.openedAt)}</td>
                  <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                    {confirmId === b.id ? (
                      <>
                        <button
                          className="link danger"
                          onClick={async () => {
                            setConfirmId(null);
                            setBooks(await api().removeBook(b.id));
                          }}
                        >
                          确认移除
                        </button>
                        <button className="link" onClick={() => setConfirmId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="link" onClick={() => setEditingId(b.id)}>
                          重命名
                        </button>
                        <button
                          className="link"
                          onClick={async () =>
                            setBooks(await api().updateBook(b.id, { kind: isPaper ? 'book' : 'paper', folder: null }))
                          }
                          title={isPaper ? '把这篇移到书库' : '把这本移到论文库（未分类）'}
                        >
                          {isPaper ? '移到书库' : '移到论文库'}
                        </button>
                        <button className="link" onClick={() => setConfirmId(b.id)}>
                          移除
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      </div>

      {dragging && (
        <div className={isPaper ? 'drop-overlay beside-folders' : 'drop-overlay'}>
          <span>{isPaper ? `松开以导入到${folderName ? `「${folderName}」` : '论文库'}` : '松开以导入 PDF'}</span>
        </div>
      )}
    </div>
  );
}
