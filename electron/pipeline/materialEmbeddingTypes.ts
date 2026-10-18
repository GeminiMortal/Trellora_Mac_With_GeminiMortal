/**
 * Types, constants, validation and hashing for material embedding profiles and adapter errors.
 * 资料嵌入配置与适配器错误的类型、常量、校验与哈希计算。
 */
import crypto from 'node:crypto';

/** Schema version of embedding profile records. / 嵌入配置记录的 schema 版本。 */
export const MATERIAL_EMBEDDING_SCHEMA_VERSION = 1 as const;
/** Input-text version tag for document-side embeddings. / 文档侧嵌入的输入文本版本标记。 */
export const MATERIAL_DOCUMENT_INPUT_VERSION = 'material-chunk-text-v1' as const;
/** Input-text version tag for query-side embeddings. / 查询侧嵌入的输入文本版本标记。 */
export const MATERIAL_QUERY_INPUT_VERSION = 'material-query-text-v1' as const;
/** Vector element type stored by sqlite-vec. / sqlite-vec 存储的向量元素类型。 */
export const MATERIAL_VECTOR_TYPE = 'float32' as const;
/** Distance metric used by the vector index. / 向量索引使用的距离度量。 */
export const MATERIAL_DISTANCE_METRIC = 'cosine' as const;
/** Encoding format requested from embedding APIs. / 向嵌入 API 请求的编码格式。 */
export const MATERIAL_ENCODING_FORMAT = 'float' as const;

/** Supported embedding transport kinds. / 支持的嵌入传输方式。 */
export type MaterialEmbeddingTransportKind = 'ollama' | 'openai-compatible';
/** Lifecycle state of an embedding profile. / 嵌入配置的生命周期状态。 */
export type MaterialEmbeddingProfileState = 'UNBOUND' | 'LOCKED' | 'LEGACY_UNBOUND';

/** Stable error codes raised by embedding-profile operations. / 嵌入配置操作抛出的稳定错误码。 */
export type MaterialEmbeddingProfileErrorCode =
  | 'EMBEDDING_PROFILE_INVALID'
  | 'EMBEDDING_PROFILE_REQUIRED'
  | 'EMBEDDING_PROFILE_LOCKED'
  | 'EMBEDDING_PROFILE_LEGACY_REQUIRES_MIGRATION'
  | 'EMBEDDING_PROFILE_SCHEMA_INVALID'
  | 'EMBEDDING_PROFILE_VECTOR_SCHEMA_CONFLICT'
  | 'EMBEDDING_PROFILE_VECTOR_TABLE_MISSING'
  | 'EMBEDDING_PROBE_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_CREDENTIAL_REQUIRED'
  | 'EMBEDDING_CONSENT_REQUIRED'
  | 'EMBEDDING_PROFILE_MISMATCH';

/** Stable error codes raised by embedding-adapter calls. / 嵌入适配器调用抛出的稳定错误码。 */
export type MaterialEmbeddingAdapterErrorCode =
  | 'EMBEDDING_INPUT_INVALID'
  | 'EMBEDDING_PROFILE_MISMATCH'
  | 'EMBEDDING_AUTH_FAILED'
  | 'EMBEDDING_RATE_LIMITED'
  | 'EMBEDDING_TIMEOUT'
  | 'EMBEDDING_NETWORK_ERROR'
  | 'EMBEDDING_BATCH_TOO_LARGE'
  | 'EMBEDDING_MODEL_UNAVAILABLE'
  | 'EMBEDDING_RESPONSE_INVALID'
  | 'EMBEDDING_MODEL_MISMATCH'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_CANCELLED'
  | 'EMBEDDING_DB_WRITE_FAILED'
  | 'EMBEDDING_DB_READBACK_FAILED'
  | 'EMBEDDING_HTTP_ERROR';

/**
 * User-selected embedding settings before they are probed and locked.
 * 用户选择、尚未探测锁定的嵌入设置。
 */
export interface MaterialEmbeddingCandidate {
  /** Profile schema version. / 配置 schema 版本。 */
  schemaVersion: typeof MATERIAL_EMBEDDING_SCHEMA_VERSION;
  /** Provider source id in the model hub. / 模型中心中的提供商来源 id。 */
  sourceId: string;
  /** Transport used to reach the embedding service. / 访问嵌入服务使用的传输方式。 */
  transportKind: MaterialEmbeddingTransportKind;
  /** Canonical endpoint identity (see normalizeEndpointIdentity). / 规范化端点标识（见 normalizeEndpointIdentity）。 */
  endpointIdentity: string;
  /** Requested model name. / 请求的模型名称。 */
  requestedModel: string;
  /** Optional dimension hint sent to the API. / 可选的发送给 API 的维度提示。 */
  requestedDimensions?: number;
  /** Vector element type; fixed to float32. / 向量元素类型；固定为 float32。 */
  vectorType: typeof MATERIAL_VECTOR_TYPE;
  /** Distance metric; fixed to cosine. / 距离度量；固定为 cosine。 */
  distanceMetric: typeof MATERIAL_DISTANCE_METRIC;
  /** Encoding format; fixed to float. / 编码格式；固定为 float。 */
  encodingFormat: typeof MATERIAL_ENCODING_FORMAT;
  /** Whether oversized inputs may be truncated before embedding. / 超长输入是否允许截断后再嵌入。 */
  truncateInputs: boolean;
  /** Version tag of document-side input text. / 文档侧输入文本的版本标记。 */
  documentInputVersion: string;
  /** Version tag of query-side input text. / 查询侧输入文本的版本标记。 */
  queryInputVersion: string;
}

/**
 * Result of probing an embedding endpoint for its returned dimension.
 * 探测嵌入端点返回维度的结果。
 */
export interface MaterialEmbeddingProbeResult {
  /** Dimension of the returned probe vector. / 返回探测向量的维度。 */
  vectorDimension: number;
  /** Model name actually reported by the service. / 服务实际回报的模型名称。 */
  responseModel?: string;
}

/**
 * Result of one embedding batch call.
 * 一次批量嵌入调用的结果。
 */
export interface MaterialEmbeddingBatchResult {
  /** Embedded vectors in request order. / 按请求顺序排列的嵌入向量。 */
  vectors: number[][];
  /** Model name actually reported by the service. / 服务实际回报的模型名称。 */
  responseModel?: string;
  /** Dimension shared by all returned vectors. / 全部返回向量的公共维度。 */
  dimension: number;
  /** Optional token usage counters. / 可选的 token 用量计数。 */
  usage?: { inputTokens?: number; totalTokens?: number };
  /** Server-side request id for diagnostics. / 用于诊断的服务端请求 id。 */
  requestId?: string;
}

/**
 * A successfully probed and locked embedding profile; a change to any field is a new index generation.
 * 已成功探测并锁定的嵌入配置；任一字段变化即视为新的索引代际。
 */
export interface MaterialEmbeddingProfile extends MaterialEmbeddingCandidate {
  /** Hash identifying this profile's embedding semantics. / 标识该配置嵌入语义的哈希。 */
  profileHash: string;
  /** Always 'LOCKED' for this type. / 本类型恒为 'LOCKED'。 */
  state: 'LOCKED';
  /** Model name actually reported by the service. / 服务实际回报的模型名称。 */
  responseModel?: string;
  /** Probed vector dimension. / 探测得到的向量维度。 */
  vectorDimension: number;
  /** ISO timestamp when the profile was locked. / 配置锁定时间的 ISO 时间戳。 */
  lockedAt: string;
  /** App version that locked the profile. / 锁定该配置的应用版本。 */
  appVersion: string;
}

/**
 * Result of a successful candidate probe, before locking.
 * 候选探测成功、尚未锁定时的结果。
 */
export interface MaterialEmbeddingProfileTestResult {
  /** Always 'TESTED' for this type. / 本类型恒为 'TESTED'。 */
  state: 'TESTED';
  /** The validated candidate that was probed. / 被探测并校验通过的候选配置。 */
  candidate: MaterialEmbeddingCandidate;
  /** Model name actually reported by the service. / 服务实际回报的模型名称。 */
  responseModel?: string;
  /** Probed vector dimension. / 探测得到的向量维度。 */
  vectorDimension: number;
  /** Hash computed from the probed result. / 依据探测结果计算的哈希。 */
  profileHash: string;
}

/**
 * Snapshot of a legacy pre-profile vector table needing migration.
 * 需要迁移的旧版（无配置）向量表快照。
 */
export interface MaterialEmbeddingLegacyState {
  /** Whether the legacy vector table exists. / 旧版向量表是否存在。 */
  vectorTableExists: boolean;
  /** Row count of the legacy vector table. / 旧版向量表的行数。 */
  vectorRowCount: number;
  /** Model name recorded with the legacy vectors. / 旧向量记录的模型名称。 */
  storedModel?: string;
  /** Dimension recorded with the legacy vectors. / 旧向量记录的维度。 */
  storedDimension?: number;
}

/**
 * Overall embedding-profile status of a library index.
 * 资料库索引的整体嵌入配置状态。
 */
export interface MaterialEmbeddingProfileStatus {
  /** Lifecycle state. / 生命周期状态。 */
  state: MaterialEmbeddingProfileState;
  /** Locked profile when available. / 可用时的已锁定配置。 */
  profile?: MaterialEmbeddingProfile;
  /** Legacy table snapshot when state is LEGACY_UNBOUND. / 状态为 LEGACY_UNBOUND 时的旧表快照。 */
  legacy?: MaterialEmbeddingLegacyState;
}

/**
 * Error raised by embedding-profile validation, locking and schema operations.
 * 嵌入配置校验、锁定与 schema 操作抛出的错误。
 */
export class MaterialEmbeddingProfileError extends Error {
  /** Stable machine-readable error code. / 稳定的机器可读错误码。 */
  readonly code: MaterialEmbeddingProfileErrorCode;
  /** Whether the operation may succeed if retried. / 操作重试是否可能成功。 */
  readonly retryable: boolean;
  /** Optional technical detail for logs. / 可选的用于日志的技术细节。 */
  readonly diagnostic?: string;

  /**
   * Creates a profile error with a stable code.
   * 创建带稳定错误码的配置错误。
   *
   * @param code - Machine-readable error code / 机器可读错误码
   * @param message - Human-readable error message / 面向用户的错误信息
   * @param diagnostic - Optional technical detail / 可选的技术细节
   * @param retryable - Whether retrying may succeed / 重试是否可能成功
   */
  constructor(code: MaterialEmbeddingProfileErrorCode, message: string, diagnostic?: string, retryable = false) {
    super(message);
    this.name = 'MaterialEmbeddingProfileError';
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

/**
 * Error raised by embedding-adapter transport calls, carrying HTTP status and retry hints.
 * 嵌入适配器传输调用抛出的错误，携带 HTTP 状态与重试提示。
 */
export class MaterialEmbeddingAdapterError extends Error {
  /** Stable machine-readable error code. / 稳定的机器可读错误码。 */
  readonly code: MaterialEmbeddingAdapterErrorCode;
  /** Whether the call may succeed if retried. / 调用重试是否可能成功。 */
  readonly retryable: boolean;
  /** HTTP status code when the error came from a response. / 错误来自响应时的 HTTP 状态码。 */
  readonly status?: number;
  /** Server-suggested retry delay in milliseconds. / 服务端建议的重试延迟（毫秒）。 */
  readonly retryAfterMs?: number;

  /**
   * Creates an adapter error with a stable code and retry metadata.
   * 创建带稳定错误码与重试元数据的适配器错误。
   *
   * @param code - Machine-readable error code / 机器可读错误码
   * @param message - Human-readable error message / 面向用户的错误信息
   * @param options - Optional retry/status metadata / 可选的重试/状态元数据
   */
  constructor(code: MaterialEmbeddingAdapterErrorCode, message: string, options: { retryable?: boolean; status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'MaterialEmbeddingAdapterError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Combined abort signal distinguishing caller cancellation from timeouts.
 * 合并中止信号：区分调用方取消与超时。
 */
export interface MaterialEmbeddingRequestSignal {
  /** Signal aborted on either cancellation or timeout. / 取消或超时时中止的信号。 */
  signal: AbortSignal;
  /** True when the abort was caused by the timeout. / 中止是否由超时引起。 */
  didTimeout: () => boolean;
  /** Releases the timeout and parent listeners; must be called when done. / 释放定时器与父监听器；结束时必须调用。 */
  cleanup: () => void;
}

/**
 * Derives a child AbortSignal that aborts on parent cancellation or a timeout, whichever comes first.
 * 派生子 AbortSignal：父取消或超时（以先到者为准）即中止。
 *
 * @param parent - Optional parent abort signal / 可选的父中止信号
 * @param timeoutMs - Timeout in milliseconds; defaults to 60s when invalid / 超时毫秒数；无效时默认 60 秒
 * @returns Signal handle with timeout tracking and cleanup / 带超时跟踪与清理的信号句柄
 */
export function createMaterialEmbeddingRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): MaterialEmbeddingRequestSignal {
  const controller = new AbortController();
  let timedOut = false;
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('embedding request timeout'));
  }, normalizedTimeout);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    // Propagate an already-aborted parent immediately instead of waiting for an event that will never fire.
    // 父信号已中止时立即传播，避免等待永不触发的事件。
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Validates and normalizes untrusted input into a MaterialEmbeddingCandidate.
 * 将不可信输入校验并归一化为 MaterialEmbeddingCandidate。
 *
 * @param input - Untrusted candidate value / 不可信的候选值
 * @returns Normalized candidate with fixed vector settings / 向量设置已固定的归一化候选
 */
export function normalizeMaterialEmbeddingCandidate(input: unknown): MaterialEmbeddingCandidate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量模型候选配置格式无效。');
  }

  const record = input as Record<string, unknown>;
  const schemaVersion = record.schemaVersion === undefined ? MATERIAL_EMBEDDING_SCHEMA_VERSION : record.schemaVersion;
  if (schemaVersion !== MATERIAL_EMBEDDING_SCHEMA_VERSION) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量模型候选配置版本不受支持。');
  }

  const sourceId = readRequiredText(record.sourceId, '向量模型来源');
  const transportKind = record.transportKind;
  if (transportKind !== 'ollama' && transportKind !== 'openai-compatible') {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量模型传输类型无效。');
  }
  const endpointIdentity = normalizeEndpointIdentity(record.endpointIdentity);
  const requestedModel = readRequiredText(record.requestedModel, '向量模型名称');
  const requestedDimensions = readOptionalDimension(record.requestedDimensions);
  const vectorType = record.vectorType === undefined ? MATERIAL_VECTOR_TYPE : record.vectorType;
  const distanceMetric = record.distanceMetric === undefined ? MATERIAL_DISTANCE_METRIC : record.distanceMetric;
  const encodingFormat = record.encodingFormat === undefined ? MATERIAL_ENCODING_FORMAT : record.encodingFormat;
  if (vectorType !== MATERIAL_VECTOR_TYPE || distanceMetric !== MATERIAL_DISTANCE_METRIC || encodingFormat !== MATERIAL_ENCODING_FORMAT) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '当前仅支持 float32、cosine、float 向量配置。');
  }
  if (typeof record.truncateInputs !== 'boolean') {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量截断策略必须明确指定。');
  }

  return {
    schemaVersion: MATERIAL_EMBEDDING_SCHEMA_VERSION,
    sourceId,
    transportKind,
    endpointIdentity,
    requestedModel,
    ...(requestedDimensions === undefined ? {} : { requestedDimensions }),
    vectorType: MATERIAL_VECTOR_TYPE,
    distanceMetric: MATERIAL_DISTANCE_METRIC,
    encodingFormat: MATERIAL_ENCODING_FORMAT,
    truncateInputs: record.truncateInputs,
    documentInputVersion: readRequiredText(record.documentInputVersion, '文档向量输入版本'),
    queryInputVersion: readRequiredText(record.queryInputVersion, '查询向量输入版本'),
  };
}

/**
 * Canonicalizes an embedding endpoint URL into a stable identity string.
 * 将嵌入服务 URL 规范化为稳定的身份字符串。
 *
 * Security: rejects credentials, query strings and fragments so secrets never enter the identity hash.
 * 安全：拒绝账号凭据、查询参数与片段，确保密钥不进入身份哈希。
 *
 * @param value - Untrusted endpoint URL / 不可信的端点 URL
 * @returns Canonical `protocol//host/path` identity / 规范化的 `protocol//host/path` 身份串
 */
export function normalizeEndpointIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址不能为空。');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址格式无效。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址只支持 HTTP 或 HTTPS。');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '向量服务地址不得包含账号、密钥、查询参数或片段。');
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
}

/**
 * Serializes a value to JSON with recursively sorted object keys for stable hashing.
 * 以递归排序对象键的方式序列化 JSON，保证哈希稳定。
 *
 * @param value - Any JSON-compatible value / 任意 JSON 兼容值
 * @returns Canonical JSON string / 规范 JSON 字符串
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

/**
 * Computes the sha256 profile hash covering all fields that affect embedding semantics.
 * 计算覆盖所有影响嵌入语义字段的 sha256 配置哈希。
 *
 * @param input - Candidate plus probed responseModel/vectorDimension / 候选配置及探测到的 responseModel/vectorDimension
 * @returns Hex sha256 profile hash / 十六进制 sha256 配置哈希
 */
export function computeMaterialEmbeddingProfileHash(input: {
  candidate: MaterialEmbeddingCandidate;
  responseModel?: string;
  vectorDimension: number;
}): string {
  const identity = {
    schemaVersion: input.candidate.schemaVersion,
    sourceId: input.candidate.sourceId,
    transportKind: input.candidate.transportKind,
    endpointIdentity: input.candidate.endpointIdentity,
    requestedModel: input.candidate.requestedModel,
    ...(input.responseModel ? { responseModel: input.responseModel } : {}),
    ...(input.candidate.requestedDimensions === undefined ? {} : { requestedDimensions: input.candidate.requestedDimensions }),
    vectorDimension: input.vectorDimension,
    vectorType: input.candidate.vectorType,
    distanceMetric: input.candidate.distanceMetric,
    encodingFormat: input.candidate.encodingFormat,
    truncateInputs: input.candidate.truncateInputs,
    documentInputVersion: input.candidate.documentInputVersion,
    queryInputVersion: input.candidate.queryInputVersion,
  };
  return crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
}

/**
 * Builds a LOCKED profile from a validated candidate and probed results.
 * 基于已校验候选与探测结果构建 LOCKED 配置。
 *
 * @param input - Candidate, probed dimension/model and optional lock metadata / 候选配置、探测维度/模型与可选锁定元数据
 * @returns Locked profile with computed profileHash / 带 profileHash 的已锁定配置
 */
export function createLockedMaterialEmbeddingProfile(input: {
  candidate: MaterialEmbeddingCandidate;
  responseModel?: string;
  vectorDimension: number;
  lockedAt?: string;
  appVersion?: string;
}): MaterialEmbeddingProfile {
  const candidate = normalizeMaterialEmbeddingCandidate(input.candidate);
  const responseModel = normalizeOptionalText(input.responseModel);
  const vectorDimension = normalizeVectorDimension(input.vectorDimension);
  // A dimension hint that disagrees with the probed dimension means the API cannot honour the request.
  // 维度提示与探测维度不一致说明 API 无法满足该请求。
  if (candidate.requestedDimensions !== undefined && candidate.requestedDimensions !== vectorDimension) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_DIMENSION_MISMATCH', '模型返回维度与候选配置不一致。');
  }
  return {
    ...candidate,
    profileHash: computeMaterialEmbeddingProfileHash({ candidate, responseModel, vectorDimension }),
    state: 'LOCKED',
    ...(responseModel ? { responseModel } : {}),
    vectorDimension,
    lockedAt: input.lockedAt ?? new Date().toISOString(),
    appVersion: input.appVersion?.trim() || 'unknown',
  };
}

/**
 * Validates a probed vector dimension as an integer in (0, 65536].
 * 将探测到的向量维度校验为 (0, 65536] 内的整数。
 *
 * @param value - Untrusted dimension value / 不可信的维度值
 * @returns Validated dimension / 校验后的维度
 */
export function normalizeVectorDimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65_536) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', '模型返回的向量维度无效。');
  }
  return value;
}

function readRequiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 512) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_INVALID', `${label}不能为空且长度不能超过 512。`);
  }
  return value.trim();
}

function readOptionalDimension(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeVectorDimension(value);
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

// Recursively sorts object keys and drops undefined entries so hashing is order-independent.
// 递归排序对象键并丢弃 undefined 条目，使哈希与键序无关。
function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, item]) => [key, sortCanonicalValue(item)]));
}
