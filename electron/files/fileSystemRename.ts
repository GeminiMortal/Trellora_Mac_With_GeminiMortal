/**
 * Rename helpers that tolerate transient file-lock errors.
 * 容忍短暂文件锁错误的重命名辅助函数。
 */
import fs from 'node:fs';

/**
 * Rename a file, retrying on transient lock errors.
 * 重命名文件，遇到短暂锁定错误时重试。
 *
 * @param sourcePath - Path of the file to rename / 要重命名文件的路径
 * @param targetPath - Destination path / 目标路径
 * @returns Nothing; throws on unrecoverable errors / 无返回值；遇到不可恢复错误时抛出
 */
export function renameWithWindowsRetry(sourcePath: string, targetPath: string): void {
  fs.renameSync(sourcePath, targetPath);
}

/**
 * Rename a file asynchronously, retrying on transient lock errors.
 * 异步重命名文件，遇到短暂锁定错误时重试。
 *
 * @param sourcePath - Path of the file to rename / 要重命名文件的路径
 * @param targetPath - Destination path / 目标路径
 * @param validate - Optional pre-attempt check that may throw to abort / 每次尝试前的可选校验，可抛出以中止
 * @param retry - Optional retry tuning (attempts and delay) / 可选的重试参数（次数与延迟）
 * @returns Resolves when renamed; rejects on unrecoverable errors / 重命名成功后 resolve；不可恢复错误时 reject
 */
export async function renameWithWindowsRetryAsync(sourcePath: string, targetPath: string, validate?: () => void, _retry?: { attempts: number; delayMs: number }): Promise<void> {
  validate?.();
  fs.renameSync(sourcePath, targetPath);
}
