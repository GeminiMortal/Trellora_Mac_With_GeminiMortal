/**
 * Custom editor-image protocol handler: serves library image assets over a privileged scheme with strict path guards.
 * 自定义编辑器图片协议处理器：通过特权 scheme 提供笔记库图片资源，并执行严格的路径守卫。
 */
import fs from 'fs';
import path from 'path';
import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import {
  EDITOR_IMAGE_PROTOCOL,
  parseEditorImageUrl,
} from '../../shared/editorImageProtocol.ts';
export { toEditorImageUrl } from '../../shared/editorImageProtocol.ts';
import { assertInsideDirectory } from './pathGuards.ts';

const supportedEditorImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const editorImageMimeTypes: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * An editor image inlined as a data URL plus its size.
 * 以 data URL 内联的编辑器图片及其大小。
 */
export interface EditorImageDataUrl {
  /** Base64 data URL of the image / 图片的 Base64 data URL */
  dataUrl: string;
  /** Byte length of the decoded image file / 图片文件的字节长度 */
  byteLength: number;
}

/**
 * Register the editor-image scheme as privileged; must run before the app is ready.
 * 将编辑器图片 scheme 注册为特权协议；必须在应用 ready 之前调用。
 *
 * @returns Nothing / 无返回值
 */
export function registerEditorImageProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: EDITOR_IMAGE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

/**
 * Handle editor-image requests by serving files from the current library.
 * 处理编辑器图片请求，从当前笔记库中提供文件。
 *
 * @param getCurrentLibraryPath - Returns the active library path or null / 返回当前笔记库路径或 null
 * @returns Nothing / 无返回值
 */
export function registerEditorImageProtocol(getCurrentLibraryPath: () => string | null): void {
  protocol.handle(EDITOR_IMAGE_PROTOCOL, async (request) => {
    if (request.method !== 'GET') return textResponse('Method not allowed', 405);

    const libraryPath = getCurrentLibraryPath();
    if (!libraryPath) return textResponse('Not found', 404);

    try {
      const imagePath = resolveEditorImageRequestPath(request.url, libraryPath);
      return await net.fetch(pathToFileURL(imagePath).href);
    } catch {
      return textResponse('Not found', 404);
    }
  });
}

/**
 * Resolve a request URL to a real image file strictly inside the library.
 * 将请求 URL 严格解析为笔记库内的真实图片文件。
 *
 * @param rawUrl - editor-image:// URL from the renderer / 来自渲染进程的 editor-image:// URL
 * @param libraryPath - Current library root / 当前笔记库根目录
 * @returns Real path of the image file / 图片文件的真实路径
 */
export function resolveEditorImageRequestPath(rawUrl: string, libraryPath: string): string {
  const requestedPath = parseEditorImageUrl(rawUrl);
  if (!requestedPath) throw new Error('图片资源地址无效。');

  const resolvedLibraryPath = path.resolve(libraryPath);
  const resolvedRequestedPath = assertInsideDirectory(
    requestedPath,
    resolvedLibraryPath,
    '图片资源路径超出当前笔记库。',
  );
  if (!supportedEditorImageExtensions.has(path.extname(resolvedRequestedPath).toLowerCase())) {
    throw new Error('不支持该图片资源类型。');
  }

  // Realpath is checked again after containment so symlink escapes cannot leave the library.
  // 包含性检查后再做 realpath 校验，防止符号链接逃逸出笔记库。
  const realLibraryPath = fs.realpathSync(resolvedLibraryPath);
  const realRequestedPath = fs.realpathSync(resolvedRequestedPath);
  assertInsideDirectory(realRequestedPath, realLibraryPath, '图片资源路径超出当前笔记库。');
  if (!fs.statSync(realRequestedPath).isFile()) throw new Error('图片资源不是文件。');
  return realRequestedPath;
}

/**
 * Read a library image as a base64 data URL for export embedding.
 * 将笔记库图片读取为 Base64 data URL，用于导出嵌入。
 *
 * @param rawUrl - editor-image:// URL from the renderer / 来自渲染进程的 editor-image:// URL
 * @param libraryPath - Current library root / 当前笔记库根目录
 * @param maxBytes - Maximum allowed image size in bytes / 允许的最大图片字节数
 * @returns Data URL and byte length / Data URL 与字节长度
 */
export function readEditorImageDataUrl(
  rawUrl: string,
  libraryPath: string,
  maxBytes: number,
): EditorImageDataUrl {
  const imagePath = resolveEditorImageRequestPath(rawUrl, libraryPath);
  const stat = fs.statSync(imagePath);
  if (stat.size > maxBytes) throw new Error('单张导出图片不能超过 10 MB。请压缩图片后重试。');

  const extension = path.extname(imagePath).toLowerCase();
  const mimeType = editorImageMimeTypes[extension];
  if (!mimeType) throw new Error('不支持该图片资源类型。');
  const buffer = fs.readFileSync(imagePath);
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    byteLength: buffer.byteLength,
  };
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
