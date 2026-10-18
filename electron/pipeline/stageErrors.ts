/**
 * Pipeline stage error type shared by stage runners for stable error codes and retry signaling.
 * 流水线阶段错误类型，供各阶段运行器共享稳定的错误码与可重试标记。
 */

/**
 * Error thrown by pipeline stages carrying a stable machine-readable code.
 * 流水线阶段抛出的错误，携带稳定的机器可读错误码。
 */
export class PipelineStageError extends Error {
  /** Stable error code for programmatic handling / 稳定的错误码，便于程序化处理。 */
  readonly code: string;
  /** Whether the failed stage may be retried as-is / 失败阶段是否可原样重试。 */
  readonly retryable: boolean;
  /** Optional developer-facing diagnostic detail / 可选的面向开发者的诊断细节。 */
  readonly diagnostic?: string;

  /**
   * Creates a pipeline stage error.
   * 创建流水线阶段错误。
   *
   * @param code - Stable error code / 稳定的错误码
   * @param message - Human-readable message / 可读的错误信息
   * @param retryable - Whether the stage can be retried (defaults to true) / 是否可重试（默认 true）
   * @param diagnostic - Optional diagnostic detail / 可选的诊断细节
   */
  constructor(code: string, message: string, retryable = true, diagnostic?: string) {
    super(message);
    this.name = 'PipelineStageError';
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

/**
 * Duck-type check for values that look like a PipelineStageError.
 * 鸭子类型检测值是否形如 PipelineStageError。
 *
 * @param error - Unknown thrown value / 未知抛出值
 * @returns True when the value exposes a string code and boolean retryable / 当值含字符串 code 与布尔 retryable 时返回 true
 */
export function isPipelineStageError(error: unknown): error is PipelineStageError {
  return Boolean(
    error
      && typeof error === 'object'
      && typeof (error as { code?: unknown }).code === 'string'
      && typeof (error as { retryable?: unknown }).retryable === 'boolean',
  );
}
