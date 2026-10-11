import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Notebook } from '../types';
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
}

type Overlay = 'index' | 'trash' | null;
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

  // ⌘E toggles source / preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'e') {
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
        </div>
        <div className="bar-right">
          <label className="toggle" title="翻阅 PDF 时自动切换到对应页码的笔记">
            <input type="checkbox" checked={follow} onChange={(e) => onFollowChange(e.target.checked)} />
            <span className="toggle-box" />
            跟随翻页
          </label>
          <div className="segmented" title="⌘E">
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
        <span className="spacer" />
        <span className="action-page">第 {currentPage} 页</span>
      </div>

      {here.length > 1 && (
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
          <NoteEditor {...props} view={view} mode={mode} setMode={setMode} />
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NoteEditor({
  notebook,
  views,
  view,
  mode,
  setMode,
  onSelect,
  onEdit,
  onGoTo,
}: Props & { view: NoteView; mode: Mode; setMode(m: Mode): void }) {
  const { seg, range } = view;
  const i = views.indexOf(view);
  const textRef = useRef<HTMLTextAreaElement>(null);

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

  // Tab inserts spaces instead of moving focus.
  const onTextKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end, value } = el;
    setContent(value.slice(0, s) + '  ' + value.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };

  return (
    <div className="editor">
      <div className="editor-meta">
        <div className="kicker">
          <span className="kicker-label">
            笔记 {pad(view.no)} / {pad(views.length)}
            {range && range.end === null && <span className="live">书写中</span>}
          </span>
          <span className="kicker-nav">
            <button className="icon-btn" disabled={i <= 0} onClick={() => onSelect(views[i - 1].seg.id)} title="上一篇">
              ‹
            </button>
            <button
              className="icon-btn"
              disabled={i >= views.length - 1}
              onClick={() => onSelect(views[i + 1].seg.id)}
              title="下一篇"
            >
              ›
            </button>
          </span>
        </div>
        <button
          className="range-big"
          onClick={() => range && onGoTo(range.start)}
          title={range ? '跳到起始页' : ''}
        >
          {rangeLabel(range)}
        </button>
        {view.warnings.map((w) => (
          <p key={w} className="error">
            {w}
          </p>
        ))}
      </div>

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
              <Markdown content={stripFront(seg.content)} onGoTo={onGoTo} />
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

function Markdown({ content, onGoTo }: { content: string; onGoTo(page: number): void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
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

function Trash({ notebook, onEdit, onGoTo, onRestored }: Props & { onRestored(): void }) {
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
                    <Markdown content={stripFront(t.content)} onGoTo={onGoTo} />
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
