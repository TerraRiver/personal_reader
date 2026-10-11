import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjs } from '../pdf';

const PAD = 32; // space around the page
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

export interface PdfViewerHandle {
  goTo(page: number): void;
}

interface Props {
  data: Uint8Array;
  initialPage: number;
  /** Pages where a note starts / was cut, marked on the page edges. */
  startPages?: number[];
  cutPages?: number[];
  onLoad?(doc: PDFDocumentProxy): void;
  /** Extra controls at the start of the toolbar, and a caption in its middle. */
  barStart?: ReactNode;
  barCenter?: ReactNode;
  onPageChange?(page: number): void;
}

type Zoom = 'fit' | number;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { data, initialPage, startPages = [], cutPages = [], onLoad, onPageChange, barStart, barCenter },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageProxy, setPageProxy] = useState<PDFPageProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(initialPage);
  const [dir, setDir] = useState<1 | -1>(1);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [box, setBox] = useState({ w: 0, h: 0 });

  const numPages = doc?.numPages ?? 0;

  // ----- load document -----
  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ data: data.slice() });
    task.promise
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setPage((p) => Math.min(Math.max(1, p), d.numPages));
        onLoad?.(d);
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
      task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc.getPage(page).then((p) => !cancelled && setPageProxy(p));
    // Warm up the neighbours so turning feels instant.
    if (page < doc.numPages) doc.getPage(page + 1);
    if (page > 1) doc.getPage(page - 1);
    setPageInput(String(page));
    onPageChange?.(page);
    stageRef.current?.scrollTo(0, 0);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page]);

  // ----- navigation -----
  const goTo = useCallback(
    (p: number) => {
      if (!numPages) return;
      const next = Math.min(numPages, Math.max(1, Math.round(p)));
      setPage((cur) => {
        if (next !== cur) setDir(next > cur ? 1 : -1);
        return next;
      });
    },
    [numPages],
  );
  const turn = useCallback(
    (d: 1 | -1) =>
      setPage((cur) => {
        const next = Math.min(Math.max(1, cur + d), numPages || 1);
        if (next !== cur) setDir(d);
        return next;
      }),
    [numPages],
  );
  useImperativeHandle(ref, () => ({ goTo }), [goTo]);

  // ----- size / scale -----
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vp = pageProxy?.getViewport({ scale: 1 });
  const fitScale = vp ? Math.min((box.w - PAD * 2) / vp.width, (box.h - PAD * 2) / vp.height) : 1;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoom === 'fit' ? fitScale : zoom));

  const setScale = useCallback((s: number) => {
    setZoom(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100)));
  }, []);

  // ----- input: keys, wheel, pinch -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = stageRef.current;
      const overflowY = !!el && el.scrollHeight > el.clientHeight + 1;
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
          turn(1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          turn(-1);
          break;
        case ' ':
          turn(e.shiftKey ? -1 : 1);
          break;
        case 'ArrowDown':
          if (overflowY) return;
          turn(1);
          break;
        case 'ArrowUp':
          if (overflowY) return;
          turn(-1);
          break;
        case 'Home':
          goTo(1);
          break;
        case 'End':
          goTo(numPages);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, goTo, numPages]);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // One trackpad gesture turns one page: after a turn, ignore the rest of the
    // gesture (including inertia) until the wheel has been quiet for a moment.
    let acc = 0;
    let last = 0;
    let locked = false;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        setScale(scaleRef.current * Math.exp(-e.deltaY * 0.01));
        return;
      }
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const delta = horizontal ? e.deltaX : e.deltaY;
      const canScroll = horizontal
        ? el.scrollWidth > el.clientWidth + 1
        : el.scrollHeight > el.clientHeight + 1;
      if (canScroll) return; // zoomed in: scroll within the page
      e.preventDefault();
      const now = performance.now();
      if (now - last > 200) {
        acc = 0;
        locked = false;
      }
      last = now;
      if (locked) return;
      acc += delta;
      if (Math.abs(acc) > 40) {
        turn(acc > 0 ? 1 : -1);
        locked = true;
        acc = 0;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setScale, turn]);

  const isCut = cutPages.includes(page);
  const isStart = startPages.includes(page);

  return (
    <div className="pdf">
      <div className="pane-bar">
        <div className="bar-left">
        {barStart}
        <div className="pager">
          <button className="icon-btn" onClick={() => turn(-1)} disabled={page <= 1} title="上一页 ←">
            ‹
          </button>
          <input
            className="page-input"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                goTo(Number(e.currentTarget.value) || 1);
                e.currentTarget.blur();
              }
            }}
            onBlur={() => setPageInput(String(page))}
          />
          <span className="muted">/ {numPages || '—'}</span>
          <button className="icon-btn" onClick={() => turn(1)} disabled={page >= numPages} title="下一页 →">
            ›
          </button>
        </div>
        </div>
        <div className="bar-caption">{barCenter}</div>
        <div className="zoom">
          <button className="icon-btn" onClick={() => setScale(scale / 1.15)} title="缩小">
            −
          </button>
          <button
            className={`zoom-label${zoom === 'fit' ? ' active' : ''}`}
            onClick={() => setZoom('fit')}
            title="适应页面"
          >
            {Math.round(scale * 100)}%
          </button>
          <button className="icon-btn" onClick={() => setScale(scale * 1.15)} title="放大">
            +
          </button>
        </div>
      </div>

      <div className="pdf-body">
        <div className="pdf-stage" ref={stageRef}>
          {error && <div className="pdf-error">无法打开 PDF：{error}</div>}
          {pageProxy && vp && (
            <div className="pdf-sheet" style={{ padding: PAD }}>
              <PdfPage
                page={pageProxy}
                scale={scale}
                dir={dir}
                width={vp.width * scale}
                height={vp.height * scale}
                cut={isCut}
                start={isStart}
              />
            </div>
          )}
        </div>
        <button className="turn-zone prev" onClick={() => turn(-1)} disabled={page <= 1} aria-label="上一页">
          ‹
        </button>
        <button className="turn-zone next" onClick={() => turn(1)} disabled={page >= numPages} aria-label="下一页">
          ›
        </button>
      </div>
      <div className="pdf-progress">
        <div style={{ width: numPages ? `${(page / numPages) * 100}%` : 0 }} />
      </div>
    </div>
  );
});

export default PdfViewer;

// ---------------------------------------------------------------------------

interface PageProps {
  page: PDFPageProxy;
  scale: number;
  dir: 1 | -1;
  width: number;
  height: number;
  cut: boolean;
  start: boolean;
}

function PdfPage({ page, scale, dir, width, height, cut, start }: PageProps) {
  const sheet = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const shownPage = useRef<PDFPageProxy | null>(null);

  // Debounce re-rendering during rapid zooming; the old bitmap is stretched meanwhile.
  const [renderScale, setRenderScale] = useState(scale);
  useEffect(() => {
    const t = setTimeout(() => setRenderScale(scale), 120);
    return () => clearTimeout(t);
  }, [scale]);

  useEffect(() => {
    const host = canvasHost.current;
    const textDiv = textHost.current;
    if (!host || !textDiv) return;

    // A page turn renders at the current scale right away.
    const s = shownPage.current === page ? renderScale : scale;
    const viewport = page.getViewport({ scale: s });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    const task = page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });

    let textLayer: pdfjs.TextLayer | null = null;
    let cancelled = false;

    task.promise
      .then(() => {
        if (cancelled) return;
        const turned = shownPage.current !== null && shownPage.current !== page;
        shownPage.current = page;
        host.replaceChildren(canvas);
        textDiv.replaceChildren();
        if (turned)
          sheet.current?.animate(
            [
              { transform: `translateX(${dir * 28}px)`, opacity: 0 },
              { transform: 'translateX(0)', opacity: 1 },
            ],
            { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' },
          );
        textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textDiv,
          viewport,
        });
        return textLayer.render();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      task.cancel();
      textLayer?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, renderScale]);

  return (
    <div
      ref={sheet}
      className={`pdf-page${cut ? ' cut' : ''}${start ? ' start' : ''}`}
      style={
        {
          width,
          height,
          '--scale-factor': scale,
          '--total-scale-factor': scale,
          '--user-unit': 1,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as React.CSSProperties
      }
    >
      <div className="canvas-host" ref={canvasHost} />
      <div className="textLayer" ref={textHost} />
      {start && <div className="start-mark">笔记从本页开始</div>}
      {cut && <div className="cut-mark">截断于本页</div>}
    </div>
  );
}
