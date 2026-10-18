/**
 * Extracts image sources from clipboard and drop payloads for the editor.
 * 为编辑器从剪贴板与拖放载荷中提取图片来源。
 */
import type { SavedEditorImage } from '../../electron';

/**
 * Builds a markdown-resolvable URL for a saved editor image.
 * 为已保存的编辑器图片生成可写入 Markdown 的 URL。
 */
export { toEditorImageUrl } from '../../../shared/editorImageProtocol.ts';

/**
 * Image payload extracted from a clipboard or drop event.
 * 从剪贴板或拖放事件中提取的图片载荷。
 */
export type ClipboardImageSource =
  | { kind: 'file'; file: File }
  | { kind: 'local-path'; sourcePath: string };

/**
 * Maximum accepted editor image size in bytes (20 MB).
 * 允许插入编辑器的图片最大体积（20 MB）。
 */
export const MAX_EDITOR_IMAGE_BYTES = 20 * 1024 * 1024;
// Supported image file extensions. / 支持的图片文件扩展名。
const supportedImageExtensionPattern = /\.(?:png|jpe?g|gif|webp)$/i;
// Matches base64 data URLs of supported image MIME types. / 匹配受支持图片 MIME 类型的 base64 data URL。
const supportedDataImagePattern = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i;

/**
 * Collects image sources from a clipboard DataTransfer: image files first,
 * then image-only HTML, then markdown local image paths.
 * 从剪贴板 DataTransfer 收集图片来源：优先图片文件，其次纯图片 HTML，最后 Markdown 本地图片路径。
 *
 * @param dataTransfer - Clipboard payload / 剪贴板载荷
 * @returns Deduplicated image sources / 去重后的图片来源
 */
export function getClipboardImageSources(dataTransfer: DataTransfer): ClipboardImageSource[] {
  const files = getImageFiles(dataTransfer);
  if (files.length > 0) return files.map((file) => ({ kind: 'file', file }));

  const html = dataTransfer.getData('text/html');
  const htmlSources = extractImageSourcesFromHtml(html);
  if (htmlSources.length > 0 && isImageOnlyHtml(html)) {
    const sources = htmlSources.flatMap(toClipboardImageSource);
    if (sources.length > 0) return deduplicateSources(sources);
  }

  const localPaths = extractLocalImagePathsFromMarkdown(dataTransfer.getData('text/plain'));
  return deduplicateSources(localPaths.map((sourcePath) => ({ kind: 'local-path', sourcePath })));
}

/**
 * Collects image files from a drop event, ignoring HTML and path sources.
 * 从拖放事件中收集图片文件，忽略 HTML 与路径来源。
 *
 * @param dataTransfer - Drop payload / 拖放载荷
 * @returns File-backed image sources / 基于文件的图片来源
 */
export function getDroppedImageSources(dataTransfer: DataTransfer): ClipboardImageSource[] {
  return getImageFiles(dataTransfer).map((file) => ({ kind: 'file', file }));
}

/**
 * Extracts local image paths from markdown when the whole text is image syntax.
 * 当整段文本均为图片语法时，从 Markdown 中提取本地图片路径。
 *
 * @param text - Plain-text clipboard content / 剪贴板纯文本内容
 * @returns Local image paths, empty when other text is present / 本地图片路径；含其他文本时为空
 */
export function extractLocalImagePathsFromMarkdown(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const destinations: string[] = [];
  const withoutImages = trimmed.replace(
    /!\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|(?:file:\/\/\/|[a-z]:[\\/])[^)\r\n]+)\s*\)/gi,
    (_match, rawDestination: string) => {
      const destination = normalizeMarkdownImageDestination(rawDestination);
      const localPath = destination ? toLocalImagePath(destination) : null;
      if (localPath) destinations.push(localPath);
      return '';
    },
  );

  return withoutImages.trim() === '' ? destinations : [];
}

/**
 * Formats a saved editor image as a markdown image with an escaped alt text.
 * 将已保存的编辑器图片格式化为 Markdown 图片语法，alt 文本会被转义。
 *
 * @param saved - Saved image metadata / 已保存的图片元数据
 * @returns Markdown image syntax / Markdown 图片语法
 */
export function formatSavedEditorImageMarkdown(saved: SavedEditorImage): string {
  const alt = saved.fileName
    .replace(/\.[^.]+$/, '')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]');
  return `![${alt}](${saved.markdownPath})`;
}

/**
 * Pulls supported image files from the transfer, preferring items and dropping duplicates.
 * 从传输数据中提取受支持的图片文件，优先使用 items 并去重。
 */
function getImageFiles(dataTransfer: DataTransfer): File[] {
  const itemFiles = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && isSupportedImageFile(file)));
  const candidates = itemFiles.length > 0
    ? itemFiles
    : Array.from(dataTransfer.files ?? []).filter(isSupportedImageFile);

  const seen = new Set<string>();
  return candidates.filter((file) => {
    const key = `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Checks MIME type or file extension against the supported image formats.
 * 按 MIME 类型或扩展名检查是否为受支持的图片格式。
 */
function isSupportedImageFile(file: File): boolean {
  return /^(?:image\/(?:png|jpeg|gif|webp))$/i.test(file.type)
    || supportedImageExtensionPattern.test(file.name);
}

/**
 * Collects every img src value from an HTML fragment.
 * 收集 HTML 片段中所有 img 的 src 值。
 */
function extractImageSourcesFromHtml(html: string): string[] {
  if (!html) return [];
  const sources: string[] = [];
  const imagePattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(html)) !== null) {
    const source = decodeBasicHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (source) sources.push(source);
  }
  return sources;
}

/**
 * True when the HTML contains no visible text outside of images and comments.
 * 当 HTML 中除图片与注释外没有可见文本时返回 true。
 */
function isImageOnlyHtml(html: string): boolean {
  const remainingText = html
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, '')
    .trim();
  return remainingText === '';
}

/**
 * Converts a raw HTML/URL source into a file or local-path source.
 * 将原始 HTML/URL 来源转换为文件或本地路径来源。
 */
function toClipboardImageSource(source: string): ClipboardImageSource[] {
  const dataFile = fileFromDataImageUrl(source);
  if (dataFile) return [{ kind: 'file', file: dataFile }];
  const sourcePath = toLocalImagePath(source);
  return sourcePath ? [{ kind: 'local-path', sourcePath }] : [];
}

/**
 * Decodes a supported base64 data URL into a File, rejecting oversized payloads.
 * 将受支持的 base64 data URL 解码为 File，拒绝过大的载荷。
 */
function fileFromDataImageUrl(source: string): File | null {
  // Reject early when the base64 length alone can exceed the size cap. / 仅 base64 长度就可能超限时提前拒绝。
  if (source.length > Math.ceil(MAX_EDITOR_IMAGE_BYTES * 4 / 3) + 256) return null;
  const match = source.match(supportedDataImagePattern);
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const extension = match[1].toLowerCase() === 'image/jpeg'
      ? 'jpg'
      : match[1].slice('image/'.length).toLowerCase();
    return new File([bytes], `clipboard.${extension}`, { type: match[1].toLowerCase() });
  } catch {
    return null;
  }
}

/**
 * Strips markdown destination decorations and keeps a supported image path.
 * 去掉 Markdown 目标装饰并保留受支持的图片路径。
 */
function normalizeMarkdownImageDestination(rawDestination: string): string | null {
  const withoutAngles = rawDestination.trim().replace(/^<|>$/g, '');
  const match = withoutAngles.match(/^(.+?\.(?:png|jpe?g|gif|webp))(?:\s+["'][^"']*["'])?$/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * Normalizes a file URL to a local image path.
 * 将 file URL 归一化为本地图片路径。
 */
function toLocalImagePath(source: string): string | null {
  const trimmed = source.trim();
  let localPath: string;
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
      localPath = decodeURIComponent(url.pathname);
      // Strip the leading slash before a drive letter, e.g. /C:/. / 去掉盘符前的前导斜杠，例如 /C:/。
      if (/^\/[a-z]:\//i.test(localPath)) localPath = localPath.slice(1);
      localPath = localPath.replace(/\//g, '\\');
    } catch {
      return null;
    }
  } else if (/^[a-z]:[\\/]/i.test(trimmed)) {
    localPath = trimmed.replace(/\//g, '\\');
  } else {
    return null;
  }

  return supportedImageExtensionPattern.test(localPath) ? localPath : null;
}

/**
 * Removes duplicate sources by file identity or case-insensitive path.
 * 按文件标识或大小写不敏感路径去除重复来源。
 */
function deduplicateSources(sources: ClipboardImageSource[]): ClipboardImageSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.kind === 'file'
      ? `file:${source.file.name}\u0000${source.file.type}\u0000${source.file.size}\u0000${source.file.lastModified}`
      : `path:${source.sourcePath.toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Decodes the small set of HTML entities that appear in image src attributes.
 * 解码图片 src 属性中会出现的少量 HTML 实体。
 */
function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
