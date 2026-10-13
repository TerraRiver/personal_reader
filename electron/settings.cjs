// App settings in <userData>/settings.json. Secrets are encrypted with the
// OS keychain (safeStorage) and never sent to the renderer in full.

const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const file = () => path.join(app.getPath('userData'), 'settings.json');

module.exports = function createSettings({ readJson, writeJson }) {
  const load = () => readJson(file(), {});

  async function savedToken() {
    const { ocrToken } = await load();
    if (!ocrToken) return null;
    try {
      return safeStorage.decryptString(Buffer.from(ocrToken, 'base64'));
    } catch {
      return null; // keychain entry gone, e.g. data copied from another machine
    }
  }

  // Development fallback: PADDLEOCR_ACCESS_TOKEN, or Access_Token in .env.
  async function devToken() {
    if (process.env.PADDLEOCR_ACCESS_TOKEN) return process.env.PADDLEOCR_ACCESS_TOKEN;
    if (app.isPackaged) return null;
    try {
      const env = await fs.readFile(path.join(app.getAppPath(), '.env'), 'utf8');
      return env.match(/^\s*Access_Token\s*=\s*["']?([^"'\s]+)/m)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /** The token to use: the saved one wins over the development fallback. */
  async function ocrToken() {
    const saved = await savedToken();
    if (saved) return { token: saved, source: 'saved' };
    const dev = await devToken();
    return dev ? { token: dev, source: 'dev' } : { token: null, source: null };
  }

  return {
    ocrToken,
    /** What the settings screen may show: where the token comes from, and a masked form. */
    async ocrTokenInfo() {
      const { token, source } = await ocrToken();
      return { source, masked: token ? `${token.slice(0, 4)}••••${token.slice(-4)}` : null };
    },
    async saveOcrToken(token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法加密保存令牌');
      const settings = await load();
      await writeJson(file(), { ...settings, ocrToken: safeStorage.encryptString(token).toString('base64') });
    },
    async clearOcrToken() {
      const { ocrToken: _, ...rest } = await load();
      await writeJson(file(), rest);
    },
  };
};
