/**
 * Document parsing engine configuration, including MinerU cloud consent and secret-key handling via Electron safeStorage.
 * 文档解析引擎配置，包括 MinerU 云端同意状态，以及基于 Electron safeStorage 的密钥处理。
 */
import { safeStorage } from 'electron';

/**
 * Supported document parsing engines.
 * 支持的文档解析引擎。
 */
export type ParsingEngine = 'mammoth' | 'mineru';

/**
 * Non-secret parsing configuration exposed to the UI.
 * 暴露给界面的非敏感解析配置。
 */
export interface ParsingConfig {
  /** Preferred parsing engine / 首选解析引擎 */
  engine: ParsingEngine;
  /** MinerU API endpoint, without credentials / MinerU API 地址，不含凭据 */
  mineruEndpoint: string;
  /** Whether cloud parsing is allowed / 是否允许云端解析 */
  cloudParsingConsent: boolean;
  /** Whether a MinerU API key has been saved / 是否已保存 MinerU API 密钥 */
  hasMineruKey: boolean;
}

interface ParsingStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

const parsingConfigKey = 'parsing';
const parsingSecretKey = 'parsingSecret';

/** Default parsing configuration used before any preference is saved / 尚未保存偏好时使用的默认解析配置 */
export const defaultParsingConfig: ParsingConfig = {
  engine: 'mammoth',
  mineruEndpoint: '',
  cloudParsingConsent: true,
  hasMineruKey: false,
};

/**
 * Read the parsing configuration; the key is never echoed back, only hasMineruKey reports whether one is saved.
 * 读取解析配置；密钥不回显，仅以 hasMineruKey 表达是否已保存。
 *
 * @param store - Key-value store backed by Electron settings / 基于 Electron 设置的键值存储
 * @returns Effective parsing configuration / 生效的解析配置
 */
export function readParsingConfig(store: ParsingStore): ParsingConfig {
  const stored = store.get(parsingConfigKey);
  const record = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  return {
    // Historical local-parser preferences migrate to the Mammoth route.
    // 历史本地解析偏好迁移到 Mammoth 路线。
    engine: record.engine === 'mineru' ? 'mineru' : 'mammoth',
    mineruEndpoint: typeof record.mineruEndpoint === 'string' ? record.mineruEndpoint : '',
    // Older versions required extra consent; now default to agreed so hidden legacy values never block PDF parsing.
    // 历史版本要求额外确认；现在默认同意，避免隐藏的旧值阻断 PDF 解析。
    cloudParsingConsent: true,
    hasMineruKey: Boolean(store.get(parsingSecretKey)),
  };
}

/**
 * Provide the main process with the decrypted MinerU key; the renderer never sees the plaintext.
 * 供主进程内部调用 MinerU 时取用解密后的密钥；渲染进程拿不到明文。
 *
 * @param store - Key-value store backed by Electron settings / 基于 Electron 设置的键值存储
 * @returns Decrypted API key, or undefined when unavailable / 解密后的 API 密钥；不可用时为 undefined
 */
export function readMineruApiKey(store: ParsingStore): string | undefined {
  const encrypted = store.get(parsingSecretKey);
  if (typeof encrypted !== 'string' || !encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

/**
 * Save a parsing configuration patch, encrypting any newly entered MinerU API key.
 * 保存解析配置增量更新，并对新输入的 MinerU API 密钥加密存储。
 *
 * @param store - Key-value store backed by Electron settings / 基于 Electron 设置的键值存储
 * @param patch - Partial configuration; mineruApiKey replaces the saved secret when non-empty / 配置增量；mineruApiKey 非空时替换已保存密钥
 * @returns The resulting parsing configuration / 保存后的解析配置
 */
export function saveParsingConfig(store: ParsingStore, patch: Partial<ParsingConfig> & { mineruApiKey?: string | null }): ParsingConfig {
  const current = readParsingConfig(store);
  const next: ParsingConfig = {
    // `engine` is kept for compatibility with previously saved preferences.
    // 保留 `engine` 以兼容此前保存的偏好设置。
    // Routing is decided by file type: DOCX -> Mammoth, PDF -> MinerU.
    // 路由由文件类型决定：DOCX -> Mammoth，PDF -> MinerU。
    engine: patch.engine === undefined ? current.engine : patch.engine === 'mineru' ? 'mineru' : 'mammoth',
    mineruEndpoint: typeof patch.mineruEndpoint === 'string' ? normalizeMineruEndpoint(patch.mineruEndpoint) : current.mineruEndpoint,
    cloudParsingConsent: true,
    hasMineruKey: current.hasMineruKey,
  };
  const enteredKey = typeof patch.mineruApiKey === 'string' ? patch.mineruApiKey.trim() : '';
  if (enteredKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API 密钥未保存。');
    store.set(parsingSecretKey, safeStorage.encryptString(enteredKey).toString('base64'));
    next.hasMineruKey = true;
  }
  store.set(parsingConfigKey, {
    engine: next.engine,
    mineruEndpoint: next.mineruEndpoint,
    cloudParsingConsent: next.cloudParsingConsent,
  });
  return next;
}

/**
 * Normalize and validate a MinerU endpoint URL.
 * 规范化并校验 MinerU API 地址。
 *
 * @param value - User-entered endpoint string / 用户输入的地址字符串
 * @returns Trimmed URL without trailing slashes / 去除尾部斜杠后的地址
 */
function normalizeMineruEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('MinerU API 地址格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('MinerU API 地址必须是不含账号、查询参数或锚点的 HTTP/HTTPS 地址。');
  }
  return trimmed.replace(/\/+$/u, '');
}
