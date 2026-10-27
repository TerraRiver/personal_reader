import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  api,
  type Book,
  type PaperBlock,
  type PaperTranslation,
  type ParseProgress,
  type TranslatedPiece,
  type TranslationProgress,
} from '../types';
import { isMod } from '../platform';
import { ConfirmDialog, RANGE_PAGES, TranslateDialog } from './RunDialogs';

interface Props {
  book: Book;
  /** The parsed blocks with their translations; null before the book is parsed. */
  translation: PaperTranslation | null;
  progress?: TranslationProgress;
  parseProgress?: ParseProgress;
  currentPage: number;
  follow: boolean;
  onFollowChange(follow: boolean): void;
  selected: string | null;
  /** A block was picked here: show it in the PDF. */
  onSelect(block: PaperBlock): void;
  onPiece(id: string, piece: TranslatedPiece): void;
}

const SHOW_ORIGINAL_KEY = 'reader.translationOriginal';

// ---------------------------------------------------------------------------
// Text: Markdown per piece, with ^12^ for footnote markers and $…$ for formulas.

// One pass, so a marker can't be matched across the ^ inside formulas ($x^2$ … $y^{2}$).
const TOKENS = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\^([^^\s][^^]*?)\^/g;
const MARK = '\u0001';

/** Formulas and markers go into inline code first, so Markdown leaves their insides alone. */
function prepare(text: string) {
  const code = (s: string) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);
  return text
    .replace(/<sup>\s*([^<]*?)\s*<\/sup>/g, '^$1^')
    .replace(TOKENS, (_, display, inline, sup) =>
      code(sup != null ? `${MARK}s${sup}` : `${MARK}${display != null ? 'M' : 'm'}${display ?? inline}`),
    );
}

export const tex = (src: string, displayMode: boolean) =>
  katex.renderToString(src, { displayMode, throwOnError: false, strict: 'ignore' });

const MD_COMPONENTS = {
  code({ children }: { children?: React.ReactNode }) {
    const s = String(children ?? '');
    if (s[0] !== MARK) return <code>{children}</code>;
    const body = s.slice(2);
    if (s[1] === 's') return <sup>{body}</sup>;
    return <span className="math" dangerouslySetInnerHTML={{ __html: tex(body, s[1] === 'M') }} />;
  },
  // Links in papers aren't worth leaving the app for by accident.
  a: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

export const Text = memo(function Text({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {prepare(text)}
    </ReactMarkdown>
  );
});

// Tables arrive as HTML from MinerU and the model; only plain table markup is kept.
const TABLE_TAGS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'SUP', 'SUB', 'B', 'I', 'EM', 'STRONG', 'BR']);
export function safeTable(html: string) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const walk = (node: Element | DocumentFragment) => {
    for (const el of [...node.children]) {
      walk(el);
      if (!TABLE_TAGS.has(el.tagName)) el.replaceWith(...el.childNodes);
      else for (const a of [...el.attributes]) if (a.name !== 'rowspan' && a.name !== 'colspan') el.removeAttribute(a.name);
    }
  };
  walk(t.content);
  return t.innerHTML;
}

// ---------------------------------------------------------------------------

export const shown = (p?: TranslatedPiece) => p?.edit ?? p?.mt;

const inRanges = (ranges: [number, number][], page: number) => ranges.some(([from, to]) => page >= from && page <= to);

/** Blocks in reading order, with runs outside the translated ranges folded into one gap each. */
type Row = { block: PaperBlock } | { gap: [number, number]; first: string };
function rows(blocks: PaperBlock[], ranges: [number, number][]): Row[] {
  const out: Row[] = [];
  for (const b of blocks) {
    const page = b.parts[0].page;
    if (inRanges(ranges, page)) {
      out.push({ block: b });
      continue;
    }
    const last = out.at(-1);
    if (last && 'gap' in last) last.gap[1] = Math.max(last.gap[1], page);
    else out.push({ gap: [page, page], first: b.id });
  }
  return out;
}

export default function TranslationPanel(props: Props) {
  const { book, translation, progress, parseProgress, currentPage, follow, onFollowChange, selected, onSelect } = props;
  const [showOriginal, setShowOriginal] = useState(() => localStorage.getItem(SHOW_ORIGINAL_KEY) === '1');
  const [asking, setAsking] = useState<[number, number] | true | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = (translation?.blocks ?? []).filter((b) => b.kind !== 'skipped');
  const ranges = translation?.ranges ?? [];

  // Turning the PDF brings its first block into view, unless the turn came from a click here.
  const jumped = useRef<number | null>(null);
  useEffect(() => {
    if (jumped.current === currentPage) {
      jumped.current = null;
      return;
    }
    jumped.current = null;
    if (!follow) return;
    const b = blocks.find((x) => x.parts.some((p) => p.page === currentPage));
    if (!b) return;
    const el =
      scroller.current?.querySelector(`[data-id="${b.id}"]`) ??
      [...(scroller.current?.querySelectorAll<HTMLElement>('[data-gap]') ?? [])].find((g) => {
        const [from, to] = g.dataset.gap!.split('-').map(Number);
        return currentPage >= from && currentPage <= to;
      });
    el?.scrollIntoView({ block: 'start' });
    // Only on page turns (and once blocks first arrive), not on every new paragraph.
  }, [currentPage, follow, blocks.length > 0]);

  const pick = (b: PaperBlock) => {
    jumped.current = b.parts[0].page;
    onSelect(b);
  };

  const running = progress && ['queued', 'translating'].includes(progress.state);
  const failed = !running && (progress?.state === 'failed' || book.translation?.state === 'failed');
  const pieces = translation?.pieces ?? {};
  const doneCount = Object.values(pieces).filter((p) => p.mt != null).length;
  const shownRows = rows(blocks, ranges);
  // Pages not translated yet: long books ask which, with the gap clicked as the suggestion.
  const translatePages = (gap?: [number, number]) => {
    if ((book.pageCount || 0) > RANGE_PAGES) setAsking(gap ?? true);
    else api().startTranslation(book.id, gap ?? [1, book.pageCount || 1]);
  };

  return (
    <div className="translation">
      <div className="pane-bar">
        <div className="bar-left">
          <span className="pane-title">译文</span>
          <Status book={book} progress={progress} parseProgress={parseProgress} />
        </div>
        <div className="bar-right">
          <label className="toggle" title="显示每段的英文原文">
            <input
              type="checkbox"
              checked={showOriginal}
              onChange={(e) => {
                setShowOriginal(e.target.checked);
                localStorage.setItem(SHOW_ORIGINAL_KEY, e.target.checked ? '1' : '0');
              }}
            />
            <span className="toggle-box" />
            原文
          </label>
          <label className="toggle" title="开启：翻 PDF 时译文跟到对应段落">
            <input type="checkbox" checked={follow} onChange={(e) => onFollowChange(e.target.checked)} />
            <span className="toggle-box" />
            跟随翻页
          </label>
        </div>
      </div>

      <div className="translation-body" ref={scroller}>
        {!translation?.blocks ? (
          <Unparsed book={book} progress={parseProgress} />
        ) : (
          <>
            {failed && (
              <p className="translation-alert">
                <span className="error">{progress?.error ?? book.translation?.error}</span>
                <button className="link small" onClick={() => api().startTranslation(book.id)}>
                  重试
                </button>
              </p>
            )}
            {!ranges.length && !running && !failed && (
              <div className="translation-empty">
                <p>还没有译文。</p>
                <p className="muted">
                  由大模型逐段翻译成中文。译文按段落排版，点一段即可在 PDF 中定位原文，也可以直接修改。
                  {(book.pageCount || 0) > RANGE_PAGES && ` 这份 PDF 共 ${book.pageCount} 页，可以一次只翻译一部分。`}
                </p>
                <button className="btn btn-primary btn-sm" onClick={() => translatePages()}>
                  开始翻译
                </button>
                <p className="muted small-print">翻译模型在图书馆右上角「设置」里填写。</p>
              </div>
            )}
            {translation.terms && translation.terms.length > 0 && (
              <details className="glossary">
                <summary>
                  术语表 {translation.terms.length} 条{translation.field ? ` · ${translation.field}` : ''}
                </summary>
                <dl>
                  {translation.terms.map((t) => (
                    <div key={t.en}>
                      <dt>{t.en}</dt>
                      <dd>{t.zh}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
            {ranges.length > 0 &&
              shownRows.map((r) =>
                'gap' in r ? (
                  <div className="tgap" key={r.first} data-gap={`${r.gap[0]}-${r.gap[1]}`}>
                    <span className="muted">
                      {r.gap[0] === r.gap[1] ? `第 ${r.gap[0]} 页` : `第 ${r.gap[0]}–${r.gap[1]} 页`}未翻译
                    </span>
                    <button className="link small" onClick={() => translatePages(r.gap)} disabled={!!running}>
                      翻译这部分
                    </button>
                  </div>
                ) : (
                  <Block
                    key={r.block.id}
                    block={r.block}
                    bookId={book.id}
                    pieces={pieces}
                    selected={selected === r.block.id}
                    showOriginal={showOriginal}
                    pending={!!running}
                    onPick={pick}
                    onPiece={props.onPiece}
                  />
                ),
              )}
            {doneCount > 0 && !(shownRows.at(-1) && 'gap' in shownRows.at(-1)!) && (
              <p className="muted translation-end">— 完 —</p>
            )}
          </>
        )}
      </div>
      {asking && (
        <TranslateDialog book={book} initial={asking === true ? undefined : asking} onClose={() => setAsking(null)} />
      )}
    </div>
  );
}

function Status({ book, progress, parseProgress }: { book: Book; progress?: TranslationProgress; parseProgress?: ParseProgress }) {
  if (parseProgress?.state === 'queued') return <span className="muted">等待解析…</span>;
  if (parseProgress?.state === 'parsing')
    return (
      <span className="muted tnum">
        解析 PDF {parseProgress.total ? `${parseProgress.done ?? 0}/${parseProgress.total} 页` : '…'}
      </span>
    );
  if (progress?.state === 'queued') return <span className="muted">等待中…</span>;
  if (progress?.state === 'translating')
    return (
      <span className="translation-progress tnum">
        <span className="progress">
          <span className="progress-bar" style={{ width: `${((progress.done ?? 0) / (progress.total || 1)) * 100}%` }} />
        </span>
        翻译中 {progress.done ?? 0}/{progress.total ?? '…'}
      </span>
    );
  if (book.translation?.state === 'done' || progress?.state === 'done') {
    const pages = book.translation?.pages ?? 0;
    return (
      <span className="tag tag-ocr">
        {pages > 0 && pages < book.pageCount ? `已译 ${pages}/${book.pageCount} 页` : '已翻译'}
      </span>
    );
  }
  return null;
}

/** Before a parse: translating needs one, so offer it (or show how it's going). */
function Unparsed({ book, progress }: { book: Book; progress?: ParseProgress }) {
  const [confirming, setConfirming] = useState(false);
  if (progress && ['queued', 'parsing'].includes(progress.state))
    return (
      <div className="translation-empty">
        <p>正在解析版面…</p>
        <p className="muted">解析完成后就可以翻译了。可以先读原文。</p>
      </div>
    );
  const failed = progress?.state === 'failed' || book.parse?.state === 'failed';
  const start = () => ((book.pageCount || 0) > RANGE_PAGES ? setConfirming(true) : api().startParse(book.id));
  return (
    <div className="translation-empty">
      <p>翻译前需要先解析。</p>
      <p className="muted">
        先用 MinerU 解析出标题、段落、注释、表格和公式，再由大模型逐段翻译成中文。
      </p>
      {failed && <p className="error">{progress?.error ?? book.parse?.error}</p>}
      <button className="btn btn-primary btn-sm" onClick={failed ? () => api().startParse(book.id) : start}>
        {failed ? '重试' : '解析'}
      </button>
      <p className="muted small-print">MinerU 密钥和翻译模型在图书馆右上角「设置」里填写。</p>
      {confirming && (
        <ConfirmDialog
          title="开始解析？"
          confirm="开始解析"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            api().startParse(book.id);
            setConfirming(false);
          }}
        >
          这份 PDF 共 {book.pageCount} 页，解析会用掉同样多的 MinerU 额度（每个账号每天 1,000 页高优先级额度）。超过 200
          页会拆成几块分别解析，再拼接起来。
        </ConfirmDialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BlockProps {
  block: PaperBlock;
  bookId: string;
  pieces: Record<string, TranslatedPiece>;
  selected: boolean;
  showOriginal: boolean;
  pending: boolean;
  onPick(b: PaperBlock): void;
  onPiece(id: string, piece: TranslatedPiece): void;
}

/** The piece ids a block is translated in, with their original text. */
function piecesOf(b: PaperBlock): [string, string][] {
  if (b.kind === 'list') return (b.items ?? []).map((t, j) => [`${b.id}.${j}`, t]);
  if (b.kind === 'image' || b.kind === 'table') {
    const out: [string, string][] = [];
    if (b.caption) out.push([`${b.id}.caption`, b.caption]);
    if (b.footnote) out.push([`${b.id}.footnote`, b.footnote]);
    return out;
  }
  if (b.kind === 'ref' || b.kind === 'equation') return [];
  return [[b.id, b.text ?? '']];
}

const Block = memo(function Block({ block: b, bookId, pieces, selected, showOriginal, pending, onPick, onPiece }: BlockProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = piecesOf(b);
  const edited = own.some(([id]) => pieces[id]?.edit != null);
  const flag = own.map(([id]) => pieces[id]?.flag).find(Boolean);
  // Only blocks of a single piece are edited in place; lists and captions keep it simple.
  const single = own.length === 1 && b.kind !== 'table' ? own[0] : null;

  const piece = (id: string) => {
    const t = shown(pieces[id]);
    if (t != null) return <Text text={t} />;
    return <p className="pending">{pending ? '（翻译中）' : '（未译出）'}</p>;
  };
  const original = (text: string) =>
    showOriginal && (
      <div className="original">
        <Text text={text} />
      </div>
    );

  let content: React.ReactNode;
  switch (b.kind) {
    case 'heading': {
      const H = (b.level ?? 2) <= 1 ? 'h3' : 'h4';
      content = (
        <>
          <H>{shown(pieces[b.id]) != null ? <Text text={shown(pieces[b.id])!} /> : b.text}</H>
          {original(b.text ?? '')}
        </>
      );
      break;
    }
    case 'ref':
      content = <Text text={b.text ?? ''} />;
      break;
    case 'equation':
      content = <div className="math" dangerouslySetInnerHTML={{ __html: tex((b.latex ?? '').replace(/^\$\$|\$\$$/g, ''), true) }} />;
      break;
    case 'list':
      content = (
        <ul>
          {own.map(([id, t]) => (
            <li key={id}>
              {piece(id)}
              {original(t)}
            </li>
          ))}
        </ul>
      );
      break;
    case 'image':
    case 'table': {
      const cap = own.map(([id, t]) => (
        <div className="caption" key={id}>
          {piece(id)}
          {original(t)}
        </div>
      ));
      const html = b.kind === 'table' && (shown(pieces[`${b.id}.html`]) ?? b.html);
      content = (
        <>
          {cap}
          {html ? (
            <div className="table" dangerouslySetInnerHTML={{ __html: safeTable(html) }} />
          ) : (
            <button className="link small figure-link" onClick={() => onPick(b)}>
              {b.kind === 'table' ? '表' : '图'} · 见 PDF 第 {b.parts[0].page} 页
            </button>
          )}
        </>
      );
      break;
    }
    default:
      content = (
        <>
          {piece(b.id)}
          {original(b.text ?? '')}
        </>
      );
  }

  const save = async (text: string | null) => {
    if (!single) return;
    const next = await api().editTranslation(bookId, single[0], text);
    if (next) onPiece(single[0], next);
    setEditing(null);
  };
  const retranslate = async () => {
    if (!single) return;
    setBusy(true);
    setError(null);
    const res = await api().retranslatePiece(bookId, single[0]);
    setBusy(false);
    if (res.piece) onPiece(single[0], res.piece);
    else setError(res.error ?? '重译失败');
  };

  return (
    <div
      className={`tblock tblock-${b.kind}${selected ? ' on' : ''}`}
      data-id={b.id}
      onClick={(e) => {
        if (editing == null && !(e.target as HTMLElement).closest('button, textarea')) onPick(b);
      }}
      onDoubleClick={() => single && editing == null && !pending && setEditing(shown(pieces[single[0]]) ?? '')}
    >
      {editing != null && single ? (
        <Editor original={single[1]} value={editing} onSave={(t) => save(t)} onCancel={() => setEditing(null)} />
      ) : (
        content
      )}
      {(edited || flag || error) && editing == null && (
        <div className="tblock-tags">
          {edited && <span className="tag">已修改</span>}
          {flag && <span className="tag tag-none" title="可能漏掉或多出了脚注序号，建议对照原文看一下">{flag}</span>}
          {error && <span className="error">{error}</span>}
        </div>
      )}
      {single && editing == null && shown(pieces[single[0]]) != null && (
        <div className="tblock-actions">
          <button className="link small" onClick={() => setEditing(shown(pieces[single[0]]) ?? '')}>
            编辑
          </button>
          <button className="link small" onClick={retranslate} disabled={busy} title={edited ? '会替换掉你的修改' : undefined}>
            {busy ? '重译中…' : '重译'}
          </button>
          {pieces[single[0]]?.edit != null && pieces[single[0]]?.mt != null && (
            <button className="link small" onClick={() => save(null)}>
              恢复机器译文
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function Editor({ original, value, onSave, onCancel }: { original: string; value: string; onSave(t: string): void; onCancel(): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="tedit">
      <div className="original">
        <Text text={original} />
      </div>
      <textarea
        ref={ref}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && isMod(e.nativeEvent)) onSave(text);
        }}
      />
      <div className="tedit-bar">
        <span className="muted">Markdown；脚注序号写作 ^12^，公式写作 $…$</span>
        <button className="link small" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => onSave(text)}>
          保存
        </button>
      </div>
    </div>
  );
}
