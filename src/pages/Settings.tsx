import { useEffect, useRef, useState } from 'react';
import { api, type OcrTokenInfo } from '../types';
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
