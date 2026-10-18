/**
 * Filesystem operations for library entries (create, rename, move) with journaled ordering and recovery.
 * 资料库条目的文件系统操作（创建、重命名、移动），带日志化排序与恢复机制。
 */
import fs from 'fs';
import path from 'path';
import { stripKnownTextExtension } from '../files/fileTypes.ts';
import { renameWithWindowsRetryAsync } from '../files/fileSystemRename.ts';
import { moveNoteBackupDirectory, prepareNoteBackupPathMove, type NoteBackupPathMove } from '../note/noteBackups.ts';
import {
  appendEntryToDirectoryOrder,
  placeEntryInDirectoryOrder,
  removeEntryFromSavedOrders,
  saveDirectoryOrder,
  loadTreeOrder,
  writeTreeOrder,
  getLibraryMetaDirectory,
  type TreeOrderState,
} from '../files/treeOrder.ts';
import {
  assertExistingDirectory,
  assertInsideDirectory,
  getUniquePath,
  sanitizeEntryName,
} from '../files/pathGuards.ts';

/**
 * Where an entry should land relative to a sibling in the saved tree order.
 * 条目在已保存树序中相对相邻条目的落点。
 */
export interface MovePosition {
  /** Drop inside the folder, or before/after a sibling / 落入文件夹内部，或置于相邻条目前/后 */
  type: 'inside' | 'before' | 'after';
  /** Anchor sibling required for before/after moves / before/after 移动所需的锚点相邻条目 */
  siblingPath?: string;
}

/** Re-exported so callers can persist tree order without importing the treeOrder module directly. / 重新导出，使调用方无需直接导入 treeOrder 模块即可保存树序。 */
export { saveDirectoryOrder };

/**
 * Creates a uniquely named folder under the parent directory and records it in tree order.
 * 在父目录下创建唯一命名的文件夹，并记入树序。
 *
 * @param libraryPath - Absolute path of the library / 资料库绝对路径
 * @param parentDirectoryPath - Parent folder path, or null for the library root / 父文件夹路径，null 表示资料库根目录
 * @param name - Desired folder name / 期望的文件夹名
 * @returns The created folder path / 新建文件夹路径
 */
export function createFolderInLibrary(libraryPath: string, parentDirectoryPath: string | null, name: string): string {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = parentDirectoryPath
    ? assertInsideDirectory(parentDirectoryPath, library)
    : library;
  assertExistingDirectory(parentDirectory);

  const safeName = sanitizeEntryName(name);
  const folderPath = getUniquePath(parentDirectory, safeName);
  fs.mkdirSync(folderPath, { recursive: false });
  appendEntryToDirectoryOrder(library, parentDirectory, folderPath);
  return folderPath;
}

/**
 * Renames a file or folder inside the library, preserving the file extension, and updates tree order.
 * 重命名资料库内的文件或文件夹（保留文件扩展名）并更新树序。
 *
 * @param libraryPath - Absolute path of the library / 资料库绝对路径
 * @param oldPath - Current path of the entry / 条目当前路径
 * @param newName - New display name / 新的显示名称
 * @returns The new path, or null if the entry no longer exists / 新路径；条目已不存在时返回 null
 */
export async function renameEntryInLibrary(libraryPath: string, oldPath: string, newName: string): Promise<string | null> {
  const library = assertExistingDirectory(libraryPath);
  const resolvedOldPath = assertInsideDirectory(oldPath, library);
  if (!fs.existsSync(resolvedOldPath)) return null;

  const isDirectory = fs.statSync(resolvedOldPath).isDirectory();
  const safeName = sanitizeEntryName(newName);
  // Files keep their existing extension; renamed notes drop a known text extension from the stem to avoid doubling.
  // 文件保留现有扩展名；笔记重命名时从主名中去掉已知文本扩展名，避免重复扩展名。
  const extension = isDirectory ? '' : path.extname(resolvedOldPath);
  const baseName = isDirectory ? safeName : stripKnownTextExtension(safeName);
  const finalName = isDirectory ? baseName : `${baseName}${extension}`;
  const newPath = path.join(path.dirname(resolvedOldPath), finalName);

  if (fs.existsSync(newPath)) {
    throw new Error('已存在同名文件或文件夹。');
  }

  await moveWithOrder(library, resolvedOldPath, newPath, () => {
    removeEntryFromSavedOrders(library, resolvedOldPath);
    appendEntryToDirectoryOrder(library, path.dirname(newPath), newPath);
  });
  return newPath;
}

/**
 * Moves an entry to another folder or a specific sorted position relative to a sibling.
 * 将条目移动到其他文件夹，或相对相邻条目的指定排序位置。
 *
 * @param libraryPath - Absolute path of the library / 资料库绝对路径
 * @param sourcePath - Path of the entry to move / 要移动的条目路径
 * @param targetDirectoryPath - Destination folder / 目标文件夹
 * @param position - Placement rule relative to the target / 相对目标的放置规则
 * @returns The new path, or null if the entry no longer exists / 新路径；条目已不存在时返回 null
 */
export async function moveEntryInLibrary(
  libraryPath: string,
  sourcePath: string,
  targetDirectoryPath: string,
  position: MovePosition = { type: 'inside' },
): Promise<string | null> {
  const library = assertExistingDirectory(libraryPath);
  const resolvedSourcePath = assertInsideDirectory(sourcePath, library);
  if (!fs.existsSync(resolvedSourcePath)) return null;

  const targetDirectory = resolveMoveTargetDirectory(library, targetDirectoryPath, position);
  const sourceStat = fs.statSync(resolvedSourcePath);
  // A folder may not be moved inside itself or any of its descendants.
  // 文件夹不能移动到自身或其任何子目录内部。
  if (sourceStat.isDirectory()) {
    const relativeTarget = path.relative(resolvedSourcePath, targetDirectory);
    if (relativeTarget === '' || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))) {
      throw new Error('不能将文件夹移动到自身内部。');
    }
  }

  const newPath = path.join(targetDirectory, path.basename(resolvedSourcePath));
  // Same-path move means a pure reorder: only the saved tree order needs updating.
  // 路径相同的移动即纯重排：只需更新已保存的树序。
  if (path.resolve(newPath) === path.resolve(resolvedSourcePath)) {
    if ((position.type === 'before' || position.type === 'after') && position.siblingPath) {
      const siblingPath = assertInsideDirectory(position.siblingPath, library);
      if (path.resolve(siblingPath) !== path.resolve(resolvedSourcePath)) {
        placeEntryInDirectoryOrder(
          library,
          targetDirectory,
          resolvedSourcePath,
          siblingPath,
          position.type,
        );
      }
    }
    return resolvedSourcePath;
  }
  if (fs.existsSync(newPath)) {
    throw new Error('目标文件夹中已存在同名文件或文件夹。');
  }

  await moveWithOrder(library, resolvedSourcePath, newPath, () => {
    removeEntryFromSavedOrders(library, resolvedSourcePath);
    if ((position.type === 'before' || position.type === 'after') && position.siblingPath) {
      placeEntryInDirectoryOrder(library, targetDirectory, newPath, position.siblingPath, position.type);
    } else {
      appendEntryToDirectoryOrder(library, targetDirectory, newPath);
    }
  });
  return newPath;
}

function resolveMoveTargetDirectory(libraryPath: string, targetDirectoryPath: string, position: MovePosition): string {
  if (position.type === 'before' || position.type === 'after') {
    if (!position.siblingPath) throw new Error('排序移动时缺少相邻项目路径。');
    const siblingPath = assertInsideDirectory(position.siblingPath, libraryPath);
    if (!fs.existsSync(siblingPath)) throw new Error('相邻项目不存在。');
    return path.dirname(siblingPath);
  }

  const targetDirectory = assertInsideDirectory(targetDirectoryPath, libraryPath);
  return assertExistingDirectory(targetDirectory);
}

/**
 * A failed order write must not expose an unreported filesystem rename to the watcher.
 * 排序写入失败时，不能让监视器看到一次未记录的文件系统重命名。
 */
async function moveWithOrder(library: string, source: string, target: string, update: () => void): Promise<void> {
  await recoverLibraryPathMove(library);
  const order = loadTreeOrder(library);
  const backup = prepareNoteBackupPathMove(library, source, target);
  const journal = pathMoveJournalPath(library);
  assertInsideDirectory(path.dirname(journal), library);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  // The journal is created exclusively and fsynced before any rename so a crash can be rolled back.
  // 日志以独占方式创建并在任何重命名前 fsync，确保崩溃后可以回滚。
  const handle = fs.openSync(journal, 'wx');
  try { fs.writeFileSync(handle, JSON.stringify({ version: 1, source, target, backup, order })); fs.fsyncSync(handle); }
  catch (error) { fs.closeSync(handle); fs.unlinkSync(journal); throw error; }
  fs.closeSync(handle);
  try {
    await renameWithWindowsRetryAsync(source, target, () => assertMovePaths(library, source, target));
    if (backup) await moveNoteBackupDirectory(library, backup);
    update();
    fs.unlinkSync(journal);
  }
  catch (error) {
    // If rollback fails, retain the synced journal for the next library activation.
    // 若回滚失败，保留已同步的日志供下次资料库激活时继续恢复。
    await recoverLibraryPathMove(library);
    throw error;
  }
}

function pathMoveJournalPath(library: string): string {
  return assertInsideDirectory(path.join(getLibraryMetaDirectory(library), 'note-path-move.json'), library);
}

/**
 * Recheck physical ancestors and destination ownership after every asynchronous retry.
 * 每次异步重试后重新校验物理祖先目录与目标路径归属。
 */
function assertMovePaths(library: string, source: string, target: string): void {
  assertInsideDirectory(source, library);
  assertInsideDirectory(target, library);
  if (fs.existsSync(target)) throw new Error('目标路径已被其他文件占用，已停止移动。');
}

/**
 * Recover unfinished filesystem/order/backup moves before the library is indexed.
 * 在资料库建立索引前，恢复未完成的文件系统/排序/备份移动。
 *
 * @param library - Absolute path of the library / 资料库绝对路径
 * @returns Promise resolving once any journaled move is rolled back or confirmed complete / 已记录移动回滚或确认完成后 resolve
 */
export async function recoverLibraryPathMove(library: string): Promise<void> {
  const journal = pathMoveJournalPath(library);
  if (!fs.existsSync(journal)) return;
  // Reject symlinked, multi-linked, or oversized journals to avoid recovering from tampered input.
  // 拒绝符号链接、多硬链接或过大的日志，避免从被篡改的输入中恢复。
  const stat = fs.lstatSync(journal);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) throw new Error('笔记移动恢复记录无效，请保留文件并检查笔记库。');
  const record = JSON.parse(fs.readFileSync(journal, 'utf8')) as { version: number; source: string; target: string; order: TreeOrderState; backup: NoteBackupPathMove | null };
  if (record.version !== 1 || typeof record.source !== 'string' || typeof record.target !== 'string'
    || record.order?.version !== 1 || !record.order.directories || typeof record.order.directories !== 'object'
    || !Object.values(record.order.directories).every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))) throw new Error('笔记移动恢复记录格式无效。');
  const source = assertInsideDirectory(record.source, library), target = assertInsideDirectory(record.target, library);
  for (const entry of [source, target]) {
    const relative = path.relative(path.resolve(library), entry);
    if (!relative || relative.split(path.sep).some(part => part.startsWith('.'))) throw new Error('笔记移动恢复路径无效。');
  }
  if (record.backup) {
    const root = fs.realpathSync(library);
    const expected = (entry: string) => path.join(root, '.menghan-backups', '.v2', path.relative(path.resolve(library), entry));
    if (record.backup.from !== expected(source) || record.backup.to !== expected(target)) throw new Error('备份移动恢复路径无效。');
  }
  const sourceExists = fs.existsSync(source), targetExists = fs.existsSync(target);
  if (sourceExists === targetExists) throw new Error('笔记移动恢复遇到路径冲突，请保留现有文件后检查。');
  if (targetExists) await renameWithWindowsRetryAsync(target, source, () => assertMovePaths(library, target, source));
  if (record.backup) await moveNoteBackupDirectory(library, { from: record.backup.to, to: record.backup.from });
  writeTreeOrder(library, record.order);
  fs.unlinkSync(journal);
}

/**
 * Metadata/index rollback uses the same journaled file and history movement.
 * 元数据/索引回滚复用同一套日志化文件移动与历史移动机制。
 *
 * @param library - Absolute path of the library / 资料库绝对路径
 * @param source - Path to move back from / 需移回的当前位置
 * @param target - Path to restore the entry to / 要恢复到的目标路径
 * @param order - Tree order state to restore alongside the move / 移动同时要恢复的树序状态
 * @returns Promise resolving after the journaled move completes / 日志化移动完成后 resolve
 */
export async function restoreEntryPath(library: string, source: string, target: string, order: TreeOrderState): Promise<void> {
  await moveWithOrder(library, source, target, () => writeTreeOrder(library, order));
}
