/**
 * Creates new note-library directories on disk with sanitized, collision-free names.
 * 在磁盘上创建新的笔记资料库目录，并生成经过清洗、无冲突的目录名。
 */
import fs from 'node:fs';
import { assertExistingDirectory, getUniquePath, sanitizeEntryName } from '../files/pathGuards.ts';

/**
 * Options for creating a library directory.
 * 创建资料库目录的选项。
 */
export interface CreateLibraryDirectoryOptions {
  /** Display name for the library; sanitized to a safe folder name / 资料库显示名；会清洗为安全的文件夹名 */
  name: string;
  /** Workspace root used when no custom parent is given / 未指定自定义父目录时使用的工作区根路径 */
  workspacePath: string;
  /** Optional custom parent directory for the new library / 新资料库的可选自定义父目录 */
  parentDirectoryPath?: string | null;
  /** Timestamp source used to disambiguate default folder names / 用于给默认文件夹名消歧的时间戳来源 */
  now?: Date;
}

/**
 * Result of creating a library directory.
 * 创建资料库目录的结果。
 */
export interface CreatedLibraryDirectory {
  /** Absolute path of the newly created directory / 新建目录的绝对路径 */
  path: string;
  /** Sanitized display name retained for UI purposes / 保留供界面显示的清洗后名称 */
  alias: string;
}

/**
 * Creates a unique library directory and returns its path and display alias.
 * 创建唯一的资料库目录，并返回其路径与显示别名。
 *
 * @param options - Creation options / 创建选项
 * @returns The created directory path and its sanitized alias / 新建目录路径及其清洗后的别名
 */
export function createLibraryDirectory(options: CreateLibraryDirectoryOptions): CreatedLibraryDirectory {
  const alias = sanitizeEntryName(options.name.trim());
  const hasCustomParent = Boolean(options.parentDirectoryPath?.trim());
  const parentDirectory = assertExistingDirectory(
    hasCustomParent ? options.parentDirectoryPath! : options.workspacePath,
  );
  // Custom parents keep the plain alias; workspace-created libraries get a timestamp suffix to avoid collisions.
  // 自定义父目录下使用纯别名；工作区内创建的资料库附加时间戳后缀以避免冲突。
  const folderName = hasCustomParent
    ? alias
    : `${alias}-${formatLibraryTimestamp(options.now ?? new Date())}`;
  const libraryPath = getUniquePath(parentDirectory, folderName);

  fs.mkdirSync(libraryPath, { recursive: false });
  return { path: libraryPath, alias };
}

/**
 * Formats a date as a compact `YYYYMMDD-HHMMSS` timestamp for folder names.
 * 将日期格式化为用于文件夹名的紧凑时间戳 `YYYYMMDD-HHMMSS`。
 *
 * @param date - Date to format / 要格式化的日期
 * @returns Compact timestamp string / 紧凑时间戳字符串
 */
export function formatLibraryTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
