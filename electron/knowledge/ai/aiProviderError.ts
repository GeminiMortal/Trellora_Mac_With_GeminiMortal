/**
 * AI provider error modeling and classification helpers.
 * AI 提供商错误建模与分类辅助。
 */

/**
 * Stable error code for requests rejected because the prompt exceeds the provider context limit.
 * 因提示词超出服务商上下文上限而被拒绝的请求所使用的稳定错误码。
 */
export const AI_CONTEXT_OVERFLOW = 'AI_CONTEXT_OVERFLOW' as const;

/**
 * Structured error thrown for AI provider failures, carrying a stable code plus optional HTTP status and token-limit details.
 * AI 提供商失败时抛出的结构化错误，携带稳定错误码以及可选的 HTTP 状态与令牌上限信息。
 */
export class AiProviderError extends Error {
  /** Stable code distinguishing context overflow from generic request failures. / 区分上下文溢出与一般请求失败的稳定错误码。 */
  readonly code: typeof AI_CONTEXT_OVERFLOW | 'AI_PROVIDER_REQUEST_FAILED';
  /** HTTP status returned by the provider, when one exists. / 服务商返回的 HTTP 状态码（如有）。 */
  readonly status?: number;
  /** Context/token limit parsed from the provider message, when one was declared. / 从服务商消息中解析出的上下文/令牌上限（如有）。 */
  readonly providerLimitTokens?: number;

  /**
   * Build an AiProviderError from structured fields.
   * 使用结构化字段构造 AiProviderError。
   *
   * @param input - Error code and message with optional status and token limit / 错误码与消息，可选状态码与令牌上限
   */
  constructor(input: {
    code: typeof AI_CONTEXT_OVERFLOW | 'AI_PROVIDER_REQUEST_FAILED';
    message: string;
    status?: number;
    providerLimitTokens?: number;
  }) {
    super(input.message);
    this.name = 'AiProviderError';
    this.code = input.code;
    this.status = input.status;
    this.providerLimitTokens = input.providerLimitTokens;
  }
}

/**
 * Determine whether a thrown value is a context-overflow AiProviderError.
 * 判断抛出值是否为上下文溢出类的 AiProviderError。
 *
 * @param error - Unknown thrown value / 未知抛出值
 * @returns True when the error is an AI context overflow / 若为 AI 上下文溢出则返回 true
 */
export function isAiContextOverflow(error: unknown): error is AiProviderError {
  return error instanceof AiProviderError && error.code === AI_CONTEXT_OVERFLOW;
}

/**
 * Build an AiProviderError from an HTTP status and provider detail text, classifying context overflow.
 * 根据 HTTP 状态码与服务商错误详情构造 AiProviderError，并识别上下文溢出。
 *
 * @param status - HTTP status code returned by the provider / 服务商返回的 HTTP 状态码
 * @param detail - Raw provider error detail text / 服务商原始错误详情文本
 * @returns Classified provider error / 分类后的提供商错误
 */
export function createAiProviderHttpError(status: number, detail = ''): AiProviderError {
  // Collapse whitespace so multi-line provider dumps stay readable and matchable. / 压缩空白，使多行服务商报错保持可读且便于匹配。
  const message = detail.replace(/\s+/gu, ' ').trim();
  const providerLimitTokens = readTokenLimit(message);
  if (looksLikeContextOverflow(message, status)) {
    return new AiProviderError({
      code: AI_CONTEXT_OVERFLOW,
      status,
      ...(providerLimitTokens ? { providerLimitTokens } : {}),
      message: '模型上下文长度超出服务商限制。',
    });
  }
  return new AiProviderError({
    code: 'AI_PROVIDER_REQUEST_FAILED',
    status,
    message: message ? `模型服务请求失败（HTTP ${status}）：${message.slice(0, 240)}` : `模型服务请求失败（HTTP ${status}）。`,
  });
}

/**
 * Build an AiProviderError from a plain error message, classifying context overflow from the text.
 * 根据纯文本错误消息构造 AiProviderError，并从文本中识别上下文溢出。
 *
 * @param message - Provider or transport error message / 提供商或传输层错误消息
 * @returns Classified provider error / 分类后的提供商错误
 */
export function createAiProviderMessageError(message: string): AiProviderError {
  const normalized = message.replace(/\s+/gu, ' ').trim();
  if (looksLikeContextOverflow(normalized, 400)) {
    const providerLimitTokens = readTokenLimit(normalized);
    return new AiProviderError({
      code: AI_CONTEXT_OVERFLOW,
      ...(providerLimitTokens ? { providerLimitTokens } : {}),
      message: '模型上下文长度超出服务商限制。',
    });
  }
  return new AiProviderError({ code: 'AI_PROVIDER_REQUEST_FAILED', message: normalized || '模型服务请求失败。' });
}

// Heuristic overflow detection: HTTP 413, or EN/CN text mentioning context/token length limits. / 启发式识别溢出：HTTP 413，或消息中出现中英文上下文/令牌长度受限字样。
function looksLikeContextOverflow(message: string, status: number): boolean {
  return status === 413
    || /(context|token|prompt).{0,40}(length|limit|maximum|exceed|too large|too long|window)/iu.test(message)
    || /(上下文|提示词).{0,20}(超出|过长|限制|窗口)/u.test(message);
}

// Extract a 3-9 digit limit from phrases like "context length limit 128000" or "上限 128000". / 从"上下文长度上限 128000"等文案中提取 3-9 位数字的令牌上限。
function readTokenLimit(message: string): number | undefined {
  const match = message.match(/(?:maximum|limit|context|window|上限|限制)[^\d]{0,24}(\d{3,9})/iu);
  const value = match?.[1] ? Number(match[1]) : undefined;
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
