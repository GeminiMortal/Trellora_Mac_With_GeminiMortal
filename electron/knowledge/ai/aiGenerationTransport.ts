/**
 * Shared request shapes and helpers for AI generation transports (local Ollama and remote providers).
 * AI 生成传输层（本地 Ollama 与远程提供商）共用的请求结构与辅助函数。
 */

import type { AssistantThinkingMode } from '../assistant/assistantTurnTypes.ts';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';
import type { AiProviderConfig } from './aiTypes.ts';

/**
 * Strategy used to obtain structured JSON output: a native schema parameter, a forced tool call, or plain JSON mode.
 * 获取结构化 JSON 输出的策略：原生 schema 参数、强制工具调用，或普通 JSON 模式。
 */
export type AiStructuredOutputTransport = 'native-json-schema' | 'tool-call' | 'json-object';

/**
 * Image input passed straight to a VLM in this turn (design doc §6.4 / §8 Phase 3).
 * 本轮直传 VLM 的图片输入（开发方案 §6.4 / §8 Phase 3）。
 * `dataUrl` is the full `data:<mime>;base64,<payload>` string produced by the renderer's FileReader;
 * each transport consumes it in the vendor's format: OpenAI uses `dataUrl` directly, while
 * Anthropic / Google / Ollama need the base64 payload split out.
 * dataUrl 为渲染进程 FileReader 生成的完整 `data:<mime>;base64,<payload>`；
 * 各 Transport 按厂商格式消费：OpenAI 直接用 dataUrl，Anthropic / Google / Ollama 需要拆出 base64。
 */
export interface AiTransportImage {
  /** Full `data:<mime>;base64,<payload>` URL produced by the renderer. / 渲染进程生成的完整 `data:<mime>;base64,<payload>` URL。 */
  dataUrl: string;
  /** Declared MIME type of the image. / 图片声明的 MIME 类型。 */
  mimeType: string;
  /** Original file name, kept for logging and vendor payloads. / 原始文件名，用于日志与厂商请求体。 */
  name: string;
}

/**
 * Split the base64 payload and MIME type out of a data URL.
 * 从 data URL 拆出 base64 载荷与 MIME。
 * Non-data URLs (not expected in practice; Phase 1 already validates the prefix) fall back to
 * treating the whole string as base64 with the provided mimeType so generation is never aborted.
 * 非 data URL（理论不该出现，Phase 1 已校验前缀）时退化为把整串当 base64、用传入 mimeType，
 * 保证不抛异常中断生成。
 *
 * @param image - Transport image carrying the data URL / 携带 data URL 的传输层图片
 * @returns MIME type and base64 payload / MIME 类型与 base64 载荷
 */
export function splitImageDataBase64(image: AiTransportImage): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+)[^,]*,([\s\S]*)$/u.exec(image.dataUrl);
  if (match) return { mimeType: match[1].trim() || image.mimeType, base64: match[2] };
  return { mimeType: image.mimeType, base64: image.dataUrl };
}

/**
 * Request for model output constrained to a named JSON schema.
 * 要求模型按具名 JSON Schema 约束输出的请求。
 */
export interface AiStructuredOutputRequest {
  /** Structured-output strategy to use. / 使用的结构化输出策略。 */
  transport: AiStructuredOutputTransport;
  /** Whether the tool schema must be marked strict (OpenAI-style strict mode). / 是否要求工具 schema 使用严格模式（OpenAI 风格 strict）。 */
  strictToolSchema: boolean;
  /** Named schema payload passed to the model. / 传给模型的具名 schema 载荷。 */
  schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
}

/**
 * One-shot generation input shared by every transport adapter.
 * 各传输适配器共用的一次性生成输入。
 */
export interface AiGenerationTransportInput {
  /** Model identifier to call. / 要调用的模型标识。 */
  model: string;
  /** User prompt text. / 用户提示词文本。 */
  prompt: string;
  /**
   * Trusted application policy. Providers receive this through their native system-instruction field.
   * 可信的应用级策略；提供商通过其原生 system 指令字段接收。
   */
  systemPrompt?: string;
  /**
   * Sampling temperature selected by the assistant generation policy.
   * 由助手生成策略选定的采样温度。
   */
  temperature?: number;
  /** Request plain JSON output when set to 'json'. / 设为 'json' 时要求纯 JSON 输出。 */
  format?: 'json';
  /** Schema-constrained structured-output settings. / schema 约束的结构化输出设置。 */
  structuredOutput?: AiStructuredOutputRequest;
  /** Request timeout in milliseconds; null explicitly disables the timeout. / 请求超时毫秒数；null 表示明确关闭超时。 */
  timeoutMs?: number | null;
  /** Upper bound on generated tokens. / 生成 token 数上限。 */
  maxOutputTokens?: number;
  /** Reasoning effort level for thinking-capable models. / 支持思考的模型所用的推理强度。 */
  thinkingMode?: AssistantThinkingMode;
  /**
   * Multimodal image inputs; present only for vision models with attachments this turn and
   * omitted for pure-text turns so the request body stays unchanged.
   * 多模态图片输入；仅在视觉模型 + 本轮带图片附件时出现，纯文本轮次省略以保持请求体不变。
   */
  images?: AiTransportImage[];
  /** Abort signal for external cancellation. / 用于外部取消的中止信号。 */
  signal?: AbortSignal;
  /** Callback invoked with the model's finish reason when one is reported. / 模型返回结束原因时触发的回调。 */
  onFinishReason?: (reason: string | undefined) => void;
}

/**
 * Streaming variant of the generation input: adds delta callbacks and drops one-shot JSON formatting options.
 * 生成输入的流式变体：增加增量回调，并去掉一次性 JSON 格式化选项。
 */
export type AiStreamingTransportInput = Omit<AiGenerationTransportInput, 'format' | 'structuredOutput'> & {
  /** Incremental text deltas emitted as the model generates. / 模型生成过程中输出的文本增量。 */
  onDelta: (text: string) => void;
  /**
   * Incremental reasoning deltas; never invoked when the provider returns no thinking content.
   * 模型深度思考（reasoning）增量；提供商未返回思考内容时不会触发。
   */
  onThinkingDelta?: (text: string) => void;
};

/**
 * Transport contract implemented by each provider adapter, covering one-shot and streaming calls.
 * 各提供商适配器实现的传输契约，覆盖一次性调用与流式调用。
 */
export interface AiGenerationTransport {
  /** Run a one-shot generation and return the full text with optional usage. / 执行一次性生成，返回完整文本与可选用量。 */
  generate: (config: AiProviderConfig, input: AiGenerationTransportInput) => Promise<{ text: string; usage?: AssistantTokenUsage }>;
  /** Stream a generation, invoking delta callbacks and returning final usage. / 流式生成，触发增量回调并返回最终用量。 */
  stream: (config: AiProviderConfig, input: AiStreamingTransportInput) => Promise<AssistantTokenUsage | undefined>;
}

/**
 * Validate remote-generation prerequisites and resolve the model to call.
 * 校验远程生成的前置条件，并解析出要调用的模型。
 *
 * @param config - Active provider config / 当前提供商配置
 * @param selectedModel - Model chosen in the UI; falls back to the configured model / 界面选择的模型；为空时回退到配置模型
 * @returns Effective model name / 实际生效的模型名
 */
export function assertRemoteGenerationRequest(config: AiProviderConfig, selectedModel: string): string {
  if (!config.remoteContentConsent) throw new Error('请先在设置中确认远程发送范围。');
  if (!config.apiKey) throw new Error('请先在设置中保存 API 密钥。');
  const model = selectedModel.trim() || config.model;
  if (!model) throw new Error('请先在设置中选择模型。');
  return model;
}

/**
 * Combine the caller's abort signal with the request timeout into a single AbortSignal.
 * 将调用方的中止信号与请求超时合并为单个 AbortSignal。
 *
 * @param input - Caller signal and optional timeout / 调用方信号与可选超时
 * @returns Combined signal; undefined only when timeouts are disabled and no signal is given / 合并后的信号；仅在关闭超时且未提供信号时为 undefined
 */
export function createGenerationRequestSignal(input: Pick<AiGenerationTransportInput, 'signal' | 'timeoutMs'>): AbortSignal | undefined {
  // timeoutMs === null explicitly disables the deadline while keeping any caller signal. / timeoutMs 为 null 表示明确关闭超时，仅保留调用方信号。
  if (input.timeoutMs === null) return input.signal;
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 60_000);
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
}

/**
 * Trim whitespace and trailing slashes from an endpoint URL so path joins stay well-formed.
 * 去除端点 URL 的首尾空白与末尾斜杠，保证路径拼接正确。
 *
 * @param value - Raw endpoint string / 原始端点字符串
 * @returns Normalized endpoint / 归一化后的端点
 */
export function normalizeGenerationEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Validate a provider-reported token count as a safe non-negative integer, rejecting implausible magnitudes.
 * 校验服务商上报的 token 计数为安全的非负整数，并拒绝异常偏大的数值。
 *
 * @param value - Raw count from the provider response / 提供商响应中的原始计数
 * @returns Validated token count, or undefined when invalid / 校验通过的 token 数；无效时为 undefined
 */
export function readNonNegativeTokenCount(value: unknown): number | undefined {
  // Reject non-integers, negatives and implausible magnitudes above 10M tokens. / 拒绝非整数、负数与超过 1000 万 token 的异常量级。
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined;
}

/**
 * Resolve and validate the sampling temperature, which must lie within 0 to 1.
 * 解析并校验采样温度，其取值必须位于 0 到 1 之间。
 *
 * @param value - Requested temperature; undefined uses the fallback / 请求的温度；为 undefined 时使用默认值
 * @param fallback - Temperature applied when value is undefined / value 为 undefined 时采用的温度
 * @returns Validated temperature / 校验后的温度
 */
export function resolveGenerationTemperature(value: number | undefined, fallback = 0.2): number {
  const temperature = value ?? fallback;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new Error('模型温度必须在 0 到 1 之间。');
  }
  return temperature;
}
