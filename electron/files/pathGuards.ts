/**
 * Path security guards: containment checks, symlink rejection and safe name/path helpers for library writes.
 * 路径安全守卫：包含性检查、符号链接拒绝，以及笔记库写入的安全名称/路径辅助函数。
 */
import fs from 'fs';
import path from 'path';

const invalidEntryNameCharacters = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

/**
 * Check both spelling and real ancestors, including destinations not created yet.
 * 同时检查字面路径与真实祖先目录，包括尚未创建的目标路径。
 *
 * @param candidatePath - Path that must stay inside the parent / 必须位于父目录内的候选路径
 * @param parentPath - Containing directory / 作为边界的父目录
 * @param message - Error message used on violation / 违规时使用的错误消息
 * @returns The resolved candidate path / 解析后的候选路径
 */
export function assertInsideDirectory(candidatePath: string, parentPath: string, message = '路径必须位于当前笔记库内。'): string {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  if (!isInside(resolvedCandidate, resolvedParent) || !isInside(resolveRealAncestors(resolvedCandidate), resolveRealAncestors(resolvedParent))) throw new Error(message);
  let current = resolvedParent;
  // Every intermediate segment is rejected when it is a symlink or junction, even if the final name does not exist yet.
  // 逐段拒绝符号链接/junction 中间节点，即使最终名称尚不存在也不例外。
  for (const part of path.relative(resolvedParent, resolvedCandidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${message} 路径包含符号链接或 junction。`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return resolvedCandidate;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * lstat detects dangling links; missing descendants inherit the closest real parent.
 * lstat 可检测悬空链接；缺失的后代路径继承最近的真实父目录。
 *
 * @param candidate - Path whose real ancestors must be resolved / 需要解析真实祖先的路径
 * @returns Path with its existing prefix canonicalized to real locations / 已存在前缀被规范化为真实位置的路径
 */
export function resolveRealAncestors(candidate: string): string {
  let current = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(current);
      return path.join(fs.realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link must fail closed instead of being treated as a new path.
      // 悬空链接必须按失败关闭处理，而不能当作新建路径放行。
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('路径包含无法解析的链接。'); }
      catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ENOENT') throw checkError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Strip illegal and control characters from a file or folder name.
 * 从文件或文件夹名称中去除非法字符与控制字符。
 *
 * @param entryName - Raw entry name / 原始条目名称
 * @returns Sanitized name / 清理后的名称
 */
export function sanitizeEntryName(entryName: string): string {
  const sanitized = [...entryName]
    .filter((character) => !invalidEntryNameCharacters.has(character) && character.charCodeAt(0) >= 32)
    .join('')
    .trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('文件或文件夹名称无效。');
  }
  return sanitized;
}

/**
 * Ensure an existing directory exists and is usable as a write target.
 * 确认目标目录已存在且可作为写入目标。
 *
 * @param directoryPath - Directory path to validate / 要校验的目录路径
 * @returns Resolved directory path / 解析后的目录路径
 */
export function assertExistingDirectory(directoryPath: string): string {
  const resolvedPath = path.resolve(directoryPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    throw new Error('目标文件夹不存在。');
  }
  return resolvedPath;
}

/**
 * Find an unused file name in a directory by appending a numeric suffix.
 * 通过追加数字后缀，在目录中找到未被占用的文件名。
 *
 * @param directoryPath - Directory to search / 要搜索的目录
 * @param fileName - Desired file name / 期望的文件名
 * @returns Full path whose name does not collide with existing entries / 名称不与现有条目冲突的完整路径
 */
export function getUniquePath(directoryPath: string, fileName: string): string {
  const parsed = path.parse(fileName);
  let candidateName = fileName;
  let candidatePath = path.join(directoryPath, candidateName);
  let counter = 1;

  while (fs.existsSync(candidatePath)) {
    candidateName = `${parsed.name} ${counter}${parsed.ext}`;
    candidatePath = path.join(directoryPath, candidateName);
    counter++;
  }

  return candidatePath;
}
