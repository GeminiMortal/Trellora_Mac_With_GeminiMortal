/**
 * Persisted physical-restore pause marker helpers used across recovery runs.
 * 跨恢复运行使用的持久化物理恢复暂停标记辅助函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertInsideDirectory } from '../files/pathGuards.ts';
/**
 * Physical restore state is outside WK-M schemas and survives application restarts.
 * 物理恢复状态不属于 WK-M schema，可在应用重启后保留。
 *
 * @param root - Workspace or library root directory / 工作区或库根目录
 * @returns Whether a restore-pause marker exists / 是否存在恢复暂停标记
 */
export function isRestorePaused(root: string): boolean { return fs.existsSync(path.join(root, '.menghan-meta', 'restore-paused.json')); }
/**
 * Writes the restore-pause marker so recovered roots stay paused after restart.
 * 写入恢复暂停标记，使恢复后的根目录在重启后仍保持暂停。
 *
 * @param root - Workspace or library root directory / 工作区或库根目录
 * @param operationId - Identifier of the restore operation / 恢复操作标识
 */
export function writeRestorePause(root: string, operationId: string): void {
  const file = assertInsideDirectory(path.join(root, '.menghan-meta', 'restore-paused.json'), root);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: 1, operationId, pausedAt: new Date().toISOString() }), 'utf8');
}
/**
 * Removes the restore-pause marker, allowing remote tasks to resume.
 * 删除恢复暂停标记，允许远程任务恢复运行。
 *
 * @param root - Workspace or library root directory / 工作区或库根目录
 */
export function clearRestorePause(root: string): void { fs.rmSync(assertInsideDirectory(path.join(root, '.menghan-meta', 'restore-paused.json'), root), { force: true }); }
