/**
 * Parsing route resolution: maps file extensions to the pipeline parser that should handle them.
 * 解析路由：把文件扩展名映射到应处理它的流水线解析器。
 *
 * Built-in routes (direct/mammoth/mineru) are resolved from static extension
 * sets. Plugin-registered routes are consulted first; when one matches, the
 * route is 'custom' and the caller must dispatch to the plugin handler via
 * getCustomParsingRoute.
 *
 * 内建路由（direct/mammoth/mineru）由静态扩展名集合解析。插件注册的路由
 * 优先参与匹配；命中时路由为 'custom'，调用方须经 getCustomParsingRoute
 * 分发到插件处理器。
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

// ── Plugin custom routes ─────────────────────────────────────────────────────

export interface CustomParsingRoute {
  /** Logical route id (matches plugin.json contributes.parsingRoutes[].route). */
  route: string;
  /** Handler invoked to parse one document into the stage output directory. */
  handler: (input: {
    inputPath: string;
    outputDir: string;
    extension: string;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number, message?: string) => void;
  }) => Promise<{ markdownFile: string; counts?: Record<string, number> }>;
}

const customRoutes = new Map<string, CustomParsingRoute>();

/**
 * Registers a plugin parsing route. Throws when the extension is already
 * claimed by another plugin route (built-in extensions are not claimable).
 * 注册插件解析路由。扩展名已被其他插件路由占用时抛错（内建扩展名不可占用）。
 */
export function registerCustomParsingRoute(extension: string, route: CustomParsingRoute): void {
  const normalized = normalizeExtension(extension);
  if (directTextExtensions.has(normalized) || mammothExtensions.has(normalized) || normalized === '.pdf') {
    throw new Error(`扩展名 ${normalized} 由内建解析路由占用，插件不可注册。`);
  }
  if (customRoutes.has(normalized)) throw new Error(`解析路由扩展名 ${normalized} 已被占用。`);
  customRoutes.set(normalized, route);
}

/** Removes a plugin parsing route (plugin disable/uninstall). */
export function unregisterCustomParsingRoute(extension: string): boolean {
  return customRoutes.delete(normalizeExtension(extension));
}

/** Returns the plugin route for an extension, if registered. */
export function getCustomParsingRoute(extensionOrName: string): CustomParsingRoute | undefined {
  return customRoutes.get(normalizeExtension(extensionOrName));
}

/** Lists all plugin-registered extensions (for diagnostics). */
export function listCustomParsingRouteExtensions(): string[] {
  return [...customRoutes.keys()];
}

/**
 * Resolves which parsing route a file name or extension belongs to.
 * 判定文件名或扩展名应走哪条解析路由。
 *
 * @param extensionOrName - File name or extension / 文件名或扩展名
 * @returns Parsing route id ('direct' | 'mammoth' | 'mineru' | 'custom' | 'unsupported') / 解析路由标识
 */
export function resolveParsingRoute(extensionOrName: string): ParsingRoute {
  const extension = normalizeExtension(extensionOrName);
  if (directTextExtensions.has(extension)) return 'direct';
  if (mammothExtensions.has(extension)) return 'mammoth';
  if (extension === '.pdf') return 'mineru';
  if (customRoutes.has(extension)) return 'custom';
  return 'unsupported';
}

/**
 * Checks whether the file should be parsed by Mammoth.
 * 判断文件是否应由 Mammoth 解析。
 *
 * @param extensionOrName - File name or extension / 文件名或扩展名
 * @returns True if .docx inputs / 若为 .docx 输入则为 true
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
