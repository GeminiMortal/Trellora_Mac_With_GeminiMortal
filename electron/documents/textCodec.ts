/**
 * Text encoding detection, decoding and lossless encoding for external document editing.
 * 外部文档编辑的文本编码识别、解码与无损编码。
 */
import iconv from 'iconv-lite';
import type { DocumentEncoding, DocumentFormat } from '../../shared/documentSession.ts';

/**
 * Document processing error with a stable machine-readable code.
 * 文档处理错误，携带稳定的机器可读错误码。
 *
 * @param code - Stable error code such as DOCUMENT_ENCODING_REQUIRED / 稳定错误码，例如 DOCUMENT_ENCODING_REQUIRED
 * @param message - User-facing Chinese error message / 面向用户的中文错误信息
 * @param retryable - Whether the caller may retry the same operation / 调用方是否可以重试同一操作
 */
export class DocumentError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}
const encodings: DocumentEncoding[] = ['utf8', 'utf16le', 'utf16be', 'gbk', 'gb18030'];
/**
 * Asserts that a value is one of the supported document encodings.
 * 断言该值是受支持的文档编码之一。
 *
 * @param value - Candidate encoding name to validate / 待校验的编码名称候选
 */
export function assertEncoding(value: unknown): asserts value is DocumentEncoding {
  if (!encodings.includes(value as DocumentEncoding)) throw new DocumentError('DOCUMENT_ENCODING_REQUIRED', '请选择支持的文本编码。');
}
/**
 * Normalizes line endings to LF before comparison or encoding.
 * 在比较或编码前将换行符归一为 LF。
 *
 * @param content - Raw text content / 原始文本内容
 * @returns Text with CRLF/CR replaced by LF / 将 CRLF/CR 替换为 LF 后的文本
 */
export function normalizeDocumentText(content: string): string { return content.replace(/\r\n|\r/g, '\n'); }

/**
 * BOM-less UTF-16 cannot be judged merely by "decodable as UTF-8"; encoding ambiguity is resolved by explicit user choice.
 * 无 BOM UTF-16 不能仅凭“可解码成 UTF-8”判定，编码歧义由用户明确选择。
 *
 * @param bytes - Raw file bytes to decode / 待解码的原始文件字节
 * @param chosen - Encoding explicitly chosen by the user, if any / 用户明确选择的编码（如有）
 * @returns Decoded content and the detected/confirmed format / 解码后的内容与已识别或确认的格式
 */
export function decodeDocument(bytes: Buffer, chosen?: DocumentEncoding): { content: string; format: DocumentFormat } {
  let encoding = chosen ?? 'utf8';
  let bom: DocumentFormat['bom'] = 'none';
  let payload = bytes;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { bom = 'utf8'; encoding = 'utf8'; payload = bytes.subarray(3); }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) { bom = 'utf16le'; encoding = 'utf16le'; payload = bytes.subarray(2); }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) { bom = 'utf16be'; encoding = 'utf16be'; payload = bytes.subarray(2); }
  if (chosen) assertEncoding(chosen);
  if (chosen && bom !== 'none' && chosen !== encoding) throw new DocumentError('DOCUMENT_ENCODING_REQUIRED', '所选编码与文件 BOM 不一致。');
  if (!chosen && bom === 'none' && bytes.includes(0)) throw new DocumentError('DOCUMENT_ENCODING_REQUIRED', '文件编码尚不明确，请选择编码后打开。');
  let text: string;
  try {
    if (encoding === 'utf8' || encoding === 'utf16le' || encoding === 'utf16be') text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(payload);
    else {
      text = iconv.decode(payload, encoding, { stripBOM: false });
      if (!iconv.encode(text, encoding).equals(payload)) throw new Error('lossy decode');
    }
  } catch { throw new DocumentError('DOCUMENT_ENCODING_REQUIRED', '无法按所选编码完整读取，请选择其他编码。'); }
  if (text.includes('\0') || [...text].filter(c => c.charCodeAt(0) < 32 && !'\r\n\t'.includes(c)).length > Math.max(1, text.length * 0.03)) throw new DocumentError('DOCUMENT_NOT_TEXT', '文件不是可编辑的纯文本。');
  const breaks = text.match(/\r\n|\r|\n/g) ?? [];
  const kinds = new Set(breaks);
  const lineEnding: DocumentFormat['lineEnding'] = kinds.size > 1 ? 'mixed' : breaks[0] === '\r\n' ? 'crlf' : breaks[0] === '\r' ? 'cr' : breaks[0] === '\n' ? 'lf' : 'none';
  return { content: normalizeDocumentText(text), format: { encoding, bom, lineEnding } };
}

/**
 * Editing content is normalized to LF first, then encoded per the confirmed format; unencodable characters are never replaced with question marks.
 * 编辑正文先归一到 LF，再按已确认格式编码；不可编码字符绝不替换成问号。
 *
 * @param content - Edited text content / 已编辑的文本内容
 * @param original - Format detected when the file was opened / 打开文件时识别的格式
 * @param override - Partial format overrides selected by the user / 用户选择的部分格式覆盖
 * @returns Encoded bytes with BOM and the final format / 含 BOM 的编码字节与最终格式
 */
export function encodeDocument(content: string, original: DocumentFormat, override: Partial<DocumentFormat> = {}): { bytes: Buffer; format: DocumentFormat } {
  const format = { ...original, ...override };
  assertEncoding(format.encoding);
  if (!['none', 'utf8', 'utf16le', 'utf16be'].includes(format.bom) || (format.bom !== 'none' && format.bom !== format.encoding)) throw new DocumentError('DOCUMENT_ENCODING_REQUIRED', '编码与 BOM 不兼容。');
  if (!['lf', 'crlf', 'cr', 'none', 'mixed'].includes(format.lineEnding)) throw new DocumentError('DOCUMENT_ENCODING_REQUIRED', '换行格式无效。');
  if (format.lineEnding === 'mixed') throw new DocumentError('DOCUMENT_ENCODING_REQUIRED', '文件包含混合换行，请选择 LF 或 CRLF 后保存。');
  const text = normalizeDocumentText(content).replace(/\n/g, format.lineEnding === 'lf' ? '\n' : format.lineEnding === 'cr' ? '\r' : '\r\n');
  const bytes = iconv.encode(text, format.encoding);
  if (iconv.decode(bytes, format.encoding, { stripBOM: false }) !== text) throw new DocumentError('DOCUMENT_ENCODING_LOSS', '原编码无法保存这些字符，请改用 UTF-8 另存。');
  const marker = format.bom === 'utf8' ? Buffer.from([0xef, 0xbb, 0xbf]) : format.bom === 'utf16le' ? Buffer.from([0xff, 0xfe]) : format.bom === 'utf16be' ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0);
  return { bytes: Buffer.concat([marker, bytes]), format: { ...format, lineEnding: text.includes('\n') || text.includes('\r') ? (format.lineEnding === 'none' ? 'crlf' : format.lineEnding) : 'none' } };
}
