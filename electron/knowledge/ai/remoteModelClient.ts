/**
 * Remote model catalog lookup and OpenAI-compatible embedding adapters.
 * 远程模型目录拉取与 OpenAI 兼容嵌入适配器。
 */
import {
  createMaterialEmbeddingRequestSignal,
  MaterialEmbeddingAdapterError,
  type MaterialEmbeddingBatchResult,
} from '../../pipeline/materialEmbeddingTypes';
import type { AiGenerationApi } from './aiTypes.ts';

/**
 * Result of a remote provider model-catalog probe.
 * 远程厂商模型目录探测结果。
 */
export interface RemoteProviderModelsResult {
  /** Whether endpoint and credential checks passed / 端点与密钥校验是否通过 */
  available: boolean;
  /** Normalized model identifiers returned by the provider / 供应商返回的归一化模型标识 */
  models: string[];
  /** User-facing status or error text / 面向用户的状态或错误文案 */
  message: string;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Validate the provider key and fetch the model catalog according to the generation protocol.
 * 按生成协议校验厂商密钥并拉取模型目录。
 *
 * @param endpoint - Provider base URL / 供应商基础地址
 * @param apiKey - Provider API key / 供应商 API 密钥
 * @param api - Generation protocol to use / 使用的生成协议
 * @returns Availability flag, model list and user-facing message / 可用性标志、模型列表与用户提示
 */
export async function fetchRemoteProviderModels(
  endpoint: string,
  apiKey: string,
  api: Exclude<AiGenerationApi, 'ollama-chat'> = 'openai-completions',
): Promise<RemoteProviderModelsResult> {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) return { available: false, models: [], message: '请先填写 API 地址。' };
  if (!apiKey.trim()) return { available: false, models: [], message: '请填写 API 密钥后再获取可用模型。' };
  try {
    const response = await fetch(resolveModelCatalogUrl(normalized, api), {
      headers: resolveModelCatalogHeaders(apiKey.trim(), api),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? 'API Key 校验失败，请检查密钥和供应商是否匹配。'
        : `远程服务返回 HTTP ${response.status}。`;
      return { available: false, models: [], message };
    }
    const payload = await response.json() as unknown;
    const models = [...new Set(readModelCatalogItems(payload).flatMap((item) => {
      if (api === 'google-generate-content') {
        const methods = item.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
      }
      const value = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
      const name = api === 'google-generate-content' ? value.replace(/^models\//u, '').trim() : value.trim();
      return name ? [name] : [];
    }))].slice(0, 300);
    return { available: true, models, message: models.length ? `API Key 校验通过，已获取 ${models.length} 个可用模型。` : 'API Key 校验通过，但供应商没有返回模型列表。' };
  } catch (error) {
    const message = error instanceof DOMException && error.name === 'TimeoutError'
      ? '连接远程服务超时。'
      : '无法连接远程服务，请检查地址和网络。';
    return { available: false, models: [], message };
  }
}

function resolveModelCatalogUrl(endpoint: string, api: Exclude<AiGenerationApi, 'ollama-chat'>): string {
  if (api === 'anthropic-messages') return /\/v1$/u.test(endpoint) ? `${endpoint}/models` : `${endpoint}/v1/models`;
  if (api === 'google-generate-content') return `${endpoint}/models?pageSize=1000`;
  return `${endpoint}/models`;
}

function resolveModelCatalogHeaders(apiKey: string, api: Exclude<AiGenerationApi, 'ollama-chat'>): Record<string, string> {
  if (api === 'anthropic-messages') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (api === 'google-generate-content') return { 'x-goog-api-key': apiKey };
  return { authorization: `Bearer ${apiKey}` };
}

function readModelCatalogItems(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
}

/**
 * OpenAI-compatible remote /embeddings adapter; keeps the legacy `number[][]` signature.
 * OpenAI 兼容 /embeddings 远程嵌入适配器，保留旧的 number[][] 兼容签名。
 *
 * @param input - Endpoint, key, model and texts to embed / 端点、密钥、模型与待嵌入文本
 * @returns Embedding vectors in request order / 按请求顺序返回的嵌入向量
 */
export async function embedRemoteTexts(input: { endpoint: string; apiKey: string; model: string; texts: string[]; timeoutMs?: number; signal?: AbortSignal; requestedDimensions?: number; expectedModel?: string }): Promise<number[][]> {
  const result = await embedRemoteBatch(input);
  return result.vectors;
}

/**
 * Call the remote /embeddings endpoint for a batch of texts and validate the response.
 * 批量调用远程 /embeddings 端点并校验响应。
 *
 * @param input - Endpoint, key, model, texts and optional dimension/timeout controls / 端点、密钥、模型、文本与可选维度/超时控制
 * @returns Vectors, dimension and optional usage/request metadata / 向量、维度与可选用量/请求元数据
 */
export async function embedRemoteBatch(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  texts: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  requestedDimensions?: number;
  expectedModel?: string;
}): Promise<MaterialEmbeddingBatchResult> {
  const endpoint = normalizeEndpoint(input.endpoint);
  const model = input.model.trim();
  const apiKey = input.apiKey.trim();
  if (!endpoint || !model || !apiKey || !Array.isArray(input.texts) || input.texts.length === 0 || input.texts.some((text) => typeof text !== 'string' || !text.trim())) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_INPUT_INVALID', '远程向量批次的地址、密钥、模型和文本不能为空。');
  }
  const requestSignal = createMaterialEmbeddingRequestSignal(input.signal, input.timeoutMs ?? 60_000);
  try {
    const response = await fetch(`${endpoint}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: requestSignal.signal,
      body: JSON.stringify({ model, input: input.texts, ...(input.requestedDimensions === undefined ? {} : { dimensions: input.requestedDimensions }) }),
    });
    if (!response.ok) throw classifyHttpError(response);

    let payload: RemoteEmbeddingResponse;
    try {
      payload = await response.json() as RemoteEmbeddingResponse;
    } catch {
      throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '远程向量服务返回的响应不是有效 JSON。');
    }
    const responseModel = readResponseModel(payload.model);
    if (input.expectedModel && responseModel && responseModel !== input.expectedModel.trim()) {
      throw new MaterialEmbeddingAdapterError('EMBEDDING_MODEL_MISMATCH', '远程服务返回模型与锁定模型不一致。');
    }
    const vectors = orderAndValidateEmbeddings(payload.data, input.texts.length, input.requestedDimensions);
    return {
      vectors,
      dimension: vectors[0]?.length ?? 0,
      ...(responseModel ? { responseModel } : {}),
      ...(typeof payload.usage?.prompt_tokens === 'number' && Number.isFinite(payload.usage.prompt_tokens)
        ? { usage: { inputTokens: payload.usage.prompt_tokens, ...(typeof payload.usage.total_tokens === 'number' && Number.isFinite(payload.usage.total_tokens) ? { totalTokens: payload.usage.total_tokens } : {}) } }
        : {}),
      ...(typeof payload.id === 'string' && payload.id.trim() ? { requestId: payload.id.trim().slice(0, 256) } : {}),
    };
  } catch (error) {
    if (error instanceof MaterialEmbeddingAdapterError) throw error;
    throw classifyTransportError(error, input.signal, requestSignal);
  } finally {
    requestSignal.cleanup();
  }
}

/** Loose shape of a remote embeddings response before validation. / 远程嵌入响应在校验前的宽松结构。 */
interface RemoteEmbeddingResponse {
  id?: unknown;
  model?: unknown;
  data?: unknown;
  usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
}

/**
 * Validate embedding rows and restore request order via each row's index.
 * 校验向量行并通过各行 index 还原请求顺序。
 */
function orderAndValidateEmbeddings(value: unknown, expectedCount: number, requestedDimensions?: number): number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '远程服务返回的向量数量与请求文本不一致。');
  }
  // Providers may return rows out of order; place each row at its declared index and reject duplicates/gaps.
  // 供应商可能乱序返回；按声明的 index 归位，并拒绝重复或缺失的 index。
  const ordered: Array<number[] | undefined> = Array.from({ length: expectedCount });
  const seen = new Set<number>();
  for (const row of value) {
    if (!row || typeof row !== 'object') throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '远程服务返回了无效向量项。');
    const record = row as { index?: unknown; embedding?: unknown };
    if (!Number.isInteger(record.index) || Number(record.index) < 0 || Number(record.index) >= expectedCount || seen.has(Number(record.index))) {
      throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '远程服务返回的向量 index 重复、缺失或越界。');
    }
    const index = Number(record.index);
    if (!Array.isArray(record.embedding) || record.embedding.length === 0 || !record.embedding.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '远程服务返回了空向量或非有限数值。');
    }
    ordered[index] = record.embedding as number[];
    seen.add(index);
  }
  if (ordered.some((embedding) => !embedding)) throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '远程服务返回的向量 index 不完整。');
  const vectors = ordered as number[][];
  const dimension = vectors[0]?.length ?? 0;
  if (requestedDimensions !== undefined && dimension !== requestedDimensions) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_DIMENSION_MISMATCH', '远程服务返回维度与候选配置不一致。');
  }
  if (vectors.some((vector) => vector.length !== dimension)) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_DIMENSION_MISMATCH', '远程服务返回的向量维度不一致。');
  }
  return vectors;
}

function readResponseModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '远程服务返回的模型标识无效。');
  return value.trim();
}

/**
 * Classify fetch failures into timeout / cancel / network adapter errors.
 * 将 fetch 失败归类为超时 / 取消 / 网络适配错误。
 */
function classifyTransportError(error: unknown, parentSignal: AbortSignal | undefined, requestSignal: ReturnType<typeof createMaterialEmbeddingRequestSignal>): MaterialEmbeddingAdapterError {
  if (requestSignal.didTimeout()) return new MaterialEmbeddingAdapterError('EMBEDDING_TIMEOUT', '远程向量请求超时。', { retryable: true });
  if (parentSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) return new MaterialEmbeddingAdapterError('EMBEDDING_CANCELLED', '远程向量请求已取消。', { retryable: true });
  return new MaterialEmbeddingAdapterError('EMBEDDING_NETWORK_ERROR', '无法连接远程向量服务。', { retryable: true });
}

/**
 * Map HTTP status codes to typed, retry-aware embedding adapter errors.
 * 将 HTTP 状态码映射为带可重试标记的类型化嵌入适配错误。
 */
function classifyHttpError(response: Response): MaterialEmbeddingAdapterError {
  const status = response.status;
  if (status === 401 || status === 403) return new MaterialEmbeddingAdapterError('EMBEDDING_AUTH_FAILED', `远程向量服务认证失败（HTTP ${status}）。`, { status });
  if (status === 408) return new MaterialEmbeddingAdapterError('EMBEDDING_TIMEOUT', '远程向量服务请求超时。', { retryable: true, status });
  if (status === 413) return new MaterialEmbeddingAdapterError('EMBEDDING_BATCH_TOO_LARGE', '远程向量批次过大。', { retryable: true, status });
  if (status === 429) return new MaterialEmbeddingAdapterError('EMBEDDING_RATE_LIMITED', '远程向量服务请求过于频繁。', { retryable: true, status, retryAfterMs: readRetryAfter(response.headers.get('retry-after')) });
  if (status === 404) return new MaterialEmbeddingAdapterError('EMBEDDING_MODEL_UNAVAILABLE', '远程向量模型不可用。', { status });
  if (status >= 500) return new MaterialEmbeddingAdapterError('EMBEDDING_NETWORK_ERROR', `远程向量服务暂时不可用（HTTP ${status}）。`, { retryable: true, status });
  return new MaterialEmbeddingAdapterError('EMBEDDING_HTTP_ERROR', `远程向量服务请求失败（HTTP ${status}）。`, { status });
}

/**
 * Parse a Retry-After header (seconds or HTTP-date) into capped milliseconds.
 * 将 Retry-After 响应头（秒数或 HTTP 日期）解析为有上限的毫秒值。
 */
function readRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 120_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(timestamp - Date.now(), 120_000)) : undefined;
}
