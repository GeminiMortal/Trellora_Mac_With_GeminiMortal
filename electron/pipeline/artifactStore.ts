/**
 * Manages pipeline stage artifacts under .menghan-meta: layout preparation,
 * manifest persistence, cache-key computation, temp-directory commits with
 * atomic directory renames, and crash recovery of interrupted stages.
 * 管理 .menghan-meta 下的流水线阶段产物：目录布局准备、manifest 持久化、
 * 缓存键计算、临时目录原子改名提交，以及中断阶段的崩溃恢复。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../library/materialsLibrary.ts';
import { atomicWriteJson, createPipelineLayout, ensurePipelineLayout, pipelineRoot, safeSegment, type PipelineLayout } from './pathLayout.ts';
import { readParseImagesManifest } from './parseImages.ts';
import type { PipelineError, PipelineManifest, PipelineStageId, PipelineStageManifest, PipelineStageState } from './types.ts';
import { isMaterialVectorProjectionCurrent } from './materialVectorCoordinator.ts';

const unifiedParseOutputs = ['document.md', 'line-layout.jsonl', 'blocks.jsonl', 'parse-report.json', 'images-manifest.json'] as const;
const linesOutputs = ['lines.jsonl', 'lines-report.json'] as const;
const signalsOutputs = ['signals.jsonl', 'signal-report.json'] as const;
const ambiguityOutputs = ['ambiguity.jsonl', 'ambiguity-report.json'] as const;
const treeOutputs = ['structure.jsonl', 'structure.json', 'tree-report.json'] as const;
const legacyChunksOutputs = ['chunks.jsonl', 'chunks-report.json'] as const;
const v2ChunksOutputs = ['parents.jsonl', 'children.jsonl', 'chunks.jsonl', 'chunk-plan.json', 'chunks-report.json'] as const;
const keywordsOutputs = ['keywords.jsonl', 'keyword-report.json'] as const;
const vectorsOutputs = ['vector-report.json'] as const;
const entitiesOutputs = ['entities.jsonl', 'relations.jsonl', 'extraction-report.json'] as const;
const signalRuleVersion = 'p3-rules-7';
const stageOrder: readonly PipelineStageId[] = ['parse', 'lines', 'signals', 'ambiguity', 'tree', 'chunks', 'keywords', 'vectors', 'entities'];

/**
 * Result of committing a stage's temp directory to its final location.
 * 将阶段临时目录提交到正式位置后的结果。
 */
export interface StageCommitResult {
  /** Absolute path of the committed stage directory / 已提交阶段目录的绝对路径 */
  artifactPath: string;
  /** Hashes and sizes of the committed output files / 已提交产物文件的哈希与大小 */
  outputs: PipelineStageManifest['outputs'];
  /** Stage counters read from the stage report / 从阶段报告读取的统计计数 */
  counts: Record<string, number>;
}

/**
 * Creates and ensures the on-disk pipeline layout for a document's parse run.
 * 为文档的解析运行创建并确保磁盘上的流水线目录布局存在。
 *
 * @param libraryPath - Absolute path of the materials library root / 资料库根目录绝对路径
 * @param document - Registered materials document metadata / 已注册的资料文档元数据
 * @param mineruEndpoint - MinerU endpoint folded into the cache fingerprint / 计入缓存指纹的 MinerU 端点
 * @param ambiguityConfigHash - Ambiguity stage config hash / 消解阶段配置哈希
 * @param structureConfigHash - Structure stage config hash / 结构阶段配置哈希
 * @param keywordConfigHash - Keyword stage config hash / 关键词阶段配置哈希
 * @param chunkingConfigHash - Chunking stage config hash / 切块阶段配置哈希
 * @param chunkingV2Enabled - Whether chunking v2 output layout is used / 是否使用切块 v2 产物布局
 * @param vectorProfileHash - Bound vector profile hash / 绑定的向量配置哈希
 * @param entitiesConfigHash - Entities stage config hash / 实体阶段配置哈希
 * @returns The prepared pipeline layout / 准备好的流水线布局
 */
export function prepareParseLayout(libraryPath: string, document: MaterialsDocument, mineruEndpoint = '', ambiguityConfigHash = 'disabled', structureConfigHash = 'default', keywordConfigHash = 'default', chunkingConfigHash = 'disabled', chunkingV2Enabled?: boolean, vectorProfileHash = 'UNBOUND', entitiesConfigHash = 'disabled'): PipelineLayout {
  const layout = createPipelineLayout(libraryPath, document, mineruEndpoint, ambiguityConfigHash, structureConfigHash, keywordConfigHash, chunkingConfigHash, chunkingV2Enabled, vectorProfileHash, entitiesConfigHash);
  ensurePipelineLayout(layout);
  return layout;
}

/**
 * Returns the fixed output file names of the parse stage.
 * 返回解析阶段的固定产物文件名列表。
 *
 * @param _layout - Pipeline layout (unused; kept for a uniform signature) / 流水线布局（未使用；保持签名统一）
 * @returns Read-only list of parse output names / 解析产物名称的只读列表
 */
export function parseOutputNames(_layout: PipelineLayout): readonly string[] {
  return unifiedParseOutputs;
}

/**
 * Returns the declared output file names for a stage, honoring chunking v2.
 * 返回某个阶段声明的产物文件名列表，切块阶段按 v2 开关区分。
 *
 * @param layout - Pipeline layout holding chunking flags / 含切块开关的流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @returns Read-only list of output names / 产物名称的只读列表
 */
export function stageOutputNames(layout: PipelineLayout, stage: PipelineStageId): readonly string[] {
  if (stage === 'parse') return parseOutputNames(layout);
  if (stage === 'lines') return linesOutputs;
  if (stage === 'signals') return signalsOutputs;
  if (stage === 'ambiguity') return ambiguityOutputs;
  if (stage === 'tree') return treeOutputs;
  if (stage === 'chunks') return layout.chunkingV2Enabled ? v2ChunksOutputs : legacyChunksOutputs;
  if (stage === 'keywords') return keywordsOutputs;
  if (stage === 'entities') return entitiesOutputs;
  return vectorsOutputs;
}

/**
 * Only the stage's declared formal outputs may be previewed; manifest or temp
 * files must never be readable as material content.
 * 仅允许预览该阶段已声明的正式产物，禁止把 manifest 或临时文件作为资料内容读取。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @param fileName - Candidate file name to check / 待检查的候选文件名
 * @returns True when the name is a declared output of the stage / 当文件名属于该阶段声明产物时为 true
 */
export function isStageOutputAllowed(layout: PipelineLayout, stage: PipelineStageId, fileName: unknown): fileName is string {
  return typeof fileName === 'string' && stageOutputNames(layout, stage).includes(fileName);
}

/**
 * Returns the final artifact directory of a stage.
 * 返回某个阶段的正式产物目录。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @returns Absolute path of the stage directory / 阶段目录的绝对路径
 */
export function stageDirectory(layout: PipelineLayout, stage: PipelineStageId): string {
  if (stage === 'parse') return layout.parseDirectory;
  if (stage === 'lines') return layout.linesDirectory;
  if (stage === 'signals') return layout.signalsDirectory;
  if (stage === 'ambiguity') return layout.ambiguityDirectory;
  if (stage === 'tree') return layout.treeDirectory;
  if (stage === 'chunks') return layout.chunksDirectory;
  if (stage === 'keywords') return layout.keywordsDirectory;
  if (stage === 'entities') return layout.entitiesDirectory;
  return layout.vectorsDirectory;
}

/**
 * Reads and loosely validates the pipeline manifest from disk.
 * 从磁盘读取并宽松校验流水线 manifest。
 *
 * @param layout - Pipeline layout providing the manifest path / 提供 manifest 路径的流水线布局
 * @returns The manifest, or null when missing or malformed / manifest；缺失或损坏时为 null
 */
export function readPipelineManifest(layout: PipelineLayout): PipelineManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(layout.manifestPath, 'utf8')) as Partial<PipelineManifest>;
    if (!value || typeof value !== 'object' || !value.stages || typeof value.stages !== 'object') return null;
    return value as PipelineManifest;
  } catch {
    return null;
  }
}

/**
 * Atomically writes the pipeline manifest to disk.
 * 将流水线 manifest 原子写入磁盘。
 *
 * @param layout - Pipeline layout providing the manifest path / 提供 manifest 路径的流水线布局
 * @param manifest - Manifest content to persist / 要持久化的 manifest 内容
 */
export function writePipelineManifest(layout: PipelineLayout, manifest: PipelineManifest): void {
  atomicWriteJson(layout.manifestPath, manifest);
}

/**
 * Loads the existing manifest or creates and persists a fresh one.
 * 加载已有 manifest，不存在时创建并持久化新的 manifest。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The existing or newly created manifest / 已有或新建的 manifest
 */
export function createOrReadManifest(layout: PipelineLayout): PipelineManifest {
  const existing = readPipelineManifest(layout);
  if (existing) return existing;
  const manifest: PipelineManifest = {
    schemaVersion: 1,
    documentId: layout.document.id,
    documentName: layout.document.name,
    sourceContentHash: layout.document.contentHash,
    sourceRelativePath: layout.document.relativePath,
    route: layout.route,
    engine: layout.engine,
    protocolVersion: 1,
    pipelineFingerprint: layout.pipelineFingerprint,
    updatedAt: new Date().toISOString(),
    stages: {},
  };
  writePipelineManifest(layout, manifest);
  return manifest;
}

/**
 * Returns the manifest entry of a single stage.
 * 返回单个阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @returns The stage manifest entry, or undefined / 阶段 manifest 条目；不存在时为 undefined
 */
export function getStage(layout: PipelineLayout, stage: PipelineStageId): PipelineStageManifest | undefined {
  return readPipelineManifest(layout)?.stages[stage];
}

/**
 * Returns the parse stage manifest entry.
 * 返回解析阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The parse stage manifest entry, or undefined / 解析阶段 manifest 条目；不存在时为 undefined
 */
export function getParseStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'parse');
}

/**
 * Returns the lines stage manifest entry.
 * 返回逻辑行阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The lines stage manifest entry, or undefined / 逻辑行阶段 manifest 条目；不存在时为 undefined
 */
export function getLinesStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'lines');
}

/**
 * Returns the signals stage manifest entry.
 * 返回规则信号阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The signals stage manifest entry, or undefined / 规则信号阶段 manifest 条目；不存在时为 undefined
 */
export function getSignalsStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'signals');
}

/**
 * Returns the ambiguity stage manifest entry.
 * 返回标题候选消解阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The ambiguity stage manifest entry, or undefined / 消解阶段 manifest 条目；不存在时为 undefined
 */
export function getAmbiguityStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'ambiguity');
}

/**
 * Returns the tree stage manifest entry.
 * 返回结构树阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The tree stage manifest entry, or undefined / 结构树阶段 manifest 条目；不存在时为 undefined
 */
export function getTreeStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'tree');
}

/**
 * Returns the chunks stage manifest entry.
 * 返回切块阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The chunks stage manifest entry, or undefined / 切块阶段 manifest 条目；不存在时为 undefined
 */
export function getChunksStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'chunks');
}

/**
 * Returns the keywords stage manifest entry.
 * 返回关键词阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The keywords stage manifest entry, or undefined / 关键词阶段 manifest 条目；不存在时为 undefined
 */
export function getKeywordsStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'keywords');
}

/**
 * Returns the vectors stage manifest entry.
 * 返回向量化阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The vectors stage manifest entry, or undefined / 向量化阶段 manifest 条目；不存在时为 undefined
 */
export function getVectorsStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'vectors');
}

/**
 * Returns the entities stage manifest entry.
 * 返回实体抽取阶段的 manifest 条目。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns The entities stage manifest entry, or undefined / 实体抽取阶段 manifest 条目；不存在时为 undefined
 */
export function getEntitiesStage(layout: PipelineLayout): PipelineStageManifest | undefined {
  return getStage(layout, 'entities');
}

/**
 * Checks whether the parse stage cache is reusable without re-running.
 * 检查解析阶段缓存是否可复用而无需重跑。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns True when the parse cache is valid / 解析缓存有效时为 true
 */
export async function isParseCacheValid(layout: PipelineLayout): Promise<boolean> {
  return isStageCacheValid(layout, 'parse');
}

/**
 * Full cache validation: stage key match plus size and hash of every declared output.
 * 完整缓存校验：阶段键匹配，并核对每个声明产物的大小与哈希。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @returns True when the stage cache is valid / 阶段缓存有效时为 true
 */
export async function isStageCacheValid(layout: PipelineLayout, stage: PipelineStageId): Promise<boolean> {
  const manifestStage = getStage(layout, stage);
  if (!manifestStage) return false;
  // A RUNNING vectors stage with a matching key is treated as valid so the shared vector projection is not torn down.
  // 键一致且仍在 RUNNING 的 vectors 阶段视为有效，避免拆掉共享向量投影。
  if (stage === 'vectors' && manifestStage.status === 'RUNNING' && manifestStage.stageKey === stageKey(layout, 'vectors')) return true;
  if (manifestStage.status !== 'SUCCEEDED' || manifestStage.stageKey !== stageKey(layout, stage)) return false;
  if (!manifestStage.outputs) return false;
  for (const fileName of stageOutputNames(layout, stage)) {
    const output = manifestStage.outputs[fileName];
    if (!output) return false;
    const target = path.join(stageDirectory(layout, stage), fileName);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size !== output.bytes) return false;
      if ((await hashFile(target)).sha256 !== output.sha256) return false;
    } catch {
      return false;
    }
  }
  if (stage === 'parse' && !(await areParseImagesValid(layout))) return false;
  return true;
}

const parseImageNamePattern = /^images\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/u;

/**
 * Images are not part of the fixed output list, so they are validated one by one
 * against images-manifest.json; library-sourced copies also compare the source snapshot.
 * 图片不在固定产物清单里，单独按 images-manifest.json 逐张校验；库内来源还需比对源图快照。
 */
async function areParseImagesValid(layout: PipelineLayout): Promise<boolean> {
  const stageDir = stageDirectory(layout, 'parse');
  const manifest = readParseImagesManifest(stageDir);
  if (!manifest) return false;
  for (const record of manifest.images) {
    if (!parseImageNamePattern.test(record.relativePath)) return false;
    const target = path.join(stageDir, record.relativePath);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size !== record.bytes) return false;
      if ((await hashFile(target)).sha256 !== record.sha256) return false;
    } catch {
      return false;
    }
    const origin = record.origin;
    if (origin && origin.kind === 'library-copy' && origin.sourceRelativePath) {
      try {
        const sourceStat = fs.statSync(path.join(layout.libraryPath, origin.sourceRelativePath));
        if (sourceStat.size !== origin.sourceSizeBytes || Math.floor(sourceStat.mtimeMs) !== origin.sourceMtimeMs) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

/** 只比较 manifest 的阶段键，供同步状态读取识别“旧 SUCCEEDED”。 */
export function isStageManifestCurrent(layout: PipelineLayout, stage: PipelineStageId): boolean {
  const manifestStage = getStage(layout, stage);
  return Boolean(manifestStage && manifestStage.status === 'SUCCEEDED' && manifestStage.stageKey === stageKey(layout, stage));
}

/**
 * Returns the cache key of the parse stage.
 * 返回解析阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Parse stage cache key / 解析阶段缓存键
 */
export function parseStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'parse');
}

/**
 * Returns the cache key of the lines stage.
 * 返回逻辑行阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Lines stage cache key / 逻辑行阶段缓存键
 */
export function linesStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'lines');
}

/**
 * Returns the cache key of the signals stage.
 * 返回规则信号阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Signals stage cache key / 规则信号阶段缓存键
 */
export function signalsStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'signals');
}

/**
 * Returns the cache key of the ambiguity stage.
 * 返回标题候选消解阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Ambiguity stage cache key / 消解阶段缓存键
 */
export function ambiguityStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'ambiguity');
}

/**
 * Returns the cache key of the tree stage.
 * 返回结构树阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Tree stage cache key / 结构树阶段缓存键
 */
export function treeStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'tree');
}

/**
 * Returns the cache key of the chunks stage.
 * 返回切块阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Chunks stage cache key / 切块阶段缓存键
 */
export function chunksStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'chunks');
}

/**
 * Returns the cache key of the keywords stage.
 * 返回关键词阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Keywords stage cache key / 关键词阶段缓存键
 */
export function keywordsStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'keywords');
}

/**
 * Returns the cache key of the vectors stage.
 * 返回向量化阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Vectors stage cache key / 向量化阶段缓存键
 */
export function vectorsStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'vectors');
}

/**
 * Returns the cache key of the entities stage.
 * 返回实体抽取阶段的缓存键。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @returns Entities stage cache key / 实体抽取阶段缓存键
 */
export function entitiesStageKey(layout: PipelineLayout): string {
  return stageKey(layout, 'entities');
}

/** 文件缓存有效还不够；vectors 必须同时与锁定 profile 和 SQLite 投影事实一致。 */
export function isVectorProjectionCurrent(layout: PipelineLayout): boolean {
  const stage = getVectorsStage(layout);
  if (!stage || stage.status !== 'SUCCEEDED' || stage.stageKey !== vectorsStageKey(layout)) return false;
  const reportPath = path.join(layout.vectorsDirectory, 'vector-report.json');
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      documentId?: string;
      stageKey?: string;
      profileHash?: string;
      dimension?: number;
      distanceMetric?: string;
      counts?: { chunks?: number };
    };
    if (report.documentId !== layout.document.id
      || report.stageKey !== vectorsStageKey(layout)
      || report.profileHash !== layout.vectorProfileHash
      || report.distanceMetric !== 'cosine'
      || !Number.isInteger(report.dimension) || Number(report.dimension) <= 0) return false;
    const expectedChunks = Number(report.counts?.chunks);
    if (!Number.isInteger(expectedChunks) || expectedChunks < 0) return false;
    return isMaterialVectorProjectionCurrent({
      libraryPath: layout.libraryPath,
      documentId: layout.documentId,
      profileHash: layout.vectorProfileHash,
      expectedChunks,
    });
  } catch {
    return false;
  }
}

function stageKey(layout: PipelineLayout, stage: PipelineStageId): string {
  const inputArtifactHash = stage === 'parse'
    ? layout.document.contentHash
    : stage === 'lines' ? parseStageKey(layout)
      : stage === 'signals' ? linesStageKey(layout)
        : stage === 'ambiguity' ? signalsStageKey(layout)
          : stage === 'tree' ? ambiguityStageKey(layout)
            : stage === 'chunks' ? treeStageKey(layout)
              : stage === 'keywords' ? chunksStageKey(layout)
                : stage === 'entities' ? chunksStageKey(layout) : keywordsStageKey(layout);
  const configHash = stage === 'signals'
    ? `${layout.pipelineFingerprint}:${signalRuleVersion}`
    : stage === 'ambiguity' ? layout.ambiguityConfigHash : stage === 'chunks' ? (layout.chunkingV2Enabled ? layout.chunkingConfigHash : layout.structureConfigHash) : stage === 'keywords' ? layout.keywordConfigHash : stage === 'entities' ? layout.entitiesConfigHash : layout.pipelineFingerprint;
  const vectorProfileHash = stage === 'vectors' ? layout.vectorProfileHash : undefined;
  return crypto.createHash('sha256').update(JSON.stringify({
    sourceContentHash: layout.document.contentHash,
    stage,
    inputArtifactHash,
    configHash,
    ...(vectorProfileHash ? { vectorProfileHash } : {}),
    engineVersion: stage === 'parse'
      ? layout.engine
      : stage === 'ambiguity'
        ? 'electron-ambiguity-p4'
        : stage === 'chunks' ? (layout.chunkingV2Enabled ? 'worker-chunks-v3' : 'worker-chunks-p5')
          : stage === 'entities' ? 'worker-entities-v2'
            : stage === 'tree' || stage === 'keywords' ? `worker-${stage}-p5`
            : stage === 'vectors' ? 'electron-vectors-p1' : stage === 'lines' ? 'worker-lines-p4' : `worker-${stage}-p3`,
    protocolVersion: 1,
    schemaVersion: 1,
  })).digest('hex');
}

/**
 * 将指定阶段及其所有下游标记为待重跑，同时保留旧正式目录，等待新阶段
 * 原子提交后再由现有 orphan 清理策略处理。上游（例如 tree）不受影响。
 */
/**
 * Mark the specified stage and all downstream stages as pending re-run,
 * keeping old artifact directories until new commits replace them.
 * 将指定阶段及其所有下游标记为待重跑，保留旧正式目录，等待新阶段原子提交后再清理。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param fromStage - Stage from which to invalidate downstream / 从此阶段开始向下失效
 * @returns Updated manifest / 更新后的 manifest
 */
export function invalidateStageAndDownstream(layout: PipelineLayout, fromStage: PipelineStageId): PipelineManifest {
  const manifest = createOrReadManifest(layout);
  const startIndex = stageOrder.indexOf(fromStage);
  if (startIndex < 0) throw new Error(`未知流水线阶段：${fromStage}`);
  const now = new Date().toISOString();
  for (const stage of stageOrder.slice(startIndex)) {
    const current = manifest.stages[stage];
    if (!current && stage !== fromStage) continue;
    manifest.stages[stage] = {
      stageKey: stageKey(layout, stage),
      status: 'IDLE',
      updatedAt: now,
    };
  }
  manifest.updatedAt = now;
  writePipelineManifest(layout, manifest);
  return manifest;
}

/**
 * Update the parse stage status in the manifest.
 * 更新 manifest 中解析阶段的状态。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param status - New stage state / 新阶段状态
 * @param error - Optional error details / 可选的错误详情
 * @param jobId - Optional job identifier / 可选的任务标识
 * @returns Updated stage manifest entry / 更新后的阶段 manifest 条目
 */
export function markParseState(layout: PipelineLayout, status: PipelineStageState, error?: PipelineError, jobId?: string): PipelineStageManifest {
  return markStageState(layout, 'parse', status, error, jobId);
}

/**
 * Update the specified stage's status in the manifest.
 * 更新 manifest 中指定阶段的状态。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @param status - New stage state / 新阶段状态
 * @param error - Optional error details / 可选的错误详情
 * @param jobId - Optional job identifier / 可选的任务标识
 * @returns Updated stage manifest entry / 更新后的阶段 manifest 条目
 */
export function markStageState(layout: PipelineLayout, stage: PipelineStageId, status: PipelineStageState, error?: PipelineError, jobId?: string): PipelineStageManifest {
  const manifest = createOrReadManifest(layout);
  const now = new Date().toISOString();
  const current = manifest.stages[stage];
  const next: PipelineStageManifest = {
    stageKey: stageKey(layout, stage),
    status,
    artifactPath: current?.artifactPath,
    startedAt: status === 'RUNNING' ? now : current?.startedAt,
    finishedAt: status === 'SUCCEEDED' ? now : current?.finishedAt,
    updatedAt: now,
    counts: current?.counts,
    outputs: current?.outputs,
    ...(jobId ? { jobId } : {}),
    ...(error ? { error } : {}),
  };
  manifest.stages[stage] = next;
  manifest.updatedAt = now;
  writePipelineManifest(layout, manifest);
  return next;
}

/**
 * Create a temp directory for the parse stage.
 * 为解析阶段创建临时目录。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param jobId - Job identifier for temp directory naming / 用于临时目录命名的任务标识
 * @returns Absolute path of the created temp directory / 创建的临时目录绝对路径
 */
export function createParseTempDirectory(layout: PipelineLayout, jobId: string): string {
  return createStageTempDirectory(layout, 'parse', jobId);
}

/**
 * Create a temp directory for the given stage, reusing an existing one if present.
 * 为给定阶段创建临时目录，如已存在则复用。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @param jobId - Job identifier for temp directory naming / 用于临时目录命名的任务标识
 * @returns Absolute path of the temp directory / 临时目录绝对路径
 */
export function createStageTempDirectory(layout: PipelineLayout, stage: PipelineStageId, jobId: string): string {
  const existing = findStageTempDirectory(layout, stage);
  if (existing) return existing;
  const directory = path.join(layout.documentRoot, `.${stageDirectoryName(stage)}.tmp-${jobId}`);
  fs.mkdirSync(directory, { recursive: false });
  return directory;
}

/**
 * Find the most recent temp directory for the given stage (by lexicographic sort of job ID).
 * 查找给定阶段最近的临时目录（按任务标识字典序排序）。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @returns Absolute path of the most recent temp directory, or null / 最近临时目录的绝对路径；不存在时为 null
 */
export function findStageTempDirectory(layout: PipelineLayout, stage: PipelineStageId): string | null {
  if (!fs.existsSync(layout.documentRoot)) return null;
  const prefix = `.${stageDirectoryName(stage)}.tmp-`;
  const candidates = fs.readdirSync(layout.documentRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(layout.documentRoot, entry.name))
    .sort()
    .reverse();
  return candidates[0] ?? null;
}

/**
 * Commit the parse stage's temp directory to its final location.
 * 将解析阶段的临时目录提交到正式位置。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param tempDirectory - Absolute path of the temp directory to commit / 要提交的临时目录绝对路径
 * @returns Commit result with artifact path, outputs, and counts / 提交结果，含产物路径、输出和统计
 */
export async function commitParseStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'parse', tempDirectory);
}

/**
 * Commit the lines stage's temp directory to its final location.
 * 将逻辑行阶段的临时目录提交到正式位置。
 */
export async function commitLinesStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'lines', tempDirectory);
}

/**
 * Commit the signals stage's temp directory to its final location.
 * 将规则信号阶段的临时目录提交到正式位置。
 */
export async function commitSignalsStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'signals', tempDirectory);
}

/**
 * Commit the ambiguity stage's temp directory to its final location.
 * 将标题候选消解阶段的临时目录提交到正式位置。
 */
export async function commitAmbiguityStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'ambiguity', tempDirectory);
}

/**
 * Commit the tree stage's temp directory to its final location.
 * 将结构树阶段的临时目录提交到正式位置。
 */
export async function commitTreeStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'tree', tempDirectory);
}

/**
 * Commit the chunks stage's temp directory to its final location.
 * 将切块阶段的临时目录提交到正式位置。
 */
export async function commitChunksStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'chunks', tempDirectory);
}

/**
 * Commit the keywords stage's temp directory to its final location.
 * 将关键词阶段的临时目录提交到正式位置。
 */
export async function commitKeywordsStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'keywords', tempDirectory);
}

/**
 * Commit the vectors stage's temp directory to its final location.
 * 将向量化阶段的临时目录提交到正式位置。
 */
export async function commitVectorsStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'vectors', tempDirectory);
}

/**
 * Commit the entities stage's temp directory to its final location.
 * 将实体抽取阶段的临时目录提交到正式位置。
 */
export async function commitEntitiesStage(layout: PipelineLayout, tempDirectory: string): Promise<StageCommitResult> {
  return commitStage(layout, 'entities', tempDirectory);
}

/**
 * Commit a stage's temp directory: validate outputs, write stage-manifest, atomically rename
 * to the final directory, update the pipeline manifest, and return the commit result.
 * 提交阶段临时目录：校验产物、写入 stage-manifest、原子改名到正式目录、更新流水线 manifest，并返回提交结果。
 *
 * @param layout - Pipeline layout / 流水线布局
 * @param stage - Stage identifier / 阶段标识
 * @param tempDirectory - Absolute path of the temp directory to commit / 要提交的临时目录绝对路径
 * @returns Commit result with artifact path, outputs, and counts / 提交结果，含产物路径、输出和统计
 */
export async function commitStage(layout: PipelineLayout, stage: PipelineStageId, tempDirectory: string): Promise<StageCommitResult> {
  const outputs: NonNullable<PipelineStageManifest['outputs']> = {};
  for (const fileName of stageOutputNames(layout, stage)) {
    const filePath = path.join(tempDirectory, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`阶段产物缺失：${fileName}`);
    outputs[fileName] = { relativePath: fileName, ...(await hashFile(filePath)) };
  }
  const reportName = stage === 'parse'
    ? 'parse-report.json'
    : stage === 'lines' ? 'lines-report.json' : stage === 'signals' ? 'signal-report.json' : stage === 'ambiguity' ? 'ambiguity-report.json' : stage === 'tree' ? 'tree-report.json' : stage === 'chunks' ? 'chunks-report.json' : stage === 'entities' ? 'extraction-report.json' : 'keyword-report.json';
  const resolvedReportName = stage === 'vectors' ? 'vector-report.json' : reportName;
  const report = JSON.parse(fs.readFileSync(path.join(tempDirectory, resolvedReportName), 'utf8')) as { counts?: Record<string, number> };
  const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
  atomicWriteJson(path.join(tempDirectory, 'stage-manifest.json'), {
    schemaVersion: 1,
    stage,
    stageKey: stageKey(layout, stage),
    outputs,
    counts,
    validatedAt: new Date().toISOString(),
  });

  const targetDirectory = stageDirectory(layout, stage);
  if (fs.existsSync(targetDirectory)) {
    const orphaned = path.join(layout.documentRoot, `.${stageDirectoryName(stage)}.orphaned-${Date.now()}`);
    await renameDirectoryWithRetry(targetDirectory, orphaned);
  }
  await moveDirectoryIntoPlace(tempDirectory, targetDirectory);
  fs.mkdirSync(layout.checkpointDirectory, { recursive: true });
  atomicWriteJson(path.join(layout.checkpointDirectory, `stage-${stage}.json`), {
    schemaVersion: 1,
    stage,
    stageKey: stageKey(layout, stage),
    status: 'SUCCEEDED',
    counts,
    updatedAt: new Date().toISOString(),
  });

  const manifest = createOrReadManifest(layout);
  const now = new Date().toISOString();
  manifest.stages[stage] = {
    stageKey: stageKey(layout, stage),
    status: 'SUCCEEDED',
    artifactPath: path.relative(layout.libraryPath, targetDirectory).replace(/\\/g, '/'),
    startedAt: manifest.stages[stage]?.startedAt,
    finishedAt: now,
    updatedAt: now,
    counts,
    outputs,
  };
  manifest.updatedAt = now;
  writePipelineManifest(layout, manifest);
  return { artifactPath: targetDirectory, outputs, counts };
}

/**
 * Clean up the parse stage's temp directory.
 * 清理解析阶段的临时目录。
 *
 * @param tempDirectory - Absolute path of the temp directory / 临时目录绝对路径
 */
export function cleanupParseTempDirectory(tempDirectory: string): void {
  cleanupStageTempDirectory(tempDirectory);
}

/**
 * Clean up a stage's temp directory (remove recursively if it exists).
 * 清理阶段临时目录（存在时递归删除）。
 *
 * @param tempDirectory - Absolute path of the temp directory / 临时目录绝对路径
 */
export function cleanupStageTempDirectory(tempDirectory: string): void {
  if (fs.existsSync(tempDirectory)) fs.rmSync(tempDirectory, { recursive: true, force: true });
}

/** 删除文档对应的全部流水线缓存，包括不同源 hash、配置指纹和临时目录。 */
/**
 * Remove all pipeline cache artifacts for a document, including different source hashes,
 * config fingerprints, and temp directories.
 * 删除文档对应的全部流水线缓存，包括不同源 hash、配置指纹和临时目录。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @param documentId - Document identifier / 文档标识
 */
export function removePipelineArtifacts(libraryPath: string, documentId: string): void {
  const root = pipelineRoot(libraryPath);
  const documentRoot = path.join(root, safeSegment(documentId));
  const relativePath = path.relative(root, documentRoot);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('流水线产物路径越界。');
  }
  if (fs.existsSync(documentRoot)) fs.rmSync(documentRoot, { recursive: true, force: true });
}

/**
 * On app startup, scan all pipeline manifests and mark any RUNNING stages as INTERRUPTED
 * so they can be retried from checkpoint.
 * 应用启动时扫描所有流水线 manifest，将仍在 RUNNING 的阶段标记为 INTERRUPTED，以便从 checkpoint 重试。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 */
export function recoverRunningStages(libraryPath: string): void {
  const root = pipelineRoot(libraryPath);
  if (!fs.existsSync(root)) return;
  for (const documentEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!documentEntry.isDirectory()) continue;
    const documentRoot = path.join(root, documentEntry.name);
    for (const hashEntry of fs.readdirSync(documentRoot, { withFileTypes: true })) {
      if (!hashEntry.isDirectory()) continue;
      const hashRoot = path.join(documentRoot, hashEntry.name);
      for (const fingerprintEntry of fs.readdirSync(hashRoot, { withFileTypes: true })) {
        if (!fingerprintEntry.isDirectory()) continue;
        const manifestPath = path.join(hashRoot, fingerprintEntry.name, 'pipeline-manifest.json');
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PipelineManifest;
          let changed = false;
          const now = new Date().toISOString();
          for (const stage of ['parse', 'lines', 'signals', 'ambiguity', 'tree', 'chunks', 'keywords', 'vectors', 'entities'] as const) {
            if (manifest.stages?.[stage]?.status !== 'RUNNING') continue;
            const current = manifest.stages[stage]!;
            manifest.stages[stage] = {
              ...current,
              status: 'INTERRUPTED',
              updatedAt: now,
              error: { code: 'WORKER_INTERRUPTED', message: '应用上次退出时阶段尚未完成，可从 checkpoint 继续。', retryable: true },
            };
            changed = true;
          }
          if (changed) {
            manifest.updatedAt = now;
            atomicWriteJson(manifestPath, manifest);
          }
        } catch {
          // 破损的缓存不覆盖其他成功缓存，下一次处理会重新创建当前指纹。
        }
      }
    }
  }
}

function stageDirectoryName(stage: PipelineStageId): string {
  if (stage === 'parse') return '01-parse';
  if (stage === 'lines') return '02-lines';
  if (stage === 'signals') return '03-signals';
  if (stage === 'ambiguity') return '04-ambiguity';
  if (stage === 'tree') return '05-tree';
  if (stage === 'chunks') return '06-chunks';
  if (stage === 'keywords') return '07-keywords';
  if (stage === 'entities') return '09-entities';
  return '08-vectors';
}

const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

/**
 * 目录原子改名带指数退避重试，吸收瞬态句柄锁。
 * happy path 首次 renameSync 即成功返回，重试仅在命中瞬态锁时触发。
 */
async function renameDirectoryWithRetry(from: string, to: string, attempts = 6, baseDelayMs = 20, maxDelayMs = 150): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts - 1 || !code || !RENAME_RETRYABLE_CODES.has(code)) throw error;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * 把阶段临时目录提交为正式目录。首选整目录原子改名；但杀毒/索引器
 * 在写入图片后会对新建目录树发起实时扫描，以目录句柄锁住 temp 本体，使整目录
 * 改名持续 EPERM（实测可超 27s），但其子项（文件与子目录）仍可改名。此时降级
 * 为逐项搬运到正式目录，避免提交因外部扫描而失败；阶段在 manifest 标记 SUCCEEDED
 * 前不被视为有效，故搬运中途的部分可见是安全的。
 */
async function moveDirectoryIntoPlace(from: string, to: string): Promise<void> {
  try {
    await renameDirectoryWithRetry(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !RENAME_RETRYABLE_CODES.has(code)) throw error;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    await renameDirectoryWithRetry(path.join(from, entry), path.join(to, entry));
  }
  fs.rmSync(from, { recursive: true, force: true });
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    bytes += Buffer.byteLength(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}
