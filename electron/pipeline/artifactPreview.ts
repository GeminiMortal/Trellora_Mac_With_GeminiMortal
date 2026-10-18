/**
 * Stage artifact preview: streamed line-level reading of JSONL/JSON stage outputs
 * with pagination, integrity verification, and optional parent-chunk filtering.
 * 阶段产物预览：以流式逐行方式读取 JSONL/JSON 阶段产物，支持分页、完整性校验和可选的父块过滤。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import type { PipelineArtifactPreview, PipelineArtifactPreviewRow, PipelineStageId } from './types.ts';

const MAX_PREVIEW_ROWS = 100;
const MAX_PREVIEW_OFFSET = 10_000_000;

/**
 * Parameters needed to locate, verify, and read a specific stage artifact.
 * 定位、校验并读取特定阶段产物所需的参数。
 */
export interface ArtifactPreviewReadOptions {
  /** Document identifier / 文档标识 */
  documentId: string;
  /** Pipeline stage that produced the artifact / 产出该产物的流水线阶段 */
  stage: PipelineStageId;
  /** Original file name of the artifact / 产物原始文件名 */
  fileName: string;
  /** Path relative to the library root / 相对于资料库根目录的路径 */
  relativePath: string;
  /** Expected byte size for integrity check / 用于完整性校验的预期字节大小 */
  bytes: number;
  /** Expected SHA-256 hex hash for integrity check / 用于完整性校验的预期 SHA-256 十六进制哈希 */
  sha256: string;
  /** Zero-based line offset for pagination / 分页用的从零开始的行偏移 */
  offset?: number;
  /** Maximum number of lines to return / 最多返回的行数 */
  limit?: number;
  /** When set, filter lines belonging to this parent chunk / 设置后只返回属于该父块的行 */
  parentChunkId?: string;
}

/**
 * Clamp offset and limit into safe preview ranges (0–MAX_PREVIEW_OFFSET and 10–MAX_PREVIEW_ROWS).
 * 将 offset 和 limit 夹取到安全预览区间（0–MAX_PREVIEW_OFFSET 与 10–MAX_PREVIEW_ROWS）。
 *
 * @param offset - Raw offset value from IPC / 来自 IPC 的原始偏移值
 * @param limit - Raw limit value from IPC / 来自 IPC 的原始限制值
 * @returns Clamped offset and limit / 夹取后的 offset 与 limit
 */
export function normalizeArtifactPreviewWindow(offset: unknown, limit: unknown): { offset: number; limit: number } {
  const normalizedOffset = Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0;
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 40;
  return {
    offset: Math.max(0, Math.min(MAX_PREVIEW_OFFSET, normalizedOffset)),
    limit: Math.max(10, Math.min(MAX_PREVIEW_ROWS, normalizedLimit)),
  };
}

/**
 * Validate and return a parent chunk ID in the expected 'p-NNNNNN' format.
 * 校验并返回符合 'p-NNNNNN' 格式的父块标识。
 *
 * @param value - Raw value from IPC; undefined/null/empty → no filter / 来自 IPC 的原始值；undefined/null/empty 表示不过滤
 * @returns Validated parent chunk ID, or undefined when not filtering / 校验后的父块标识；不过滤时返回 undefined
 */
export function normalizeArtifactPreviewParentChunkId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^p-\d{6}$/.test(value)) {
    throw new Error('父块标识无效。');
  }
  return value;
}

/**
 * A manifest is the authority for previewable artifacts. Checking the hash
 * immediately before streaming prevents a same-size replacement from being
 * presented as a valid Parent/Child artifact.
 * 清单是可预览产物的权威来源。在流式读取前立即校验哈希，
 * 防止同尺寸替换文件被错误展示为有效的父/子产物。
 *
 * @param filePath - Absolute path to the artifact file / 产物文件的绝对路径
 * @param expected - Expected bytes and sha256 from the manifest / 来自清单的预期字节数与 SHA-256 哈希
 */
export async function assertArtifactPreviewIntegrity(filePath: string, expected: Pick<ArtifactPreviewReadOptions, 'bytes' | 'sha256'>): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error('阶段产物文件不存在，可能需要重新处理该阶段。');
  }
  if (!stat.isFile()) throw new Error('阶段产物不是可预览的普通文件。');
  if (stat.size !== expected.bytes) throw new Error('阶段产物大小已变化，缓存校验未通过，请重新处理该阶段。');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) {
    throw new Error('阶段产物哈希已变化，缓存校验未通过，请重新处理该阶段。');
  }
}

/**
 * Stream-read a JSONL/JSON artifact line by line with pagination and optional parent-chunk filtering.
 * The file is integrity-checked before reading begins.
 * 以流式方式逐行读取 JSONL/JSON 产物，支持分页和可选的父块过滤。读取前先进行完整性校验。
 *
 * @param filePath - Absolute path to the artifact file / 产物文件的绝对路径
 * @param options - Read parameters including pagination and integrity fields / 包含分页和完整性字段的读取参数
 * @returns Preview result with rows, pagination metadata and line counts / 预览结果，包含行数据、分页元数据和行计数
 */
export async function readArtifactPreview(filePath: string, options: ArtifactPreviewReadOptions): Promise<PipelineArtifactPreview> {
  await assertArtifactPreviewIntegrity(filePath, options);
  const window = normalizeArtifactPreviewWindow(options.offset, options.limit);
  const rows: PipelineArtifactPreviewRow[] = [];
  let sourceLineNumber = 0;
  let lineCount = 0;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      sourceLineNumber += 1;
      if (options.parentChunkId && !belongsToParentChunk(line, options.parentChunkId)) continue;
      lineCount += 1;
      if (lineCount > window.offset && rows.length < window.limit) {
        rows.push({ lineNumber: sourceLineNumber, text: line });
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return {
    documentId: options.documentId,
    stage: options.stage,
    fileName: options.fileName,
    relativePath: options.relativePath,
    bytes: options.bytes,
    sha256: options.sha256,
    offset: window.offset,
    limit: window.limit,
    lineCount,
    hasMore: window.offset + rows.length < lineCount,
    rows,
  };
}

/**
 * Predicate: does a JSONL line's `parentChunkId` field match the requested chunk?
 * 判断 JSONL 行的 `parentChunkId` 字段是否与请求的块标识匹配。
 */
function belongsToParentChunk(line: string, parentChunkId: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && (value as Record<string, unknown>).parentChunkId === parentChunkId;
  } catch {
    return false;
  }
}
