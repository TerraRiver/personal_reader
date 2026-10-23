// App settings in <userData>/settings.json. Secrets are encrypted with the
// OS keychain (safeStorage) and never sent to the renderer in full.

const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const file = () => path.join(app.getPath('userData'), 'settings.json');

const mask = (s) => (s ? `${s.slice(0, 4)}••••${s.slice(-4)}` : null);

// Paper translation: MinerU parses the PDF, an OpenAI-compatible model translates.
// Each field: its key in settings.json, the .env name used during development, a default.
const TRANSLATE_FIELDS = {
  mineruKey: { env: 'MinerU_Key', secret: true },
  mineruModel: { env: 'MinerU_Model_Name', default: 'vlm' },
  llmBaseUrl: { env: 'LLM_Base_URL', default: '' },
  llmModel: { env: 'LLM_Model_Name', default: '' },
  llmKey: { env: 'LLM_Api_Key', secret: true },
  llmWorkers: { default: 8 },
};

module.exports = function createSettings({ readJson, writeJson, serial }) {
  const load = () => readJson(file(), {});
  // Each change reads the whole file and writes it back, so changes take turns
  // in main's write queue; otherwise two at once could lose one or collide on disk.
  const change = (fn) => serial(async () => writeJson(file(), await fn(await load())));

  const decrypt = (value) => {
    if (!value) return null;
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      return null; // keychain entry gone, e.g. data copied from another machine
    }
  };

  // Development fallback: values in the project's .env, never read by packaged builds.
  async function devEnv() {
    if (app.isPackaged) return {};
    try {
      const env = await fs.readFile(path.join(app.getAppPath(), '.env'), 'utf8');
      const out = {};
      for (const m of env.matchAll(/^\s*([A-Za-z_]+)\s*=\s*["']?(.*?)["']?\s*$/gm)) out[m[1]] = m[2];
      return out;
    } catch {
      return {};
    }
  }

  async function devToken() {
    if (process.env.PADDLEOCR_ACCESS_TOKEN) return process.env.PADDLEOCR_ACCESS_TOKEN;
    return (await devEnv()).Access_Token || null;
  }

  /** The token to use: the saved one wins over the development fallback. */
  async function ocrToken() {
    const saved = decrypt((await load()).ocrToken);
    if (saved) return { token: saved, source: 'saved' };
    const dev = await devToken();
    return dev ? { token: dev, source: 'dev' } : { token: null, source: null };
  }

  /** Every translation field with where it came from: 'saved', 'dev' or null (default / unset). */
  async function translateFields() {
    const saved = (await load()).translate ?? {};
    const env = await devEnv();
    const out = {};
    for (const [name, f] of Object.entries(TRANSLATE_FIELDS)) {
      const own = f.secret ? decrypt(saved[name]) : saved[name];
      if (own != null && own !== '') out[name] = { value: own, source: 'saved' };
      else if (f.env && env[f.env]) out[name] = { value: env[f.env], source: 'dev' };
      else out[name] = { value: f.default ?? null, source: null };
    }
    return out;
  }

  return {
    ocrToken,
    /** What the settings screen may show: where the token comes from, and a masked form. */
    async ocrTokenInfo() {
      const { token, source } = await ocrToken();
      return { source, masked: mask(token) };
    },
    async saveOcrToken(token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法加密保存令牌');
      await change((settings) => ({ ...settings, ocrToken: safeStorage.encryptString(token).toString('base64') }));
    },
    clearOcrToken: () => change(({ ocrToken: _, ...rest }) => rest),

    /** Plain values for the main process: { mineruKey, mineruModel, llmBaseUrl, … }. */
    async translateConfig() {
      const fields = await translateFields();
      return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value]));
    },
    /** For the settings screen: secrets masked. */
    async translateInfo() {
      const fields = await translateFields();
      return Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [
          k,
          { source: v.source, value: TRANSLATE_FIELDS[k].secret ? mask(v.value) : v.value },
        ]),
      );
    },
    /** Saves the given fields; an empty string clears a field back to its fallback. */
    saveTranslate: (patch) =>
      change((settings) => {
        const next = { ...(settings.translate ?? {}) };
        for (const [name, value] of Object.entries(patch)) {
          const f = TRANSLATE_FIELDS[name];
          if (!f) continue;
          if (value === '' || value == null) {
            delete next[name];
          } else if (f.secret) {
            if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法加密保存密钥');
            next[name] = safeStorage.encryptString(String(value).trim()).toString('base64');
          } else {
            next[name] = typeof f.default === 'number' ? Number(value) : String(value).trim();
          }
        }
        return { ...settings, translate: next };
      }),
  };
};
