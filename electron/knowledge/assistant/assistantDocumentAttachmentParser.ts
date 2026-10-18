/**
 * Parse assistant document attachments (PDF / DOCX) into bounded turn context text and
 * derived image placeholders, with temp-directory lifecycle management.
 * 解析助手文档附件（PDF / DOCX），生成有界的单轮上下文文本与派生图片占位符，并管理临时目录生命周期。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMammothDocxParse } from '../../pipeline/mammothStage';
import { runMineruPdfParse, type MineruParseOptions } from '../../pipeline/mineruClient';
import { readParseImagesManifest, type ParseImageRecord } from '../../pipeline/parseImages';
import type { MineruRuntimeConfig } from '../types.ts';
import type { AiTransportImage } from '../ai/aiGenerationTransport.ts';
import type { AssistantAttachment, AssistantDocumentAttachment, AssistantImageMimeType } from './assistantTurnTypes.ts';
import {
  assistantDocumentExtensions,
  maxAssistantDocumentBytes,
  maxAssistantImageBytes,
  maxAssistantImageTotalBytes,
} from './assistantTurnTypes.ts';

/** Upper bound of document body characters injected into one assistant turn. / 单轮注入文档正文的最大字符数。 */
const MAX_DOCUMENT_TEXT_CHARS = 500_000;
/** Upper bound of PDF pages accepted by local text extraction. / 本地文本提取接受的最大 PDF 页数。 */
const MAX_PDF_PAGES = 500;
/** Temp-directory name prefix for assistant document parse sessions. / 助手文档解析会话使用的临时目录名前缀。 */
const TEMP_DIRECTORY_PREFIX = 'trellora-assistant-doc-';

/**
 * Maximum number of document-derived images materialized into one VLM request.
 * 单次 VLM 请求中最多物化的文档派生图片数量。
 */
export const maxAssistantDerivedDocumentImages = 4;

/**
 * A single image extracted from a parsed document, recorded with a prompt placeholder.
 * 从解析文档中提取的单张图片记录，附带提示词占位符。
 */
export interface AssistantParsedDocumentImage {
  imageId: string;
  attachmentId: string;
  /** Placeholder token embedded in the rewritten document text. / 嵌入改写后文档文本中的占位符。 */
  placeholder: string;
  name: string;
  mimeType: AssistantImageMimeType;
  sizeBytes: number;
  /** Content hash used for deduplication and tamper checks. / 用于去重与完整性校验的内容哈希。 */
  sha256: string;
  /** Absolute path inside the owned temp directory; invalid after dispose. / 位于归属临时目录内的绝对路径；dispose 后失效。 */
  absolutePath: string;
  /** One-based document line numbers where the placeholder appears. / 占位符出现的文档行号（从 1 开始）。 */
  lineNumbers: number[];
}

/**
 * A parsed document image paired with its VLM transport payload.
 * 解析得到的文档图片与其 VLM 传输载荷的配对。
 */
export interface AssistantMaterializedDocumentImage {
  /** Original parsed image record. / 原始解析图片记录。 */
  source: AssistantParsedDocumentImage;
  /** Data-URL transport payload sent to the model. / 发送给模型的 data URL 传输载荷。 */
  transport: AiTransportImage;
}

/**
 * Result of parsing all document attachments for one turn; owns temp directories
 * holding derived images until dispose() is called.
 * 单轮全部文档附件的解析结果；持有含派生图片的临时目录，直至调用 dispose()。
 */
export interface AssistantDocumentParseSession {
  /** Extracted body text keyed by attachment ID. / 按附件 ID 索引的正文文本。 */
  documentTextByAttachmentId: ReadonlyMap<string, string>;
  /** Derived images keyed by attachment ID. / 按附件 ID 索引的派生图片。 */
  documentImagesByAttachmentId: ReadonlyMap<string, readonly AssistantParsedDocumentImage[]>;
  /** Idempotent cleanup of owned temp directories; safe to call multiple times. / 归属临时目录的幂等清理；可安全多次调用。 */
  dispose(): void;
}

/**
 * Options controlling document parsing: cancellation, MinerU runtime, and temp roots.
 * 控制文档解析的选项：取消信号、MinerU 运行时与临时目录根。
 */
export interface AssistantDocumentParseOptions {
  signal: AbortSignal;
  /** Optional override of the Mammoth worker script path. / 可选的 Mammoth Worker 脚本路径覆盖。 */
  mammothWorkerScriptPath?: string;
  /** 仅主进程注入的 MinerU 运行时配置；明文密钥不得进入 IPC、日志或附件元数据。 MinerU runtime config injected by the main process only; plaintext keys must never enter IPC, logs, or attachment metadata. */
  mineru?: MineruRuntimeConfig;
  /** 验证脚本可替换远端调用；生产缺省使用主进程 MinerU 客户端。 Verification scripts may replace the remote call; production defaults to the main-process MinerU client. */
  mineruRunner?: (options: MineruParseOptions) => Promise<{ counts: Record<string, number> }>;
  /** 验证脚本可注入受控目录；生产缺省使用系统临时目录。 Verification scripts may inject a controlled directory; production defaults to the system temp directory. */
  tempRoot?: string;
  /** Progress callback emitting human-readable status messages. / 进度回调，推送可读状态消息。 */
  onProgress?: (message: string) => void;
}

/** Per-attachment parse outcome; ownedTempDirectory is kept only when it holds live images. / 单附件解析结果；仅当目录中仍有存活图片时才保留 ownedTempDirectory。 */
interface ParsedDocumentOutcome {
  text: string;
  images: AssistantParsedDocumentImage[];
  ownedTempDirectory?: { directory: string; tempRoot: string };
}

/**
 * Parse this turn's PDF / DOCX attachments into bounded context text. Images extracted by
 * MinerU / Mammoth are kept only for this ParseSession's lifetime; callers must dispose in
 * `finally` after reading the needed images.
 * 将本轮 PDF / DOCX 附件解析为有界上下文。MinerU / Mammoth 提取的图片只在本轮
 * ParseSession 生命周期内保留，调用方须在读取所需图片后于 finally 中 dispose。
 *
 * @param attachments - Attachment list; only `kind === 'document'` entries are parsed / 附件列表；仅解析 kind === 'document' 的项
 * @param options - Parse options: signal, MinerU config, temp root, progress callback / 解析选项：取消信号、MinerU 配置、临时根目录、进度回调
 * @returns Disposable session mapping attachment IDs to text and derived images / 可释放的会话，按附件 ID 提供文本与派生图片
 */
export async function parseAssistantDocumentAttachments(
  attachments: readonly AssistantAttachment[],
  options: AssistantDocumentParseOptions,
): Promise<AssistantDocumentParseSession> {
  const documents = attachments.filter((attachment): attachment is AssistantDocumentAttachment => attachment.kind === 'document');
  const documentTextByAttachmentId = new Map<string, string>();
  const documentImagesByAttachmentId = new Map<string, readonly AssistantParsedDocumentImage[]>();
  const ownedTempDirectories: Array<{ directory: string; tempRoot: string }> = [];
  let disposed = false;

  try {
    for (const [index, attachment] of documents.entries()) {
      throwIfAborted(options.signal);
      validateDocumentAttachment(attachment);
      options.onProgress?.(`正在解析文档附件 ${index + 1}/${documents.length}：${attachment.name}`);
      const extension = path.extname(attachment.path).toLowerCase();
      const outcome = extension === '.pdf'
        ? await parsePdfAttachment(attachment, options)
        : await parseDocxAttachment(attachment, options);
      if (outcome.ownedTempDirectory) ownedTempDirectories.push(outcome.ownedTempDirectory);
      if (!outcome.text.trim()) {
        if (extension === '.pdf') throw new Error(`PDF“${attachment.name}”没有可读取的正文。`);
        throw new Error(`DOCX“${attachment.name}”没有可读取的正文。`);
      }
      documentTextByAttachmentId.set(attachment.attachmentId, outcome.text);
      documentImagesByAttachmentId.set(attachment.attachmentId, outcome.images);
    }
  } catch (error) {
    // Roll back temp directories owned so far before propagating the failure. / 在向上抛出失败前，回滚已占用的临时目录。
    for (const owned of ownedTempDirectories) removeOwnedTempDirectory(owned.directory, owned.tempRoot);
    throw error;
  }

  return {
    documentTextByAttachmentId,
    documentImagesByAttachmentId,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const owned of ownedTempDirectories) removeOwnedTempDirectory(owned.directory, owned.tempRoot);
    },
  };
}

/**
 * Convert selected document images into VLM data URLs. Explicitly uploaded images should
 * consume the total budget first; callers pass the remaining budget via `maxTotalBytes`.
 * Out-of-budget, replaced, or hash-mismatched files are skipped.
 * 把已选中的文档图片转成 VLM data URL。显式上传图片应先占用总预算，
 * 调用方通过 maxTotalBytes 传入剩余预算；越界、被替换或哈希不匹配的文件会跳过。
 *
 * @param images - Parsed document images eligible for materialization / 可物化的解析文档图片
 * @param options - Optional caps on count/bytes and hashes already used / 可选的数量与字节上限以及已占用的哈希集合
 * @returns Materialized images with base64 data URLs, within budget / 预算内的物化图片（含 base64 data URL）
 */
export function materializeAssistantDocumentImages(
  images: readonly AssistantParsedDocumentImage[],
  options: { maxImages?: number; maxTotalBytes?: number; excludedSha256?: ReadonlySet<string> } = {},
): AssistantMaterializedDocumentImage[] {
  const maxImages = Math.max(0, Math.min(maxAssistantDerivedDocumentImages, options.maxImages ?? maxAssistantDerivedDocumentImages));
  const maxTotalBytes = Math.max(0, Math.min(maxAssistantImageTotalBytes, options.maxTotalBytes ?? maxAssistantImageTotalBytes));
  const output: AssistantMaterializedDocumentImage[] = [];
  const seenHashes = new Set(options.excludedSha256 ?? []);
  let totalBytes = 0;

  for (const image of images) {
    if (output.length >= maxImages) break;
    if (seenHashes.has(image.sha256) || image.sizeBytes <= 0 || image.sizeBytes > maxAssistantImageBytes) continue;
    if (totalBytes + image.sizeBytes > maxTotalBytes) continue;
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(image.absolutePath);
    } catch {
      continue;
    }
    // Re-verify size and content hash on read: skip files replaced or truncated since parse. / 读取时重新校验大小与内容哈希：跳过解析后被替换或截断的文件。
    if (buffer.length !== image.sizeBytes || buffer.length > maxAssistantImageBytes) continue;
    if (createHash('sha256').update(buffer).digest('hex') !== image.sha256) continue;
    output.push({
      source: image,
      transport: {
        dataUrl: `data:${image.mimeType};base64,${buffer.toString('base64')}`,
        mimeType: image.mimeType,
        name: `${image.name} ${image.placeholder}`,
      },
    });
    seenHashes.add(image.sha256);
    totalBytes += buffer.length;
  }
  return output;
}

/**
 * Compute content hashes of explicitly uploaded images so they keep priority and
 * deduplicate against PDF-derived images.
 * 计算显式上传图片的内容哈希，用于保证它们优先并与 PDF 派生图去重。
 *
 * @param images - Transport images whose data URLs are hashed / 需要哈希 data URL 的传输图片
 * @returns Set of lowercase hex SHA-256 digests of decoded image bytes / 解码后图片字节的小写十六进制 SHA-256 摘要集合
 */
export function collectAiTransportImageHashes(images: readonly AiTransportImage[]): Set<string> {
  const hashes = new Set<string>();
  for (const image of images) {
    const match = /^data:[^;,]+;base64,(.+)$/su.exec(image.dataUrl);
    if (!match) continue;
    try {
      hashes.add(createHash('sha256').update(Buffer.from(match[1]!, 'base64')).digest('hex'));
    } catch {
      // Upstream attachment validation reports invalid dataUrls; here we only deduplicate best-effort. / 上游附件校验负责报告非法 dataUrl；这里只做尽力去重。
    }
  }
  return hashes;
}

/**
 * Dispatch PDF parsing: MinerU cloud when consented, otherwise local pdf.js text extraction.
 * 分发 PDF 解析：已授权时走 MinerU 云端，否则走本地 pdf.js 文本提取。
 */
async function parsePdfAttachment(
  attachment: AssistantDocumentAttachment,
  options: AssistantDocumentParseOptions,
): Promise<ParsedDocumentOutcome> {
  const mineru = options.mineru;
  if (mineru?.cloudParsingConsent && mineru.apiKey?.trim()) {
    options.onProgress?.(`正在使用 MinerU 解析 PDF“${attachment.name}”的正文与图片…`);
    return parsePdfWithMineru(attachment, options, mineru);
  }

  try {
    const localText = await parsePdfText(attachment.path, options.signal);
    if (localText.trim()) return { text: boundDocumentText(localText), images: [] };
  } catch (error) {
    throwIfAborted(options.signal);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF“${attachment.name}”本地文本提取失败：${detail}。可在“设置 > 文档解析”中配置并授权 MinerU 后重试。`);
  }
  throw new Error(`PDF“${attachment.name}”没有可读取的文本；扫描版或需要识别图表的 PDF 请在“设置 > 文档解析”中配置并授权 MinerU。`);
}

/**
 * Extract page-tagged plain text from a PDF via pdf.js, bounded by page and character caps.
 * 通过 pdf.js 提取带页码标记的 PDF 纯文本，并受页数与字符数上限约束。
 */
async function parsePdfText(filePath: string, signal: AbortSignal): Promise<string> {
  ensurePdfJsTextExtractionGlobals();
  const { getDocument, PDFWorker } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const worker = new PDFWorker();
  const loadingTask = getDocument({ data: bytes, worker, useWorkerFetch: false, useSystemFonts: true });
  const abort = () => loadingTask.destroy();
  // Destroy the loading task on abort so pdf.js stops and releases the worker mid-parse. / 中止时销毁加载任务，使 pdf.js 停止解析并释放 Worker。
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF 页数不能超过 ${MAX_PDF_PAGES} 页。`);
    const pages: string[] = [];
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages && totalChars < MAX_DOCUMENT_TEXT_CHARS; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const value = item.str.trim();
        if (value) pageText += `${pageText && !pageText.endsWith('\n') ? ' ' : ''}${value}`;
        if (item.hasEOL && pageText && !pageText.endsWith('\n')) pageText += '\n';
      }
      const normalized = normalizeText(pageText);
      if (normalized) {
        const section = `# 第 ${pageNumber} 页\n${normalized}`;
        pages.push(section);
        totalChars += section.length + 2;
      }
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    signal.removeEventListener('abort', abort);
    await loadingTask.destroy().catch(() => undefined);
    worker.destroy();
  }
}

/**
 * PDF.js legacy display 包初始化需要 DOMMatrix / Path2D；文本提取路径不会调用绘制方法。
 * The pdf.js legacy display bundle requires DOMMatrix / Path2D at init; the text-extraction
 * path never calls drawing methods, so empty stub classes are enough.
 */
function ensurePdfJsTextExtractionGlobals(): void {
  const globals = globalThis as unknown as { DOMMatrix?: unknown; Path2D?: unknown };
  if (typeof globals.DOMMatrix === 'undefined') globals.DOMMatrix = class AssistantPdfDomMatrix {};
  if (typeof globals.Path2D === 'undefined') globals.Path2D = class AssistantPdfPath2D {};
}

/**
 * Parse a DOCX via the Mammoth worker into a temp directory and rewrite its images.
 * 通过 Mammoth Worker 将 DOCX 解析到临时目录，并改写其中的图片引用。
 */
async function parseDocxAttachment(
  attachment: AssistantDocumentAttachment,
  options: AssistantDocumentParseOptions,
): Promise<ParsedDocumentOutcome> {
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, TEMP_DIRECTORY_PREFIX));
  let keepTempDirectory = false;
  try {
    await runMammothDocxParse({
      inputPath: attachment.path,
      outputDir: tempDirectory,
      sourceName: attachment.name,
      signal: options.signal,
      ...(options.mammothWorkerScriptPath ? { workerScriptPath: options.mammothWorkerScriptPath } : {}),
    });
    throwIfAborted(options.signal);
    const markdown = normalizeText(fs.readFileSync(path.join(tempDirectory, 'document.md'), 'utf8'));
    const { text, images } = rewriteParsedDocumentImages(markdown, attachment, tempDirectory, 'DOCX');
    // Keep the temp directory only while derived images still need their files on disk. / 仅当派生图片仍需磁盘文件时才保留临时目录。
    keepTempDirectory = images.length > 0;
    return {
      text,
      images,
      ...(keepTempDirectory ? { ownedTempDirectory: { directory: tempDirectory, tempRoot } } : {}),
    };
  } finally {
    if (!keepTempDirectory) removeOwnedTempDirectory(tempDirectory, tempRoot);
  }
}

/**
 * Parse a PDF via the MinerU client into a temp directory; the directory is always kept
 * because MinerU output is treated as image-bearing until disposed.
 * 通过 MinerU 客户端将 PDF 解析到临时目录；该目录始终保留，因为 MinerU 产物视为含图片，直至释放。
 */
async function parsePdfWithMineru(
  attachment: AssistantDocumentAttachment,
  options: AssistantDocumentParseOptions,
  mineru: MineruRuntimeConfig,
): Promise<ParsedDocumentOutcome> {
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, TEMP_DIRECTORY_PREFIX));
  let keepTempDirectory = false;
  try {
    const runner = options.mineruRunner ?? runMineruPdfParse;
    await runner({
      inputPath: attachment.path,
      outputDir: tempDirectory,
      documentId: attachment.attachmentId,
      endpoint: mineru.endpoint,
      apiKey: mineru.apiKey ?? '',
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(progress.message),
    });
    throwIfAborted(options.signal);
    const markdown = normalizeText(fs.readFileSync(path.join(tempDirectory, 'document.md'), 'utf8'));
    const { text, images } = rewriteParsedDocumentImages(markdown, attachment, tempDirectory, 'PDF');
    keepTempDirectory = true;
    return {
      text,
      images,
      ownedTempDirectory: { directory: tempDirectory, tempRoot },
    };
  } finally {
    if (!keepTempDirectory) removeOwnedTempDirectory(tempDirectory, tempRoot);
  }
}

/**
 * Replace image markdown references with stable placeholders and collect image metadata
 * plus the line numbers where each placeholder occurs.
 * 将 Markdown 图片引用替换为稳定占位符，并收集图片元数据及各占位符出现的行号。
 */
function rewriteParsedDocumentImages(
  markdown: string,
  attachment: AssistantDocumentAttachment,
  tempDirectory: string,
  documentKind: 'PDF' | 'DOCX',
): { text: string; images: AssistantParsedDocumentImage[] } {
  const manifest = readParseImagesManifest(tempDirectory);
  const recordsByReference = new Map<string, ParseImageRecord>();
  for (const record of manifest?.images ?? []) {
    recordsByReference.set(normalizeImageReference(record.relativePath), record);
    if (record.origin.ref) recordsByReference.set(normalizeImageReference(record.origin.ref), record);
  }
  const drafts = new Map<string, Omit<AssistantParsedDocumentImage, 'lineNumbers'>>();
  // Handles both `![alt](<ref>)` and `![alt](ref "title")` forms; unmatched refs stay untouched. / 同时处理 `![alt](<ref>)` 与 `![alt](ref "title")` 两种写法；未匹配的引用保持原样。
  const rewritten = markdown.replace(
    /!\[([^\]]*)\]\(<([^>]*)>\)|!\[([^\]]*)\]\(([^)\s]*)(?:\s+["'][^)]*["'])?\)/gu,
    (full, angleAlt: string | undefined, angleRef: string | undefined, plainAlt: string | undefined, plainRef: string | undefined) => {
      const ref = angleRef ?? plainRef ?? '';
      const record = recordsByReference.get(normalizeImageReference(ref));
      if (!record) return full;
      const mimeType = toAssistantImageMimeType(record.mime);
      const absolutePath = resolveOwnedParseImagePath(tempDirectory, record.relativePath);
      if (!mimeType || !absolutePath) return full;
      const imageId = `${attachment.attachmentId}:${record.sha256.slice(0, 16)}`;
      const placeholder = `[[${documentKind}_IMAGE:${imageId}]]`;
      if (!drafts.has(imageId)) {
        const alt = (angleAlt ?? plainAlt ?? '').trim();
        drafts.set(imageId, {
          imageId,
          attachmentId: attachment.attachmentId,
          placeholder,
          name: alt || `${attachment.name} · ${documentKind} 图片`,
          mimeType,
          sizeBytes: record.bytes,
          sha256: record.sha256,
          absolutePath,
        });
      }
      return placeholder;
    },
  );
  const text = boundDocumentText(rewritten);
  const lines = text.split('\n');
  // Images without surviving placeholder lines (e.g. after truncation) are dropped. / 若占位符行在截断后不再出现，则丢弃对应图片。
  const images = [...drafts.values()].flatMap((draft) => {
    const lineNumbers = lines.flatMap((line, index) => line.includes(draft.placeholder) ? [index + 1] : []);
    return lineNumbers.length ? [{ ...draft, lineNumbers }] : [];
  });
  return { text, images };
}

/**
 * Normalize an image reference for manifest lookup: unify slashes, strip query/fragment,
 * and drop a leading `./` with tolerant URI decoding.
 * 规范化图片引用以便查表：统一分隔符、去掉查询串与片段，并容忍 URI 解码失败后去除 `./` 前缀。
 */
function normalizeImageReference(value: string): string {
  const withoutQuery = value.trim().replace(/\\/gu, '/').split(/[?#]/u, 1)[0] ?? '';
  try {
    return decodeURIComponent(withoutQuery).replace(/^\.\//u, '');
  } catch {
    return withoutQuery.replace(/^\.\//u, '');
  }
}

/**
 * Resolve a manifest-relative image path, rejecting anything escaping the temp directory
 * (path-traversal guard); returns undefined for missing or non-file targets.
 * 解析清单中的相对图片路径，拒绝任何逃逸出临时目录的路径（路径穿越防护）；目标缺失或非文件时返回 undefined。
 */
function resolveOwnedParseImagePath(tempDirectory: string, relativePath: string): string | undefined {
  const root = path.resolve(tempDirectory);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  try {
    return fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Narrow a MIME string to the image types the VLM transport accepts. / 将 MIME 字符串收窄为 VLM 传输接受的图片类型。 */
function toAssistantImageMimeType(value: string): AssistantImageMimeType | undefined {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp') return value;
  return undefined;
}

/**
 * Validate extension, file type, and size of a document attachment before parsing.
 * 解析前校验文档附件的扩展名、文件类型与大小。
 */
function validateDocumentAttachment(attachment: AssistantDocumentAttachment): void {
  const resolvedPath = path.resolve(attachment.path);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!assistantDocumentExtensions.has(extension)) throw new Error(`不支持的文档附件类型：${extension || '未知'}。`);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error(`文档附件“${attachment.name}”不是文件。`);
  if (stat.size > maxAssistantDocumentBytes) throw new Error(`文档附件“${attachment.name}”不能超过 ${Math.floor(maxAssistantDocumentBytes / 1_000_000)} MB。`);
}

/**
 * Normalize text and cap it at the per-turn character budget with a truncation marker.
 * 规范化文本并按单轮字符预算截断，附带截断标记。
 */
function boundDocumentText(value: string): string {
  const normalized = normalizeText(value);
  if (normalized.length <= MAX_DOCUMENT_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\n\n[文档正文已按单轮上限截断]`;
}

/** Unify line endings, trim trailing spaces, and collapse excessive blank lines. / 统一换行、去除行尾空白并压缩过多空行。 */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim();
}

/** Throw an AbortError when the parse signal has been cancelled. / 解析信号已取消时抛出 AbortError。 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('文档附件解析已取消。', 'AbortError');
}

/**
 * Delete an owned temp directory only when it sits directly under the temp root with the
 * expected prefix, so cleanup can never touch arbitrary paths.
 * 仅当目录直接位于临时根下且带有预期前缀时才删除，确保清理不会误删任意路径。
 */
function removeOwnedTempDirectory(directory: string, tempRoot: string): void {
  const resolved = path.resolve(directory);
  const resolvedTempRoot = path.resolve(tempRoot);
  // Double-check parent and prefix before deletion; skip silently on mismatch. / 删除前二次校验父目录与前缀；不匹配则静默跳过。
  if (path.dirname(resolved) !== resolvedTempRoot || !path.basename(resolved).startsWith(TEMP_DIRECTORY_PREFIX)) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}
