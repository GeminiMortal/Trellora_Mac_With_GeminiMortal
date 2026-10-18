/**
 * Batch import of plain-text files into a note library with all-or-nothing rollback.
 * 将纯文本文件批量导入笔记库，具备全成或全回滚的语义。
 */
import fs from 'fs';
import path from 'path';
import { getFileTypeInfo, isLikelyTextBuffer } from './fileTypes.ts';
import { randomUUID } from 'node:crypto';
import { decodeTextBuffer } from './textFile.ts';
import { assertExistingDirectory, assertInsideDirectory, getUniquePath } from './pathGuards.ts';

/**
 * Options for a batch text-file import.
 * 批量文本文件导入选项。
 */
export interface ImportTextFilesOptions {
  /** Absolute path of the target note library / 目标笔记库的绝对路径 */
  libraryPath: string;
  /** Absolute paths of source files or folders to import / 要导入的源文件或文件夹绝对路径 */
  sourcePaths: string[];
  /** Optional target folder inside the library / 笔记库内可选的目标文件夹 */
  targetDirectoryPath?: string | null;
}

/**
 * A single file that was copied into the library.
 * 已复制进笔记库的单个文件。
 */
export interface ImportedTextFile {
  /** Original source path / 原始来源路径 */
  sourcePath: string;
  /** Path of the created file in the library / 笔记库中创建文件的路径 */
  targetPath: string;
  /** Final file name / 最终文件名 */
  name: string;
  /** Classified file kind / 分类后的文件类别 */
  kind: 'markdown' | 'text' | 'code';
  /** Lower-cased extension / 小写扩展名 */
  extension: string;
}

/**
 * Preflight the whole batch; publish complete files exclusively and undo this batch on failure.
 * 对整批做预检；仅发布完整文件，失败时撤销本批次。
 *
 * @param options - Import sources and destination / 导入来源与目标位置
 * @returns Descriptions of every created file / 每个已创建文件的描述
 */
export function importTextFilesToLibrary(options: ImportTextFilesOptions): ImportedTextFile[] {
  const libraryPath = assertExistingDirectory(options.libraryPath);
  const targetDirectory = resolveTargetDirectory(libraryPath, options.targetDirectoryPath);

  const sourceFiles = options.sourcePaths.flatMap((sourcePath) => {
    const resolvedSourcePath = path.resolve(sourcePath);
    if (!fs.existsSync(resolvedSourcePath)) throw new Error(`找不到要导入的文件：${sourcePath}`);
    // Folders are imported flattened: recursively collect recognizable text files, skipping hidden and system junk.
    // 文件夹按目录结构平铺导入：递归收集可识别的文本文件，跳过隐藏与系统垃圾文件。
    if (fs.statSync(resolvedSourcePath).isDirectory()) {
      const junkNames = new Set(['thumbs.db', 'desktop.ini']);
      const collected: string[] = [];
      const walk = (directoryPath: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(directoryPath, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { if (!entry.name.startsWith('.') && entry.name !== '.menghan-meta' && entry.name !== '.git') walk(path.join(directoryPath, entry.name)); continue; }
          if (entry.isFile()) {
            if (entry.name.startsWith('.') || junkNames.has(entry.name.toLocaleLowerCase('en-US'))) continue;
            collected.push(path.join(directoryPath, entry.name));
          }
        }
      };
      walk(resolvedSourcePath);
      return collected;
    }
    return [resolvedSourcePath];
  });

  const prepared = sourceFiles.map((sourcePath) => {
    const typeInfo = getFileTypeInfo(sourcePath);
    if (!typeInfo) {
      throw new Error(`不支持的文本文件：${path.basename(sourcePath)}`);
    }

    const buffer = fs.readFileSync(sourcePath);
    if (!isLikelyTextBuffer(buffer)) {
      throw new Error(`文件不是可识别的纯文本：${path.basename(sourcePath)}`);
    }

    const content = decodeTextBuffer(buffer);
    return { sourcePath, content, typeInfo };
  });
  const created: Array<{ path: string; dev: number; ino: number }> = [];
  const temporary: string[] = [];
  let result: ImportedTextFile[] = [];
  let failure: Error | undefined;
  try {
    const staged = prepared.map((file) => {
      assertInsideDirectory(targetDirectory, libraryPath);
      const stagingPath = path.join(targetDirectory, `.trellora-import-${randomUUID()}.tmp`);
      const handle = fs.openSync(stagingPath, 'wx');
      temporary.push(stagingPath);
      try { fs.writeFileSync(handle, file.content, 'utf8'); fs.fsyncSync(handle); }
      finally { fs.closeSync(handle); }
      return { ...file, stagingPath };
    });
    result = staged.map((file) => {
      assertInsideDirectory(targetDirectory, libraryPath);
      const targetPath = getUniquePath(targetDirectory, path.basename(file.sourcePath));
      // Hard-linking the staged file publishes it atomically under the final name.
      // 对暂存文件建立硬链接，以最终名称原子地发布该文件。
      fs.linkSync(file.stagingPath, targetPath);
      const stat = fs.lstatSync(file.stagingPath);
      created.push({ path: targetPath, dev: stat.dev, ino: stat.ino });
      fs.unlinkSync(file.stagingPath);
      return { sourcePath: file.sourcePath, targetPath, name: path.basename(targetPath), kind: file.typeInfo.kind, extension: file.typeInfo.extension };
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    // Rollback deletes only files still carrying the recorded device/inode pair, so a replaced file is never removed.
    // 回滚只删除仍带记录的 device/inode 对的文件，避免误删被替换的文件。
    for (const file of created.reverse()) {
      try {
        assertInsideDirectory(file.path, libraryPath);
        const stat = fs.lstatSync(file.path);
        if (stat.dev === file.dev && stat.ino === file.ino && !stat.isSymbolicLink()) fs.unlinkSync(file.path);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') failure = new Error(`${failure.message}；新增文件清理失败：${file.path}`, { cause: cleanupError });
      }
    }
  } finally {
    for (const file of temporary) {
      try { assertInsideDirectory(file, libraryPath); fs.unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error instanceof Error ? error : new Error(String(error)); }
    }
  }
  if (failure) throw failure;
  return result;
}

/**
 * Resolve and validate the import destination inside the library.
 * 解析并校验笔记库内的导入目标目录。
 *
 * @param libraryPath - Validated library root / 已校验的笔记库根目录
 * @param targetDirectoryPath - Optional subfolder path inside the library / 笔记库内可选子文件夹路径
 * @returns Resolved and existing target directory / 解析后且已存在的目标目录
 */
function resolveTargetDirectory(libraryPath: string, targetDirectoryPath?: string | null): string {
  const targetDirectory = targetDirectoryPath
    ? assertInsideDirectory(targetDirectoryPath, libraryPath, '目标文件夹必须位于当前笔记库内。')
    : libraryPath;
  return assertExistingDirectory(targetDirectory);
}
