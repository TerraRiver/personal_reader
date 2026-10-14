import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Book, Notebook } from '../types';
import { CITE_HREF, citation, pdfPageOf, printedPage, remarkCitations } from '../citation';
import { isMod, shortcut } from '../platform';
import {
  type NoteView,
  canStart,
  covers,
  cutNote,
  cutTarget,
  deleteNote,
  headline,
  parseRange,
  rangeLabel,
  restoreNote,
  startNote,
  stripFront,
} from '../notes';

interface Props {
  notebook: Notebook;
  views: NoteView[];
  activeId: string | null;
  currentPage: number;
  follow: boolean;
  onFollowChange(follow: boolean): void;
  onSelect(id: string): void;
  /** Replace the notebook; optionally switch to another note. */
  onEdit(next: Notebook, activeId?: string | null): void;
  onGoTo(page: number): void;
  book: Book;
  onUpdateBook(patch: Partial<Book>): void;
}

type Overlay = 'index' | 'trash' | 'free' | null;
type Mode = 'source' | 'preview';

const pad = (n: number) => String(n).padStart(2, '0');

export default function NotesPanel(props: Props) {
  const { notebook, views, activeId, currentPage, follow, onFollowChange, onEdit } = props;
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [mode, setMode] = useState<Mode>('source');

  const view = views.find((v) => v.seg.id === activeId);
  const here = views.filter((v) => covers(v, currentPage));
  const startable = canStart(views, currentPage);
  const target = cutTarget(views, currentPage, activeId);

  // ⌘E / Ctrl+E toggles source / preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMod(e) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setMode((m) => (m === 'source' ? 'preview' : 'source'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const start = () => {
    const { notebook: next, id } = startNote(notebook, currentPage);
    setMode('source');
    setOverlay(null);
    onEdit(next, id);
  };

  const cut = () => {
    if (!target) return;
    onEdit(cutNote(notebook, target.seg.id, currentPage), target.seg.id);
  };

  // ----- citations: [p n] with the page number printed in the book -----
  const { book, onUpdateBook } = props;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const freeRef = useRef<HTMLTextAreaElement>(null);
  // Citations go into the free note while it's open, otherwise into the page note.
  const citeRef = overlay === 'free' ? freeRef : textRef;
  const caret = useRef({ start: 0, end: 0 });
  const [askStart, setAskStart] = useState<'insert' | 'edit' | null>(null);
  const [frontHint, setFrontHint] = useState(false);
  const canCite = mode === 'source' && (overlay === 'free' || !!view);
  const printed = book.bodyStart ? printedPage(currentPage, book.bodyStart) : undefined;

  const insertCitation = (bodyStart: number) => {
    const el = citeRef.current;
    if (!el) return;
    const n = printedPage(currentPage, bodyStart);
    el.focus();
    el.setSelectionRange(caret.current.start, caret.current.end);
    // Inserted as typing, so ⌘Z takes it back out.
    document.execCommand('insertText', false, citation(n));
    if (n === null) {
      // Select the x, ready to be typed over.
      const end = el.selectionStart;
      el.setSelectionRange(end - 2, end - 1);
      if (!book.citeHintOff) setFrontHint(true);
    }
  };

  const cite = () => {
    const el = citeRef.current;
    if (!el) return;
    caret.current = { start: el.selectionStart, end: el.selectionEnd };
    if (book.bodyStart) insertCitation(book.bodyStart);
    else setAskStart('insert');
  };

  const toggle = (o: Overlay) => setOverlay((cur) => (cur === o ? null : o));

  return (
    <div className="notes">
      <div className="pane-bar">
        <div className="bar-left">
          <button className={`link${overlay === 'index' ? ' on' : ''}`} onClick={() => toggle('index')}>
            笔记列表<span className="count-badge">{pad(views.length)}</span>
          </button>
          <button className={`link${overlay === 'trash' ? ' on' : ''}`} onClick={() => toggle('trash')}>
            废纸篓<span className="count-badge">{pad(notebook.trash.length)}</span>
          </button>
          <button
            className={`link${overlay === 'free' ? ' on' : ''}`}
            onClick={() => toggle('free')}
            title="这本书的自由笔记，不和页码绑定"
          >
            自由写{notebook.free?.content.trim() && <span className="free-dot" />}
          </button>
        </div>
        <div className="bar-right">
          <label
            className="toggle"
            title="开启：翻 PDF 时切换到对应的笔记，选笔记时 PDF 翻到它的页码。关闭：两边互不跟随"
          >
            <input type="checkbox" checked={follow} onChange={(e) => onFollowChange(e.target.checked)} />
            <span className="toggle-box" />
            跟随翻页
          </label>
          <div className="segmented" title={shortcut('E')}>
            <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')}>
              源码
            </button>
            <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
              预览
            </button>
          </div>
        </div>
      </div>

      <div className="action-bar">
        <button
          className="btn btn-primary btn-sm"
          disabled={!startable}
          onClick={start}
          title={
            startable
              ? `从第 ${currentPage} 页开始一篇新笔记`
              : `第 ${currentPage} 页已有笔记。只能在没有笔记的页，或上一篇的截断页开始新笔记`
          }
        >
          开始笔记
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={!target}
          onClick={cut}
          title={
            target
              ? `笔记 ${pad(target.no)} 在第 ${currentPage} 页截断`
              : `第 ${currentPage} 页没有书写中的笔记`
          }
        >
          截断
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={!canCite}
          onMouseDown={(e) => e.preventDefault()} // keep the caret in the note
          onClick={cite}
          title={
            !canCite && mode === 'source'
              ? '打开一篇笔记后可以插入引注'
              : mode === 'source'
                ? '在光标处插入当前页的引注 [p 页码]'
                : '切换到源码后可以插入引注'
          }
        >
          插入引注
        </button>
        <span className="spacer" />
        {book.bodyStart ? (
          <button
            className="action-page action-page-link"
            onClick={() => setAskStart('edit')}
            title={`正文第 1 页 = PDF 第 ${book.bodyStart} 页。点击修改`}
          >
            第 {currentPage} 页 · {printed === null ? '正文前' : `书上 p${printed}`}
          </button>
        ) : (
          <span className="action-page" title="首次插入引注时设置正文起始页，之后这里会显示书上的页码">
            第 {currentPage} 页
          </span>
        )}
      </div>

      {frontHint && (
        <div className="cite-hint">
          <p>
            PDF 第 {currentPage} 页在正文之前（序言、书评等），没有可换算的页码，已插入 <code>[p x]</code>。x
            已选中，直接输入书上的页码即可。
          </p>
          <div className="cite-hint-actions">
            <label className="toggle">
              <input
                type="checkbox"
                onChange={(e) => {
                  onUpdateBook({ citeHintOff: e.target.checked });
                  if (e.target.checked) setFrontHint(false);
                }}
              />
              <span className="toggle-box" />
              这本书不再提示
            </label>
            <button className="link small" onClick={() => setFrontHint(false)}>
              知道了
            </button>
          </div>
        </div>
      )}

      {askStart && (
        <BodyStartDialog
          initial={book.bodyStart ?? currentPage}
          currentPage={currentPage}
          inserting={askStart === 'insert'}
          onCancel={() => {
            setAskStart(null);
            citeRef.current?.focus();
          }}
          onConfirm={(start) => {
            onUpdateBook({ bodyStart: start });
            const insert = askStart === 'insert';
            setAskStart(null);
            if (insert) insertCitation(start);
            else citeRef.current?.focus();
          }}
        />
      )}

      {here.length > 1 && overlay !== 'free' && (
        <div className="switcher">
          <span className="muted">本页有 {here.length} 篇笔记</span>
          {here.map((v) => (
            <button
              key={v.seg.id}
              className={v.seg.id === activeId ? 'active' : ''}
              onClick={() => props.onSelect(v.seg.id)}
            >
              {pad(v.no)} · {rangeLabel(v.range)}
            </button>
          ))}
        </div>
      )}

      <div className="notes-stage">
        {view ? (
          <NoteEditor {...props} view={view} mode={mode} setMode={setMode} textRef={textRef} />
        ) : (
          <div className="empty-page">
            <p className="start-kicker">本页没有笔记</p>
            <h2 className="start-title">第 {currentPage} 页</h2>
            <p className="muted start-hint">
              {startable
                ? '觉得该记笔记了，就点上方「开始笔记」，从这一页开始写。'
                : '从笔记列表里选择一篇笔记查看。'}
            </p>
          </div>
        )}
        {overlay === 'index' && (
          <NoteIndex
            {...props}
            onPick={(id) => {
              props.onSelect(id);
              setOverlay(null);
            }}
          />
        )}
        {overlay === 'trash' && <Trash {...props} onRestored={() => setOverlay(null)} />}
        {overlay === 'free' && <FreeNote {...props} mode={mode} setMode={setMode} textRef={freeRef} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NoteEditor({
  notebook,
  view,
  mode,
  setMode,
  onEdit,
  onGoTo,
  book,
  textRef,
}: Props & {
  view: NoteView;
  mode: Mode;
  setMode(m: Mode): void;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { seg } = view;

  // Put the caret at the end when a note opens in the editor.
  useEffect(() => {
    const el = textRef.current;
    if (mode !== 'source' || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [mode, seg.id]);

  const setContent = (content: string) =>
    onEdit({
      ...notebook,
      segments: notebook.segments.map((s) => (s.id === seg.id ? { ...s, content, updatedAt: Date.now() } : s)),
    });

  const onTextKey = tabInserts(setContent);

  return (
    <div className="editor">
      {view.warnings.length > 0 && (
        <div className="editor-warnings">
          {view.warnings.map((w) => (
            <p key={w} className="error">
              {w}
            </p>
          ))}
        </div>
      )}

      <div className="editor-body">
        {mode === 'source' ? (
          <textarea
            ref={textRef}
            className="source"
            spellCheck={false}
            value={seg.content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onTextKey}
          />
        ) : (
          <div className="markdown" onDoubleClick={() => setMode('source')}>
            {stripFront(seg.content).trim() ? (
              <Markdown content={stripFront(seg.content)} onGoTo={onGoTo} bodyStart={book.bodyStart} />
            ) : (
              <p className="muted">空白笔记，双击开始编辑。</p>
            )}
          </div>
        )}
      </div>

      <div className="editor-foot">
        <span className="muted">编辑于 {new Date(seg.updatedAt).toLocaleString('zh-CN')}</span>
        <button className="link" onClick={() => onEdit(deleteNote(notebook, seg.id), null)} title="移入废纸篓">
          删除笔记
        </button>
      </div>
    </div>
  );
}

/** Tab inserts spaces instead of moving focus. */
const tabInserts = (setContent: (content: string) => void) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const el = e.currentTarget;
  const { selectionStart: s, selectionEnd: end, value } = el;
  setContent(value.slice(0, s) + '  ' + value.slice(end));
  requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
};

// ---------------------------------------------------------------------------

/** The book's free note: one per book, not bound to pages, over the note stage. */
function FreeNote({
  notebook,
  mode,
  setMode,
  onEdit,
  onGoTo,
  book,
  textRef,
}: Props & { mode: Mode; setMode(m: Mode): void; textRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const content = notebook.free?.content ?? '';
  const setContent = (next: string) => onEdit({ ...notebook, free: { content: next, updatedAt: Date.now() } });

  useEffect(() => {
    const el = textRef.current;
    if (mode !== 'source' || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [mode, textRef]);

  return (
    <div className="overlay free-note">
      <div className="notes-heading">
        <h2>自由写</h2>
        <span className="muted free-sub">整本书一篇，不跟页码走</span>
      </div>
      <div className="editor-body">
        {mode === 'source' ? (
          <textarea
            ref={textRef}
            className="source"
            spellCheck={false}
            value={content}
            placeholder={'随手记下关于整本书的想法：读后感、提纲、问题……\n\n支持 Markdown，⌘E 预览；「插入引注」可以引用当前页。'}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={tabInserts(setContent)}
          />
        ) : (
          <div className="markdown" onDoubleClick={() => setMode('source')}>
            {content.trim() ? (
              <Markdown content={content} onGoTo={onGoTo} bodyStart={book.bodyStart} />
            ) : (
              <p className="muted">还没有内容，双击开始写。</p>
            )}
          </div>
        )}
      </div>
      <div className="editor-foot">
        <span className="muted">
          {notebook.free ? `编辑于 ${new Date(notebook.free.updatedAt).toLocaleString('zh-CN')}` : '尚未保存'}
        </span>
      </div>
    </div>
  );
}

/** Asks where the body's page 1 is, in PDF pages. */
function BodyStartDialog({
  initial,
  currentPage,
  inserting,
  onConfirm,
  onCancel,
}: {
  initial: number;
  currentPage: number;
  inserting: boolean;
  onConfirm(start: number): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(String(initial));
  const n = parseInt(value, 10);
  const valid = n >= 1;
  const example = valid ? printedPage(currentPage, n) : null;
  return (
    <div className="cite-dialog" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <h3>正文从哪一页开始？</h3>
      <p className="muted">
        引注用的是书上印的页码。请填写<strong>正文第 1 页</strong>在 PDF 里是第几页（看右侧的页码框）。
        之后插入引注会自动换算；正文之前的序言、书评等页插入 <code>[p x]</code>，由你手动填写。
      </p>
      <form
        className="cite-dialog-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onConfirm(n);
        }}
      >
        <span>正文第 1 页 = PDF 第</span>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
          onFocus={(e) => e.currentTarget.select()}
        />
        <span>页</span>
        <span className="spacer" />
        <button type="button" className="link small" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!valid}>
          {inserting ? '确定并插入' : '确定'}
        </button>
      </form>
      <p className="muted cite-dialog-example">
        {valid &&
          (example === null
            ? `当前 PDF 第 ${currentPage} 页在正文之前，会插入 [p x]`
            : `当前 PDF 第 ${currentPage} 页会插入 ${citation(example)}`)}
      </p>
    </div>
  );
}

function Markdown({
  content,
  onGoTo,
  bodyStart,
}: {
  content: string;
  onGoTo(page: number): void;
  /** For citations: the PDF page of the body's page 1. */
  bodyStart?: number;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkCitations]}
      components={{
        a: ({ href, children }) => {
          // [p 12]: printed page 12, jumping to its PDF page.
          if (href?.startsWith(CITE_HREF)) {
            const ref = decodeURIComponent(href.slice(CITE_HREF.length));
            const printed = /^\d+$/.test(ref) ? Number(ref) : null;
            if (printed === null || !bodyStart)
              return (
                <span
                  className="cite-ref"
                  title={printed === null ? '正文之前的页码，无法换算跳转' : '设置正文起始页后可跳转'}
                >
                  {children}
                </span>
              );
            const pdfPage = pdfPageOf(printed, bodyStart);
            return (
              <a
                className="cite-link"
                href={href}
                title={`跳到书上第 ${printed} 页（PDF 第 ${pdfPage} 页）`}
                onClick={(e) => {
                  e.preventDefault();
                  onGoTo(pdfPage);
                }}
              >
                {children}
              </a>
            );
          }
          const m = href?.match(/^#p\.?(\d+)$/i);
          if (m)
            return (
              <a
                className="page-link"
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  onGoTo(Number(m[1]));
                }}
              >
                {children}
              </a>
            );
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

/** Body text after the headline, flattened for a one-line preview. */
function excerpt(md: string) {
  const body = stripFront(md).trim();
  const nl = body.indexOf('\n');
  return (nl < 0 ? '' : body.slice(nl + 1))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[#>*_`~\-[\]()!|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------------------

function NoteIndex({ views, activeId, currentPage, onPick }: Props & { onPick(id: string): void }) {
  return (
    <div className="overlay">
      <div className="notes-heading">
        <h2>笔记列表</h2>
        <span className="count">{pad(views.length)}</span>
      </div>
      {views.length === 0 ? (
        <p className="muted notes-empty">还没有笔记。翻到想开始的页，点「开始笔记」。</p>
      ) : (
        <ul className="note-list">
          {views.map((v) => {
            const name = headline(v.seg.content);
            return (
              <li
                key={v.seg.id}
                className={[covers(v, currentPage) ? 'here' : '', activeId === v.seg.id ? 'active' : ''].join(' ')}
                onClick={() => onPick(v.seg.id)}
              >
                <span className="note-range">
                  <span className="note-no">{pad(v.no)}</span>
                  {rangeLabel(v.range)}
                </span>
                <span className={`note-title${name ? '' : ' muted'}`}>
                  {name || '空白笔记'}
                  {v.warnings.length > 0 && <span className="warn-dot" title={v.warnings.join('\n')} />}
                </span>
                <span className="note-excerpt">{excerpt(v.seg.content)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Trash({ notebook, book, onEdit, onGoTo, onRestored }: Props & { onRestored(): void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const items = notebook.trash;

  return (
    <div className="overlay">
      <div className="notes-heading">
        <h2>废纸篓</h2>
        {items.length > 0 &&
          (confirmEmpty ? (
            <span className="confirm">
              <button
                className="link danger"
                onClick={() => {
                  onEdit({ ...notebook, trash: [] });
                  setConfirmEmpty(false);
                }}
              >
                确认清空
              </button>
              <button className="link" onClick={() => setConfirmEmpty(false)}>
                取消
              </button>
            </span>
          ) : (
            <button className="link small" onClick={() => setConfirmEmpty(true)}>
              清空
            </button>
          ))}
      </div>

      {items.length === 0 ? (
        <p className="muted notes-empty">废纸篓是空的。删除的笔记会放在这里。</p>
      ) : (
        <ul className="trash-list">
          {items.map((t) => (
            <li key={t.id} className={openId === t.id ? 'open' : ''}>
              <div className="trash-head" onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                <span className="note-range">{rangeLabel(parseRange(t.content))}</span>
                <span className="note-title">{headline(t.content) || '无标题'}</span>
                <span className="trash-date muted">{new Date(t.deletedAt).toLocaleDateString('zh-CN')}</span>
              </div>
              {openId === t.id && (
                <>
                  <div className="markdown trash-preview">
                    <Markdown content={stripFront(t.content)} onGoTo={onGoTo} bodyStart={book.bodyStart} />
                  </div>
                  <div className="trash-actions">
                    <button
                      className="link"
                      onClick={() => {
                        onEdit(restoreNote(notebook, t.id), t.id);
                        onRestored();
                      }}
                    >
                      恢复
                    </button>
                    <button className="link" onClick={() => navigator.clipboard.writeText(t.content)}>
                      复制
                    </button>
                    <span className="spacer" />
                    <button
                      className="link danger"
                      onClick={() => onEdit({ ...notebook, trash: items.filter((x) => x.id !== t.id) })}
                    >
                      永久删除
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
