/**
 * Provides bounded, main-process-only attachment context: metadata listing, keyword search, line-range reads, and document image selection for assistant turns.
 * 提供主进程内部的有界附件上下文：元数据列表、关键词检索、行范围读取以及文档图片选择，供助手回合使用。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssistantAttachment, AssistantImageMimeType } from '../assistant/assistantTurnTypes.ts';
import type { AssistantParsedDocumentImage } from '../assistant/assistantDocumentAttachmentParser.ts';
import {
  assistantDocumentExtensions,
  assistantTextExtensions,
  maxAssistantAttachmentBytes,
  maxAssistantAttachmentTotalBytes,
  maxAssistantDocumentBytes,
} from '../assistant/assistantTurnTypes.ts';

const MAX_RANGE_LINES = 80;
const MAX_RANGE_CHARS = 4_000;
const MAX_SEARCH_RESULTS = 6;

/**
 * Main-process attachment record (multimodal development plan §6.3).
 * - image: registers only the dataUrl — nothing is written to disk, split into lines, or made searchable; the Transport layer consumes it via listImageAttachments.
 * - document: the document parser supplies this turn's plain text, which participates in search / readRange line by line.
 * - text: the file is read directly and split into lines, using the existing search / readRange logic.
 * 主进程内部的附件记录（多模态开发方案 §6.3）。
 * - image：仅登记 dataUrl，不落盘、不分行、不可搜索；Transport 层通过 listImageAttachments 取用。
 * - document：由文档解析器提供本轮纯文本，按行参与 search / readRange。
 * - text：直接读文件、按行切分，走现有 search / readRange 逻辑。
 */
interface AttachmentRecord {
  kind: 'image' | 'document' | 'text';
  attachmentId: string;
  /** Image attachments use the `image://<attachmentId>` pseudo-path; document/text attachments use the resolved absolute path. 图片附件为 `image://<attachmentId>` 伪路径；文档/文本为真实解析后的绝对路径。 */
  path: string;
  name: string;
  /** Empty string for image attachments (no extension semantics). 图片附件为空字符串（无扩展名语义）。 */
  extension: string;
  mimeType: string;
  sizeBytes: number;
  /** Empty string for image/placeholder document attachments (excluded from content hashing). 图片/文档占位附件为空字符串（不参与内容哈希）。 */
  sha256: string;
  /** Empty array for image/placeholder document attachments (not searchable). 图片/文档占位附件为空数组（不可搜索）。 */
  lines: string[];
  /** Present only for image attachments; the Transport layer reads it via listImageAttachments. 仅图片附件存在，Transport 层通过 listImageAttachments 读取。 */
  dataUrl?: string;
  /** Present only for document attachments; image file lifecycle remains owned by ParseSession. 仅 document 存在；图片文件仍由 ParseSession 负责生命周期。 */
  documentImages?: readonly AssistantParsedDocumentImage[];
}

/**
 * Metadata for an image attachment delivered as a multimodal payload.
 * 图片附件的元数据，以多模态载荷形式传输。
 */
export interface AssistantImageAttachmentMetadata {
  kind: 'image';
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  searchable: false;
}

/**
 * Metadata for document or text attachments that support line-based search and range reads.
 * 支持按行搜索与范围读取的文档/文本附件元数据。
 */
export interface AssistantSearchableAttachmentMetadata {
  kind: 'document' | 'text';
  attachmentId: string;
  name: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  lineCount: number;
  /** True when document parsing or text attachment reading succeeded. 文档解析成功或文本附件读取成功时为 true。 */
  searchable: boolean;
  availableRange: { lineFrom: 1; lineTo: number };
}

/**
 * Union of image and searchable attachment metadata records.
 * 图片附件与可搜索附件元数据的联合类型。
 */
export type AssistantAttachmentMetadata =
  | AssistantImageAttachmentMetadata
  | AssistantSearchableAttachmentMetadata;

/**
 * A single attachment search hit: a scored line range inside one attachment.
 * 附件搜索命中项：某个附件内带评分的行范围。
 */
export interface AssistantAttachmentSearchHit {
  attachmentId: string;
  lineFrom: number;
  lineTo: number;
  score: number;
  /** How the hit was produced: keyword match or explicit-read fallback range. 命中来源：关键词匹配，或明确读取请求的回退范围。 */
  reason: 'query-match' | 'explicit-leading-range';
}

/**
 * Result of reading a bounded line range from a searchable attachment.
 * 从可搜索附件读取有界行范围的结果。
 */
export interface AssistantAttachmentRangeRead {
  attachmentId: string;
  name: string;
  lineFrom: number;
  lineTo: number;
  sha256: string;
  text: string;
  /** True when the requested range or text was cut by MAX_RANGE_LINES / MAX_RANGE_CHARS. 当请求范围或文本被 MAX_RANGE_LINES / MAX_RANGE_CHARS 截断时为 true。 */
  truncated: boolean;
  /** Ids of document images whose placeholders fall inside the returned text. 占位符落在返回文本内的文档图片 id。 */
  imageIds: string[];
}

/**
 * Transport-layer payload view for an image attachment (multimodal development plan §6.4).
 * 图片附件在 Transport 层的传输视图（多模态开发方案 §6.4）。
 */
export interface AssistantImageAttachmentPayload {
  attachmentId: string;
  name: string;
  mimeType: AssistantImageMimeType;
  sizeBytes: number;
  dataUrl: string;
}

/**
 * Main-process-only, bounded attachment search and range reader.
 * 仅运行于主进程的有界附件搜索与范围读取器。
 */
export class AttachmentContextProvider {
  private readonly records: AttachmentRecord[];

  /**
   * Builds attachment records from the turn's attachments, validating extensions and size limits.
   * 根据本轮附件构建附件记录，并校验扩展名与大小限制。
   *
   * @param attachments - Attachments declared for this turn / 本轮声明的附件
   * @param options - Optional parsed document text and images keyed by attachmentId / 可选的按 attachmentId 索引的已解析文档文本与图片
   */
  constructor(attachments: readonly AssistantAttachment[], options: {
    documentTextByAttachmentId?: ReadonlyMap<string, string>;
    documentImagesByAttachmentId?: ReadonlyMap<string, readonly AssistantParsedDocumentImage[]>;
  } = {}) {
    let textTotalBytes = 0;
    this.records = attachments.map((attachment) => {
      if (attachment.kind === 'image') {
        return {
          kind: 'image' as const,
          attachmentId: attachment.attachmentId,
          path: `image://${attachment.attachmentId}`,
          name: attachment.name,
          extension: '',
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sha256: '',
          lines: [],
          dataUrl: attachment.dataUrl,
        };
      }
      const attachmentPath = path.resolve(attachment.path);
      const extension = path.extname(attachmentPath).toLowerCase();
      const isDocument = attachment.kind === 'document';
      const allowedExtensions = isDocument ? assistantDocumentExtensions : assistantTextExtensions;
      if (!allowedExtensions.has(extension)) throw new Error(`不支持作为 AI 上下文的附件类型：${extension || '未知类型'}。`);
      const stat = fs.statSync(attachmentPath);
      if (!stat.isFile()) throw new Error(`AI 附件不是文件：${attachment.name}。`);
      const perFileLimit = isDocument ? maxAssistantDocumentBytes : maxAssistantAttachmentBytes;
      if (stat.size > perFileLimit) throw new Error(`AI 附件“${attachment.name}”不能超过 ${Math.floor(perFileLimit / 1_000_000)} MB。`);
      if (isDocument) {
        const content = options.documentTextByAttachmentId?.get(attachment.attachmentId)?.replace(/\r\n?/gu, '\n').trim() ?? '';
        return {
          kind: 'document' as const,
          attachmentId: attachment.attachmentId,
          path: attachmentPath,
          name: path.basename(attachmentPath),
          extension,
          mimeType: attachment.mimeType,
          sizeBytes: stat.size,
          sha256: content ? hash(content) : '',
          lines: content ? content.split('\n') : [],
          documentImages: options.documentImagesByAttachmentId?.get(attachment.attachmentId) ?? [],
        };
      }
      textTotalBytes += stat.size;
      if (textTotalBytes > maxAssistantAttachmentTotalBytes) throw new Error('AI 文本附件总大小不能超过 5 MB。');
      const content = fs.readFileSync(attachmentPath, 'utf8').replace(/\r\n?/gu, '\n');
      const sha256 = hash(content);
      return {
        kind: 'text' as const,
        attachmentId: attachment.attachmentId,
        path: attachmentPath,
        name: path.basename(attachmentPath),
        extension,
        mimeType: resolveMimeType(extension),
        sizeBytes: stat.size,
        sha256,
        lines: content.split('\n'),
      };
    });
  }

  /**
   * Lists renderer-safe metadata for every attachment.
   * 列出全部附件的渲染层安全元数据。
   *
   * @returns Metadata records in declaration order / 按声明顺序返回的元数据记录
   */
  listMetadata(): AssistantAttachmentMetadata[] {
    return this.records.map((record) => {
      if (record.kind === 'image') {
        return {
          kind: 'image',
          attachmentId: record.attachmentId,
          name: record.name,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          searchable: false,
        };
      }
      return {
        kind: record.kind,
        attachmentId: record.attachmentId,
        name: record.name,
        extension: record.extension,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        lineCount: record.lines.length,
        searchable: record.lines.length > 0,
        availableRange: { lineFrom: 1, lineTo: Math.max(record.lines.length, 1) },
      };
    });
  }

  /**
   * Returns the dataUrl and metadata of every image attachment for the Transport layer (multimodal plan §6.4).
   * 供 Transport 层取用（多模态开发方案 §6.4）：返回本轮所有图片附件的 dataUrl 与元信息。
   *
   * @returns Image payloads for attachments that carry a dataUrl / 携带 dataUrl 的图片附件载荷
   */
  listImageAttachments(): AssistantImageAttachmentPayload[] {
    return this.records
      .filter((record): record is AttachmentRecord & { kind: 'image'; dataUrl: string } => record.kind === 'image' && typeof record.dataUrl === 'string')
      .map((record) => ({
        attachmentId: record.attachmentId,
        name: record.name,
        mimeType: record.mimeType as AssistantImageMimeType,
        sizeBytes: record.sizeBytes,
        dataUrl: record.dataUrl,
      }));
  }

  /**
   * Reads one image attachment's dataUrl by attachmentId (optional Transport-layer use).
   * 按 attachmentId 取单张图片的 dataUrl（Transport 层可选用）。
   *
   * @param attachmentId - Attachment id to look up / 要查找的附件标识
   * @returns The dataUrl, or undefined when missing or not an image / dataUrl；不存在或非图片时返回 undefined
   */
  readImageDataUrl(attachmentId: string): string | undefined {
    const record = this.records.find((candidate) => candidate.attachmentId === attachmentId && candidate.kind === 'image');
    return record?.dataUrl;
  }

  /**
   * Scores searchable attachment lines against query terms and returns non-overlapping hit ranges.
   * 按查询词对可搜索附件行打分，返回互不重叠的命中范围。
   *
   * @param query - Natural-language query / 自然语言查询
   * @param maximumResults - Maximum hits to return (1-20, default 6) / 最多返回的命中数（1-20，默认 6）
   * @returns Ranked hits, or explicit leading ranges when the query requests attachment reads / 排序后的命中；当查询明确要求读取附件时返回显式起始范围
   */
  search(query: string, maximumResults = MAX_SEARCH_RESULTS): AssistantAttachmentSearchHit[] {
    if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 20) throw new Error('附件搜索结果上限无效。');
    const terms = extractQueryTerms(query);
    const searchableRecords = this.records.filter((record) => record.lines.length > 0);
    const hits: AssistantAttachmentSearchHit[] = [];
    for (const record of searchableRecords) {
      const scoredLines = record.lines
        .map((line, index) => ({ index, score: scoreLine(line, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);
      const selected: Array<{ from: number; to: number }> = [];
      // Expand each hit line into a context window and skip overlapping ranges (at most two per attachment).
      // 将命中行扩展为上下文窗口，并跳过重叠区间（每个附件最多两段）。
      for (const entry of scoredLines) {
        const from = Math.max(1, entry.index + 1 - 12);
        const to = Math.min(record.lines.length, entry.index + 1 + 20);
        if (selected.some((range) => from <= range.to && to >= range.from)) continue;
        selected.push({ from, to });
        hits.push({ attachmentId: record.attachmentId, lineFrom: from, lineTo: to, score: entry.score, reason: 'query-match' });
        if (selected.length >= 2) break;
      }
    }
    const ranked = hits.sort((left, right) => right.score - left.score || left.attachmentId.localeCompare(right.attachmentId));
    if (ranked.length) return ranked.slice(0, maximumResults);
    // When keyword search finds nothing but the query explicitly asks for attachments, fall back to leading lines.
    // 关键词无命中但查询明确要求读取附件时，回退返回各附件的起始行范围。
    if (!isExplicitAttachmentReadRequest(query)) return [];
    return searchableRecords.slice(0, maximumResults).map((record) => ({
      attachmentId: record.attachmentId,
      lineFrom: 1,
      lineTo: Math.min(record.lines.length, MAX_RANGE_LINES),
      score: 1,
      reason: 'explicit-leading-range' as const,
    }));
  }

  /**
   * Reads a bounded line range from a searchable attachment, along with document image ids covered by the text.
   * 从可搜索附件读取有界的行范围，并附带正文覆盖到的文档图片 id。
   *
   * @param input - Attachment id and 1-based inclusive line range / 附件标识与 1 基闭区间行范围
   * @returns The clipped text with truncation flags and covered image ids / 裁剪后的文本、截断标记与覆盖到的图片 id
   */
  readRange(input: { attachmentId: string; lineFrom: number; lineTo: number }): AssistantAttachmentRangeRead {
    const record = this.records.find((candidate) => candidate.attachmentId === input.attachmentId);
    if (!record) throw new Error('附件范围读取标识无效。');
    if (record.kind === 'image') throw new Error('图片附件不支持范围读取。');
    if (!record.lines.length) throw new Error('该附件当前不可搜索（尚未解析）。');
    if (!Number.isSafeInteger(input.lineFrom) || !Number.isSafeInteger(input.lineTo)
      || input.lineFrom < 1 || input.lineTo < input.lineFrom || input.lineTo > record.lines.length) {
      throw new Error('附件范围读取行号无效。');
    }
    const boundedTo = Math.min(input.lineTo, input.lineFrom + MAX_RANGE_LINES - 1);
    const raw = record.lines.slice(input.lineFrom - 1, boundedTo).join('\n');
    const text = raw.slice(0, MAX_RANGE_CHARS);
    const imageIds = (record.documentImages ?? [])
      // Keep document images whose placeholders both lie in the requested lines and still appear in the returned text.
      // 保留占位符同时落在请求行内且仍出现在返回文本中的文档图片。
      .filter((image) => image.lineNumbers.some((lineNumber) => lineNumber >= input.lineFrom && lineNumber <= boundedTo)
        && text.includes(image.placeholder))
      .map((image) => image.imageId);
    return {
      attachmentId: record.attachmentId,
      name: record.name,
      lineFrom: input.lineFrom,
      lineTo: boundedTo,
      sha256: record.sha256,
      text,
      truncated: boundedTo < input.lineTo || text.length < raw.length,
      imageIds,
    };
  }

  /**
   * Selects document images that intersect or sit near this turn's hit ranges; when the user explicitly asks for visuals but no image falls in range, the first images in document order are added as fallback. Only metadata is returned; file reading stays with the parser until dispose.
   * 选择和本轮命中范围直接相交或邻近的文档图片；若用户明确要求看图但范围中没有
   * 图片，则按文档顺序补首图。仅返回元数据，文件读取仍由解析器在 dispose 前完成。
   *
   * @param reads - Range reads already performed this turn / 本轮已完成的范围读取
   * @param query - Original user query used to detect explicit visual requests / 用于判断明确看图意图的原始用户查询
   * @param maximumResults - Maximum images to return (0-20, default 4) / 最多返回的图片数（0-20，默认 4）
   * @returns Selected document images ordered by score then document position / 按评分与文档位置选出的文档图片
   */
  selectDocumentImages(
    reads: readonly AssistantAttachmentRangeRead[],
    query: string,
    maximumResults = 4,
  ): AssistantParsedDocumentImage[] {
    if (!Number.isSafeInteger(maximumResults) || maximumResults < 0 || maximumResults > 20) throw new Error('文档图片结果上限无效。');
    if (maximumResults === 0) return [];
    const readsByAttachment = new Map<string, AssistantAttachmentRangeRead[]>();
    for (const read of reads) {
      const values = readsByAttachment.get(read.attachmentId) ?? [];
      values.push(read);
      readsByAttachment.set(read.attachmentId, values);
    }
    const visualRequest = isExplicitDocumentVisualRequest(query);
    const proximityCandidates = this.records.flatMap((record) => {
      if (record.kind !== 'document' || !record.documentImages?.length) return [];
      const ranges = readsByAttachment.get(record.attachmentId) ?? [];
      return record.documentImages.flatMap((image) => {
        let score = 0;
        // Direct placeholder hits dominate; nearby lines score by proximity within a 12-line window.
        // 直接命中占位符优先；邻近行按 12 行窗口内的距离计分。
        for (const range of ranges) {
          if (range.imageIds.includes(image.imageId)) score = Math.max(score, 10_000);
          const distance = Math.min(...image.lineNumbers.map((lineNumber) => lineDistance(lineNumber, range.lineFrom, range.lineTo)));
          if (distance <= 12) score = Math.max(score, 1_000 - distance);
        }
        return score > 0 ? [{ image, score, firstLine: image.lineNumbers[0] ?? Number.MAX_SAFE_INTEGER }] : [];
      });
    });
    // When visuals are explicitly requested, backfill images in document order even if the read ranges cover no placeholders.
    // This covers both "images late in the document" and natural phrasings that produced no text keyword hits.
    // 明确看图时，即使已读取的文本范围没有覆盖图片占位符，也应按文档顺序补图。
    // 这既覆盖"图片在文档后半段"，也覆盖自然问法没有产生文本关键词命中的情况。
    const candidates = proximityCandidates.length || !visualRequest
      ? proximityCandidates
      : this.records.flatMap((record) => record.kind === 'document'
        ? (record.documentImages ?? []).map((image) => ({
          image,
          score: 10,
          firstLine: image.lineNumbers[0] ?? Number.MAX_SAFE_INTEGER,
        }))
        : []);
    const seenHashes = new Set<string>();
    // Deduplicate identical image payloads by content hash while preserving score order.
    // 按内容哈希去重相同图片载荷，同时保持评分顺序。
    const output: AssistantParsedDocumentImage[] = [];
    for (const candidate of candidates.sort((left, right) => right.score - left.score
      || left.firstLine - right.firstLine
      || left.image.imageId.localeCompare(right.image.imageId))) {
      if (seenHashes.has(candidate.image.sha256)) continue;
      seenHashes.add(candidate.image.sha256);
      output.push(candidate.image);
      if (output.length >= maximumResults) break;
    }
    return output;
  }

  /**
   * Resolves the stored path for an attachment (image pseudo-path or real file path).
   * 解析附件的存储路径（图片伪路径或真实文件路径）。
   *
   * @param attachmentId - Attachment id to resolve / 要解析的附件标识
   * @returns The record path / 记录中的路径
   */
  resolveLocalPath(attachmentId: string): string {
    const record = this.records.find((candidate) => candidate.attachmentId === attachmentId);
    if (!record) throw new Error('附件标识无效。');
    return record.path;
  }
}

/**
 * Renders attachment metadata as plain-text lines for prompt inclusion.
 * 将附件元数据渲染为可写入 Prompt 的纯文本行。
 *
 * @param metadata - Metadata to render / 要渲染的元数据
 * @returns Multi-line metadata text / 多行元数据文本
 */
export function renderAttachmentMetadata(metadata: AssistantAttachmentMetadata): string {
  if (metadata.kind === 'image') {
    return [
    '[附件元数据 · 图片]',
      `attachmentId=${metadata.attachmentId}`,
      `name=${metadata.name}`,
      `type=${metadata.mimeType}`,
      `bytes=${metadata.sizeBytes}`,
      'searchable=false',
      'delivery=multimodal-image',
    ].join('\n');
  }
  const lines = [
    '[附件元数据 · 正文未展开]',
    `attachmentId=${metadata.attachmentId}`,
    `name=${metadata.name}`,
    `type=${metadata.mimeType}`,
    `bytes=${metadata.sizeBytes}`,
    `searchable=${metadata.searchable}`,
  ];
  if (metadata.sha256) lines.push(`sha256=${metadata.sha256}`);
  if (metadata.searchable) lines.push(`availableRange=L${metadata.availableRange.lineFrom}-L${metadata.availableRange.lineTo}`);
  else lines.push('note=该附件类型在当前版本尚未接入解析流水线，正文暂不可用。');
  return lines.join('\n');
}

/**
 * Renders a range read as plain-text lines, inserting document image ids before the body when present.
 * 将范围读取渲染为纯文本行；存在文档图片时在正文前插入图片 id。
 *
 * @param read - Range read result / 范围读取结果
 * @returns Multi-line range text / 多行范围文本
 */
export function renderAttachmentRange(read: AssistantAttachmentRangeRead): string {
  const lines = [
    '[附件范围读取]',
    `attachmentId=${read.attachmentId}`,
    `range=L${read.lineFrom}-L${read.lineTo}`,
    `sha256=${read.sha256}`,
    read.text,
  ];
  if (read.imageIds.length) lines.splice(4, 0, `documentImageIds=${read.imageIds.join(',')}`);
  return lines.join('\n');
}

/**
 * Binds the VLM image order to stable placeholders in the body so the model does not mismatch images and sections.
 * 将 VLM 图片顺序与正文中的稳定占位符绑定，避免模型把图和章节错配。
 *
 * @param images - Document images in visual-input order / 按视觉输入顺序排列的文档图片
 * @param explicitImageCount - Number of explicit image inputs already sent before these / 在这些图片之前已发送的显式图片输入数量
 * @returns Instruction text binding visual inputs to placeholders / 将视觉输入与占位符绑定的说明文本
 */
export function renderDocumentImageTransportIndex(
  images: readonly AssistantParsedDocumentImage[],
  explicitImageCount = 0,
): string {
  return [
    '[文档图片视觉输入索引]',
    ...images.map((image, index) => `视觉输入第 ${explicitImageCount + index + 1} 张=${image.placeholder}；来源附件=${image.attachmentId}`),
    '请把视觉输入与正文中的同名占位符结合理解；解析器生成的图注与周边文本只作为辅助，图片内容以视觉输入为准。',
  ].join('\n');
}

/** Normalizes a query into search terms, adding 2-char CJK bigrams for long Han segments. 将查询规范化为检索词，并为较长的 Han 片段补充二元词组。 */
function extractQueryTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase('zh-Hans-CN').replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim();
  const output = new Set<string>();
  for (const segment of normalized.split(/\s+/u).filter(Boolean)) {
    if (segment.length <= 16) output.add(segment);
    if (/\p{Script=Han}/u.test(segment) && segment.length > 4) {
      for (let index = 0; index < segment.length - 1; index += 1) output.add(segment.slice(index, index + 2));
    }
  }
  return [...output].filter((term) => term.length >= 2).slice(0, 48);
}

/** Scores a line by summing min(8, term.length) for each matched query term. 对每行按命中的查询词累加 min(8, term.length) 计分。 */
function scoreLine(line: string, terms: readonly string[]): number {
  const normalized = line.toLocaleLowerCase('zh-Hans-CN');
  return terms.reduce((score, term) => score + (normalized.includes(term) ? Math.min(8, term.length) : 0), 0);
}

/** Returns true when the query contains attachment keywords AND inspection intent. 当查询同时包含附件关键词和审查意图时返回 true。 */
function isExplicitAttachmentReadRequest(query: string): boolean {
  return /(附件|文件|文档|PDF|DOCX|Word|图|图片|图表|流程图|示意图|截图|插图|照片)/iu.test(query)
    && hasInspectionIntent(query);
}

/** Returns true when the query contains visual/image keywords AND inspection intent. 当查询同时包含视觉/图片关键词和审查意图时返回 true。 */
function isExplicitDocumentVisualRequest(query: string): boolean {
  return /(图|图片|图表|流程图|示意图|截图|插图|照片|视觉|PDF)/iu.test(query)
    && hasInspectionIntent(query);
}

/** Returns true when the query contains intent words (e.g. "analyze", "what is") indicating a read request. 当查询包含意图词（如"分析"、"是什么"）表示希望读取内容时返回 true。 */
function hasInspectionIntent(query: string): boolean {
  return /(总结|概括|阅读|读取|分析|内容|说明|看|识别|解释|描述|提取|判断|理解|含义|意思|作用|用途|主题|是什么|是啥|什么|啥|有何|有哪些|有什么|有啥|哪(?:个|些|张|幅)|如何|怎么|怎样|为何|为什么|吗|呢|[?？])/iu.test(query);
}

function lineDistance(lineNumber: number, from: number, to: number): number {
  if (lineNumber < from) return from - lineNumber;
  if (lineNumber > to) return lineNumber - to;
  return 0;
}

function resolveMimeType(extension: string): string {
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (extension === '.csv') return 'text/csv';
  if (extension === '.json') return 'application/json';
  if (extension === '.yaml' || extension === '.yml') return 'application/yaml';
  if (extension === '.xml') return 'application/xml';
  if (extension === '.html' || extension === '.htm') return 'text/html';
  return 'text/plain';
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
