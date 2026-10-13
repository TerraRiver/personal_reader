import type { Annotations, MarkColor, MarkStyle, NumberStampType, StampType } from './types';

export const AUTO_COPY_KEY = 'reader.autoCopy';
export const autoCopyEnabled = () => {
  try {
    return localStorage.getItem(AUTO_COPY_KEY) !== '0';
  } catch {
    return true;
  }
};

export function emptyAnnotations(): Annotations {
  return { version: 1, marks: [], stamps: [], counters: { 'num-circle': 1, 'num-square': 1, 'num-solid': 1 } };
}

export function normalizeAnnotations(raw: Partial<Annotations> | null): Annotations {
  const base = emptyAnnotations();
  if (!raw) return base;
  return {
    version: 1,
    marks: raw.marks ?? [],
    stamps: raw.stamps ?? [],
    counters: { ...base.counters, ...raw.counters },
  };
}

// ---------------------------------------------------------------------------
// Colors: a light fill for highlights, a stronger ink for lines.

export const COLORS: { id: MarkColor; name: string; fill: string; ink: string }[] = [
  { id: 'yellow', name: '黄', fill: '#ffe14d', ink: '#d9a400' },
  { id: 'green', name: '绿', fill: '#a6e89a', ink: '#2e9e44' },
  { id: 'blue', name: '蓝', fill: '#a8d2ff', ink: '#1e6fe0' },
  { id: 'pink', name: '粉', fill: '#ffb3d1', ink: '#e0408a' },
  { id: 'red', name: '红', fill: '#ff9e9e', ink: '#e4002b' },
];
export const colorOf = (id: MarkColor) => COLORS.find((c) => c.id === id) ?? COLORS[0];

export const STYLES: { id: MarkStyle; name: string }[] = [
  { id: 'highlight', name: '高亮' },
  { id: 'underline', name: '横线' },
  { id: 'wavy', name: '波浪线' },
];

// ---------------------------------------------------------------------------
// Stamps

export const NUMBER_STAMPS: NumberStampType[] = ['num-circle', 'num-square', 'num-solid'];
export const isNumberStamp = (t: StampType): t is NumberStampType => (NUMBER_STAMPS as string[]).includes(t);

export const STAMPS: { id: StampType; name: string }[] = [
  { id: 'check', name: '对号' },
  { id: 'cross', name: '错号' },
  { id: 'num-circle', name: '圆圈序号' },
  { id: 'num-square', name: '方框序号' },
  { id: 'num-solid', name: '实心序号' },
  { id: 'question', name: '问号' },
  { id: 'exclaim', name: '感叹号' },
  { id: 'star', name: '星号' },
];

/** Default side length as a fraction of the page width. */
export const STAMP_SIZE = 0.055;

// ---------------------------------------------------------------------------
// Geometry

type Box = { x: number; y: number; w: number; h: number };

/**
 * Turns the client rects of a selection into one box per line, relative to
 * the page element. Text layers produce many overlapping fragments, and
 * line breaks produce empty ones.
 */
export function lineBoxes(rects: DOMRectList | DOMRect[], page: DOMRect): Box[] {
  const boxes = [...rects]
    .filter((r) => r.width > 1 && r.height > 1)
    .map((r) => ({ x: r.left - page.left, y: r.top - page.top, w: r.width, h: r.height }))
    .sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const lines: Box[] = [];
  for (const b of boxes) {
    // Same line when the vertical centres are within half a line of each other.
    const line = lines.find((l) => Math.abs(l.y + l.h / 2 - (b.y + b.h / 2)) < Math.min(l.h, b.h) / 2);
    if (!line) {
      lines.push({ ...b });
      continue;
    }
    const right = Math.max(line.x + line.w, b.x + b.w);
    const bottom = Math.max(line.y + line.h, b.y + b.h);
    line.x = Math.min(line.x, b.x);
    line.y = Math.min(line.y, b.y);
    line.w = right - line.x;
    line.h = bottom - line.y;
  }
  return lines;
}

/** A wavy line under a box, in pixels. */
export function wavyPath(x: number, bottom: number, w: number, h: number) {
  const amp = Math.max(1.2, h * 0.09);
  const half = Math.max(2.5, h * 0.2);
  let d = `M ${x} ${bottom} q ${half / 2} ${-amp * 2} ${half} 0`;
  for (let at = x + half; at < x + w - 0.5; at += half) d += ` t ${half} 0`;
  return d;
}
