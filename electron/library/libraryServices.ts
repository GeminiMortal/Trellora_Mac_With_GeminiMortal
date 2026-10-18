/**
 * Library-level services: pre-save note backups and safe editor-image storage.
 * 资料库级服务：保存前笔记备份与安全的编辑器图片存储。
 */
import fs from 'fs';
import path from 'path';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import { getNoteBackupDirectory, listNoteBackups, pruneNoteBackups, type BackupEntry } from '../note/noteBackups.ts';
export type { BackupEntry } from '../note/noteBackups.ts';

/**
 * Result of persisting a pasted editor image into the library.
 * 将粘贴的编辑器图片保存进资料库的结果。
 */
export interface SavedEditorImage {
  /** Forward-slash relative path suitable for Markdown embedding / 适合嵌入 Markdown 的正斜杠相对路径 */
  markdownPath: string;
  /** Absolute path of the saved image on disk / 已保存图片在磁盘上的绝对路径 */
  absolutePath: string;
  /** File name inside the image directory / 图片目录内的文件名 */
  fileName: string;
}

/**
 * Options controlling backup frequency and retention.
 * 控制备份频率与保留策略的选项。
 */
export interface BackupOptions {
  /** Timestamp source used for backup naming and interval checks / 用于备份命名与间隔检查的时间来源 */
  now?: Date;
  /** Minimum time between backups of the same note / 同一笔记两次备份的最小间隔 */
  minIntervalMs?: number;
  /**
   * 兼容旧入口；保留数量固定为三份，此参数不再改变窗口。
   * Kept for legacy call sites; the retention count is fixed at three and this parameter no longer changes the window.
   */
  maxBackups?: number;
}

const editorImageDirectoryName = 'image';
const markdownExtensions = new Set(['.md', '.markdown']);
/** Maximum accepted editor image size / 允许的编辑器图片最大体积 */
export const MAX_EDITOR_IMAGE_BYTES = 20 * 1024 * 1024;
const defaultBackupIntervalMs = 5 * 60 * 1000;

/**
 * Saves a backup of the note's current content before it is overwritten, subject to throttling.
 * 在笔记被覆盖前保存其当前内容的备份，并受频率限制约束。
 *
 * @param filePath - Absolute path of the note being saved / 正在保存的笔记绝对路径
 * @param nextContent - Content about to be written / 即将写入的内容
 * @param libraryPath - Library root used for path containment checks / 用于路径包含校验的资料库根目录
 * @param options - Backup timing options / 备份时间选项
 * @returns The created backup entry, or null when no backup was needed / 新建的备份条目；无需备份时返回 null
 */
export function ensureBackupBeforeSave(
  filePath: string,
  nextContent: string,
  libraryPath: string,
  options: BackupOptions = {},
): BackupEntry | null {
  assertInsideDirectory(filePath, libraryPath);
  if (!fs.existsSync(filePath)) return null;

  // Unchanged content never produces a backup.
  // 内容未变化时不产生备份。
  const currentContent = fs.readFileSync(filePath, 'utf8');
  if (currentContent === nextContent) return null;

  const backups = listBackupsForNote(filePath, libraryPath);
  const now = options.now ?? new Date();
  const minIntervalMs = options.minIntervalMs ?? defaultBackupIntervalMs;
  const latestBackup = backups[0];
  // Throttle backups so rapid successive saves do not fill the history.
  // 限制备份频率，避免连续快速保存写满历史记录。
  if (latestBackup) {
    const elapsed = now.getTime() - parseBackupTimestamp(latestBackup.createdAt).getTime();
    if (elapsed >= 0 && elapsed < minIntervalMs) return null;
  }

  const backupDir = getNoteBackupDirectory(filePath, libraryPath);

  const createdAt = formatBackupTimestamp(now);
  let backupPath = path.join(backupDir, `${createdAt}.md`);
  let counter = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(backupDir, `${createdAt}-${counter}.md`);
    counter++;
  }

  // Copy the on-disk bytes exclusively and fsync so the snapshot survives a crash during the save.
  // 以独占方式复制磁盘字节并 fsync，保证保存中途崩溃时快照仍然可用。
  const handle = fs.openSync(backupPath, 'wx');
  try { fs.writeFileSync(handle, fs.readFileSync(filePath)); fs.fsyncSync(handle); }
  catch (error) { fs.closeSync(handle); fs.unlinkSync(backupPath); throw error; }
  fs.closeSync(handle);
  pruneNoteBackups(filePath, libraryPath);

  return {
    id: path.basename(backupPath, '.md'),
    createdAt,
    path: backupPath,
  };
}

/**
 * Lists existing backups for a note in reverse chronological order.
 * 按时间倒序列出某笔记的现有备份。
 *
 * @param filePath - Absolute path of the note / 笔记绝对路径
 * @param libraryPath - Library root used for path containment checks / 用于路径包含校验的资料库根目录
 * @returns The note's backup entries / 该笔记的备份条目
 */
export function listBackupsForNote(filePath: string, libraryPath: string): BackupEntry[] {
  return listNoteBackups(filePath, libraryPath);
}


/**
 * Stores a pasted editor image in the library's shared `image` directory with collision-free naming.
 * 将粘贴的编辑器图片存入资料库共享的 `image` 目录，并使用无冲突命名。
 *
 * @param libraryPath - Library root that must contain the note / 必须包含该笔记的资料库根目录
 * @param notePath - Markdown note the image is pasted into / 图片粘贴目标 Markdown 笔记
 * @param bytes - Raw image bytes / 原始图片字节
 * @param now - Timestamp used in the generated file name / 用于生成文件名的时间戳
 * @returns The stored image's paths and file name / 已存图片的路径与文件名
 */
export function saveEditorImageToLibrary(
  libraryPath: string,
  notePath: string,
  bytes: Buffer | Uint8Array,
  now = new Date(),
): SavedEditorImage {
  const resolvedLibraryPath = path.resolve(libraryPath);
  const resolvedNotePath = path.resolve(notePath);
  if (!isInsideDirectory(resolvedNotePath, resolvedLibraryPath)) {
    throw new Error('当前笔记路径超出笔记库。');
  }
  if (!markdownExtensions.has(path.extname(resolvedNotePath).toLowerCase())) {
    throw new Error('只有 Markdown 笔记可以粘贴图片。');
  }
  if (!fs.existsSync(resolvedNotePath) || !fs.statSync(resolvedNotePath).isFile()) {
    throw new Error('找不到当前 Markdown 笔记。');
  }

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length === 0) throw new Error('剪贴板图片为空。');
  if (buffer.length > MAX_EDITOR_IMAGE_BYTES) throw new Error('图片不能超过 20 MB。');

  const imageType = detectEditorImageType(buffer);
  if (!imageType) {
    throw new Error('只支持 PNG、JPEG、GIF 或 WebP 图片。');
  }

  const imageDirectory = path.join(resolvedLibraryPath, editorImageDirectoryName);
  assertInsideDirectory(imageDirectory, resolvedLibraryPath, '图片保存路径超出当前笔记库或包含链接。');
  if (fs.existsSync(imageDirectory) && !fs.statSync(imageDirectory).isDirectory()) {
    throw new Error('笔记库中的 image 已存在，但它不是文件夹。');
  }
  fs.mkdirSync(imageDirectory, { recursive: true });

  const baseName = `image-${formatEditorImageTimestamp(now)}`;
  let finalName = `${baseName}${imageType.extension}`;
  let absolutePath = path.join(imageDirectory, finalName);
  let counter = 1;
  while (fs.existsSync(absolutePath)) {
    finalName = `${baseName}-${counter}${imageType.extension}`;
    absolutePath = path.join(imageDirectory, finalName);
    counter++;
  }

  if (!isInsideDirectory(absolutePath, resolvedLibraryPath)) {
    throw new Error('图片保存路径超出当前笔记库。');
  }

  let temporaryPath = path.join(imageDirectory, `.${finalName}.tmp`);
  counter = 1;
  while (fs.existsSync(temporaryPath)) {
    temporaryPath = path.join(imageDirectory, `.${finalName}.${counter}.tmp`);
    counter++;
  }

  try {
    // Write exclusively to a temp name, then rename so the visible file is never partial.
    // 先以独占方式写入临时文件名再重命名，保证可见文件不会写了一半。
    fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' });
    fs.renameSync(temporaryPath, absolutePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  const markdownPath = path.relative(path.dirname(resolvedNotePath), absolutePath).replace(/\\/g, '/');

  return {
    markdownPath,
    absolutePath,
    fileName: finalName,
  };
}

/**
 * Converts an absolute path to a library-relative path, rejecting anything outside the library.
 * 将绝对路径转换为资料库相对路径，拒绝资料库之外的任何路径。
 *
 * @param filePath - Absolute path to relativize / 要转换的绝对路径
 * @param libraryPath - Library root / 资料库根目录
 * @returns The path relative to the library / 相对资料库的路径
 */
export function getLibraryRelativePath(filePath: string, libraryPath: string): string {
  const relativePath = path.relative(path.resolve(libraryPath), path.resolve(filePath));
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('路径位于当前笔记库之外。');
  }
  return relativePath;
}

function formatBackupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseBackupTimestamp(timestamp: string): Date {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!match) return new Date(0);

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function formatEditorImageTimestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function detectEditorImageType(bytes: Buffer): { extension: '.png' | '.jpg' | '.gif' | '.webp' } | null {
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return { extension: '.png' };

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg' };
  }

  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return { extension: '.gif' };

  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return { extension: '.webp' };

  return null;
}

function isInsideDirectory(candidatePath: string, parentPath: string): boolean {
  try { assertInsideDirectory(candidatePath, parentPath); return true; }
  catch { return false; }
}
