/**
 * Model hub persistence: provider connections, encrypted secrets, and purpose slot resolution.
 * 模型中枢持久化：厂商连接、加密密钥与用途槽位解析。
 */
import { safeStorage } from 'electron';
import type { AiGenerationApi, AiProviderConfig } from './aiTypes.ts';
import type { ModelHub, ModelHubPatch, ModelSlot, ModelSlotId } from '../../../shared/modelHubTypes.ts';
/**
 * Re-exported shared model-hub types used across main and renderer.
 * 主进程与渲染进程共用的模型中枢类型再导出。
 */
export type { ModelHub, ModelHubPatch, ModelSlot, ModelSlotId, ProviderConnection } from '../../../shared/modelHubTypes.ts';

/** Source id reserved for the local Ollama runtime. / 本地 Ollama 运行时保留的来源标识。 */
export const OLLAMA_SOURCE_ID = 'ollama';
/** Source id meaning "no provider configured", valid only for the rerank slot. / 表示"未配置厂商"的来源标识，仅重排槽位可用。 */
export const NO_SOURCE_ID = 'none';

/**
 * Catalog entry describing a supported remote model provider.
 * 描述受支持远程模型厂商的目录项。
 */
export interface ModelProviderCatalogEntry {
  /** Stable provider id used in storage / 存储中使用的稳定厂商标识 */
  id: string;
  /** Display label / 展示名称 */
  label: string;
  /** Default base endpoint / 默认基础端点 */
  endpoint: string;
  /** Wire protocol for generation calls / 生成调用使用的线上协议 */
  api: Exclude<AiGenerationApi, 'ollama-chat'>;
  /** Whether the provider offers generation only / 该厂商是否仅提供生成能力 */
  generationOnly: boolean;
  /** Preset embedding model ids for this provider / 该厂商的嵌入模型预设 */
  embeddingPresets: string[];
  /** Preset rerank model ids for this provider / 该厂商的重排模型预设 */
  rerankPresets: string[];
}

/**
 * Catalog of commonly used providers: generation protocol is independent of vendor
 * identity, and presets only suggest models for the matching purpose.
 * 市面常用厂商目录：生成协议与厂商身份分离，presets 仅用于对应模型用途。
 */
export const MODEL_PROVIDER_CATALOG: ModelProviderCatalogEntry[] = [
  { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', api: 'openai-responses', generationOnly: false, embeddingPresets: ['text-embedding-3-small', 'text-embedding-3-large'], rerankPresets: [] },
  { id: 'anthropic', label: 'Anthropic Claude', endpoint: 'https://api.anthropic.com', api: 'anthropic-messages', generationOnly: true, embeddingPresets: [], rerankPresets: [] },
  { id: 'google', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generate-content', generationOnly: true, embeddingPresets: [], rerankPresets: [] },
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
  { id: 'moonshot', label: 'Moonshot AI', endpoint: 'https://api.moonshot.cn/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
  { id: 'qwen', label: '通义千问（百炼）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['text-embedding-v3', 'text-embedding-v2'], rerankPresets: ['gte-rerank-v2'] },
  { id: 'zhipu', label: '智谱 AI', endpoint: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', generationOnly: false, embeddingPresets: ['embedding-3'], rerankPresets: [] },
  { id: 'siliconflow', label: 'SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'], rerankPresets: ['BAAI/bge-reranker-v2-m3'] },
  { id: 'jina', label: 'Jina AI', endpoint: 'https://api.jina.ai/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['jina-embeddings-v3', 'jina-embeddings-v2-base-zh'], rerankPresets: ['jina-reranker-v2-base-multilingual'] },
  { id: 'voyage', label: 'Voyage AI', endpoint: 'https://api.voyageai.com/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['voyage-3', 'voyage-zh-3'], rerankPresets: ['rerank-2'] },
  { id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
  { id: 'custom', label: '自定义 OpenAI 兼容 API', endpoint: '', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
];

/** Preset embedding model names commonly available on local Ollama. / 本地 Ollama 常见的嵌入模型预设名。 */
export const OLLAMA_EMBEDDING_PRESETS = ['bge-m3', 'nomic-embed-text', 'm3e-base'];

/**
 * Minimal key-value store abstraction used for hub persistence.
 * 模型中枢持久化使用的最小键值存储抽象。
 */
export interface HubStore {
  /** Read a stored value / 读取已存值 */
  get: (key: string) => unknown;
  /** Write a stored value / 写入存储值 */
  set: (key: string, value: unknown) => void;
  /** Delete a stored value / 删除存储值 */
  delete: (key: string) => void;
}

interface StoredProvider {
  endpoint?: string;
  api?: Exclude<AiGenerationApi, 'ollama-chat'>;
  models?: string[];
}

const hubKey = 'modelHub';
const providersKey = 'modelProviders';
const secretsKey = 'modelProviderSecrets';

function readRecord(store: HubStore, key: string): Record<string, unknown> {
  const stored = store.get(key);
  return (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
}

function readStoredProviders(store: HubStore): Record<string, StoredProvider> {
  const record = readRecord(store, providersKey);
  const result: Record<string, StoredProvider> = {};
  for (const [id, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    result[id] = {
      endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
      api: isRemoteGenerationApi(entry.api) ? entry.api : undefined,
      models: Array.isArray(entry.models) ? entry.models.filter((name): name is string => typeof name === 'string') : undefined,
    };
  }
  return result;
}

function readSecrets(store: HubStore): Record<string, string> {
  const record = readRecord(store, secretsKey);
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(record)) {
    if (typeof value === 'string' && value) result[id] = value;
  }
  return result;
}

function catalogEntry(id: string): ModelProviderCatalogEntry {
  return MODEL_PROVIDER_CATALOG.find((entry) => entry.id === id) ?? MODEL_PROVIDER_CATALOG[MODEL_PROVIDER_CATALOG.length - 1];
}

function normalizeSlot(value: unknown, fallback: ModelSlot, allowNone: boolean): ModelSlot {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const source = typeof record.source === 'string' ? record.source : fallback.source;
  return {
    source: source === OLLAMA_SOURCE_ID ? OLLAMA_SOURCE_ID : source === NO_SOURCE_ID && allowNone ? NO_SOURCE_ID : source,
    model: typeof record.model === 'string' ? record.model : fallback.model,
  };
}

/**
 * Read the model hub; on first read it migrates the legacy single aiProvider
 * config into the "provider connection + purpose slot" structure.
 * 读取模型中枢；首读时把旧版单一 aiProvider 配置迁移为「厂商连接 + 用途槽位」结构。
 *
 * @param store - Config store to read from / 读取配置的存储
 * @returns The normalized model hub / 归一化后的模型中枢
 */
export function readModelHub(store: HubStore): ModelHub {
  const stored = store.get(hubKey);
  const record = (stored && typeof stored === 'object' ? stored : null) as Record<string, unknown> | null;
  const providers = readStoredProviders(store);
  const secrets = readSecrets(store);

  let ollamaEndpoint = '';
  let remoteConsent = true;
  let slots: Record<ModelSlotId, ModelSlot> = {
    generation: { source: OLLAMA_SOURCE_ID, model: '' },
    embedding: { source: OLLAMA_SOURCE_ID, model: '' },
    rerank: { source: NO_SOURCE_ID, model: '' },
  };

  if (record) {
    ollamaEndpoint = typeof record.ollamaEndpoint === 'string' ? record.ollamaEndpoint : '';
    // The legacy switch is no longer exposed; auto-migrate to consented on read so old values cannot silently block.
    // 旧版开关不再暴露；读取时自动迁移为已同意，避免旧值形成不可见阻断。
    remoteConsent = true;
    const storedSlots = (record.slots && typeof record.slots === 'object' ? record.slots : {}) as Record<string, unknown>;
    slots = {
      generation: normalizeSlot(storedSlots.generation, slots.generation, false),
      embedding: normalizeSlot(storedSlots.embedding, slots.embedding, false),
      rerank: normalizeSlot(storedSlots.rerank, slots.rerank, true),
    };
  }

  return {
    ollamaEndpoint,
    ollamaEmbeddingPresets: OLLAMA_EMBEDDING_PRESETS,
    remoteConsent,
    slots,
    providers: MODEL_PROVIDER_CATALOG.map((entry) => {
      const storedProvider = providers[entry.id];
      return {
        id: entry.id,
        label: entry.label,
        endpoint: storedProvider?.endpoint ?? entry.endpoint,
        defaultEndpoint: entry.endpoint,
        api: storedProvider?.api ?? entry.api,
        generationOnly: entry.generationOnly,
        hasKey: Boolean(secrets[entry.id]),
        models: storedProvider?.models ?? [],
        embeddingPresets: entry.embeddingPresets,
        rerankPresets: entry.rerankPresets,
      };
    }),
  };
}

/**
 * Legacy single-provider configuration shape used as migration input.
 * 作为迁移输入的旧版单一厂商配置结构。
 */
export interface LegacyModelConfig {
  /** Legacy provider settings without the raw key / 旧版厂商配置（不含明文密钥） */
  provider?: (Omit<AiProviderConfig, 'apiKey'> & { hasApiKey?: boolean }) | null;
  /** Legacy encrypted provider secret / 旧版加密厂商密钥 */
  providerSecret?: string;
  /** Legacy semantic embedding model name / 旧版语义嵌入模型名 */
  embeddingModel: string;
}

/**
 * Migrate legacy single aiProvider + semanticEmbeddingModel into the model hub; skipped when already migrated.
 * 旧版单一 aiProvider + semanticEmbeddingModel 迁移到模型中枢；已迁移则直接跳过。
 *
 * @param store - Config store to write to / 写入配置的存储
 * @param legacy - Legacy configuration to migrate / 待迁移的旧版配置
 */
export function ensureModelHubMigrated(store: HubStore, legacy: LegacyModelConfig): void {
  if (store.get(hubKey)) return;
  const providers: Record<string, StoredProvider> = {};
  const secrets: Record<string, string> = {};
  let generation: ModelSlot = { source: OLLAMA_SOURCE_ID, model: '' };
  let ollamaEndpoint = '';
  let remoteConsent = true;

  const previous = legacy.provider;
  if (previous?.kind === 'openai-compatible') {
    const id = MODEL_PROVIDER_CATALOG.some((entry) => entry.id === previous.provider) ? (previous.provider as string) : 'custom';
    providers[id] = {
      endpoint: previous.endpoint ?? '',
      models: (previous.availableModels ?? []).map((model) => model.name).filter(Boolean),
    };
    if (legacy.providerSecret) secrets[id] = legacy.providerSecret;
    generation = { source: id, model: previous.model ?? '' };
    remoteConsent = true;
  } else if (previous?.kind === 'ollama') {
    ollamaEndpoint = previous.endpoint ?? '';
    generation = { source: OLLAMA_SOURCE_ID, model: previous.model ?? '' };
  }

  store.set(providersKey, providers);
  if (Object.keys(secrets).length) store.set(secretsKey, secrets);
  store.set(hubKey, {
    version: 1,
    ollamaEndpoint,
    remoteConsent,
    slots: {
      generation,
      embedding: { source: OLLAMA_SOURCE_ID, model: legacy.embeddingModel },
      rerank: { source: NO_SOURCE_ID, model: '' },
    },
  });
}

/**
 * Apply a partial hub patch and persist the normalized result.
 * 应用模型中枢增量补丁并持久化归一化结果。
 *
 * @param store - Config store to write to / 写入配置的存储
 * @param patch - Partial hub changes / 中枢的部分变更
 * @returns The updated model hub / 更新后的模型中枢
 */
export function saveModelHub(store: HubStore, patch: ModelHubPatch): ModelHub {
  const current = readModelHub(store);
  const slots: Record<ModelSlotId, ModelSlot> = {
    generation: normalizeSlot({ ...current.slots.generation, ...patch.slots?.generation }, current.slots.generation, false),
    embedding: normalizeSlot({ ...current.slots.embedding, ...patch.slots?.embedding }, current.slots.embedding, false),
    rerank: normalizeSlot({ ...current.slots.rerank, ...patch.slots?.rerank }, current.slots.rerank, true),
  };
  // Generation and embedding must always resolve to a real source; only rerank may be "none".
  // 生成与嵌入必须落到真实来源；仅重排槽位允许为 "none"。
  if (slots.generation.source === NO_SOURCE_ID) slots.generation = { ...slots.generation, source: OLLAMA_SOURCE_ID };
  if (slots.embedding.source === NO_SOURCE_ID) slots.embedding = { ...slots.embedding, source: OLLAMA_SOURCE_ID };
  // Generation-only providers cannot serve embedding or rerank; reset those slots to a safe source.
  // 仅生成厂商不能承担嵌入或重排；将其重置为安全来源。
  const embeddingProvider = current.providers.find((provider) => provider.id === slots.embedding.source);
  if (embeddingProvider?.generationOnly) slots.embedding = { source: OLLAMA_SOURCE_ID, model: '' };
  const rerankProvider = current.providers.find((provider) => provider.id === slots.rerank.source);
  if (rerankProvider?.generationOnly) slots.rerank = { source: NO_SOURCE_ID, model: '' };
  store.set(hubKey, {
    version: 1,
    ollamaEndpoint: typeof patch.ollamaEndpoint === 'string' ? patch.ollamaEndpoint.trim() : current.ollamaEndpoint,
    remoteConsent: true,
    slots,
  });
  return readModelHub(store);
}

/**
 * Persist a provider connection (endpoint, protocol, model list) and optionally its encrypted API key.
 * 持久化厂商连接（端点、协议、模型列表）并可选写入加密 API 密钥。
 *
 * @param store - Config store to write to / 写入配置的存储
 * @param id - Provider catalog id / 厂商目录 id
 * @param patch - Connection fields to update / 待更新的连接字段
 * @returns The updated model hub / 更新后的模型中枢
 */
export function saveProviderConnection(store: HubStore, id: string, patch: { endpoint?: string; api?: Exclude<AiGenerationApi, 'ollama-chat'>; apiKey?: string | null; models?: string[] }): ModelHub {
  if (!MODEL_PROVIDER_CATALOG.some((entry) => entry.id === id)) throw new Error('未知的模型厂商。');
  const providers = readStoredProviders(store);
  const current = providers[id] ?? {};
  const next: StoredProvider = { ...current };
  if (typeof patch.endpoint === 'string') next.endpoint = patch.endpoint.trim() || catalogEntry(id).endpoint;
  if (patch.api && isRemoteGenerationApi(patch.api)) next.api = patch.api;
  if (Array.isArray(patch.models)) next.models = [...new Set(patch.models.map((name) => name.trim()).filter(Boolean))].slice(0, 300);
  providers[id] = next;
  store.set(providersKey, providers);

  const enteredKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (enteredKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API 密钥未保存。');
    const secrets = readSecrets(store);
    secrets[id] = safeStorage.encryptString(enteredKey).toString('base64');
    store.set(secretsKey, secrets);
  }
  return readModelHub(store);
}

/**
 * Resolve provider credentials for main-process use; the renderer only ever sees hasKey.
 * 主进程内部取用厂商凭据；渲染进程只能看到 hasKey。
 *
 * @param store - Config store to read from / 读取配置的存储
 * @param id - Provider catalog id / 厂商目录 id
 * @returns Endpoint and decrypted API key when available / 端点与（可用时的）解密 API 密钥
 */
export function resolveProviderCredentials(store: HubStore, id: string): { endpoint: string; apiKey?: string } {
  const hub = readModelHub(store);
  const provider = hub.providers.find((entry) => entry.id === id);
  const endpoint = provider?.endpoint || catalogEntry(id).endpoint;
  const encrypted = readSecrets(store)[id];
  if (!endpoint) return { endpoint: '' };
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return { endpoint };
  try {
    return { endpoint, apiKey: safeStorage.decryptString(Buffer.from(encrypted, 'base64')) };
  } catch {
    return { endpoint };
  }
}

/**
 * Store the model list fetched for a provider, keyed by provider id.
 * 按厂商 id 存储已拉取的模型列表。
 *
 * @param store - Config store to write to / 写入配置的存储
 * @param id - Provider catalog id / 厂商目录 id
 * @param models - Model identifiers to keep / 需要保留的模型标识
 */
export function storeProviderModels(store: HubStore, id: string, models: string[]): void {
  saveProviderConnection(store, id, { models });
}

/**
 * Resolve the generation slot into a runtime AiProviderConfig (for configureAiProvider).
 * 生成槽位 → 运行时 AiProviderConfig（供 configureAiProvider 使用）。
 *
 * @param store - Config store to read from / 读取配置的存储
 * @returns Runtime provider configuration / 运行时厂商配置
 */
export function resolveGenerationConfig(store: HubStore): AiProviderConfig {
  const hub = readModelHub(store);
  const slot = hub.slots.generation;
  if (slot.source === OLLAMA_SOURCE_ID) {
    return { kind: 'ollama', endpoint: hub.ollamaEndpoint.trim() || undefined, model: slot.model.trim() || undefined };
  }
  const credentials = resolveProviderCredentials(store, slot.source);
  const provider = hub.providers.find((entry) => entry.id === slot.source);
  return {
    kind: 'openai-compatible',
    provider: slot.source,
    api: provider?.api ?? catalogEntry(slot.source).api,
    endpoint: credentials.endpoint || catalogEntry(slot.source).endpoint,
    apiKey: credentials.apiKey,
    model: slot.model.trim() || undefined,
    availableModels: (provider?.models ?? []).map((name) => ({ name })),
    remoteContentConsent: hub.remoteConsent,
  };
}

/**
 * Resolved runtime embedding source: local Ollama or a credentialed remote provider.
 * 解析后的运行时嵌入来源：本地 Ollama 或已带凭据的远程厂商。
 */
export type ResolvedEmbeddingSource =
  | { kind: 'ollama'; endpoint?: string; model: string }
  | { kind: 'remote'; endpoint: string; apiKey: string; model: string };

/**
 * Resolve the embedding slot into an indexing runtime source; remote embedding
 * requires remote-send consent and a usable key.
 * 嵌入槽位 → 索引运行时来源；远程嵌入必须已同意远程发送且密钥可用。
 *
 * @param store - Config store to read from / 读取配置的存储
 * @returns Resolved source, or null when unavailable / 解析后的来源，不可用时为 null
 */
export function resolveEmbeddingSource(store: HubStore): ResolvedEmbeddingSource | null {
  const hub = readModelHub(store);
  const slot = hub.slots.embedding;
  const model = slot.model.trim();
  if (!model) return null;
  if (slot.source === OLLAMA_SOURCE_ID) {
    return { kind: 'ollama', endpoint: hub.ollamaEndpoint.trim() || undefined, model };
  }
  const provider = hub.providers.find((entry) => entry.id === slot.source);
  if (provider?.generationOnly) return null;
  if (!hub.remoteConsent) return null;
  const credentials = resolveProviderCredentials(store, slot.source);
  if (!credentials.endpoint || !credentials.apiKey) return null;
  return { kind: 'remote', endpoint: credentials.endpoint, apiKey: credentials.apiKey, model };
}

function isRemoteGenerationApi(value: unknown): value is Exclude<AiGenerationApi, 'ollama-chat'> {
  return value === 'openai-completions'
    || value === 'openai-responses'
    || value === 'anthropic-messages'
    || value === 'google-generate-content';
}
