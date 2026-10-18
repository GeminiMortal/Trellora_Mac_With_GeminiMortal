/**
 * Detailed per-turn trace recording with secret redaction for the assistant pipeline.
 * 助手流水线的逐轮详细追踪记录，并对敏感信息进行脱敏。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AssistantPublicModelText } from './assistantTurnTypes.ts';

/**
 * Canonical ordered list of assistant trace stages recorded per turn.
 * 助手每轮记录的规范化追踪阶段列表（有序）。
 */
export const assistantDetailedTraceStages = [
  'turn',
  'routing',
  'rewrite',
  'context-tool',
  'planner',
  'model',
  'validation',
  'react-tool',
  'plan-commit',
  'fallback',
  'follow-up',
  'result',
] as const;

/**
 * Union of valid trace stage names.
 * 合法追踪阶段名的联合类型。
 */
export type AssistantDetailedTraceStage = typeof assistantDetailedTraceStages[number];

/**
 * Lifecycle status of a traced stage call.
 * 被追踪阶段调用的生命周期状态。
 */
export type AssistantDetailedTraceStatus = 'started' | 'completed' | 'rejected';

/**
 * A single in-memory trace event before redaction and persistence.
 * 落盘脱敏前的单条内存追踪事件。
 */
export interface AssistantDetailedTraceEntry {
  stage: AssistantDetailedTraceStage;
  action: string;
  status: AssistantDetailedTraceStatus;
  /** Optional call kind label, e.g. model or tool / 可选的调用类型标签，如模型或工具 */
  callKind?: string;
  /** Raw input payload; redacted before writing / 原始输入载荷，写入前脱敏 */
  input?: unknown;
  /** Raw output payload; redacted before writing / 原始输出载荷，写入前脱敏 */
  output?: unknown;
  /** Stable machine-readable error code / 稳定的机器可读错误码 */
  errorCode?: string;
  /** Raw error value; converted via toDetailedTraceError / 原始错误值，经 toDetailedTraceError 转换 */
  error?: unknown;
  /** Wall-clock duration of the action in milliseconds / 动作耗时（毫秒） */
  elapsedMs?: number;
  /** Extra structured context for debugging / 用于调试的附加结构化上下文 */
  metadata?: Record<string, unknown>;
}

/**
 * Callback that receives each finished trace entry.
 * 接收每条已完成追踪事件的回调。
 */
export type AssistantDetailedTraceSink = (entry: AssistantDetailedTraceEntry) => void;

/**
 * Persisted record projection for the renderer debug view (already redacted).
 * 渲染进程调试视图用的落盘记录投影（已经过脱敏）。
 */
export interface AssistantDetailedTraceRecordView {
  timestamp: string;
  sequence: number;
  requestId: string;
  stage: string;
  action: string;
  status: string;
  callKind?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  error?: unknown;
  elapsedMs?: number;
  metadata?: Record<string, unknown>;
}

interface AssistantDetailedTraceRecord extends AssistantDetailedTraceEntry {
  timestamp: string;
  sequence: number;
  requestId: string;
}

// Redaction patterns: secret-like keys, binary payloads, bearer tokens, inline secrets,
// local file paths, and hidden reasoning blocks that must never reach disk.
// 脱敏规则：疑似密钥字段、二进制载荷、Bearer 令牌、行内密钥、本地文件路径，以及不得落盘的隐藏思考块。
const SECRET_KEY_PATTERN = /^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|token)$/iu;
const BINARY_PAYLOAD_KEY_PATTERN = /^(?:data[-_]?url|base64)$/iu;
const AUTHORIZATION_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/-]+=*/giu;
const INLINE_SECRET_PATTERN = /((?:api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token)\s*[:=]\s*["']?)[^\s,"'}]+/giu;
const WINDOWS_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|]+/gu;
const HIDDEN_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>/giu;
const HIDDEN_JSON_STRING_PATTERN = /("(?:analysis|reasoning|chain[_-]?of[_-]?thought|thoughts?)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;

/**
 * Max characters of model input retained for the public model trace.
 * 公开模型追踪中保留的模型输入最大字符数。
 */
export const ASSISTANT_PUBLIC_MODEL_INPUT_MAX_CHARS = 32_000;

/**
 * Max characters of model output retained for the public model trace.
 * 公开模型追踪中保留的模型输出最大字符数。
 */
export const ASSISTANT_PUBLIC_MODEL_OUTPUT_MAX_CHARS = 24_000;

/**
 * A turn-scoped JSONL writer. Logging is best effort: a filesystem failure is
 * reported to stderr but never changes the assistant result.
 * 按轮次写入 JSONL 的追踪写入器。写日志是尽力而为：文件系统故障只上报 stderr，绝不改变助手结果。
 */
export class AssistantDetailedTrace {
  /** Output JSONL file path / 输出的 JSONL 文件路径 */
  readonly filePath: string;
  /** Id of the traced request / 被追踪请求的 ID */
  readonly requestId: string;

  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(logDirectory: string, requestId: string, startedAt = new Date()) {
    this.requestId = requestId;
    const directory = path.join(logDirectory, 'assistant-detailed');
    fs.mkdirSync(directory, { recursive: true });
    const timestamp = startedAt.toISOString().replace(/[:.]/gu, '-');
    const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 128) || 'unknown-request';
    this.filePath = path.join(directory, `assistant-turn-${timestamp}-${safeRequestId}.jsonl`);
  }

  /**
   * Append one redacted trace entry; failures are logged, never thrown.
   * 追加一条脱敏后的追踪事件；写入失败仅记录日志，绝不抛出。
   *
   * @param entry - Trace event to persist / 待落盘的追踪事件
   */
  record(entry: AssistantDetailedTraceEntry): void {
    const record: AssistantDetailedTraceRecord = {
      timestamp: new Date().toISOString(),
      sequence: ++this.sequence,
      requestId: this.requestId,
      ...entry,
    };
    // Serialize appends through a promise chain so entries never interleave.
    // 用 Promise 链串行化追加，避免各条记录互相交错。
    const line = `${JSON.stringify(redactDetailedTraceValue(record))}\n`;
    this.pending = this.pending
      .then(() => fs.promises.appendFile(this.filePath, line, 'utf8'))
      .catch((error) => {
        console.warn(`[assistant-detailed-trace] 无法写入 ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /**
   * Wait until every queued append has settled.
   * 等待所有排队中的追加写入完成。
   *
   * @returns Promise that resolves when the write queue is drained / 写入队列清空后 resolve 的 Promise
   */
  async flush(): Promise<void> {
    await this.pending;
  }
}

/**
 * Normalize an unknown thrown value into a redacted, serializable error shape.
 * 将未知抛出值规范化为脱敏后可序列化的错误结构。
 *
 * @param error - Raw error value / 原始错误值
 * @returns Redacted name/message/stack record / 脱敏后的 name/message/stack 记录
 */
export function toDetailedTraceError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: redactDetailedTraceText(error.message),
      ...(error.stack ? { stack: redactDetailedTraceText(error.stack) } : {}),
    };
  }
  return { name: 'UnknownError', message: redactDetailedTraceText(String(error)) };
}

/**
 * Mask bearer tokens and inline key/value secrets inside free text.
 * 在自由文本中遮蔽 Bearer 令牌和行内键值形式的密钥。
 *
 * @param value - Text to redact / 待脱敏的文本
 * @returns Text with secrets replaced by [REDACTED] / 密钥替换为 [REDACTED] 后的文本
 */
export function redactDetailedTraceText(value: string): string {
  return value
    .replace(AUTHORIZATION_PATTERN, '$1[REDACTED]')
    .replace(INLINE_SECRET_PATTERN, '$1[REDACTED]');
}

/**
 * Build a bounded, redacted public copy of model text: secrets masked, local
 * paths and hidden reasoning stripped, then head/tail truncated to fit the budget.
 * 生成模型文本的受限脱敏公开副本：遮蔽密钥、剔除本地路径与隐藏思考，再按预算做头尾截断。
 *
 * @param value - Raw model text / 原始模型文本
 * @param maxCharacters - Max retained characters / 最多保留的字符数
 * @returns Public text with truncation metadata / 含截断元数据的公开文本
 */
export function createAssistantPublicModelText(value: string, maxCharacters: number): AssistantPublicModelText {
  const originalCharacters = value.length;
  const redacted = redactDetailedTraceText(value)
    .replace(WINDOWS_PATH_PATTERN, '[本地路径已省略]')
    .replace(HIDDEN_THINK_BLOCK_PATTERN, '<think>[隐藏思考已省略]</think>')
    .replace(HIDDEN_JSON_STRING_PATTERN, '$1"[隐藏思考已省略]"');
  if (redacted.length <= maxCharacters) return { text: redacted, originalCharacters, truncated: false };

  // Keep a head-heavy split (62.5% head / 37.5% tail) with a fixed budget for the
  // omission marker so the returned text can never exceed maxCharacters.
  // 按头重尾轻比例（头 62.5% / 尾 37.5%）截断，并为省略标记预留固定预算，确保结果不超上限。
  const markerBudget = 96;
  const retainedCharacters = Math.max(2, maxCharacters - markerBudget);
  const headCharacters = Math.ceil(retainedCharacters * 0.625);
  const tailCharacters = retainedCharacters - headCharacters;
  const omittedCharacters = redacted.length - headCharacters - tailCharacters;
  return {
    text: `${redacted.slice(0, headCharacters)}\n\n… 已省略中间 ${omittedCharacters.toLocaleString('zh-CN')} 个字符 …\n\n${redacted.slice(-tailCharacters)}`,
    originalCharacters,
    truncated: true,
  };
}

/**
 * Recursively redact any JSON-serializable value: strings masked, secret-named
 * keys removed, binary payloads dropped, and circular references replaced.
 * 递归脱敏任意可 JSON 化的值：遮蔽字符串、抹除疑似密钥字段名、丢弃二进制载荷，并替换循环引用。
 *
 * @param value - Value to redact / 待脱敏的值
 * @param seen - Cycle-tracking set used during recursion / 递归中用于检测循环引用的集合
 * @returns Fully redacted copy / 完全脱敏后的副本
 */
export function redactDetailedTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactDetailedTraceText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return toDetailedTraceError(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDetailedTraceValue(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : BINARY_PAYLOAD_KEY_PATTERN.test(key)
        ? '[BINARY_DATA_REDACTED]'
        : redactDetailedTraceValue(item, seen),
  ]));
}
