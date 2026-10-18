/**
 * Resolve vendor-native model-catalog requests and filter language-generation models for the model selector.
 * 解析厂商原生模型目录请求，并为模型选择器筛选支持文本生成的模型。
 */

import type { AiGenerationApi, AiRemoteProviderId } from './aiTypes.ts';

type RemoteGenerationApi = Exclude<AiGenerationApi, 'ollama-chat'>;

/**
 * HTTP request description for fetching a vendor model catalog.
 * 拉取厂商模型目录的 HTTP 请求描述。
 */
export interface GenerationModelCatalogRequest {
  /** Catalog endpoint URL. / 目录接口地址。 */
  url: string;
  /** Request headers including authentication. / 请求头（含鉴权信息）。 */
  headers: Record<string, string>;
}

/**
 * Provider connection settings needed to build a model-catalog request.
 * 构建模型目录请求所需的提供商连接配置。
 */
export interface GenerationModelCatalogConfig {
  /** Remote vendor identity. / 远程厂商标识。 */
  provider: AiRemoteProviderId;
  /** Wire protocol used to talk to the provider. / 与提供商通信使用的接口协议。 */
  api: RemoteGenerationApi;
  /** Base endpoint URL of the provider API. / 提供商 API 的基础地址。 */
  endpoint: string;
  /** API key used to authenticate catalog requests. / 用于目录请求鉴权的 API 密钥。 */
  apiKey: string;
}

/**
 * Resolve the vendor-native model catalog used by the language-model selector.
 * 解析语言模型选择器使用的厂商原生模型目录。
 *
 * @param config - Provider endpoint and credentials / 提供商地址与凭据
 * @returns URL and headers for the catalog fetch / 拉取目录所用的 URL 与请求头
 */
export function resolveGenerationModelCatalogRequest(config: GenerationModelCatalogConfig): GenerationModelCatalogRequest {
  const endpoint = normalizeEndpoint(config.endpoint);
  if (config.provider === 'qwen') {
    const nativeUrl = resolveBailianGenerationCatalogUrl(endpoint);
    if (nativeUrl) {
      return {
        url: nativeUrl,
        headers: { authorization: `Bearer ${config.apiKey}` },
      };
    }
  }
  if (config.api === 'anthropic-messages') {
    return {
      url: /\/v1$/u.test(endpoint) ? `${endpoint}/models` : `${endpoint}/v1/models`,
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    };
  }
  if (config.api === 'google-generate-content') {
    return {
      url: `${endpoint}/models?pageSize=1000`,
      headers: { 'x-goog-api-key': config.apiKey },
    };
  }
  return {
    url: `${endpoint}/models`,
    headers: { authorization: `Bearer ${config.apiKey}` },
  };
}

/**
 * Extract model entry objects from a vendor catalog response, probing common wrapper keys.
 * 从厂商目录响应中提取模型条目对象，按常见包裹字段逐层探测。
 *
 * @param value - Raw JSON response value / 原始 JSON 响应值
 * @param depth - Recursion depth guard against deeply nested payloads / 防止深层嵌套载荷的递归深度保护
 * @returns Model entry records found in the response / 响应中找到的模型条目记录
 */
export function readGenerationModelCatalogItems(value: unknown, depth = 0): Array<Record<string, unknown>> {
  // Hard depth cap keeps hostile or cyclic-looking payloads from recursing forever. / 深度硬上限防止恶意或近似循环的载荷导致无限递归。
  if (depth > 3 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
  }
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'models', 'output', 'result', 'items']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      const items = candidate.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
      if (items.length) return items;
    }
    const nested = readGenerationModelCatalogItems(candidate, depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

/**
 * Read a model identifier from a catalog item, normalizing away Google's `models/` prefix.
 * 从目录条目中读取模型标识，并去掉 Google 的 `models/` 前缀。
 *
 * @param value - Catalog item record / 目录条目记录
 * @param api - Wire protocol of the provider / 提供商使用的接口协议
 * @returns Normalized model name when present / 归一化后的模型名（如有）
 */
export function readGenerationModelCatalogName(value: Record<string, unknown>, api: RemoteGenerationApi): string | undefined {
  for (const key of ['id', 'model', 'model_name', 'name']) {
    const candidate = value[key];
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const name = candidate.trim();
    return api === 'google-generate-content' ? name.replace(/^models\//u, '') : name;
  }
  return undefined;
}

/**
 * Prefer declared capabilities. Name-based exclusion is only a compatibility
 * fallback for model-list APIs that expose identifiers without task metadata.
 * 优先使用声明的能力进行判断；仅当模型列表 API 只暴露标识而没有任务元数据时，
 * 才退回按名称排除的兼容性判断。
 *
 * @param provider - Vendor identity / 厂商标识
 * @param api - Wire protocol of the provider / 提供商使用的接口协议
 * @param item - Raw catalog item / 原始目录条目
 * @param model - Normalized model name / 归一化后的模型名
 * @returns True when the model can serve text generation / 模型可用于文本生成时返回 true
 */
export function supportsLanguageGeneration(
  provider: AiRemoteProviderId,
  api: RemoteGenerationApi,
  item: Record<string, unknown>,
  model: string,
): boolean {
  if (api === 'google-generate-content') {
    const methods = item.supportedGenerationMethods;
    if (Array.isArray(methods)) return methods.some((method) => method === 'generateContent');
  }

  // Explicit capability codes outrank name guessing: positive TG/chat matches win; media/ASR codes reject. / 显式能力码优先于名称猜测：TG/chat 正匹配直接通过，媒体/ASR 码直接拒绝。
  const capabilities = readStringArray(item.capabilities);
  if (capabilities.some((capability) => /^(?:tg|text[-_ ]?generation|chat|completion)$/iu.test(capability))) return true;
  if (capabilities.some((capability) => /^(?:tr|me|ig|vg|asr|tts|realtime-omni|realtime-text-to-speech|realtime-asr|realtime-audio-translate|3d-generation)$/iu.test(capability)
    || /(?:embedding|rerank|moderation|image|video|audio|speech|transcri|realtime)/iu.test(capability))) return false;

  const inferenceMetadata = readRecord(item.inference_metadata) ?? readRecord(item.inferenceMetadata);
  const responseModalities = readStringArray(inferenceMetadata?.response_modality ?? inferenceMetadata?.responseModality);
  if (responseModalities.length && !responseModalities.some((modality) => /^text$/iu.test(modality))) return false;

  const declaredPurpose = readDeclaredPurpose(item);
  if (declaredPurpose === 'generation') return true;
  if (declaredPurpose === 'other') return false;

  return !isKnownNonLanguageModel(model, provider);
}

// Only official DashScope/MaaS hosts are rewritten to the Bailian catalog API with a TG capability filter. / 仅当端点为官方 DashScope/MaaS 域名时，改写为百炼目录接口并附加 TG 能力过滤。
function resolveBailianGenerationCatalogUrl(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    const officialHost = hostname === 'dashscope.aliyuncs.com'
      || hostname.endsWith('.dashscope.aliyuncs.com')
      || hostname.endsWith('.maas.aliyuncs.com');
    if (!officialHost) return undefined;
    url.pathname = '/api/v1/models';
    url.search = '';
    url.searchParams.set('capabilities', 'TG');
    url.searchParams.set('page_no', '1');
    url.searchParams.set('page_size', '100');
    return url.toString();
  } catch {
    return undefined;
  }
}

// Classify declared task/model_type/purpose metadata as 'generation', 'other', or unknown. / 将声明的 task/model_type/purpose 元数据归类为"生成""其他"或未知。
function readDeclaredPurpose(item: Record<string, unknown>): 'generation' | 'other' | undefined {
  for (const key of ['task', 'model_type', 'modelType', 'purpose']) {
    const values = typeof item[key] === 'string' ? [item[key] as string] : readStringArray(item[key]);
    if (values.some((value) => /(?:chat|completion|text[-_ ]?generation|language|reasoning)/iu.test(value))) return 'generation';
    if (values.some((value) => /(?:embedding|rerank|moderation|image|video|audio|speech|transcri|realtime|tts|asr)/iu.test(value))) return 'other';
  }
  return undefined;
}

// Last-resort name-based exclusion for embedding/media models; OpenAI uses a narrower keyword set. / 按名称排除嵌入/媒体模型的兜底判断；OpenAI 使用更窄的关键词集合。
function isKnownNonLanguageModel(model: string, provider: AiRemoteProviderId): boolean {
  const normalized = model.toLowerCase();
  if (provider === 'openai') {
    return /(?:^|[-_/])(?:embedding|moderation|whisper|transcri(?:be|ption)|tts|realtime|audio|image|dall-e|sora)(?:[-_/]|$)/u.test(normalized);
  }
  return /(?:^|[-_/])(?:embedding|rerank|moderation|whisper|transcri(?:be|ption)|tts|asr|realtime|audio|speech|image|video|dall-e|sora)(?:[-_/]|$)/u.test(normalized);
}

// Coerce a value to a trimmed, non-empty string list. / 将值规整为去空白后的非空字符串列表。
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

// Coerce a value to a plain object record, or undefined for arrays/scalars. / 将值规整为普通对象记录；数组与标量返回 undefined。
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Trim whitespace and trailing slashes so URL concatenation stays well-formed. / 去掉首尾空白与末尾斜杠，保证后续 URL 拼接正确。
function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}
