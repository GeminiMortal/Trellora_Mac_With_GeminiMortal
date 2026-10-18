/**
 * File type classification for text and Markdown files the library can open and import.
 * 笔记库可打开与导入的文本、Markdown 文件类型分类。
 */
import path from 'path';

/**
 * Coarse kind of a supported text file.
 * 受支持文本文件的粗粒度类别。
 */
export type FileKind = 'markdown' | 'text' | 'code';

/**
 * Extension and kind of a recognized text file.
 * 已识别文本文件的扩展名与类别。
 */
export interface FileTypeInfo {
  /** Lower-cased extension including the leading dot / 含前导点的小写扩展名 */
  extension: string;
  /** Coarse file kind / 粗粒度文件类别 */
  kind: FileKind;
}

/** Extensions treated as Markdown / 被视为 Markdown 的扩展名 */
export const markdownExtensions = new Set(['.md', '.markdown']);

/** Extensions treated as source code / 被视为源代码的扩展名 */
export const codeExtensions = new Set([
  '.js', '.jsx', '.ts', '.tsx',
  '.py', '.java', '.c', '.cpp', '.cs',
  '.go', '.rs', '.php', '.rb',
  '.sh', '.bat', '.ps1', '.sql',
]);

/** Extensions allowed for text import and editing / 允许文本导入与编辑的扩展名 */
export const supportedTextExtensions = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.css',
]);

/**
 * Get the lower-cased extension of a file path or name.
 * 获取文件路径或名称的小写扩展名。
 *
 * @param filePathOrName - File path or name / 文件路径或名称
 * @returns Lower-cased extension including the leading dot, or an empty string / 含前导点的小写扩展名，或空字符串
 */
export function getNormalizedExtension(filePathOrName: string): string {
  return path.extname(filePathOrName).toLowerCase();
}

/**
 * Whether the file is a Markdown document.
 * 判断文件是否为 Markdown 文档。
 *
 * @param filePathOrName - File path or name / 文件路径或名称
 * @returns True when the extension is Markdown / 扩展名属于 Markdown 时为 true
 */
export function isMarkdownFile(filePathOrName: string): boolean {
  return markdownExtensions.has(getNormalizedExtension(filePathOrName));
}

/**
 * Whether the file is a source code document.
 * 判断文件是否为源代码文档。
 *
 * @param filePathOrName - File path or name / 文件路径或名称
 * @returns True when the extension is code / 扩展名属于代码时为 true
 */
export function isCodeFile(filePathOrName: string): boolean {
  return codeExtensions.has(getNormalizedExtension(filePathOrName));
}

/**
 * Whether the file is a supported plain-text document.
 * 判断文件是否为受支持的纯文本文档。
 *
 * @param filePathOrName - File path or name / 文件路径或名称
 * @returns True when the extension is supported / 扩展名受支持时为 true
 */
export function isSupportedTextFile(filePathOrName: string): boolean {
  const ext = getNormalizedExtension(filePathOrName);
  return supportedTextExtensions.has(ext) || codeExtensions.has(ext);
}

/**
 * Classify a file by its extension, or return null when unsupported.
 * 按扩展名对文件分类，不支持时返回 null。
 *
 * @param filePathOrName - File path or name / 文件路径或名称
 * @returns Type info, or null when the extension is unsupported / 类型信息；扩展名不支持时为 null
 */
export function getFileTypeInfo(filePathOrName: string): FileTypeInfo | null {
  const extension = getNormalizedExtension(filePathOrName);
  if (markdownExtensions.has(extension)) return { extension, kind: 'markdown' };
  if (codeExtensions.has(extension)) return { extension, kind: 'code' };
  if (supportedTextExtensions.has(extension)) return { extension, kind: 'text' };
  return null;
}

/**
 * Remove a known text extension from a file name, leaving unknown names unchanged.
 * 从文件名中去除已知文本扩展名；未知名称保持不变。
 *
 * @param fileName - File name to trim / 要裁剪的文件名
 * @returns File name without its known extension / 去除已知扩展名后的文件名
 */
export function stripKnownTextExtension(fileName: string): string {
  const extension = getNormalizedExtension(fileName);
  if (!extension || (!supportedTextExtensions.has(extension) && !codeExtensions.has(extension))) return fileName;
  return fileName.slice(0, -extension.length);
}

/**
 * Heuristic check that a buffer holds plain text rather than binary content.
 * 启发式判断缓冲区内容是纯文本而非二进制。
 *
 * @param buffer - Bytes to inspect / 要检查的字节
 * @returns True when the sample looks like text / 样本看起来像文本时为 true
 */
export function isLikelyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;

  const hasUtf8Bom = buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf;
  const hasUtf16Bom = buffer.length >= 2
    && (
      (buffer[0] === 0xff && buffer[1] === 0xfe)
      || (buffer[0] === 0xfe && buffer[1] === 0xff)
    );

  if (hasUtf8Bom || hasUtf16Bom) return true;

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return false;

  let controlCharacters = 0;
  // Tab, LF and CR are the only control characters tolerated in a text sample.
  // 样本中仅允许制表符、换行和回车这三种控制字符。
  for (const byte of sample) {
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isAllowedControl) controlCharacters++;
  }

  return controlCharacters / sample.length < 0.03;
}
