/**
 * Crash-safe note file reads and atomic text/byte writes with version validation.
 * 笔记文件的崩溃安全读取，以及带版本校验的原子文本/字节写入。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteDiskVersion } from '../shared/noteSave.ts';
import { decodeTextBuffer } from './files/textFile.ts';

/**
 * Typed note file failure with a stable code and a retryability flag.
 * 带稳定错误码与可重试标记的笔记文件错误。
 */
export class NoteFileError extends Error {
  /**
   * Creates a note file error.
   * 创建笔记文件错误。
   *
   * @param code - Stable machine-readable error code / 稳定的机器可读错误码
   * @param message - User-facing Chinese message / 面向用户的中文提示
   * @param retryable - Whether the operation may succeed when retried / 操作重试后是否可能成功
   */
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

/**
 * Computes the SHA-256 hex digest of raw bytes for optimistic concurrency versions.
 * 计算原始字节的 SHA-256 十六进制摘要，用作乐观并发版本。
 *
 * @param bytes - Raw file bytes / 原始文件字节
 * @returns Lowercase hex hash / 小写十六进制哈希
 */
export function byteHash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/**
 * One stable byte read supplies both the editor text and its optimistic version.
 * 一次稳定字节读取同时提供编辑器文本与其乐观并发版本。
 *
 * @param filePath - Path of the note to read / 要读取的笔记路径
 * @returns Decoded content plus the disk version for save validation / 解码后的内容与用于保存校验的磁盘版本
 */
export async function readNoteBytes(filePath: string): Promise<{ bytes: Buffer; content: string; version: NoteDiskVersion }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await fs.open(filePath, 'r');
    try {
      const before = await handle.stat();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const named = await fs.stat(filePath);
      // Accept the read only when the inode and timestamps prove nothing modified the file mid-read.
      // 仅当 inode 与时间戳证明读取期间文件未被修改时才接受本次读取。
      if (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
        && after.ino === named.ino && after.size === named.size && after.mtimeMs === named.mtimeMs && after.ctimeMs === named.ctimeMs) {
        return { bytes, content: decodeTextBuffer(bytes), version: { diskHash: byteHash(bytes), byteLength: bytes.length, mtimeMs: after.mtimeMs } };
      }
    } finally { await handle.close(); }
  }
  throw new NoteFileError('NOTE_READ_UNSTABLE', '笔记正在被其他程序修改，请稍后重试。', true);
}

/**
 * Replace only after a complete, synced sibling exists; never unlink the original.
 * 仅在完整且已同步的同目录临时文件存在后才替换；从不删除原文件。
 *
 * @param filePath - Target note path / 目标笔记路径
 * @param content - UTF-8 text to persist / 要持久化的 UTF-8 文本
 * @param validate - Throws when the on-disk version no longer matches the edit base / 磁盘版本与编辑基线不符时抛出
 * @param timing - Optional phase timing observer / 可选的阶段耗时观察器
 * @returns The new disk version after a successful replace / 替换成功后的新磁盘版本
 */
export async function atomicTextWrite(filePath: string, content: string, validate: () => Promise<void>, timing?: (phase: string, durationMs: number) => void): Promise<NoteDiskVersion> {
  return atomicByteWrite(filePath, Buffer.from(content, 'utf8'), validate, timing);
}

/**
 * 外部文档提交已经按原编码生成的字节；原笔记调用仍固定 UTF-8。
 * External documents submit bytes already encoded in their original charset; note calls remain UTF-8.
 *
 * @param filePath - Target file path / 目标文件路径
 * @param bytes - Complete file bytes to persist / 要持久化的完整文件字节
 * @param validate - Throws when the on-disk version no longer matches the edit base / 磁盘版本与编辑基线不符时抛出
 * @param timing - Optional phase timing observer / 可选的阶段耗时观察器
 * @returns The new disk version after a successful replace / 替换成功后的新磁盘版本
 */
export async function atomicByteWrite(filePath: string, bytes: Buffer, validate: () => Promise<void>, timing?: (phase: string, durationMs: number) => void): Promise<NoteDiskVersion> {
  const temporary = path.join(path.dirname(filePath), `.trellora-save-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let started = performance.now();
  try {
    // 'wx' fails if the random temporary name collides; content is synced before any rename.
    // 'wx' 在随机临时名冲突时失败；任何改名前内容均已同步落盘。
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    await handle.close();
    handle = undefined;
    timing?.('temporary-write-sync', performance.now() - started);
    for (let attempt = 0; ; attempt++) {
      started = performance.now();
      await validate();
      timing?.('version-check', performance.now() - started);
      started = performance.now();
      // The target may be transiently locked; retry rename with exponential backoff before failing.
      // 目标文件可能短暂锁定；失败前按指数退避重试改名。
      try { await fs.rename(temporary, filePath); timing?.('replace', performance.now() - started); break; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
    return { diskHash: byteHash(bytes), byteLength: bytes.length, mtimeMs: stat.mtimeMs };
  } finally {
    // Best-effort cleanup: the original file is never unlinked, only the temporary sibling is.
    // 尽力清理：从不删除原文件，仅清理同目录临时文件。
    await handle?.close();
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
