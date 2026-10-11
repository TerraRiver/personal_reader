import type { Notebook, Segment, TrashItem } from './types';

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Page range in front matter

export interface Range {
  start: number;
  /** null while the note is open (not cut yet). */
  end: number | null;
}

const FRONT = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const KEY = /^\s*(页码|pages)\s*[:：]\s*(.*)$/i;

export function parseRange(content: string): Range | null {
  const fm = content.match(FRONT);
  const line = fm?.[1].split('\n').map((l) => l.match(KEY)).find(Boolean);
  if (!line) return null;
  const m = line[2].trim().match(/^(\d+)\s*(?:[-–—~]\s*(\d+)?)?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : /[-–—~]/.test(line[2]) ? null : start;
  if (start < 1 || (end !== null && end < start)) return null;
  return { start, end };
}

const formatRange = (r: Range) => (r.end === null ? `${r.start}-` : `${r.start}-${r.end}`);

/** Write the range into the front matter, keeping everything else intact. */
export function writeRange(content: string, r: Range): string {
  const value = `页码: ${formatRange(r)}`;
  const fm = content.match(FRONT);
  if (!fm) return `---\n${value}\n---\n\n${content}`;
  const lines = fm[1].split('\n');
  const i = lines.findIndex((l) => KEY.test(l));
  if (i >= 0) lines[i] = value;
  else lines.unshift(value);
  return `---\n${lines.join('\n')}\n---\n` + content.slice(fm[0].length);
}

/** The note without its front matter. */
export const stripFront = (content: string) => content.replace(FRONT, '');

export const rangeLabel = (r: Range | null) =>
  !r
    ? '未设置页码'
    : r.end === null
      ? `第 ${r.start} 页起`
      : r.start === r.end
        ? `第 ${r.start} 页`
        : `第 ${r.start}–${r.end} 页`;

/** First meaningful line of a note body, used as its name. */
export function headline(md: string) {
  const line = stripFront(md)
    .split('\n')
    .map((l) => l.replace(/^\s*(#+|>|[-*+]|\d+\.)\s*/, '').replace(/[*_`~]/g, '').trim())
    .find(Boolean);
  return line ? line.slice(0, 60) : '';
}

// ---------------------------------------------------------------------------
// Layout: notes in page order, with the extent of open notes resolved

export interface NoteView {
  seg: Segment;
  range: Range | null;
  /** Last page covered. An open note runs until the next note starts. */
  last: number;
  no: number;
  warnings: string[];
}

export function layout(segs: Segment[]): NoteView[] {
  const views = segs.map((seg) => ({ seg, range: parseRange(seg.content), last: 0, no: 0, warnings: [] as string[] }));
  views.sort((a, b) => {
    if (!a.range || !b.range) return a.range ? -1 : b.range ? 1 : a.seg.createdAt - b.seg.createdAt;
    return a.range.start - b.range.start || a.seg.createdAt - b.seg.createdAt;
  });
  views.forEach((v, i) => {
    v.no = i + 1;
    if (!v.range) {
      v.warnings.push('缺少页码范围。在开头写上 ---、页码: 12-18、--- 三行，这篇笔记才会跟随 PDF。');
      return;
    }
    const next = views.slice(i + 1).find((n) => n.range && n.range.start >= v.range!.start);
    v.last = v.range.end ?? (next ? next.range!.start : Infinity);
  });
  // Ranges may only touch on a cut page. Views are sorted, so check each earlier note.
  const tag = (v: NoteView) => `笔记 ${String(v.no).padStart(2, '0')}（${rangeLabel(v.range)}）`;
  views.forEach((b, j) => {
    const a = views.slice(0, j).find((x) => x.range?.end != null && b.range && b.range.start < x.range.end);
    if (!a) return;
    a.warnings.push(`与${tag(b)}重叠。下一篇最早只能从本篇的截断页（第 ${a.range!.end} 页）开始。`);
    b.warnings.push(`与${tag(a)}重叠，最早只能从它的截断页（第 ${a.range!.end} 页）开始。`);
  });
  return views;
}

export const covers = (v: NoteView, page: number) => !!v.range && page >= v.range.start && page <= v.last;

/**
 * The note to show for a page. The current one wins while it still covers the
 * page, so a cut page shared by two notes never flips back and forth.
 * Pages without notes show nothing.
 */
export function noteForPage(views: NoteView[], page: number, currentId: string | null): string | null {
  const hits = views.filter((v) => covers(v, page));
  if (hits.some((v) => v.seg.id === currentId)) return currentId;
  return hits[hits.length - 1]?.seg.id ?? null;
}

/** Notes may start only on a page without notes, or on the previous note's cut page. */
export function canStart(views: NoteView[], page: number) {
  const hits = views.filter((v) => covers(v, page));
  return hits.length === 0 || (hits.length === 1 && hits[0].range!.end === page);
}

/** The open note a cut on this page applies to (the shown one if it qualifies). */
export function cutTarget(views: NoteView[], page: number, activeId: string | null) {
  const open = views.filter((v) => covers(v, page) && v.range!.end === null);
  return open.find((v) => v.seg.id === activeId) ?? open[0] ?? null;
}

// ---------------------------------------------------------------------------
// Edits

export function startNote(nb: Notebook, page: number): { notebook: Notebook; id: string } {
  const seg: Segment = {
    id: uid(),
    content: writeRange('', { start: page, end: null }),
    createdAt: now(),
    updatedAt: now(),
  };
  return { notebook: { ...nb, segments: [...nb.segments, seg] }, id: seg.id };
}

export function cutNote(nb: Notebook, id: string, page: number): Notebook {
  return {
    ...nb,
    segments: nb.segments.map((s) => {
      if (s.id !== id) return s;
      const r = parseRange(s.content)!;
      return { ...s, content: writeRange(s.content, { start: r.start, end: page }), updatedAt: now() };
    }),
  };
}

export function deleteNote(nb: Notebook, id: string): Notebook {
  const seg = nb.segments.find((s) => s.id === id);
  const keep = seg && stripFront(seg.content).trim();
  return {
    ...nb,
    segments: nb.segments.filter((s) => s.id !== id),
    trash: keep ? [{ id: seg.id, content: seg.content, deletedAt: now() }, ...nb.trash] : nb.trash,
  };
}

export function restoreNote(nb: Notebook, id: string): Notebook {
  const item = nb.trash.find((t) => t.id === id)!;
  return {
    ...nb,
    segments: [...nb.segments, { id: item.id, content: item.content, createdAt: now(), updatedAt: now() }],
    trash: nb.trash.filter((t) => t.id !== id),
  };
}

// ---------------------------------------------------------------------------
// Loading

export function emptyNotebook(): Notebook {
  return { version: 3, segments: [], trash: [] };
}

type OldNote = { id?: string; content?: string; startPage?: number; endPage?: number | null; createdAt?: number };

const fromOld = (n: OldNote): string =>
  n.startPage ? writeRange(n.content ?? '', { start: n.startPage, end: n.endPage ?? null }) : (n.content ?? '');

/** Accepts whatever is on disk and upgrades older formats. */
export function normalizeNotebook(raw: unknown): Notebook {
  const r = raw as { version?: number; segments?: OldNote[]; trash?: OldNote[] } | null;
  if (r?.version === 3) return r as Notebook;

  const nb = emptyNotebook();
  if (r?.version === 2) {
    nb.segments = (r.segments ?? [])
      .filter((s) => s.content?.trim())
      .map((s) => ({ id: s.id ?? uid(), content: fromOld(s), createdAt: s.createdAt ?? now(), updatedAt: now() }));
    nb.trash = (r.trash ?? []).map((t) => ({ id: t.id ?? uid(), content: fromOld(t), deletedAt: now() }));
    return nb;
  }
  // First format: a flat list, or a main note plus sub-notes. Kept in the trash.
  const old: OldNote[] = Array.isArray(raw)
    ? raw
    : [(raw as { main?: OldNote })?.main, ...((raw as { subs?: OldNote[] })?.subs ?? [])].filter(
        (n): n is OldNote => !!n,
      );
  nb.trash = old
    .filter((n) => n.content?.trim())
    .map((n) => ({ id: uid(), content: fromOld(n), deletedAt: now() }));
  return nb;
}

export type { TrashItem };
