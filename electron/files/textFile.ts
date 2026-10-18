/**
 * Text file reading helpers with BOM-aware decoding for common Unicode encodings.
 * 文本文件读取辅助函数，支持常见 Unicode 编码的 BOM 感知解码。
 */
import fs from 'fs';

/**
 * Decode a file buffer to a string, stripping UTF-8/UTF-16 BOMs and normalizing UTF-16 to UTF-16LE.
 * 将文件缓冲区解码为字符串，剥离 UTF-8/UTF-16 BOM，并把 UTF-16 统一为 UTF-16LE。
 *
 * @param buffer - Raw file bytes / 原始文件字节
 * @returns Decoded text / 解码后的文本
 */
export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const withoutBom = buffer.subarray(2);
    const swapped = Buffer.allocUnsafe(withoutBom.length);
    // UTF-16BE is byte-swapped into UTF-16LE, which Node.js decodes natively.
    // 将 UTF-16BE 逐字节交换为 UTF-16LE，Node.js 可原生解码后者。
    for (let index = 0; index < withoutBom.length; index += 2) {
      swapped[index] = withoutBom[index + 1] ?? 0;
      swapped[index + 1] = withoutBom[index] ?? 0;
    }
    return swapped.toString('utf16le');
  }

  return buffer.toString('utf8');
}
/**
 * Read a text file from disk with BOM-aware decoding.
 * 从磁盘读取文本文件，并进行 BOM 感知解码。
 *
 * @param filePath - Absolute path of the file to read / 要读取文件的绝对路径
 * @returns Decoded file content / 解码后的文件内容
 */
export function readTextFile(filePath: string): string {
  return decodeTextBuffer(fs.readFileSync(filePath));
}

/**
 * Write a string to a file as UTF-8 without a BOM.
 * 以 UTF-8（无 BOM）编码写入字符串到文件。
 *
 * @param filePath - Absolute path of the file to write / 要写入文件的绝对路径
 * @param content - Text content to persist / 要持久化的文本内容
 * @returns Nothing / 无返回值
 */
export function writeUtf8TextFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
}
