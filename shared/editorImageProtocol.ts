/**
 * Custom protocol helpers for serving local images to the editor via menghan-image URLs.
 * 通过 menghan-image URL 向编辑器提供本地图片的自定义协议辅助函数。
 */

/**
 * Custom protocol scheme for editor image resources.
 * 编辑器图片资源使用的自定义协议方案。
 */
export const EDITOR_IMAGE_PROTOCOL = 'menghan-image';

/**
 * Fixed protocol host part required by URL parsing.
 * URL 解析所需的固定协议主机部分。
 */
const editorImageProtocolHost = 'local';

/**
 * Convert an absolute file path into a menghan-image protocol URL.
 * 将绝对文件路径转换为 menghan-image 协议 URL。
 *
 * @param absolutePath - Absolute path of the image file / 图片文件的绝对路径
 * @returns Protocol URL usable in the editor / 可在编辑器中使用的协议 URL
 */
export function toEditorImageUrl(absolutePath: string): string {
  // URL paths always use forward slashes regardless of platform separators.
  // URL 路径始终使用正斜杠，与平台分隔符无关。
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  return `${EDITOR_IMAGE_PROTOCOL}://${editorImageProtocolHost}/${encodeURIComponent(normalizedPath)}`;
}

/**
 * Parse a menghan-image URL back into a validated absolute file path, rejecting any URL with credentials, ports, queries, fragments, or relative paths.
 * 将 menghan-image URL 解析回经过校验的绝对文件路径，拒绝携带凭据、端口、查询串、片段或相对路径的 URL。
 *
 * @param rawUrl - URL string to parse / 要解析的 URL 字符串
 * @returns Absolute file path, or null when the URL is invalid or unsafe / 绝对文件路径；URL 无效或不安全时返回 null
 */
export function parseEditorImageUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    // Only the exact protocol/host form without credentials, port, query, or fragment is accepted.
    // 仅接受精确的协议/主机形式，且不得含凭据、端口、查询串或片段。
    if (
      url.protocol !== `${EDITOR_IMAGE_PROTOCOL}:`
      || url.hostname !== editorImageProtocolHost
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) return null;

    const encodedPath = url.pathname.replace(/^\/+/, '');
    if (!encodedPath) return null;

    const decodedPath = decodeURIComponent(encodedPath);
    // Reject null bytes and anything that is not an absolute POSIX path.
    // 拒绝空字节以及非绝对 POSIX 路径。
    if (decodedPath.includes('\0')) return null;
    if (!/^(?:[a-z]:\/|\/)/i.test(decodedPath)) return null;
    return decodedPath;
  } catch {
    return null;
  }
}
