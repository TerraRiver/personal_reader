import { useEffect, useRef, useState } from 'react';
import { api, type OcrTokenInfo, type TranslateField, type TranslateInfo } from '../types';
import { AUTO_COPY_KEY, autoCopyEnabled } from '../annotations';

const TOKEN_PAGE = 'https://aistudio.baidu.com/account/accessToken';

export default function Settings({ onClose }: { onClose(): void }) {
  return (
    <div className="settings">
      <div className="titlebar settings-titlebar">
        <button className="link back" onClick={onClose}>
          ← 书库
        </button>
      </div>

      <header className="library-header settings-header">
        <h1>设置</h1>
      </header>

      <ReadingSection />
      <OcrTokenSection />
      <TranslateSection />
    </div>
  );
}

function ReadingSection() {
  const [autoCopy, setAutoCopy] = useState(autoCopyEnabled);
  return (
    <section className="settings-section">
      <div className="settings-label">
        <h2>阅读</h2>
      </div>
      <div className="settings-body">
        <label className="toggle settings-toggle">
          <input
            type="checkbox"
            checked={autoCopy}
            onChange={(e) => {
              setAutoCopy(e.target.checked);
              try {
                localStorage.setItem(AUTO_COPY_KEY, e.target.checked ? '1' : '0');
              } catch {
                // Falls back to the default next time.
              }
            }}
          />
          <span className="toggle-box" />
          选中文字时自动复制
        </label>
        <p className="muted settings-hint">在 PDF 上选中文字，松开鼠标就复制到剪贴板。只想画线、不想覆盖剪贴板时可以关掉。</p>
      </div>
    </section>
  );
}

function OcrTokenSection() {
  const [info, setInfo] = useState<OcrTokenInfo | null>(null);
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => api().ocrTokenInfo().then(setInfo);
  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    const error = await api().saveOcrToken(token);
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: error });
      input.current?.focus();
      return;
    }
    setToken('');
    setReveal(false);
    setMessage({ ok: true, text: '令牌有效，已加密保存。现在可以在书库里对扫描版的书点「OCR」了。' });
    refresh();
  };

  const clear = async () => {
    await api().clearOcrToken();
    setConfirmClear(false);
    setMessage(null);
    refresh();
  };

  return (
    <section className="settings-section">
      <div className="settings-label">
        <h2>OCR</h2>
        <p className="muted">飞桨 AI Studio · PP-OCRv6</p>
        <p className="muted">把扫描页里的文字识别出来，叠回原来的位置，让它可以选中、复制。识别在飞桨的服务器上进行，需要你自己的访问令牌。</p>
      </div>

      <div className="settings-body">
        <div className="token-status">
          <span className="settings-kicker">当前状态</span>
          {!info ? (
            <span className="muted">读取中…</span>
          ) : info.source === 'saved' ? (
            <span className="token-line">
              <span className="tag tag-ocr">已设置</span>
              <code>{info.masked}</code>
              {confirmClear ? (
                <>
                  <button className="link small danger" onClick={clear}>
                    确认删除
                  </button>
                  <button className="link small" onClick={() => setConfirmClear(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button className="link small" onClick={() => setConfirmClear(true)}>
                  删除令牌
                </button>
              )}
            </span>
          ) : info.source === 'dev' ? (
            <span className="token-line">
              <span className="tag">开发令牌</span>
              <code>{info.masked}</code>
              <span className="muted">来自 .env，在这里保存后优先使用保存的令牌</span>
            </span>
          ) : (
            <span className="token-line">
              <span className="tag tag-none">未设置</span>
              <span className="muted">按下面三步获取令牌，大约一分钟</span>
            </span>
          )}
        </div>

        <ol className="steps">
          <li>
            <span className="step-no">01</span>
            <div>
              <h3>打开 AI Studio 的访问令牌页</h3>
              <p className="muted">用百度账号登录。没有账号的话，按页面提示免费注册即可。</p>
              <a className="btn btn-sm step-action" href={TOKEN_PAGE} target="_blank" rel="noreferrer">
                打开访问令牌页 ↗
              </a>
            </div>
          </li>
          <li>
            <span className="step-no">02</span>
            <div>
              <h3>复制你的访问令牌</h3>
              <p className="muted">页面上会显示你账号的访问令牌（一串字母和数字），点旁边的「复制」按钮。</p>
            </div>
          </li>
          <li>
            <span className="step-no">03</span>
            <div>
              <h3>粘贴到这里，验证并保存</h3>
              <p className="muted">保存前会先向飞桨确认令牌有效，这一步不消耗识别额度。</p>
              <div className="token-input">
                <input
                  ref={input}
                  type={reveal ? 'text' : 'password'}
                  value={token}
                  placeholder="粘贴访问令牌"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    setToken(e.target.value);
                    setMessage(null);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && save()}
                />
                <button className="link small" onClick={() => setReveal((r) => !r)} disabled={!token}>
                  {reveal ? '隐藏' : '显示'}
                </button>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={!token.trim() || busy}>
                  {busy ? '验证中…' : '验证并保存'}
                </button>
              </div>
              {message && <p className={message.ok ? 'token-ok' : 'error'}>{message.text}</p>}
            </div>
          </li>
        </ol>

        <ul className="settings-notes muted">
          <li>令牌用系统钥匙串加密，只保存在这台电脑上，不会写进书库文件。</li>
          <li>令牌等同于你的账号凭证，不要发给别人。</li>
          <li>每个账号每天可免费识别 20,000 页，超出后第二天恢复。</li>
        </ul>
      </div>
    </section>
  );
}

const MINERU_PAGE = 'https://mineru.net/apiManage';

type Draft = Partial<Record<TranslateField, string>>;

/** Where a value comes from, beside its field. */
function Source({ info }: { info?: { source: 'saved' | 'dev' | null } }) {
  if (info?.source === 'saved') return <span className="tag tag-ocr">已保存</span>;
  if (info?.source === 'dev') return <span className="tag" title="来自 .env，在这里保存后优先使用保存的值">开发配置</span>;
  return <span className="tag tag-none">未设置</span>;
}

function TranslateSection() {
  const [info, setInfo] = useState<TranslateInfo | null>(null);
  const refresh = () => api().translateInfo().then(setInfo);
  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="settings-section">
      <div className="settings-label">
        <h2>论文翻译</h2>
        <p className="muted">MinerU · OpenAI 兼容接口</p>
        <p className="muted">
          论文库里的论文可以整篇译成中文：MinerU 先解析版面（正文、标题、脚注、参考文献），再由你配置的大模型逐段翻译。阅读时译文和原文 PDF 并排对照。
        </p>
      </div>
      <div className="settings-body">
        <TranslateGroup
          title="MinerU 解析"
          which="mineru"
          info={info}
          onSaved={refresh}
          fields={[
            { name: 'mineruKey', label: '密钥', secret: true, placeholder: '粘贴 MinerU API 密钥' },
            { name: 'mineruModel', label: '模型', options: [['vlm', 'vlm（推荐，精度更高）'], ['pipeline', 'pipeline']] },
          ]}
          help={
            <>
              在 MinerU 官网登录后创建 API 密钥。每个账号每天有 1,000 页高优先级解析额度，单篇不超过 200 页。{' '}
              <a href={MINERU_PAGE} target="_blank" rel="noreferrer">
                打开 MinerU 密钥页 ↗
              </a>
            </>
          }
        />
        <TranslateGroup
          title="翻译模型"
          which="llm"
          info={info}
          onSaved={refresh}
          fields={[
            { name: 'llmBaseUrl', label: '接口地址', placeholder: 'https://api.example.com/v1' },
            { name: 'llmModel', label: '模型名称', placeholder: '例如 deepseek-chat' },
            { name: 'llmKey', label: '密钥', secret: true, placeholder: '粘贴 API 密钥' },
            { name: 'llmWorkers', label: '并发数', placeholder: '8', narrow: true },
          ]}
          help="任何兼容 OpenAI Chat Completions 的服务都可以，接口地址填到 /v1 为止。并发数是同时发出的请求数，越大越快，但要在服务商的速率限制以内。"
        />
        <ul className="settings-notes muted">
          <li>密钥用系统钥匙串加密，只保存在这台电脑上，不会写进书库文件。</li>
          <li>论文内容会发送给 MinerU 和你配置的模型服务商处理。</li>
        </ul>
      </div>
    </section>
  );
}

interface FieldSpec {
  name: TranslateField;
  label: string;
  secret?: boolean;
  placeholder?: string;
  options?: [string, string][];
  narrow?: boolean;
}

function TranslateGroup({
  title,
  which,
  info,
  fields,
  help,
  onSaved,
}: {
  title: string;
  which: 'mineru' | 'llm';
  info: TranslateInfo | null;
  fields: FieldSpec[];
  help: React.ReactNode;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = Object.values(draft).some((v) => v !== undefined);

  const test = async () => {
    setBusy('test');
    setMessage(null);
    const error = await api().checkTranslateSettings(which, draft);
    setBusy(null);
    setMessage(error ? { ok: false, text: error } : { ok: true, text: '连接正常。' });
  };
  const save = async () => {
    setBusy('save');
    setMessage(null);
    const patch = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined));
    const error = await api().saveTranslateSettings(patch);
    setBusy(null);
    if (error) return setMessage({ ok: false, text: error });
    setDraft({});
    setMessage({ ok: true, text: '已保存。' });
    onSaved();
  };

  return (
    <div className="translate-group">
      <h3>{title}</h3>
      <p className="muted translate-help">{help}</p>
      <div className="translate-fields">
        {fields.map((f) => {
          const current = info?.[f.name];
          const value = draft[f.name] ?? (f.secret ? '' : String(current?.value ?? ''));
          const set = (v: string) => {
            setDraft((d) => ({ ...d, [f.name]: v }));
            setMessage(null);
          };
          return (
            <label key={f.name} className="translate-field">
              <span className="settings-kicker">{f.label}</span>
              {f.options ? (
                <select value={value || f.options[0][0]} onChange={(e) => set(e.target.value)}>
                  {f.options.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={f.narrow ? 'narrow' : undefined}
                  type={f.secret ? 'password' : 'text'}
                  value={value}
                  placeholder={f.secret && current?.value ? `${current.value}（留空则不修改）` : f.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => set(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
                />
              )}
              {f.secret || f.name === 'llmBaseUrl' || f.name === 'llmModel' ? <Source info={current} /> : <span />}
            </label>
          );
        })}
      </div>
      <div className="translate-actions">
        <button className="btn btn-sm" onClick={test} disabled={!!busy}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || !!busy}>
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        {message && <span className={message.ok ? 'token-ok' : 'error'}>{message.text}</span>}
      </div>
    </div>
  );
}
