import { useEffect, useState, type ReactNode } from 'react';
import { api, type Book, type TranslationEstimate } from '../types';

/** PDFs longer than this ask which pages to translate, and confirm before parsing. */
export const RANGE_PAGES = 50;

/** The first page outside `ranges` (sorted, merged), or null when they cover 1–total. */
export function firstUntranslated(ranges: [number, number][], total: number) {
  let page = 1;
  for (const [from, to] of ranges) {
    if (page < from) break;
    page = Math.max(page, to + 1);
  }
  return page <= total ? page : null;
}

const rangeText = (ranges: [number, number][]) =>
  ranges.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join('、');

/**
 * Starts translating `book`: short PDFs whole, long ones after `ask()` lets the reader
 * pick pages. Returns a hint instead when the book isn't parsed yet.
 */
export function startTranslation(book: Book, ask: () => void): string | null {
  if (book.parse?.state !== 'done') return '翻译前需要先解析';
  const pages = book.pageCount || 1;
  if (pages > RANGE_PAGES) ask();
  else api().startTranslation(book.id, [1, pages]);
  return null;
}

function Modal({ children, onCancel }: { children: ReactNode; onCancel(): void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="cite-dialog modal" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        {children}
      </div>
    </div>
  );
}

/** Pick the pages to translate: by default the next 50 not translated yet. */
export function TranslateDialog({
  book,
  initial,
  onClose,
}: {
  book: Book;
  /** Pages to suggest instead, e.g. a gap picked in the translation pane. */
  initial?: [number, number];
  onClose(): void;
}) {
  const total = book.pageCount || 1;
  const [ranges, setRanges] = useState<[number, number][] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [estimate, setEstimate] = useState<TranslationEstimate | null>(null);

  const [initFrom, initTo] = initial ?? [];
  useEffect(() => {
    api()
      .loadTranslation(book.id)
      .then((t) => {
        const done = t?.ranges ?? [];
        setRanges(done);
        const start = initFrom ?? firstUntranslated(done, total) ?? 1;
        const end = Math.min(initTo ?? total, start + RANGE_PAGES - 1, total);
        setFrom(String(start));
        setTo(String(end));
      });
  }, [book.id, total, initFrom, initTo]);

  const a = parseInt(from, 10);
  const b = parseInt(to, 10);
  const valid = a >= 1 && b >= a && b <= total;
  useEffect(() => {
    setEstimate(null);
    if (!valid) return;
    const t = setTimeout(() => api().estimateTranslation(book.id, a, b).then(setEstimate), 200);
    return () => clearTimeout(t);
  }, [book.id, a, b, valid]);

  const start = () => {
    if (!valid) return;
    api().startTranslation(book.id, [a, b]);
    onClose();
  };

  return (
    <Modal onCancel={onClose}>
      <h3>翻译哪些页？</h3>
      <p className="muted">
        这份 PDF 共 {total} 页，整本翻译很耗 token，可以一次翻译一部分。已经译过的段落不会重复翻译；跨页的段落按开头所在的页算。
      </p>
      <form
        className="cite-dialog-row"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <span>第</span>
        <input
          autoFocus
          value={from}
          onChange={(e) => setFrom(e.target.value.replace(/\D/g, ''))}
          onFocus={(e) => e.currentTarget.select()}
        />
        <span>–</span>
        <input value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} onFocus={(e) => e.currentTarget.select()} />
        <span>页</span>
        <span className="spacer" />
        <button type="button" className="link small" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!valid || estimate?.pieces === 0}>
          开始翻译
        </button>
      </form>
      <p className="muted cite-dialog-example">
        {!valid
          ? from && to && `页码要在 1–${total} 之间，且起始页不大于结束页`
          : !estimate
            ? '估算中…'
            : estimate.pieces === 0
              ? '这些页已经全部译完了'
              : `约 ${estimate.pieces} 段、${estimate.chars.toLocaleString()} 字要翻译${estimate.done ? `，另有 ${estimate.done} 段已译过` : ''}`}
      </p>
      {ranges && ranges.length > 0 && <p className="muted">已翻译：第 {rangeText(ranges)} 页</p>}
    </Modal>
  );
}

/** A yes / no question before something that costs quota. */
export function ConfirmDialog({
  title,
  children,
  confirm,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirm: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Modal onCancel={onCancel}>
      <h3>{title}</h3>
      <p className="muted">{children}</p>
      <div className="cite-dialog-row">
        <span className="spacer" />
        <button className="link small" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn-primary btn-sm" autoFocus onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </Modal>
  );
}
