/**
 * Parsing route resolution: maps file extensions to the pipeline parser that should handle them.
 * 解析路由：把文件扩展名映射到应处理它的流水线解析器。
 */

import path from 'node:path';
import type { ParsingRoute } from './types.ts';

/**
 * Extensions that are already plain text and can skip heavyweight parsing.
 * 已是纯文本、可跳过重量级解析的扩展名集合。
 */
export const directTextExtensions = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml', '.log', '.xml', '.html', '.htm',
]);

/**
 * Extensions parsed by the Mammoth DOCX worker.
 * 由 Mammoth DOCX Worker 解析的扩展名集合。
 */
export const mammothExtensions = new Set(['.docx']);

/**
 * Resolves which parsing route a file name or extension belongs to.
 * 判定文件名或扩展名应走哪条解析路由。
 *
 * @param extensionOrName - File name or extension / 文件名或扩展名
 * @returns Parsing route id ('direct' | 'mammoth' | 'mineru' | 'unsupported') / 解析路由标识
 */
export function resolveParsingRoute(extensionOrName: string): ParsingRoute {
  const extension = normalizeExtension(extensionOrName);
  if (directTextExtensions.has(extension)) return 'direct';
  if (mammothExtensions.has(extension)) return 'mammoth';
  if (extension === '.pdf') return 'mineru';
  return 'unsupported';
}

/**
 * Checks whether the file should be parsed by Mammoth.
 * 判断文件是否应由 Mammoth 解析。
 *
 * @param extensionOrName - File name or extension / 文件名或扩展名
 * @returns True for .docx inputs / 输入为 .docx 时返回 true
 */
export function isMammothFormat(extensionOrName: string): boolean {
  return mammothExtensions.has(normalizeExtension(extensionOrName));
}

// Accepts a bare ".ext" or a full file name; falls back to path.extname otherwise.
// 支持裸扩展名“.ext”或完整文件名；否则退回 path.extname 提取。
function normalizeExtension(extensionOrName: string): string {
  const normalized = extensionOrName.trim().toLowerCase();
  return /^\.[a-z0-9]+$/u.test(normalized) ? normalized : path.extname(normalized);
}
