import { useEffect, useRef, useState } from 'react';
import { api, type Book, type TextLayerKind } from '../types';
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

export default function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    api().listBooks().then(setBooks);
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

  const sorted = [...(books ?? [])].sort(
    (a, b) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt),
  );

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) setBooks(await api().importFiles(files));
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
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="titlebar" />

      <header className="library-header">
        <h1>书库</h1>
        <div className="library-header-meta">
          <span className="count">{pad(books?.length ?? 0)}</span>
          <span className="label">本书</span>
        </div>
        <button className="btn btn-primary" onClick={async () => setBooks(await api().importBooks())}>
          导入 PDF <span className="plus">+</span>
        </button>
      </header>

      {books && books.length === 0 ? (
        <div className="library-empty">
          <p>书库还是空的。</p>
          <p className="muted">点击「导入 PDF」，或直接把文件拖进窗口。</p>
        </div>
      ) : (
        <table className="book-table">
          <thead>
            <tr>
              <th className="col-no">序号</th>
              <th>书名</th>
              <th className="col-num">页数</th>
              <th className="col-tag">文字</th>
              <th className="col-tag">书签</th>
              <th className="col-progress">进度</th>
              <th className="col-date">上次阅读</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((b, i) => {
              const progress = b.pageCount ? Math.round((b.lastPage / b.pageCount) * 100) : 0;
              return (
                <tr key={b.id} onClick={() => editingId !== b.id && onOpen(b.id)}>
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
                  </td>
                  <td className="col-num">{b.pageCount || '—'}</td>
                  <td className="col-tag">
                    {b.textLayer ? (
                      <span className={`tag tag-${b.textLayer}`} title={TEXT_HINT[b.textLayer]}>
                        {TEXT_LABEL[b.textLayer]}
                      </span>
                    ) : (
                      <span className="muted">{failed.includes(b.id) ? '无法检测' : '检测中…'}</span>
                    )}
                  </td>
                  <td className="col-tag">
                    {b.bookmarkCount === undefined ? (
                      <span className="muted">—</span>
                    ) : b.bookmarkCount > 0 ? (
                      <span className="tag">{b.bookmarkCount} 个</span>
                    ) : (
                      <span className="muted">无</span>
                    )}
                  </td>
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

      {dragging && (
        <div className="drop-overlay">
          <span>松开以导入 PDF</span>
        </div>
      )}
    </div>
  );
}
