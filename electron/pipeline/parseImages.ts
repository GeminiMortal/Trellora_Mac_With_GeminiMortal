/**
 * Parse-stage image sink: content-addressed image adoption for every parsing route,
 * plus markdown reference collection and rewriting so artifacts stay self-contained.
 * 解析阶段图片汇：为所有解析路由提供内容寻址的图片采纳，并收集/改写 markdown 引用，保证产物自包含。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Name of the images subdirectory inside stage output / 阶段输出内图片子目录名 */
export const PARSE_IMAGES_DIRECTORY_NAME = 'images';
/** Name of the image manifest file / 图片清单文件名 */
export const PARSE_IMAGES_MANIFEST_NAME = 'images-manifest.json';

const MAX_SINGLE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 256 * 1024 * 1024;

/** Where an image came from / 图片来源类别 */
export type ParseImageOriginKind = 'mineru-zip' | 'docx-embedded' | 'library-copy';

/**
 * Provenance of one adopted image.
 * 单个已采纳图片的来源信息。
 */
export interface ParseImageOrigin {
  /** Source route kind / 来源路由类别 */
  kind: ParseImageOriginKind;
  /**
   * 图片在源产物中的引用或条目名，用于 markdown 引用改写与排查。
   * Reference or entry name in the source artifact, used for markdown rewrite and debugging.
   */
  ref: string;
  /**
   * library-copy 来源相对资料库的路径，供缓存校验比对源图是否变化。
   * For library-copy: path relative to the library, used by cache validation to detect source changes.
   */
  sourceRelativePath?: string;
  /** Source file size for cache validation / 供缓存校验的源文件大小 */
  sourceSizeBytes?: number;
  /** Source mtime for cache validation / 供缓存校验的源修改时间 */
  sourceMtimeMs?: number;
}

/**
 * One saved image record in the manifest.
 * 清单中单条已保存图片记录。
 */
export interface ParseImageRecord {
  /** File name (`<sha256>.<ext>`) / 文件名（`<sha256>.<ext>`） */
  name: string;
  /** Path relative to the stage output directory / 相对阶段输出目录的路径 */
  relativePath: string;
  /** Content hash used for addressing / 用于寻址的内容哈希 */
  sha256: string;
  /** Size in bytes / 字节大小 */
  bytes: number;
  /** MIME type / MIME 类型 */
  mime: string;
  /** Provenance / 来源信息 */
  origin: ParseImageOrigin;
}

/** Why a reference was not adopted / 引用未被采纳的原因 */
export type ParseImageSkipReason = 'remote-url' | 'outside-library' | 'unsupported-type' | 'too-large' | 'unreadable';

/**
 * Record of a reference that was deliberately not adopted.
 * 刻意未采纳的引用记录。
 */
export interface ParseImageSkippedRecord {
  /** Original reference / 原始引用 */
  ref: string;
  /** Skip reason / 跳过原因 */
  reason: ParseImageSkipReason;
}

/**
 * Manifest describing all adopted and skipped images of a parse run.
 * 描述一次解析运行全部已采纳与已跳过图片的清单。
 */
export interface ParseImagesManifest {
  /** Manifest schema version / 清单结构版本 */
  schemaVersion: 1;
  /** Producing stage / 产出阶段 */
  stage: 'parse';
  /** Saved images / 已保存图片 */
  images: ParseImageRecord[];
  /** Skipped references / 已跳过引用 */
  skipped: ParseImageSkippedRecord[];
  /** Generation timestamp / 生成时间戳 */
  generatedAt: string;
}

/**
 * Collector that saves images under content-addressed names and records rewrites.
 * 以内容寻址名保存图片并记录改写映射的收集器。
 */
export interface ParseImageSink {
  /**
   * 保存内存中的图片字节，返回可写入 markdown 的相对引用；不满足约束时返回 null 并记入 skipped。
   * Saves in-memory image bytes and returns a writable markdown reference; returns null and records a skip when constraints fail.
   *
   * @param buffer - Image bytes / 图片字节
   * @param mimeHint - Optional MIME hint / 可选 MIME 提示
   * @param origin - Provenance / 来源信息
   * @returns Relative reference or null / 相对引用或 null
   */
  saveBuffer(buffer: Buffer, mimeHint: string | undefined, origin: ParseImageOrigin): string | null;
  /**
   * Adopts an existing file into the sink / 将已有文件采纳进图片汇
   *
   * @param absolutePath - Absolute source file path / 源文件绝对路径
   * @param origin - Provenance / 来源信息
   * @returns Relative reference or null / 相对引用或 null
   */
  adoptFile(absolutePath: string, origin: ParseImageOrigin): string | null;
  /**
   * Adopts a byte stream into the sink / 将字节流采纳进图片汇
   *
   * @param source - Async byte source / 异步字节源
   * @param origin - Provenance / 来源信息
   * @returns Relative reference or null / 相对引用或 null
   */
  adoptStream(source: AsyncIterable<Buffer | string>, origin: ParseImageOrigin): Promise<string | null>;
  /**
   * 由路由侧显式记录无法采纳的引用（远程 URL、库外路径、源文件不可读等）。
   * Explicitly records a reference the route could not adopt (remote URL, out-of-library path, unreadable source, etc.).
   *
   * @param ref - Original reference / 原始引用
   * @param reason - Skip reason / 跳过原因
   */
  recordSkip(ref: string, reason: ParseImageSkipReason): void;
  /**
   * Returns the original-reference → relative-path rewrite map / 返回原始引用到相对路径的改写映射
   */
  rewriteMap(): ReadonlyMap<string, string>;
  /** Number of saved images / 已保存图片数 */
  savedCount(): number;
  /** Number of skipped references / 已跳过引用数 */
  skippedCount(): number;
  /** Builds the manifest object / 构建清单对象 */
  manifest(): ParseImagesManifest;
  /**
   * Writes the manifest atomically into a directory / 将清单原子写入目录
   *
   * @param outputDir - Target directory / 目标目录
   */
  writeManifest(outputDir: string): void;
}

interface DetectedImageType {
  extension: '.png' | '.jpg' | '.gif' | '.webp';
  mime: string;
}

/**
 * 解析阶段统一图片汇：所有路由（MinerU zip、DOCX 内嵌、资料库内被引用文件）
 * 都把图片以内容寻址名 `<sha256>.<ext>` 写入阶段输出目录的 images/ 子目录，
 * 并生成 images-manifest.json，保证产物自包含、渲染与分析只在工作区内解析。
 *
 * Unified image collection for the parse stage. Every route (MinerU zip,
 * DOCX embedded, library file referenced by a source document) writes images
 * under content-addressed names `<sha256>.<ext>` into the stage output's
 * images/ subdirectory and produces images-manifest.json, keeping artifacts
 * self-contained so rendering and analysis only resolve paths inside the workspace.
 *
 * @param outputDir - Stage output directory / 阶段输出目录
 * @returns Image sink for this run / 本次运行的图片汇
 */
export function createParseImageSink(outputDir: string): ParseImageSink {
  const imagesDirectory = path.join(outputDir, PARSE_IMAGES_DIRECTORY_NAME);
  const records: ParseImageRecord[] = [];
  const recordsBySha = new Map<string, ParseImageRecord>();
  const skipped: ParseImageSkippedRecord[] = [];
  const rewrites = new Map<string, string>();
  let totalBytes = 0;

  function skip(ref: string, reason: ParseImageSkipReason): void {
    skipped.push({ ref, reason });
  }

  function saveBuffer(buffer: Buffer, mimeHint: string | undefined, origin: ParseImageOrigin): string | null {
    if (buffer.length === 0 || buffer.length > MAX_SINGLE_IMAGE_BYTES) {
      skip(origin.ref, 'too-large');
      return null;
    }
    if (totalBytes + buffer.length > MAX_TOTAL_IMAGE_BYTES) {
      skip(origin.ref, 'too-large');
      return null;
    }
    const detected = detectImageType(buffer) ?? detectImageTypeByMimeHint(mimeHint);
    if (!detected) {
      skip(origin.ref, 'unsupported-type');
      return null;
    }
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    let record = recordsBySha.get(sha256);
    if (!record) {
      const name = `${sha256}${detected.extension}`;
      record = {
        name,
        relativePath: `${PARSE_IMAGES_DIRECTORY_NAME}/${name}`,
        sha256,
        bytes: buffer.length,
        mime: detected.mime,
        origin,
      };
      fs.mkdirSync(imagesDirectory, { recursive: true });
      fs.writeFileSync(path.join(imagesDirectory, name), buffer);
      recordsBySha.set(sha256, record);
      records.push(record);
      totalBytes += buffer.length;
    }
    if (origin.ref) rewrites.set(origin.ref, record.relativePath);
    return record.relativePath;
  }

  return {
    saveBuffer,
    adoptFile(absolutePath, origin) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        skip(origin.ref, 'unreadable');
        return null;
      }
      if (!stat.isFile() || stat.size > MAX_SINGLE_IMAGE_BYTES) {
        skip(origin.ref, stat.isFile() ? 'too-large' : 'unreadable');
        return null;
      }
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(absolutePath);
      } catch {
        skip(origin.ref, 'unreadable');
        return null;
      }
      return saveBuffer(buffer, undefined, origin);
    },
    async adoptStream(source, origin) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          bytes += buffer.length;
          if (bytes > MAX_SINGLE_IMAGE_BYTES) {
            skip(origin.ref, 'too-large');
            return null;
          }
          chunks.push(buffer);
        }
      } catch {
        skip(origin.ref, 'unreadable');
        return null;
      }
      return saveBuffer(Buffer.concat(chunks), undefined, origin);
    },
    recordSkip: skip,
    rewriteMap: () => rewrites,
    savedCount: () => records.length,
    skippedCount: () => skipped.length,
    manifest: () => ({
      schemaVersion: 1,
      stage: 'parse',
      images: [...records],
      skipped: [...skipped],
      generatedAt: new Date().toISOString(),
    }),
    writeManifest(targetDir) {
      const manifestPath = path.join(targetDir, PARSE_IMAGES_MANIFEST_NAME);
      const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temporaryPath, JSON.stringify({
        schemaVersion: 1,
        stage: 'parse',
        images: records,
        skipped,
        generatedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      fs.renameSync(temporaryPath, manifestPath);
    },
  };
}

/**
 * Reads and validates an images manifest from a stage directory.
 * 从阶段目录读取并校验图片清单。
 *
 * @param directory - Stage directory / 阶段目录
 * @returns Manifest or null when missing/invalid / 清单；缺失或非法时为 null
 */
export function readParseImagesManifest(directory: string): ParseImagesManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, PARSE_IMAGES_MANIFEST_NAME), 'utf8')) as Partial<ParseImagesManifest>;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.images) || !Array.isArray(value.skipped)) return null;
    return value as ParseImagesManifest;
  } catch {
    return null;
  }
}

const markdownImagePattern = /!\[[^\]]*\]\(<([^>]*)>\)|!\[[^\]]*\]\(([^)\s]*)(?:\s+["'][^)]*["'])?\)/gu;

/**
 * Extracts all image destinations referenced by markdown text.
 * 提取 markdown 文本引用的全部图片目标。
 *
 * @param text - Markdown text / markdown 文本
 * @returns Decoded image references / 解码后的图片引用列表
 */
export function collectMarkdownImageReferences(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(markdownImagePattern)) {
    const ref = decodeMarkdownUrl(match[1] ?? match[2] ?? '');
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * Rewrites image destinations in markdown text according to a mapping.
 * 按映射改写 markdown 文本中的图片目标。
 *
 * @param text - Markdown text / markdown 文本
 * @param rewrite - Original reference → new relative path / 原始引用到新相对路径的映射
 * @returns Rewritten text / 改写后的文本
 */
export function rewriteMarkdownImageReferences(text: string, rewrite: ReadonlyMap<string, string>): string {
  if (rewrite.size === 0 || !text.includes('![')) return text;
  return text.replace(markdownImagePattern, (whole, angled: string | undefined, plain: string | undefined) => {
    const ref = decodeMarkdownUrl(angled ?? plain ?? '');
    const next = rewrite.get(ref);
    if (!next) return whole;
    const original = angled !== undefined ? `<${angled}>` : (plain ?? '');
    return whole.replace(original, next);
  });
}

/**
 * 将 markdown 文件中的图片引用按映射改写（流式逐行，避免大文件整体入内存）。
 * Rewrites image references inside a markdown file (streaming line by line so
 * large files never load fully into memory).
 *
 * @param filePath - Markdown file path / markdown 文件路径
 * @param rewrite - Original reference → new relative path / 原始引用到新相对路径的映射
 */
export async function rewriteMarkdownFileImageReferences(filePath: string, rewrite: ReadonlyMap<string, string>): Promise<void> {
  if (rewrite.size === 0) return;
  const temporaryPath = `${filePath}.imgtmp-${process.pid}-${Date.now()}`;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const output = fs.createWriteStream(temporaryPath, { encoding: 'utf8' });
  try {
    let pending = '';
    for await (const chunk of input) {
      pending += String(chunk);
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        output.write(`${rewriteMarkdownImageReferences(line, rewrite)}\n`);
        newlineIndex = pending.indexOf('\n');
      }
    }
    if (pending.length > 0) output.write(rewriteMarkdownImageReferences(pending, rewrite));
    await new Promise<void>((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
      output.end();
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* 保留原文件 */ }
    throw error;
  }
}

/**
 * direct 路由的 markdown 源文档可能相对引用资料库内图片；解析前统一采纳进
 * 阶段输出目录，使产物自包含。库外路径与远程 URL 不下载、不复制，记入 skipped。
 * Markdown sources on the direct route may relatively reference images inside
 * the library; they are adopted into the stage output directory before parsing
 * so artifacts are self-contained. Out-of-library paths and remote URLs are
 * neither downloaded nor copied — they are recorded as skipped.
 *
 * @param params - Planning parameters / 规划参数
 * @param params.sourcePath - Markdown source path / markdown 源路径
 * @param params.libraryPath - Library root path / 资料库根路径
 * @param params.sink - Sink receiving adopted images / 接收已采纳图片的图片汇
 */
export function planDirectMarkdownImages(params: {
  sourcePath: string;
  libraryPath: string;
  sink: ParseImageSink;
}): void {
  const markdownExtensions = new Set(['.md', '.markdown']);
  if (!markdownExtensions.has(path.extname(params.sourcePath).toLowerCase())) return;
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(params.sourcePath, 'utf8');
  } catch {
    return;
  }
  const sourceDirectory = path.dirname(params.sourcePath);
  const libraryPath = path.resolve(params.libraryPath);
  for (const line of sourceText.split(/\r?\n/u)) {
    for (const ref of collectMarkdownImageReferences(line)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(ref)) {
        params.sink.recordSkip(ref, 'remote-url');
        continue;
      }
      const absolutePath = path.resolve(sourceDirectory, ref.replace(/[\\/]+$/u, ''));
      const relativeToLibrary = path.relative(libraryPath, absolutePath);
      if (relativeToLibrary.startsWith('..') || path.isAbsolute(relativeToLibrary)) {
        params.sink.recordSkip(ref, 'outside-library');
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        params.sink.recordSkip(ref, 'unreadable');
        continue;
      }
      params.sink.adoptFile(absolutePath, {
        kind: 'library-copy',
        ref,
        sourceRelativePath: relativeToLibrary.replace(/\\/gu, '/'),
        sourceSizeBytes: stat.size,
        sourceMtimeMs: Math.floor(stat.mtimeMs),
      });
    }
  }
}

function decodeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function detectImageType(buffer: Buffer): DetectedImageType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { extension: '.gif', mime: 'image/gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', mime: 'image/webp' };
  }
  return null;
}

function detectImageTypeByMimeHint(mimeHint: string | undefined): DetectedImageType | null {
  switch ((mimeHint ?? '').split(';')[0].trim().toLowerCase()) {
    case 'image/png': return { extension: '.png', mime: 'image/png' };
    case 'image/jpeg': return { extension: '.jpg', mime: 'image/jpeg' };
    case 'image/gif': return { extension: '.gif', mime: 'image/gif' };
    case 'image/webp': return { extension: '.webp', mime: 'image/webp' };
    default: return null;
  }
}
