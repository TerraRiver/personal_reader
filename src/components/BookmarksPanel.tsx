import { useEffect, useRef, useState } from 'react';
import type { Bookmark } from '../types';

interface Props {
  bookmarks: Bookmark[];
  currentPage: number;
  pageCount: number;
  onChange(next: Bookmark[]): void;
  onGoTo(page: number): void;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Index of the bookmark whose section contains the page, or -1. */
export function currentBookmark(bookmarks: Bookmark[], page: number) {
  let found = -1;
  bookmarks.forEach((b, i) => {
    if (b.page <= page) found = i;
  });
  return found;
}

/** Stable sort by page, so bookmarks on the same page keep their order. */
const byPage = (list: Bookmark[]) =>
  list
    .map((b, i) => [b, i] as const)
    .sort((a, b) => a[0].page - b[0].page || a[1] - b[1])
    .map(([b]) => b);

export default function BookmarksPanel({ bookmarks, currentPage, pageCount, onChange, onGoTo }: Props) {
  const [editing, setEditing] = useState<{ id: string; field: 'title' | 'page' } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const current = currentBookmark(bookmarks, currentPage);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the current section in view while reading.
  useEffect(() => {
    listRef.current?.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const update = (id: string, patch: Partial<Bookmark>) =>
    onChange(byPage(bookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b))));

  const add = () => {
    const at = bookmarks[current];
    const b: Bookmark = {
      id: crypto.randomUUID(),
      title: `第 ${currentPage} 页`,
      page: currentPage,
      level: at ? at.level : 0,
    };
    // Insert after every bookmark at or before this page.
    const i = bookmarks.findIndex((x) => x.page > currentPage);
    const next = bookmarks.slice();
    next.splice(i < 0 ? next.length : i, 0, b);
    onChange(next);
    setEditing({ id: b.id, field: 'title' });
  };

  const indent = (i: number, d: 1 | -1) => {
    const b = bookmarks[i];
    const max = i > 0 ? bookmarks[i - 1].level + 1 : 0;
    update(b.id, { level: Math.min(max, Math.max(0, b.level + d)) });
  };

  return (
    <aside className="bookmarks">
      <div className="bookmarks-head">
        <h3>
          书签<span className="count-badge">{pad(bookmarks.length)}</span>
        </h3>
        <span className="bookmarks-tools">
          {bookmarks.length > 0 &&
            (confirmClear ? (
              <>
                <button
                  className="link small danger"
                  onClick={() => {
                    onChange([]);
                    setConfirmClear(false);
                  }}
                >
                  确认清空
                </button>
                <button className="link small" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </>
            ) : (
              <button className="link small" onClick={() => setConfirmClear(true)} title="删除这本书的全部书签">
                清空
              </button>
            ))}
          <button className="btn btn-primary btn-sm" onClick={add} title={`在第 ${currentPage} 页添加书签`}>
            添加 <span className="plus">+</span>
          </button>
        </span>
      </div>

      {bookmarks.length === 0 ? (
        <p className="muted bookmarks-empty">这本书没有书签。翻到章节开头，点「添加」。</p>
      ) : (
        <ul className="bookmark-list" ref={listRef}>
          {bookmarks.map((b, i) => (
            <li
              key={b.id}
              className={i === current ? 'current' : ''}
              style={{ paddingLeft: 16 + b.level * 14 }}
            >
              {editing?.id === b.id && editing.field === 'title' ? (
                <InlineInput
                  className="bm-title-input"
                  value={b.title}
                  selectAll
                  onCommit={(v) => {
                    setEditing(null);
                    if (v.trim()) update(b.id, { title: v.trim() });
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <button
                  className={`bm-title${b.level === 0 ? ' top' : ''}`}
                  onClick={() => onGoTo(b.page)}
                  onDoubleClick={() => setEditing({ id: b.id, field: 'title' })}
                  title="单击跳转，双击重命名"
                >
                  {b.title}
                </button>
              )}

              <span className="bm-actions">
                <button className="icon-btn" onClick={() => indent(i, -1)} disabled={b.level === 0} title="提升一级">
                  ⇤
                </button>
                <button
                  className="icon-btn"
                  onClick={() => indent(i, 1)}
                  disabled={i === 0 || b.level > bookmarks[i - 1].level}
                  title="降低一级"
                >
                  ⇥
                </button>
                <button className="icon-btn" onClick={() => setEditing({ id: b.id, field: 'title' })} title="重命名">
                  ✎
                </button>
                <button
                  className="icon-btn"
                  onClick={() => onChange(bookmarks.filter((x) => x.id !== b.id))}
                  title="删除书签"
                >
                  ×
                </button>
              </span>

              {editing?.id === b.id && editing.field === 'page' ? (
                <InlineInput
                  className="bm-page-input"
                  value={String(b.page)}
                  numeric
                  selectAll
                  onCommit={(v) => {
                    setEditing(null);
                    const p = Number(v);
                    if (p) update(b.id, { page: Math.min(Math.max(1, p), pageCount || p) });
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <button
                  className="bm-page"
                  onClick={() => setEditing({ id: b.id, field: 'page' })}
                  title="修改页码"
                >
                  {b.page}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function InlineInput({
  value,
  className,
  numeric,
  selectAll,
  onCommit,
  onCancel,
}: {
  value: string;
  className: string;
  numeric?: boolean;
  selectAll?: boolean;
  onCommit(v: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    if (selectAll) ref.current?.select();
  }, [selectAll]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(text);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      className={className}
      value={text}
      onChange={(e) => setText(numeric ? e.target.value.replace(/\D/g, '') : e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}
