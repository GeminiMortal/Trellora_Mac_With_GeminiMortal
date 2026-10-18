import { safeStorage } from 'electron';
import type { WebSearchConfig, WebSearchProviderExtras, WebSearchProviderId, WebSearchRuntimeConfig } from './webSearchTypes.ts';
import { WEB_SEARCH_MAX_RESULTS_DEFAULT, WEB_SEARCH_MAX_RESULTS_MAX, WEB_SEARCH_MAX_RESULTS_MIN, webSearchProviderIds } from './webSearchTypes.ts';
import { normalizeProviderExtras } from './webSearchProviders.ts';

/**
 * Application-level web search configuration (web search design §6.1, following the parsingConfig.ts pattern):
 * - Shared fields and per-vendor private fields are stored in groups so switching vendors keeps filled settings;
 * - Secrets are encrypted with safeStorage under separate keys; the renderer only sees has*Key flags;
 * - Non-secret dynamic options (providerExtras) are validated/defaulted per vendor configFields (aligned with WeKnora ExtraConfig);
 * - Privacy consent for web search is built in as granted; the consent field is kept only for legacy configs and the runtime protocol.
 * 联网搜索应用级配置（联网搜索设计方案 §6.1，对齐 parsingConfig.ts 范式）：
 * - 公共字段与厂商自留字段分组存储，切换厂商不丢已填配置；
 * - 密钥用 safeStorage 加密单独存键，渲染进程只见 has*Key 标志；
 * - 非密动态配置项（providerExtras）按厂商 configFields 校验并补默认值（对标 WeKnora ExtraConfig）；
 * - 联网搜索的隐私确认已内置为同意；保留 consent 字段仅兼容旧配置和运行时协议。
 */

/** Minimal key-value store abstraction used by config persistence / 配置持久化使用的最小键值存储抽象 */
interface WebSearchStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

const webSearchConfigKey = 'webSearch';
const webSearchSecretKey = 'webSearchSecret';
const webSearchTavilySecretKey = 'webSearchSecretTavily';
const webSearchBaiduSecretKey = 'webSearchSecretBaidu';

/**
 * Default web search configuration used before any user customization.
 * 用户自定义之前的联网搜索默认配置。
 */
export const defaultWebSearchConfig: WebSearchConfig = {
  enabled: false,
  provider: 'zhipu',
  maxResults: WEB_SEARCH_MAX_RESULTS_DEFAULT,
  consent: true,
  searxngUrl: '',
  hasZhipuKey: false,
  hasTavilyKey: false,
  hasBaiduKey: false,
  providerExtras: {},
};

/**
 * Read web search config; secrets are never echoed, only expressed via has*Key flags.
 * 读取联网搜索配置；密钥不回显，仅以 has*Key 表达是否已保存。
 *
 * @param store - Backing key-value store / 底层键值存储
 * @returns Sanitized config safe to hand to the renderer / 可安全下发渲染进程的配置
 */
export function readWebSearchConfig(store: WebSearchStore): WebSearchConfig {
  const stored = store.get(webSearchConfigKey);
  const record = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const provider = record.provider;
  return {
    enabled: record.enabled === true,
    provider: webSearchProviderIds.includes(provider as WebSearchProviderId) ? (provider as WebSearchProviderId) : 'zhipu',
    maxResults: clampMaxResults(record.maxResults),
    // Older builds required an extra settings-page confirmation; now it is implicit, and legacy configs migrate to consented.
    // 历史版本要求在设置页额外确认；现在无需重复勾选，旧配置也一并迁移为已同意。
    consent: true,
    searxngUrl: typeof record.searxngUrl === 'string' ? record.searxngUrl : '',
    hasZhipuKey: Boolean(store.get(webSearchSecretKey)),
    hasTavilyKey: Boolean(store.get(webSearchTavilySecretKey)),
    hasBaiduKey: Boolean(store.get(webSearchBaiduSecretKey)),
    providerExtras: readProviderExtras(record.providerExtras),
  };
}

/**
 * Assemble adapter runtime config for main-process use; decrypted secrets are never persisted or sent back to the renderer.
 * 供主进程内部装配适配器运行时配置；解密后的密钥不落盘不回传渲染进程。
 *
 * @param store - Backing key-value store / 底层键值存储
 * @returns Runtime config with decrypted secrets / 含解密密钥的运行时配置
 */
export function readWebSearchRuntimeConfig(store: WebSearchStore): WebSearchRuntimeConfig {
  const config = readWebSearchConfig(store);
  return {
    zhipu: { apiKey: readSecret(store, webSearchSecretKey), extras: config.providerExtras.zhipu },
    searxng: { url: config.searxngUrl },
    tavily: { apiKey: readSecret(store, webSearchTavilySecretKey) },
    baidu: { apiKey: readSecret(store, webSearchBaiduSecretKey) },
  };
}

/** Decrypt a safeStorage secret; returns undefined when unavailable or undecryptable / 解密 safeStorage 密文；不可用或解密失败时返回 undefined */
function readSecret(store: WebSearchStore, key: string): string | undefined {
  const encrypted = store.get(key);
  if (typeof encrypted !== 'string' || !encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

/**
 * Normalize non-secret extras per vendor; unknown vendor keys are dropped and invalid values fall back to defaults.
 * 逐厂商归一化非密配置取值；未知厂商键丢弃，非法取值回退默认。
 */
function readProviderExtras(raw: unknown): Partial<Record<WebSearchProviderId, WebSearchProviderExtras>> {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const extras: Partial<Record<WebSearchProviderId, WebSearchProviderExtras>> = {};
  for (const id of webSearchProviderIds) {
    if (source[id] !== undefined) extras[id] = normalizeProviderExtras(id, source[id]);
  }
  return extras;
}

/**
 * Partial config update accepted by saveWebSearchConfig; secret fields carry plaintext only within this request.
 * saveWebSearchConfig 接受的局部配置补丁；密钥字段仅在本请求中携带明文。
 */
export type WebSearchConfigPatch = Partial<Omit<WebSearchConfig, 'hasZhipuKey' | 'hasTavilyKey' | 'hasBaiduKey'>> & {
  /** A string (including empty) sets or clears the secret; plaintext appears only in the save request / 传入字符串（含空串）表示清空密钥；明文只出现在保存请求中。 */
  zhipuApiKey?: string | null;
  tavilyApiKey?: string | null;
  baiduApiKey?: string | null;
};

/**
 * Persist a config patch: merges with current values, encrypts secret updates, and returns the new config.
 * 保存配置补丁：与当前值合并，加密密钥变更，并返回新配置。
 *
 * @param store - Backing key-value store / 底层键值存储
 * @param patch - Partial update with optional plaintext secrets / 含可选明文密钥的局部更新
 * @returns The config after applying the patch / 应用补丁后的配置
 */
export function saveWebSearchConfig(store: WebSearchStore, patch: WebSearchConfigPatch): WebSearchConfig {
  const current = readWebSearchConfig(store);
  const consent = true;
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
  const next: WebSearchConfig = {
    enabled,
    provider: patch.provider !== undefined && webSearchProviderIds.includes(patch.provider) ? patch.provider : current.provider,
    maxResults: patch.maxResults !== undefined ? clampMaxResults(patch.maxResults) : current.maxResults,
    consent,
    searxngUrl: typeof patch.searxngUrl === 'string' ? normalizeSearxngUrl(patch.searxngUrl) : current.searxngUrl,
    hasZhipuKey: applySecretPatch(store, webSearchSecretKey, patch.zhipuApiKey) ?? current.hasZhipuKey,
    hasTavilyKey: applySecretPatch(store, webSearchTavilySecretKey, patch.tavilyApiKey) ?? current.hasTavilyKey,
    hasBaiduKey: applySecretPatch(store, webSearchBaiduSecretKey, patch.baiduApiKey) ?? current.hasBaiduKey,
    providerExtras: patch.providerExtras !== undefined ? mergeProviderExtras(current.providerExtras, patch.providerExtras) : current.providerExtras,
  };
  store.set(webSearchConfigKey, {
    enabled: next.enabled,
    provider: next.provider,
    maxResults: next.maxResults,
    consent: next.consent,
    searxngUrl: next.searxngUrl,
    providerExtras: next.providerExtras,
  });
  return next;
}

/**
 * Apply a secret patch: a string (including empty) sets/clears the secret, undefined/null leaves it unchanged; returns the new presence flag.
 * 密钥补丁写入：字符串（含空串）表示设置/清空，undefined/null 表示不动；返回新的存在标志。
 */
function applySecretPatch(store: WebSearchStore, key: string, value: string | null | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const enteredKey = value.trim();
  if (enteredKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API 密钥未保存。');
    store.set(key, safeStorage.encryptString(enteredKey).toString('base64'));
    return true;
  }
  store.set(key, null);
  return false;
}

/**
 * Merge non-secret extras patch: only vendors present in the patch are overwritten; the rest stay as-is.
 * 合并非密配置补丁：只覆盖补丁中出现的厂商，其余保持现状。
 */
function mergeProviderExtras(
  current: Partial<Record<WebSearchProviderId, WebSearchProviderExtras>>,
  patch: unknown,
): Partial<Record<WebSearchProviderId, WebSearchProviderExtras>> {
  const next = { ...current };
  const source = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  for (const id of webSearchProviderIds) {
    if (source[id] !== undefined) next[id] = normalizeProviderExtras(id, source[id]);
  }
  return next;
}

function clampMaxResults(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : WEB_SEARCH_MAX_RESULTS_DEFAULT;
  return Math.max(WEB_SEARCH_MAX_RESULTS_MIN, Math.min(WEB_SEARCH_MAX_RESULTS_MAX, parsed));
}

/** Validate and normalize a SearXNG instance URL: http/https only, no credentials, trailing slashes stripped / 校验并归一化 SearXNG 实例地址：仅 http/https、不含账号信息、去尾斜杠 */
function normalizeSearxngUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('SearXNG 实例地址格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('SearXNG 实例地址必须是不含账号信息的 HTTP/HTTPS 地址。');
  }
  return trimmed.replace(/\/+$/u, '');
}
