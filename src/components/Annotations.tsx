import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MarkColor, MarkStyle, Stamp, StampType, TextMark } from '../types';
import { COLORS, STYLES, colorOf, isNumberStamp, lineBoxes, wavyPath } from '../annotations';

const COLOR_KEY = 'reader.markColor';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// ---------------------------------------------------------------------------
// Stamp artwork, drawn in a 100 × 100 box.

export function StampGlyph({ type, n, color = 'red' }: { type: StampType; n?: number; color?: MarkColor }) {
  const INK = colorOf(color).ink;
  const num = String(n ?? 1);
  const numSize = num.length > 2 ? 34 : num.length > 1 ? 44 : 56;
  const text = (fill: string, size = numSize) => (
    <text x="50" y="52" textAnchor="middle" dominantBaseline="central" fontSize={size} fontWeight={700} fill={fill}>
      {num}
    </text>
  );
  const round = { fill: 'none', stroke: INK, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg viewBox="0 0 100 100" className="stamp-glyph" aria-hidden>
      {type === 'check' && <polyline points="16,54 40,78 86,24" strokeWidth={11} {...round} />}
      {type === 'cross' && <path d="M22 22 L78 78 M78 22 L22 78" strokeWidth={11} {...round} />}
      {type === 'num-circle' && (
        <>
          <circle cx="50" cy="50" r="43" strokeWidth={6} {...round} />
          {text(INK)}
        </>
      )}
      {type === 'num-square' && (
        <>
          <rect x="8" y="8" width="84" height="84" strokeWidth={6} {...round} />
          {text(INK)}
        </>
      )}
      {type === 'num-solid' && (
        <>
          <circle cx="50" cy="50" r="46" fill={INK} />
          {text('#fff')}
        </>
      )}
      {type === 'question' && (
        <path
          d="M30 34 C30 18 42 10 52 10 C66 10 74 20 74 31 C74 44 60 48 55 56 C53 59 52 62 52 68 M52 86 L52 87"
          strokeWidth={11}
          {...round}
        />
      )}
      {type === 'exclaim' && <path d="M50 12 L50 64 M50 86 L50 87" strokeWidth={12} {...round} />}
      {type === 'star' && (
        <polygon
          points="50,6 62,38 96,38 68,58 79,92 50,72 21,92 32,58 4,38 38,38"
          fill={INK}
          stroke={INK}
          strokeWidth={4}
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Text marks, drawn under the text layer so the text stays selectable.

export function MarksUnderlay({ marks, width, height }: { marks: TextMark[]; width: number; height: number }) {
  return (
    <svg className="marks-layer" width={width} height={height}>
      {marks.map((m) => {
        const c = colorOf(m.color);
        return m.rects.map(([x, y, w, h], i) => {
          const px = { x: x * width, y: y * height, w: w * width, h: h * height };
          const stroke = Math.max(1, px.h * 0.08);
          const bottom = px.y + px.h + stroke / 2;
          if (m.style === 'highlight')
            return <rect key={`${m.id}-${i}`} x={px.x} y={px.y} width={px.w} height={px.h} fill={c.fill} />;
          if (m.style === 'underline')
            return (
              <line
                key={`${m.id}-${i}`}
                x1={px.x}
                x2={px.x + px.w}
                y1={bottom}
                y2={bottom}
                stroke={c.ink}
                strokeWidth={stroke}
              />
            );
          return (
            <path
              key={`${m.id}-${i}`}
              d={wavyPath(px.x, bottom, px.w, px.h)}
              fill="none"
              stroke={c.ink}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          );
        });
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Everything above the text layer: the toolbar for selections and marks,
// stamps, and stamp placing.

interface OverlayProps {
  page: number;
  width: number;
  height: number;
  marks: TextMark[];
  stamps: Stamp[];
  /** The stamp being placed, or null. */
  placing: StampType | null;
  autoCopy: boolean;
  onAddMark(mark: Omit<TextMark, 'id' | 'createdAt' | 'page'>): void;
  onUpdateMark(id: string, patch: Partial<TextMark>): void;
  onDeleteMark(id: string): void;
  onPlaceStamp(x: number, y: number): void;
  /** `group`: successive updates in the same group undo as one step. */
  onUpdateStamp(id: string, patch: Partial<Stamp>, group?: string): void;
  onDeleteStamp(id: string): void;
}

type Bar =
  | { kind: 'selection'; boxes: { x: number; y: number; w: number; h: number }[]; text: string; copied: boolean }
  | { kind: 'mark'; id: string };

export function AnnotationOverlay(props: OverlayProps) {
  const { width, height, marks, stamps, placing, autoCopy } = props;
  const root = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const [selectedStamp, setSelectedStamp] = useState<string | null>(null);
  const [color, setColorState] = useState<MarkColor>(() => {
    try {
      return (localStorage.getItem(COLOR_KEY) as MarkColor) || 'yellow';
    } catch {
      return 'yellow';
    }
  });
  const setColor = (c: MarkColor) => {
    setColorState(c);
    try {
      localStorage.setItem(COLOR_KEY, c);
    } catch {
      // Remembering the color is a convenience only.
    }
  };

  const latest = useRef(props);
  latest.current = props;

  // ----- selections and clicks on the page -----
  useEffect(() => {
    const pageEl = root.current?.parentElement;
    if (!pageEl) return;
    const onUp = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.stamp, .mark-bar')) return;
      // Let the selection settle first.
      setTimeout(() => {
        const sel = getSelection();
        const textLayer = pageEl.querySelector('.textLayer');
        const rect = pageEl.getBoundingClientRect();
        if (sel && !sel.isCollapsed && textLayer?.contains(sel.anchorNode) && textLayer.contains(sel.focusNode)) {
          const text = sel.toString().trim();
          const boxes = lineBoxes(sel.getRangeAt(0).getClientRects(), rect);
          if (!text || !boxes.length) return;
          setSelectedStamp(null);
          let copied = false;
          if (latest.current.autoCopy) {
            navigator.clipboard.writeText(text).catch(() => {});
            copied = true;
          }
          setBar({ kind: 'selection', boxes, text, copied });
          return;
        }
        // A plain click: open the mark under the pointer, if any.
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        const hit = [...latest.current.marks]
          .reverse()
          .find((m) => m.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh * 1.3));
        setSelectedStamp(null);
        setBar(hit ? { kind: 'mark', id: hit.id } : null);
      });
    };
    pageEl.addEventListener('mouseup', onUp);
    return () => pageEl.removeEventListener('mouseup', onUp);
  }, []);

  // The toolbar for a selection goes away with the selection.
  useEffect(() => {
    if (bar?.kind !== 'selection') return;
    const onChange = () => {
      if (getSelection()?.isCollapsed) setBar(null);
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [bar]);

  // Esc closes the toolbar; Delete removes the selected stamp; digits renumber
  // a selected number stamp (typed in a row they form one number, e.g. 1 2 -> 12).
  const typed = useRef({ id: '', text: '', at: 0 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        setBar(null);
        setSelectedStamp(null);
      }
      const stamp = latest.current.stamps.find((s) => s.id === selectedStamp);
      if (stamp && isNumberStamp(stamp.type)) {
        const t = typed.current;
        const typing = t.id === stamp.id && performance.now() - t.at < 1000;
        if (/^[0-9]$/.test(e.key) || (e.key === 'Backspace' && typing && t.text)) {
          e.preventDefault();
          const text = e.key === 'Backspace' ? t.text.slice(0, -1) : ((typing ? t.text : '') + e.key).slice(-3);
          typed.current = { id: stamp.id, text, at: performance.now() };
          const n = parseInt(text, 10);
          if (n > 0) latest.current.onUpdateStamp(stamp.id, { n }, `renumber:${stamp.id}`);
          return;
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedStamp) {
        e.preventDefault();
        latest.current.onDeleteStamp(selectedStamp);
        setSelectedStamp(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedStamp]);

  const apply = (style: MarkStyle) => {
    if (bar?.kind !== 'selection') return;
    props.onAddMark({
      style,
      color,
      text: bar.text,
      rects: bar.boxes.map((b) => [b.x / width, b.y / height, b.w / width, b.h / height]),
    });
    getSelection()?.removeAllRanges();
    setBar(null);
  };

  const mark = bar?.kind === 'mark' ? marks.find((m) => m.id === bar.id) : undefined;
  const anchor =
    bar?.kind === 'selection'
      ? bar.boxes
      : mark?.rects.map(([x, y, w, h]) => ({ x: x * width, y: y * height, w: w * width, h: h * height }));

  return (
    <div className="annotation-overlay" ref={root}>
      {placing && (
        <div
          className="stamp-capture"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            props.onPlaceStamp((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          }}
        />
      )}

      {stamps.map((s) => (
        <StampItem
          key={s.id}
          stamp={s}
          width={width}
          height={height}
          selected={selectedStamp === s.id}
          onSelect={() => {
            setSelectedStamp(s.id);
            setBar(null);
          }}
          onChange={(patch) => props.onUpdateStamp(s.id, patch)}
          onDelete={() => {
            props.onDeleteStamp(s.id);
            setSelectedStamp(null);
          }}
        />
      ))}

      {bar && anchor?.length ? (
        <MarkBar
          anchor={anchor}
          width={width}
          height={height}
          color={mark?.color ?? color}
          style={mark?.style}
          copied={bar.kind === 'selection' && bar.copied}
          onColor={(c) => {
            setColor(c);
            if (mark) props.onUpdateMark(mark.id, { color: c });
          }}
          onStyle={(st) => (mark ? props.onUpdateMark(mark.id, { style: st }) : apply(st))}
          onCopy={
            mark
              ? () => {
                  navigator.clipboard.writeText(mark.text).catch(() => {});
                  setBar(null);
                }
              : undefined
          }
          onDelete={
            mark
              ? () => {
                  props.onDeleteMark(mark.id);
                  setBar(null);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MarkBar({
  anchor,
  width,
  height,
  color,
  style,
  copied,
  onColor,
  onStyle,
  onCopy,
  onDelete,
}: {
  anchor: { x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
  color: MarkColor;
  /** Set when editing an existing mark. */
  style?: MarkStyle;
  copied: boolean;
  onColor(c: MarkColor): void;
  onStyle(s: MarkStyle): void;
  onCopy?(): void;
  onDelete?(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // Below the last line, or above the first when there's no room; kept on the page.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = anchor[anchor.length - 1];
    const first = anchor[0];
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    let top = last.y + last.h + 10;
    if (top + bh > height - 4) top = Math.max(4, first.y - bh - 10);
    const left = Math.min(Math.max(4, last.x + last.w - bw / 2), Math.max(4, width - bw - 4));
    setPos({ left, top });
  }, [anchor, width, height]);

  return (
    <div
      ref={ref}
      className="mark-bar"
      style={pos}
      // Keep the text selection while using the toolbar.
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="mark-swatches">
        {COLORS.map((c) => (
          <button
            key={c.id}
            className={`swatch${c.id === color ? ' active' : ''}`}
            style={{ background: c.fill, borderColor: c.ink }}
            title={c.name}
            onClick={() => onColor(c.id)}
          />
        ))}
      </span>
      <span className="mark-styles">
        {STYLES.map((s) => (
          <button key={s.id} className={s.id === style ? 'active' : ''} onClick={() => onStyle(s.id)}>
            <StyleIcon style={s.id} color={color} />
            {s.name}
          </button>
        ))}
      </span>
      {(onCopy || onDelete || copied) && (
        <span className="mark-extra">
          {copied && <span className="muted">已复制</span>}
          {onCopy && (
            <button className="link small" onClick={onCopy}>
              复制
            </button>
          )}
          {onDelete && (
            <button className="link small danger" onClick={onDelete}>
              删除
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function StyleIcon({ style, color }: { style: MarkStyle; color: MarkColor }) {
  const c = colorOf(color);
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden>
      {style === 'highlight' && <rect x="1" y="2" width="16" height="10" fill={c.fill} />}
      {style === 'underline' && <line x1="1" x2="17" y1="11" y2="11" stroke={c.ink} strokeWidth="2" />}
      {style === 'wavy' && <path d={wavyPath(1, 11, 16, 9)} fill="none" stroke={c.ink} strokeWidth="1.6" />}
      <text x="9" y="9" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">
        文
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const MIN_SIDE = 14; // px

function StampItem({
  stamp,
  width,
  height,
  selected,
  onSelect,
  onChange,
  onDelete,
}: {
  stamp: Stamp;
  width: number;
  height: number;
  selected: boolean;
  onSelect(): void;
  onChange(patch: Partial<Stamp>): void;
  onDelete(): void;
}) {
  // Live geometry while dragging; committed on release.
  const [live, setLive] = useState<{ x: number; y: number; size: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const g = live ?? stamp;
  const side = g.size * width;

  const drag = useCallback(
    (e: React.PointerEvent, corner?: Corner) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect();
      const start = { px: e.clientX, py: e.clientY, x: stamp.x * width, y: stamp.y * height, side: stamp.size * width };
      let next = { x: stamp.x, y: stamp.y, size: stamp.size };
      let moved = false;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - start.px;
        const dy = ev.clientY - start.py;
        if (!moved && Math.hypot(dx, dy) < 2) return;
        moved = true;
        if (!corner) {
          next = { ...next, x: (start.x + dx) / width, y: (start.y + dy) / height };
        } else {
          // The opposite corner stays put.
          const sx = corner.includes('e') ? 1 : -1;
          const sy = corner.includes('s') ? 1 : -1;
          const ax = start.x - (sx * start.side) / 2;
          const ay = start.y - (sy * start.side) / 2;
          const cx = start.x + (sx * start.side) / 2 + dx; // where the dragged corner is now
          const cy = start.y + (sy * start.side) / 2 + dy;
          const s = Math.max(MIN_SIDE, sx * (cx - ax), sy * (cy - ay));
          next = { x: (ax + (sx * s) / 2) / width, y: (ay + (sy * s) / 2) / height, size: s / width };
        }
        setLive(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setLive(null);
        if (moved) onChange(next);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [stamp, width, height, onSelect, onChange],
  );

  return (
    <div
      className={`stamp${selected ? ' selected' : ''}`}
      style={{ left: g.x * width - side / 2, top: g.y * height - side / 2, width: side, height: side }}
      onPointerDown={(e) => drag(e)}
      onDoubleClick={() => isNumberStamp(stamp.type) && setEditing(true)}
      title={isNumberStamp(stamp.type) ? '拖动移动；选中后按数字键改号码' : '拖动移动'}
    >
      <StampGlyph type={stamp.type} n={stamp.n} color={stamp.color} />
      {selected &&
        (['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => (
          <span key={c} className={`stamp-handle ${c}`} onPointerDown={(e) => drag(e, c)} />
        ))}
      {selected && !live && (
        <span className="stamp-colors" onPointerDown={(e) => e.stopPropagation()}>
          {COLORS.map((c) => (
            <button
              key={c.id}
              className={`swatch${c.id === (stamp.color ?? 'red') ? ' active' : ''}`}
              style={{ background: c.ink, borderColor: c.ink }}
              title={c.name}
              onClick={() => onChange({ color: c.id })}
            />
          ))}
        </span>
      )}
      {selected && (
        <button
          className="stamp-delete"
          title="删除（Delete）"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
        >
          ×
        </button>
      )}
      {editing && (
        <input
          className="stamp-number"
          autoFocus
          defaultValue={stamp.n}
          onPointerDown={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = String(stamp.n ?? '');
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            setEditing(false);
            const n = parseInt(e.currentTarget.value, 10);
            if (n > 0 && n < 1000 && n !== stamp.n) onChange({ n });
          }}
        />
      )}
    </div>
  );
}
