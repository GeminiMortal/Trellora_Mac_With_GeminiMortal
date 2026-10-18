/**
 * Pipeline directory layout: computes the per-document artifact tree under .menghan-meta and its cache fingerprint.
 * 流水线目录布局：计算 .menghan-meta 下按文档组织的阶段产物目录树及其缓存指纹。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../library/materialsLibrary.ts';
import { resolveParsingRoute } from './routes.ts';
import { pipelineChunkingV2Enabled } from './chunkingConfig.ts';
import type { ParsingRoute } from './types.ts';

/**
 * Resolved on-disk layout and cache key inputs for one document pipeline run.
 * 单文档流水线运行的磁盘布局与缓存键输入。
 */
export interface PipelineLayout {
  /** Absolute library root / 资料库绝对根路径 */
  libraryPath: string;
  /** Document id / 文档 ID */
  documentId: string;
  /** Source document metadata / 源文档元数据 */
  document: MaterialsDocument;
  /** Root directory of this document's artifacts / 本文档产物根目录 */
  documentRoot: string;
  /** Cache fingerprint covering document, route and engine / 覆盖文档、路由与引擎的缓存指纹 */
  pipelineFingerprint: string;
  /** Parsing route / 解析路由 */
  route: ParsingRoute;
  /** Engine identifier embedded in the fingerprint / 计入指纹的引擎标识 */
  engine: string;
  /** Manifest file path / 清单文件路径 */
  manifestPath: string;
  /** Stage output directories / 各阶段输出目录 */
  parseDirectory: string;
  /** Lines stage directory / 逻辑行阶段目录 */
  linesDirectory: string;
  /** Signals stage directory / 信号阶段目录 */
  signalsDirectory: string;
  /** Ambiguity stage directory / 歧义阶段目录 */
  ambiguityDirectory: string;
  /** Structure tree stage directory / 结构树阶段目录 */
  treeDirectory: string;
  /** Chunks stage directory / 切块阶段目录 */
  chunksDirectory: string;
  /** Keywords stage directory / 关键词阶段目录 */
  keywordsDirectory: string;
  /** Vectors stage directory / 向量阶段目录 */
  vectorsDirectory: string;
  /** Entities stage directory / 实体阶段目录 */
  entitiesDirectory: string;
  /** Checkpoint directory / 检查点目录 */
  checkpointDirectory: string;
  /** Ambiguity config hash / 歧义配置哈希 */
  ambiguityConfigHash: string;
  /** Structure config hash / 结构配置哈希 */
  structureConfigHash: string;
  /** Chunking config hash / 切块配置哈希 */
  chunkingConfigHash: string;
  /** Whether chunking v2 is active / 是否启用切块 v2 */
  chunkingV2Enabled: boolean;
  /** Keyword config hash / 关键词配置哈希 */
  keywordConfigHash: string;
  /** Locked vector profile hash / 锁定向量配置哈希 */
  vectorProfileHash: string;
  /** Entities config hash / 实体配置哈希 */
  entitiesConfigHash: string;
}

/**
 * Returns the pipeline artifact root inside a library's metadata directory.
 * 返回资料库元数据目录内的流水线产物根路径。
 *
 * @param libraryPath - Library root path / 资料库根路径
 * @returns Absolute path to .menghan-meta/pipeline / .menghan-meta/pipeline 的绝对路径
 */
export function pipelineRoot(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta', 'pipeline');
}

/**
 * Builds the full layout for a document, deriving engine id and cache fingerprint.
 * 为文档构建完整布局，并推导引擎标识与缓存指纹。
 *
 * @param libraryPath - Library root path / 资料库根路径
 * @param document - Source document metadata / 源文档元数据
 * @param mineruEndpoint - MinerU endpoint used for PDF parsing / PDF 解析使用的 MinerU 端点
 * @param ambiguityConfigHash - Ambiguity config hash / 歧义配置哈希
 * @param structureConfigHash - Structure config hash / 结构配置哈希
 * @param keywordConfigHash - Keyword config hash / 关键词配置哈希
 * @param chunkingConfigHash - Chunking config hash / 切块配置哈希
 * @param chunkingV2Enabled - Whether chunking v2 is active / 是否启用切块 v2
 * @param vectorProfileHash - Locked vector profile hash / 锁定向量配置哈希
 * @param entitiesConfigHash - Entities config hash / 实体配置哈希
 * @returns Fully resolved pipeline layout / 完整解析出的流水线布局
 */
export function createPipelineLayout(libraryPath: string, document: MaterialsDocument, mineruEndpoint = '', ambiguityConfigHash = 'disabled', structureConfigHash = 'default', keywordConfigHash = 'default', chunkingConfigHash = 'disabled', chunkingV2Enabled = pipelineChunkingV2Enabled(), vectorProfileHash = 'UNBOUND', entitiesConfigHash = 'disabled'): PipelineLayout {
  const root = pipelineRoot(libraryPath);
  const route = resolveParsingRoute(document.extension);
  const engine = route === 'direct'
    ? 'direct-p4'
    : route === 'mineru'
      ? 'mineru-v4-p4'
      : route === 'mammoth'
        ? 'mammoth-1.12.1-p1'
        : 'unsupported-v1';
  const fingerprint = hashValue({
    documentId: document.id,
    extension: document.extension,
    route,
    engine,
    // Endpoint changes invalidate only the MinerU parse cache. The secret is
    // intentionally excluded so changing a key does not create duplicate
    // copies of the same local artifact.
    // 端点变化只使 MinerU 解析缓存失效。刻意排除密钥，避免更换密钥导致
    // 同一本地产物出现重复副本。
    ...(route === 'mineru' ? { mineruEndpoint: mineruEndpoint || 'https://mineru.net/api/v4' } : {}),
    protocolVersion: 1,
    schemaVersion: 1,
  });
  const documentRoot = path.join(root, safeSegment(document.id), safeSegment(document.contentHash), fingerprint);
  return {
    libraryPath: path.resolve(libraryPath),
    documentId: document.id,
    document,
    documentRoot,
    pipelineFingerprint: fingerprint,
    route,
    engine,
    manifestPath: path.join(documentRoot, 'pipeline-manifest.json'),
    parseDirectory: path.join(documentRoot, '01-parse'),
    linesDirectory: path.join(documentRoot, '02-lines'),
    signalsDirectory: path.join(documentRoot, '03-signals'),
    ambiguityDirectory: path.join(documentRoot, '04-ambiguity'),
    treeDirectory: path.join(documentRoot, '05-tree'),
    chunksDirectory: path.join(documentRoot, '06-chunks'),
    keywordsDirectory: path.join(documentRoot, '07-keywords'),
    vectorsDirectory: path.join(documentRoot, '08-vectors'),
    entitiesDirectory: path.join(documentRoot, '09-entities'),
    checkpointDirectory: path.join(documentRoot, 'checkpoints'),
    ambiguityConfigHash,
    structureConfigHash,
    chunkingConfigHash,
    chunkingV2Enabled,
    keywordConfigHash,
    vectorProfileHash,
    entitiesConfigHash,
  };
}

/**
 * Computes a stable SHA-256 hex hash of any JSON-serializable value.
 * 计算任意可 JSON 序列化值的稳定 SHA-256 十六进制哈希。
 *
 * @param value - Value to hash / 待哈希的值
 * @returns Hex digest / 十六进制摘要
 */
export function hashValue(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Validates a path segment to block traversal and separator injection.
 * 校验路径片段，阻止目录穿越与分隔符注入。
 *
 * @param value - Candidate path segment / 候选路径片段
 * @returns The same value when safe / 安全时原样返回
 */
export function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error('流水线路径片段无效。');
  return value;
}

/**
 * Creates the document root and writes the immutable source descriptor.
 * 创建文档根目录并写入不可变的源描述文件。
 *
 * @param layout - Pipeline layout / 流水线布局
 */
export function ensurePipelineLayout(layout: PipelineLayout): void {
  fs.mkdirSync(layout.documentRoot, { recursive: true });
  const sourceDirectory = path.join(layout.documentRoot, '00-source');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  atomicWriteJson(path.join(sourceDirectory, 'source.json'), {
    schemaVersion: 1,
    documentId: layout.document.id,
    documentName: layout.document.name,
    sourceRelativePath: layout.document.relativePath,
    sourceContentHash: layout.document.contentHash,
    sourceSizeBytes: layout.document.sizeBytes,
    route: layout.route,
    engine: layout.engine,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Writes JSON via temp file + rename so readers never observe partial writes.
 * 通过临时文件 + 重命名写入 JSON，读取方不会看到半成品内容。
 *
 * @param filePath - Destination file path / 目标文件路径
 * @param value - Value to serialize / 待序列化的值
 */
export function atomicWriteJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}
