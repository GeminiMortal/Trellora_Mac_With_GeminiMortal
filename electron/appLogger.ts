/**
 * Safe application logger that persists only allowlisted identifiers to rotating NDJSON files.
 * 安全的应用日志模块：仅将白名单标识符持久化到轮转 NDJSON 文件，绝不写入提示词、响应正文或凭据。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * A single persisted log record containing only allowlisted identifiers.
 * 单条持久化日志记录，仅包含白名单标识符字段。
 */
export interface SafeLogEntry { at: string; level: 'info' | 'warn' | 'error'; module: string; code: string; taskId?: string; }

/**
 * Persist only allowlisted identifiers; provider messages, prompts and bodies never enter this log.
 * 仅持久化白名单标识符；提供商消息、提示词与正文永远不进入此日志。
 */
export class AppLogger {
  private entries: SafeLogEntry[] = [];
  private writing = false;
  /** True when the latest disk write failed and the logger is running degraded / 最近一次磁盘写入失败、日志器降级运行时为 true */
  degraded = false;
  /**
   * Creates a logger writing into `directory()` with per-file size and count rotation.
   * 创建写入 `directory()` 的日志器，按单文件大小与保留个数轮转。
   *
   * @param directory - Resolves the log directory at write time / 写入时解析日志目录
   * @param maxBytes - Size budget of one log file before rotation / 单个日志文件轮转前的大小预算
   * @param files - Number of rotated files to keep / 保留的轮转文件数量
   */
  constructor(private readonly directory: () => string, private readonly maxBytes = 5 * 1024 * 1024, private readonly files = 5) {}

  /**
   * Records one allowlisted entry and appends it to the rotating NDJSON log.
   * 记录一条白名单条目，并追加到轮转 NDJSON 日志。
   *
   * @param level - Severity level / 严重级别
   * @param module - Allowlisted module identifier / 白名单模块标识
   * @param code - Allowlisted stable error code / 白名单稳定错误码
   * @param taskId - Optional allowlisted task identifier / 可选的白名单任务标识
   */
  record(level: SafeLogEntry['level'], module: string, code: string, taskId?: string): void {
    // Reject values outside the identifier alphabet so free-form text never reaches disk.
    // 拒绝不在标识符字符集内的取值，确保自由文本不会落盘。
    const identifier = (value: string) => /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? value : 'UNKNOWN';
    const entry: SafeLogEntry = { at: new Date().toISOString(), level, module: identifier(module), code: identifier(code), ...(taskId ? { taskId: identifier(taskId) } : {}) };
    this.entries.push(entry);
    this.entries = this.entries.slice(-100);
    if (this.writing) return;
    this.writing = true;
    try {
      const directory = this.directory();
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'application.ndjson');
      const line = `${JSON.stringify(entry)}\n`;
      // Rotate when the append would exceed the size budget, keeping only the configured file count.
      // 追加将超出大小预算时轮转，仅保留配置数量的日志文件。
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > this.maxBytes) {
        for (let index = this.files - 1; index >= 1; index--) {
          const from = index === 1 ? file : `${file}.${index - 1}`;
          const to = `${file}.${index}`;
          if (fs.existsSync(to)) fs.unlinkSync(to);
          if (fs.existsSync(from)) fs.renameSync(from, to);
        }
      }
      fs.appendFileSync(file, line, 'utf8');
      this.degraded = false;
    } catch { this.degraded = true; }
    finally { this.writing = false; }
  }

  /**
   * Include persisted safe errors after a cold restart, without copying detailed assistant traces.
   * 冷启动后纳入已持久化的安全错误，但不复制详细助理轨迹。
   *
   * @returns Valid entries re-read and re-validated from disk / 从磁盘重读并重新校验后的有效条目
   */
  recent(): SafeLogEntry[] {
    try {
      const file = path.join(this.directory(), 'application.ndjson');
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      return lines.slice(-100).flatMap(line => {
        try {
          // Re-validate on-disk rows as untrusted input: unknown shapes are dropped, not repaired.
          // 将磁盘行视为不可信输入重新校验：未知形状直接丢弃，不做修复。
          const entry = JSON.parse(line) as SafeLogEntry;
          if (!['info', 'warn', 'error'].includes(entry.level) || !/^[a-zA-Z0-9:_-]{1,128}$/.test(entry.code)) return [];
          return [{ at: String(entry.at).slice(0, 30), level: entry.level, module: /^[a-zA-Z0-9:_-]{1,128}$/.test(entry.module) ? entry.module : 'UNKNOWN', code: entry.code }];
        } catch { return []; }
      });
    } catch { return [...this.entries]; }
  }
}

/**
 * Diagnostics retain the service location but strip credentials, query parameters and fragments.
 * 诊断中保留服务地址，但剥离凭据、查询参数与片段。
 *
 * @param value - Raw service URL candidate / 原始服务 URL 候选值
 * @returns Sanitized URL without secrets, or undefined when missing or invalid / 去除机密后的 URL；缺失或无效时为 undefined
 */
export function safeServiceEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return undefined; }
}
