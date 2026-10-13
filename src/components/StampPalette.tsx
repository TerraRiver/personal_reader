import { useEffect, useRef } from 'react';
import type { Annotations, MarkColor, NumberStampType, StampType } from '../types';
import { COLORS, NUMBER_STAMPS, STAMPS, isNumberStamp } from '../annotations';
import { StampGlyph } from './Annotations';

interface Props {
  counters: Annotations['counters'];
  placing: StampType | null;
  color: MarkColor;
  onColor(color: MarkColor): void;
  onPick(type: StampType | null): void;
  onCounter(type: NumberStampType, next: number): void;
  onClose(): void;
}

/** Stamp picker. Picking a stamp starts placing it; each click on the page places one. */
export default function StampPalette({ counters, placing, color, onColor, onPick, onCounter, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on a click outside, unless that click places a stamp.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest('.stamp-toggle, .stamp-capture, .stamp')) return;
      onClose();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  return (
    <div className="stamp-palette" ref={ref}>
      <div className="stamp-palette-colors">
        <span className="muted">颜色</span>
        {COLORS.map((c) => (
          <button
            key={c.id}
            className={`swatch${c.id === color ? ' active' : ''}`}
            style={{ background: c.ink, borderColor: c.ink }}
            title={c.name}
            onClick={() => onColor(c.id)}
          />
        ))}
        <span className="muted stamp-palette-tip">已盖的图章选中后也能改颜色</span>
      </div>
      <div className="stamp-grid">
        {STAMPS.map(({ id, name }) => {
          const numbered = isNumberStamp(id) ? id : null;
          return (
            <div key={id} className={`stamp-cell${placing === id ? ' active' : ''}`}>
              <button className="stamp-pick" onClick={() => onPick(placing === id ? null : id)} title={name}>
                <StampGlyph type={id} n={numbered ? counters[numbered] : undefined} color={color} />
              </button>
              <span className="stamp-name">{name}</span>
              {numbered && (
                <span className="stamp-counter" title="下一个盖出的号码，整本书连续">
                  <button
                    className="icon-btn"
                    onClick={() => onCounter(numbered, counters[numbered] - 1)}
                    disabled={counters[numbered] <= 1}
                  >
                    −
                  </button>
                  <span className="count">{counters[numbered]}</span>
                  <button className="icon-btn" onClick={() => onCounter(numbered, counters[numbered] + 1)}>
                    +
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="stamp-foot">
        {placing ? (
          <span>点击页面盖章，可连续盖 · Esc 或关闭面板结束</span>
        ) : (
          <span className="muted">选一个图章，再点击页面。盖好的图章可拖动、拖角缩放，序号选中后按数字键改。</span>
        )}
        <button
          className="link small"
          onClick={() => NUMBER_STAMPS.forEach((t) => onCounter(t, 1))}
          title="三种序号都从 1 重新开始，比如进入新的一章"
        >
          序号从 1 开始
        </button>
      </div>
    </div>
  );
}
