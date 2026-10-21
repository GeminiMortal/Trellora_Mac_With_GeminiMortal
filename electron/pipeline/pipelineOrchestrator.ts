/**
 * Pipeline orchestrator: the top-level task scheduler that drives every document
 * through parse→lines→signals→ambiguity→tree→chunks→keywords→vectors→entities,
 * plus debounced library-level graph rebuilds and async vector sync.
 * 流水线编排器：顶层任务调度器，驱动每份文档经过 parse→lines→signals→ambiguity→tree→
 * chunks→keywords→vectors→entities 全流程，并管理防抖的库级图重建与异步向量同步。
 */

import { isRestorePaused } from '../backup/restorePause.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../library/materialsLibrary.ts';
import { findMaterialsDocument, listMaterialsDocuments, markMaterialsDocumentVectorState } from '../library/materialsLibrary.ts';
import type { AiProviderConfig } from '../knowledge/ai/aiTypes.ts';
import { getCustomParsingRoute, resolveParsingRoute } from './routes.ts';
import {
  cleanupStageTempDirectory,
  commitAmbiguityStage,
  commitChunksStage,
  commitEntitiesStage,
  commitKeywordsStage,
  commitVectorsStage,
  commitLinesStage,
  commitParseStage,
  commitSignalsStage,
  commitTreeStage,
  createStageTempDirectory,
  stageDirectory,
  ambiguityStageKey,
  chunksStageKey,
  entitiesStageKey,
  isStageCacheValid,
  isStageManifestCurrent,
  isVectorProjectionCurrent,
  keywordsStageKey,
  vectorsStageKey,
  linesStageKey,
  markStageState,
  prepareParseLayout,
  readPipelineManifest,
  recoverRunningStages,
  removePipelineArtifacts,
  signalsStageKey,
  treeStageKey,
} from './artifactStore.ts';
import { runAmbiguityStage } from './ambiguityStage.ts';
import { ambiguityConfigHash, DEFAULT_PIPELINE_AMBIGUITY_CONFIG } from './ambiguityConfig.ts';
import { DEFAULT_PIPELINE_STRUCTURE_CONFIG, structureConfigHash } from './structureConfig.ts';
import { chunkingConfigHash, pipelineChunkingV2Enabled, readLibraryChunkingConfig } from './chunkingConfig.ts';
import { graphEnhancementConfigHash, readLibraryGraphEnhancementConfig } from './graphEnhancementConfig.ts';
import { commitLibraryGraph, computeLibraryGraphKey, createLibraryGraphStagingDirectory, DEFAULT_LIBRARY_LEIDEN_CONFIG, libraryGraphDirectory, libraryGraphRoot, readLibraryGraphReport } from './libraryGraphStore.ts';
import { isGraphProjectionCurrent, readGraphCommunities, readGraphEntityDescriptions, readGraphProjectionStatus, replaceGraphProjection, updateGraphCommunitySummaries } from './graphProjection.ts';
import { computeCommunitySummaryKey, generateCommunitySummaries, inheritReusableSummaries, isCommunitySummaryCurrent, readCommunitySummaryRecords, type CommunitySummaryRecord } from './communitySummaries.ts';
import { buildGraphVectorIndex, computeGraphVectorKey, isGraphVectorIndexCurrent, buildGraphEntityVectorText, queryGraphEntityVectorNeighbors } from './graphVectorIndex.ts';
import {
  ALIAS_ARBITRATION_CACHE_FILE_NAME, ARBITRATION_MAX_CANDIDATES,
  applyAliasMapToEntitiesDirs, appendAliasArbitrationCache, arbitrateAliasGroups,
  filterAliasCandidates, loadEntitiesFromArtifactDirs, readAliasArbitrationCache, writeAliasArtifacts,
  type AliasArbitrationGroup,
} from './aliasArbitration.ts';
import { keywordStageConfigHash, readLibraryKeywordStageResources, type KeywordStageResources } from './keywordConfig.ts';
import { importKeywordsStage, isKeywordIndexCurrent, readFtsIndexProjectionSnapshot, removeKeywordIndexEntries } from './keywordIndex.ts';
import { runMineruPdfParse } from './mineruClient.ts';
import { CloudAuthorization, cloudAuthorizationRequired } from './cloudAuthorization.ts';
import { runMammothDocxParse } from './mammothStage.ts';
import { PythonWorkerClient, WorkerClientError } from './pythonWorkerClient.ts';
import { PipelineLlmCoordinator, type PipelineLlmAvailability, type PipelineLlmRequest } from './pipelineLlmCoordinator.ts';
import { runDirectTextParse } from './textStage.ts';
import { createParseImageSink, planDirectMarkdownImages } from './parseImages.ts';
import { isPipelineStageError, PipelineStageError } from './stageErrors.ts';
import { readMaterialEmbeddingProfile } from './materialEmbeddingProfile.ts';
import { readMaterialVectorProjectionSnapshot, synchronizeMaterialVectors, type MaterialEmbeddingAdapter } from './materialVectorCoordinator.ts';
import { MaterialEmbeddingProfileError, type MaterialEmbeddingProfile } from './materialEmbeddingTypes.ts';
import type { AmbiguityModelClient, LibraryChunkingConfig, LibraryGraphEnhancementConfig, MineruRuntimeConfig, PipelineAmbiguityConfig, PipelineDocumentStatus, PipelineError, PipelineFtsIndexStatus, PipelineProgressEvent, PipelineStageId, PipelineStageManifest, PipelineStructureConfig, PipelineVectorReport } from './types.ts';

const stageOrder: readonly PipelineStageId[] = ['parse', 'lines', 'signals', 'ambiguity', 'tree', 'chunks', 'keywords', 'vectors', 'entities'];

const GRAPH_REBUILD_DEBOUNCE_MS = 60_000;
const GRAPH_REBUILD_STARTUP_DELAY_MS = 5_000;
const GRAPH_VECTOR_EMBED_TIMEOUT_MS = 60_000;

/** Freshness state of a library-level graph projection / 库级图投影的新鲜度状态 */
export type LibraryGraphState = 'disabled' | 'missing' | 'building' | 'current' | 'stale' | 'failed';

/**
 * Status snapshot of the library-level graph, displayed in the renderer.
 * 库级图谱状态快照，供渲染进程展示。
 */
export interface LibraryGraphStatus {
  /** Current freshness state / 当前新鲜度状态 */
  state: LibraryGraphState;
  /** Graph key if a projection exists / 存在投影时的图谱键 */
  graphKey?: string;
  /** Engine that produced the graph / 产出图谱的引擎 */
  engine?: string;
  /** Aggregate counters / 聚合计数 */
  counts?: { nodes: number; edges: number; communities: number; levels: number };
  /** When the projection was imported / 投影导入时间 */
  importedAt?: string;
  /** Last error if any / 如有则为最后一次错误 */
  error?: PipelineError;
}

/**
 * Result returned by a library graph rebuild, indicating whether the output was cached.
 * 库级图重建的结果，指示产出是否为缓存命中。
 */
export interface LibraryGraphRebuildResult extends LibraryGraphStatus {
  /** True when an existing graph projection was reused / 重用了已有图投影时为 true */
  cached: boolean;
}

interface QueuedJob {
  key: string;
  libraryPath: string;
  documentId: string;
}

interface ActiveJob extends QueuedJob {
  jobId: string;
  route: ReturnType<typeof resolveParsingRoute>;
  currentStage: PipelineStageId;
  tempDirectories: Partial<Record<PipelineStageId, string>>;
  abortController: AbortController;
  cancelRequested: boolean;
}

/**
 * Callbacks and configuration injected into the orchestrator.
 * 注入到编排器的回调与配置。
 */
export interface PipelineOrchestratorOptions {
  /** Status push callback / 状态推送回调 */
  onStatus?: (status: PipelineDocumentStatus) => void;
  /** Progress event callback / 进度事件回调 */
  onProgress?: (event: PipelineProgressEvent) => void;
  /** Log callback / 日志回调 */
  onLog?: (message: string) => void;
  /** Provides MinerU credentials and consent state / 提供 MinerU 凭据与同意状态 */
  getMineruConfig?: () => MineruRuntimeConfig;
  /** Returns the ambiguity stage config for a library / 返回资料库的歧义阶段配置 */
  getAmbiguityConfig?: () => PipelineAmbiguityConfig;
  /** Returns the ambiguity LLM client for a library / 返回资料库的歧义 LLM 客户端 */
  getAmbiguityModel?: (libraryPath: string) => AmbiguityModelClient;
  /**
   * Library-level LLM config (bound profile first, global fallback); used by
   * ambiguity disambiguation, LLM chunking and graph enhancement for LLM calls and cache fingerprints.
   * 资料库级语言模型解析（绑定优先、全局回退）；用于歧义消解、智能切块与图谱增强的 LLM 调用与缓存指纹。
   */
  getPipelineLlmConfig?: (libraryPath: string) => AiProviderConfig;
  /** Returns the structure config for a library / 返回资料库的结构配置 */
  getStructureConfig?: () => PipelineStructureConfig;
  /** Returns the chunking config for a library / 返回资料库的切块配置 */
  getChunkingConfig?: (libraryPath: string) => LibraryChunkingConfig;
  /** Returns the graph enhancement config for a library / 返回资料库的图增强配置 */
  getGraphEnhancementConfig?: (libraryPath: string) => LibraryGraphEnhancementConfig;
  /** Shared LLM coordinator (defaults to a new one) / 共享 LLM 协调器（缺省新建） */
  pipelineLlmCoordinator?: PipelineLlmCoordinator;
  /** Returns keyword stage resources for a library / 返回资料库的关键词阶段资源 */
  getKeywordResources?: (libraryPath: string) => KeywordStageResources;
  /** Returns an embedding adapter for a profile / 为配置返回嵌入适配器 */
  getMaterialEmbeddingAdapter?: (input: { libraryPath: string; profile: MaterialEmbeddingProfile }) => MaterialEmbeddingAdapter | undefined | Promise<MaterialEmbeddingAdapter | undefined>;
  /**
   * Notifies the renderer to refresh its read-only graph view after a rebuild.
   * 库级图谱投影重建完成后通知渲染进程刷新只读视图。
   */
  onLibraryGraphUpdated?: (libraryPath: string) => void;
}

/**
 * Orchestrates document pipeline runs, manages a single-worker process and
 * schedules debounced library-level graph rebuilds.
 * 编排文档流水线运行，管理单个 Worker 进程并调度防抖的库级图重建。
 */
export class PipelineOrchestrator {
  private readonly cloudAuthorization = new CloudAuthorization();
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly activeCompletions = new Map<string, Promise<void>>();
  private readonly queuedKeys = new Set<string>();
  private readonly removingKeys = new Set<string>();
  private readonly queue: QueuedJob[] = [];
  private readonly worker: PythonWorkerClient;
  private readonly pipelineLlmCoordinator: PipelineLlmCoordinator;
  private readonly options: PipelineOrchestratorOptions;
  private readonly graphRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly graphRebuildActive = new Map<string, Promise<LibraryGraphRebuildResult>>();
  private readonly graphRebuildDirty = new Set<string>();
  private readonly activeAsyncVectorSyncs = new Map<string, Promise<void>>();
  private draining = false;
  private maintenancePaused = false;

  /** Whether any pipeline job, graph rebuild or async vector sync is active / 是否有任何流水线任务、图重建或异步向量同步正在运行 */
  get maintenanceBusy(): boolean { return this.activeJobs.size > 0 || this.graphRebuildActive.size > 0 || this.activeAsyncVectorSyncs.size > 0; }
  /**
   * 索引代际切换前必须等待本库的流水线、图谱写入和异步向量同步结束。
   * Index-generation switching must wait until this library's pipeline, graph writes and async vector sync finish.
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @returns True when the library is busy / 资料库正忙时返回 true
   */
  isLibraryBusy(libraryPath: string): boolean {
    const target = path.resolve(libraryPath);
    return [...this.activeJobs.values()].some(job => path.resolve(job.libraryPath) === target)
      || this.graphRebuildActive.has(target)
      || [...this.activeAsyncVectorSyncs.keys()].some(key => key.startsWith(`${target}:`));
  }
  /** Pauses all graph rebuild scheduling and queue draining for maintenance operations. / 暂停所有图重建调度与队列排空，用于维护操作。 */
  pauseForMaintenance(): void {
    this.maintenancePaused = true;
    for (const [key, timer] of this.graphRebuildTimers) { clearTimeout(timer); this.graphRebuildDirty.add(key); }
    this.graphRebuildTimers.clear();
  }
  /** Resumes graph rebuild scheduling and queue draining after maintenance. / 维护操作后恢复图重建调度与队列排空。 */
  resumeAfterMaintenance(): void {
    this.maintenancePaused = false;
    for (const key of this.graphRebuildDirty) this.scheduleLibraryGraphRebuild(key);
    this.graphRebuildDirty.clear();
    void this.drainQueue();
  }

  /**
   * Rebind queued work while maintenance owns all writers; the old workspace becomes a read-only copy.
   * 维护操作独占写者时重新绑定队列中的任务；旧工作区变为只读副本。
   *
   * @param source - Source workspace path / 源工作区路径
   * @param target - Target workspace path / 目标工作区路径
   */
  rebindWorkspace(source: string, target: string): void {
    if (!this.maintenancePaused || this.maintenanceBusy) throw new Error('请先暂停资料任务后再迁移工作区。');
    const map = (file: string) => {
      const relative = path.relative(source, file);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ? path.join(target, relative) : file;
    };
    this.queuedKeys.clear();
    for (const job of this.queue) { job.libraryPath = map(job.libraryPath); job.key = jobKey(job.libraryPath, job.documentId); this.queuedKeys.add(job.key); }
    const dirty = [...this.graphRebuildDirty].map(map); this.graphRebuildDirty.clear();
    for (const library of dirty) this.graphRebuildDirty.add(library);
  }

  /**
   * Creates the orchestrator and its worker client.
   * 创建编排器及其 Worker 客户端。
   *
   * @param options - Injected callbacks and config / 注入的回调与配置
   */
  constructor(options: PipelineOrchestratorOptions = {}) {
    this.options = options;
    this.pipelineLlmCoordinator = options.pipelineLlmCoordinator ?? new PipelineLlmCoordinator();
    this.worker = new PythonWorkerClient({
      onLog: options.onLog,
      onProgress: (event) => {
        const active = [...this.activeJobs.values()].find((job) => job.jobId === event.jobId);
        if (!active) return;
        this.options.onProgress?.({ ...event, libraryPath: active.libraryPath, documentId: active.documentId });
      },
    });
  }

  /**
   * Recovers orphaned RUNNING stages on app restart.
   * 应用重启时回收孤立的 RUNNING 阶段。
   *
   * @param libraryPath - Library root path / 资料库根路径
   */
  recoverLibrary(libraryPath: string): void {
    recoverRunningStages(libraryPath);
    this.recoverLibraryGraphProjection(libraryPath);
  }

  /** 重启续跑：entities 已提交但投影缺失/过期时重新排入防抖重建，避免内存定时器随重启丢失。 */
  private recoverLibraryGraphProjection(libraryPath: string): void {
    const resolved = path.resolve(libraryPath);
    if (this.getLibraryGraphStatus(resolved).state === 'stale') {
      this.scheduleLibraryGraphRebuild(resolved, GRAPH_REBUILD_STARTUP_DELAY_MS);
    }
  }

  /**
   * Enqueues all pending documents in a library.
   * 将资料库中所有待处理文档加入队列。
   *
   * @param libraryPath - Library root path / 资料库根路径
   */
  async enqueuePending(libraryPath: string): Promise<void> {
    if (isRestorePaused(libraryPath)) return;
    const configReady = this.hasMineruConfig();
    for (const document of listMaterialsDocuments(libraryPath)) {
      const status = this.getStatus(libraryPath, document);
      if (status.route === 'unsupported') continue;
      const layout = this.createLayout(libraryPath, document, this.getMineruConfig().endpoint);
      const pendingStage = await nextPendingStage(layout);
      if (pendingStage === undefined) {
        markMaterialsDocumentVectorState(libraryPath, document.id, 'indexed');
      }
      if (pendingStage === 'vectors' && status.state === 'RUNNING' && status.stage === 'vectors') continue;
      const vectorWaitingForProfile = pendingStage === 'vectors' && !hasLockedMaterialEmbeddingProfile(libraryPath);
      const shouldResume = !vectorWaitingForProfile && (pendingStage !== undefined
        || status.state === 'IDLE'
        || status.state === 'INTERRUPTED'
        || (status.state === 'WAITING_CONFIG' && configReady));
      if (shouldResume) await this.enqueueParse(libraryPath, document.id);
    }
  }

  /**
   * Enqueues pending documents across multiple libraries.
   * 将多个资料库的待处理文档加入队列。
   *
   * @param libraryPaths - Library root paths / 资料库根路径列表
   */
  async enqueuePendingAll(libraryPaths: string[]): Promise<void> {
    for (const libraryPath of libraryPaths) await this.enqueuePending(libraryPath);
  }

  /**
   * Returns the pipeline status for every document in a library.
   * 返回资料库中每份文档的流水线状态。
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @returns Document statuses / 文档状态列表
   */
  getStatuses(libraryPath: string): PipelineDocumentStatus[] {
    return listMaterialsDocuments(libraryPath).map((document) => this.getStatus(libraryPath, document));
  }

  /**
   * Reuse the exact active configuration fingerprint for manifest consumers.
   * 以当前活跃配置指纹供清单消费者复用。
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @param document - Document metadata / 文档元数据
   * @returns The layout for this document / 本文档的布局
   */
  getCurrentLayout(libraryPath: string, document: MaterialsDocument): ReturnType<typeof prepareParseLayout> {
    return this.createLayout(libraryPath, document, this.getMineruConfig().endpoint);
  }

  /**
   * Builds the full pipeline status for one document by reading its manifest and FTS projection.
   * 通过读取清单与 FTS 投影，构建单份文档的完整流水线状态。
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @param document - Document metadata / 文档元数据
   * @returns Document status / 文档状态
   */
  getStatus(libraryPath: string, document: MaterialsDocument): PipelineDocumentStatus {
    const config = this.getMineruConfig();
    const layout = this.createLayout(libraryPath, document, config.endpoint);
    const manifest = readPipelineManifest(layout);
    const stages = manifest?.stages;
    const route = resolveParsingRoute(document.extension);
    const base = baseStatus(libraryPath, document, route);
    if (route === 'unsupported') {
      return {
        ...base,
        stage: 'parse',
        state: 'FAILED',
        error: unsupportedFormatError(document.extension),
        updatedAt: new Date().toISOString(),
      };
    }
    const ftsIndex = buildFtsIndexStatus(layout, stages?.keywords);
    if (route === 'mineru' && !isStageManifestCurrent(layout, 'parse') && !this.cloudAuthorization.has(libraryPath, document)) {
      return { ...base, state: 'WAITING_CONFIG', error: cloudAuthorizationRequired(), updatedAt: new Date().toISOString(), stages, ftsIndex };
    }
    if (!stages?.parse && route === 'mineru' && !this.hasMineruConfig()) {
      return { ...base, state: 'WAITING_CONFIG', error: mineruConfigError(), updatedAt: new Date().toISOString(), stages, ftsIndex };
    }
    const currentStage = firstIncompleteStage(stages, layout, ftsIndex.state === 'CURRENT');
    const current = currentStage ? stages?.[currentStage] : stages?.vectors;
    const state = currentStage ? (current?.status === 'SUCCEEDED' ? 'IDLE' : current?.status ?? 'IDLE') : 'SUCCEEDED';
    return {
      ...base,
      stage: currentStage ?? 'vectors',
      state,
      artifactPath: latestArtifactPath(stages),
      counts: aggregateCounts(stages),
      error: current?.error,
      stages,
      ftsIndex,
      updatedAt: current?.updatedAt ?? manifest?.updatedAt ?? new Date().toISOString(),
    };
  }

  /**
   * Enqueues a single document for processing (called from IPC).
   * 将单份文档加入处理队列（从 IPC 调用）。
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @param documentId - Document id / 文档 ID
   * @returns Document status after enqueueing / 加入队列后的文档状态
   */
  async startParse(libraryPath: string, documentId: string): Promise<PipelineDocumentStatus> {
    return this.enqueueParse(libraryPath, documentId);
  }

  /**
   * Tokenizes a search query using the library's Jieba dictionary via the Worker.
   * 通过 Worker 使用资料库的 Jieba 词典对检索查询分词。
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @param query - Query text / 查询文本
   * @returns Tokenized tokens / 分词后的词元列表
   */
  async tokenizeMaterialSearchQuery(libraryPath: string, query: string): Promise<string[]> {
    const resources = this.getKeywordResources(libraryPath);
    if (resources.validationError) {
      throw new PipelineStageError(
        resources.validationError.code,
        resources.validationError.message,
        resources.validationError.retryable,
      );
    }
    const result = await this.worker.tokenizeSearch({
      query,
      dictionaryTerms: resources.dictionaryTerms,
      stopwords: resources.stopwords,
    });
    return result.tokens;
  }

  /**
   * 停止文档任务后再删除其全部缓存，避免取消中的任务重新提交阶段产物。
   * Stops the document task first, then removes all its caches, preventing cancelled
   * tasks from recommitting stage artifacts.
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @param documentId - Document id to remove / 要移除的文档 ID
   */
  async removeDocument(libraryPath: string, documentId: string): Promise<void> {
    const key = jobKey(libraryPath, documentId);
    this.removingKeys.add(key);
    try {
      const active = this.activeJobs.get(key);
      if (active) {
        active.cancelRequested = true;
        active.abortController.abort();
        if (isPythonWorkerStage(active.currentStage)) {
          try {
            await this.worker.cancel(active.jobId);
          } catch (error) {
            this.options.onLog?.(`[PIPELINE] 取消删除中的 Worker 任务失败，将强制重启 Worker：${error instanceof Error ? error.message : String(error)}`);
            await this.worker.shutdown();
          }
        }
        await this.activeCompletions.get(key);
      }

      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index]?.key !== key) continue;
        this.queue.splice(index, 1);
      }
      this.queuedKeys.delete(key);
      removeKeywordIndexEntries(libraryPath, documentId);
      removePipelineArtifacts(libraryPath, documentId);
      this.scheduleLibraryGraphRebuild(libraryPath);
    } finally {
      this.removingKeys.delete(key);
    }
  }

  /**
   * Cancels a running or queued parse job for one document.
   * 取消单份文档的运行中或已排队的解析任务。
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @param documentId - Document id / 文档 ID
   * @returns Document status after cancellation / 取消后的文档状态
   */
  async cancelParse(libraryPath: string, documentId: string): Promise<PipelineDocumentStatus> {
    const key = jobKey(libraryPath, documentId);
    const active = this.activeJobs.get(key);
    if (active) {
      active.cancelRequested = true;
      active.abortController.abort();
      if (isPythonWorkerStage(active.currentStage)) await this.worker.cancel(active.jobId);
      const document = findMaterialsDocument(libraryPath, documentId);
      if (!document) throw new Error('找不到要取消的资料文档。');
      return this.getStatus(libraryPath, document);
    }

    const queuedIndex = this.queue.findIndex((job) => job.key === key);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.queuedKeys.delete(key);
      const document = findMaterialsDocument(libraryPath, documentId);
      if (!document) throw new Error('找不到要取消的资料文档。');
      const layout = this.createLayout(libraryPath, document, this.getMineruConfig().endpoint);
      const stage = await nextPendingStage(layout);
      if (stage) markStageState(layout, stage, 'CANCELLED', { code: 'STAGE_CANCELLED', message: '处理任务已取消。', retryable: true });
      const status = this.getStatus(libraryPath, document);
      this.options.onStatus?.(status);
      return status;
    }

    const document = findMaterialsDocument(libraryPath, documentId);
    if (!document) throw new Error('找不到要取消的资料文档。');
    return this.getStatus(libraryPath, document);
  }

  /**
   * Shuts down the orchestrator: cancels all work, stops the worker and waits for completion.
   * 关闭编排器：取消所有工作、停止 Worker 并等待完成。
   */
  async shutdown(): Promise<void> {
    this.maintenancePaused = true;
    for (const active of this.activeJobs.values()) active.abortController.abort();
    this.queue.splice(0, this.queue.length);
    this.queuedKeys.clear();
    for (const timer of this.graphRebuildTimers.values()) clearTimeout(timer);
    this.graphRebuildTimers.clear();
    this.graphRebuildDirty.clear();
    await this.worker.shutdown();
    await Promise.allSettled([...this.activeCompletions.values(), ...this.activeAsyncVectorSyncs.values()]);
    this.activeAsyncVectorSyncs.clear();
  }

  /**
   * 防抖触发库级图谱重建（默认 60 秒）；在 entities 提交、文档删除或启动续跑后调用。
   * Debounces library graph rebuild (default 60 s); called after entities commits, document removal or restart.
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @param delayMs - Debounce delay in ms / 防抖延迟（毫秒）
   */
  scheduleLibraryGraphRebuild(libraryPath: string, delayMs: number = GRAPH_REBUILD_DEBOUNCE_MS): void {
    if (isRestorePaused(libraryPath)) return;
    const key = path.resolve(libraryPath);
    if (this.maintenancePaused) { this.graphRebuildDirty.add(key); return; }
    const existing = this.graphRebuildTimers.get(key);
    if (existing) clearTimeout(existing);
    this.graphRebuildTimers.set(key, setTimeout(() => {
      this.graphRebuildTimers.delete(key);
      void this.runLibraryGraphRebuild(key).catch((error) => {
        this.options.onLog?.(`[PIPELINE] 计划内图谱重建异常：${error instanceof Error ? error.message : String(error)}`);
      });
    }, delayMs));
  }

  /**
   * 手动重建库级图谱；并发调用合并为同一任务，后续变更重新排队。
   * Manually rebuilds the library graph; concurrent calls coalesce into one task; later changes re-queue.
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @returns Rebuild result / 重建结果
   */
  rebuildLibraryGraph(libraryPath: string): Promise<LibraryGraphRebuildResult> {
    return this.runLibraryGraphRebuild(path.resolve(libraryPath));
  }

  /**
   * 库级图谱状态（供 UI 展示）：以真实投影与已提交产物为准，不推断。
   * Library graph status (for UI display): based on actual projection and committed artifacts only, never inferred.
   *
   * @param libraryPath - Library root path / 资料库根路径
   * @returns Graph status / 图谱状态
   */
  getLibraryGraphStatus(libraryPath: string): LibraryGraphStatus {
    const resolved = path.resolve(libraryPath);
    const config = this.getGraphEnhancementConfig(resolved);
    if (!config.enabled) return { state: 'disabled' };
    if (this.graphRebuildActive.has(resolved)) return { state: 'building' };
    const projection = readGraphProjectionStatus(resolved);
    const entries = this.collectCommittedEntities(resolved);
    if (entries.length === 0) {
      return projection ? { state: 'stale', graphKey: projection.graphKey, importedAt: projection.importedAt } : { state: 'missing' };
    }
    const graphKey = computeLibraryGraphKey({ entitiesStageKeys: entries.map((entry) => entry.stageKey), leidenConfig: config.leidenConfig, aliasArbitrationEnabled: config.aliasArbitrationEnabled });
    const report = readLibraryGraphReport(resolved, graphKey);
    if (report && projection?.graphKey === graphKey
      && isGraphProjectionCurrent(resolved, { graphKey, expectedEntities: report.counts.nodes, expectedCommunities: report.counts.communities })) {
      return { state: 'current', graphKey, engine: report.engine, counts: report.counts, importedAt: projection.importedAt };
    }
    return { state: 'stale', graphKey, ...(report ? { engine: report.engine } : {}) };
  }

  private async runLibraryGraphRebuild(libraryPath: string): Promise<LibraryGraphRebuildResult> {
    const running = this.graphRebuildActive.get(libraryPath);
    if (running) {
      this.graphRebuildDirty.add(libraryPath);
      return running;
    }
    const task = this.executeLibraryGraphRebuild(libraryPath).finally(() => {
      this.graphRebuildActive.delete(libraryPath);
    });
    this.graphRebuildActive.set(libraryPath, task);
    const result = await task;
    if (result.state === 'rebuilt') this.options.onLibraryGraphUpdated?.(libraryPath);
    if (this.graphRebuildDirty.delete(libraryPath)) this.scheduleLibraryGraphRebuild(libraryPath);
    return result;
  }

  private async executeLibraryGraphRebuild(libraryPath: string): Promise<LibraryGraphRebuildResult> {
    const config = this.getGraphEnhancementConfig(libraryPath);
    if (!config.enabled) return { state: 'disabled', cached: false };
    const entries = this.collectCommittedEntities(libraryPath);
    if (entries.length === 0) return { state: 'missing', cached: false };
    const graphKey = computeLibraryGraphKey({ entitiesStageKeys: entries.map((entry) => entry.stageKey), leidenConfig: config.leidenConfig, aliasArbitrationEnabled: config.aliasArbitrationEnabled });
    const existingReport = readLibraryGraphReport(libraryPath, graphKey);
    if (existingReport && isGraphProjectionCurrent(libraryPath, {
      graphKey,
      expectedEntities: existingReport.counts.nodes,
      expectedCommunities: existingReport.counts.communities,
    })) {
      await this.ensureLibraryGraphSummaries(libraryPath, graphKey, libraryGraphDirectory(libraryPath, graphKey));
      await this.ensureLibraryGraphVectors(libraryPath, graphKey);
      return { state: 'current', cached: true, graphKey, engine: existingReport.engine, counts: existingReport.counts };
    }
    const jobId = `graph-${crypto.randomUUID()}`;
    const stagingDirectory = createLibraryGraphStagingDirectory(libraryPath, graphKey, jobId);
    let aliasDirectory: string | undefined;
    try {
      this.options.onLog?.(`[PIPELINE] 开始库级图谱装配：${entries.length} 份 entities 产物，graphKey=${graphKey.slice(0, 12)}…`);
      const arbitration = await this.prepareLibraryAliasArbitration(libraryPath, graphKey, entries, stagingDirectory);
      aliasDirectory = arbitration.aliasDirectory;
      await this.worker.runStage({
        jobId,
        stage: 'graph',
        inputPath: libraryGraphRoot(libraryPath),
        outputDir: stagingDirectory,
        options: {
          entitiesDirs: arbitration.entitiesDirs,
          graphKey,
          stageKey: graphKey,
          config: { leiden: config.leidenConfig },
        },
      });
      // commit 会清理旧图目录：先把旧社区摘要读入内存，供重建时增量继承（成员未变的社区零调用复用）。
      // Commit clears the old graph directory: read old summaries into memory first, for incremental inheritance during rebuild (communities with unchanged members reuse with zero LLM calls).
      const previousSummaries = readPreviousGraphSummaryRecords(libraryPath);
      const committedDirectory = commitLibraryGraph(libraryPath, graphKey, stagingDirectory);
      const projection = replaceGraphProjection({ libraryPath, graphKey, graphDirectory: committedDirectory });
      this.options.onLog?.(`[PIPELINE] 库级图谱装配完成：${projection.importedEntities} 实体、${projection.importedRelations} 边、${projection.importedCommunities} 社区（引擎 ${projection.engine}）。`);
      await this.ensureLibraryGraphSummaries(libraryPath, graphKey, committedDirectory, previousSummaries);
      await this.ensureLibraryGraphVectors(libraryPath, graphKey);
      return {
        state: 'rebuilt',
        cached: false,
        graphKey,
        engine: projection.engine,
        counts: { nodes: projection.importedEntities, edges: projection.importedRelations, communities: projection.importedCommunities, levels: projection.levels },
      };
    } catch (error) {
      if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
      if (aliasDirectory && fs.existsSync(aliasDirectory)) fs.rmSync(aliasDirectory, { recursive: true, force: true });
      const stageError: PipelineError = isPipelineStageError(error)
        ? { code: error.code, message: error.message, retryable: error.retryable, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }
        : { code: 'GRAPH_REBUILD_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true };
      this.options.onLog?.(`[PIPELINE] 库级图谱装配失败：${stageError.message}`);
      return { state: 'failed', cached: false, graphKey, error: stageError };
    }
  }

  /**
   * 社区摘要（方案 §3.3）：图装配成功后 best-effort 生成或应用摘要并写回投影；
   * 失败仅记日志，不让图谱重建失败。模型/提示词/预算变化经 summaryKey 只失效摘要。
   * Community summaries (plan §3.3): best-effort generates or applies summaries and writes them
   * back to the projection after graph assembly; failures only log without failing the rebuild.
   * Model/prompt/budget changes only invalidate summaries via summaryKey.
   */
  private async ensureLibraryGraphSummaries(libraryPath: string, graphKey: string, graphDirectory: string, previousSummaries?: CommunitySummaryRecord[]): Promise<void> {
    try {
      const config = this.getGraphEnhancementConfig(libraryPath);
      const providerConfig = this.getPipelineLlmConfig(libraryPath);
      const fingerprint = this.pipelineLlmCoordinator.fingerprint(providerConfig);
      const summaryKey = computeCommunitySummaryKey({
        graphKey,
        promptVersion: config.summaryPromptVersion,
        fingerprint,
        budgetTokens: config.summaryBudgetTokens,
      });
      if (isCommunitySummaryCurrent(graphDirectory, summaryKey)) {
        const applied = updateGraphCommunitySummaries(libraryPath, readCommunitySummaryRecords(graphDirectory));
        this.options.onLog?.(`[PIPELINE] 社区摘要命中缓存：应用 ${applied.updated} 条摘要，覆盖 ${applied.coverage} 个社区。`);
        return;
      }
      const availability = await this.pipelineLlmCoordinator.getAvailability(providerConfig);
      if (!availability.available) {
        this.options.onLog?.(`[PIPELINE] 社区摘要跳过：${availability.message ?? '模型不可用。'}`);
        return;
      }
      // 增量继承（方案 §4.7）：新社区成员指纹命中旧记录 → 沿用，只重算受影响社区。
      // Incremental inheritance (plan §4.7): new community members whose fingerprint matches old records are reused; only affected communities are recomputed.
      let preloaded: CommunitySummaryRecord[] | undefined;
      if (previousSummaries && previousSummaries.length > 0) {
        const newCommunities = readGraphCommunities(libraryPath) ?? [];
        if (newCommunities.length > 0) {
          const inheritance = inheritReusableSummaries({ oldRecords: previousSummaries, newCommunities });
          if (inheritance.preloaded.length > 0) preloaded = inheritance.preloaded;
        }
      }
      const controller = new AbortController();
      const result = await generateCommunitySummaries({
        graphDirectory,
        graphKey,
        config,
        fingerprint,
        ...(preloaded ? { preloaded } : {}),
        callSummary: async (text) => {
          const responses = await this.pipelineLlmCoordinator.completeRequests({
            requests: [{
              requestId: `community-summary-${crypto.randomUUID()}`,
              documentId: `graph:${graphKey.slice(0, 12)}`,
              text,
              inputHash: summaryKey,
              maxChars: config.maxChars,
            }],
            callKind: 'graph-community-summary',
            timeoutMs: config.llmTimeoutMs,
            maxOutputTokens: config.llmMaxOutputTokens,
            signal: controller.signal,
            ...(providerConfig ? { providerConfig } : {}),
            skipAvailabilityCheck: true,
          });
          return responses[0]?.output ?? '';
        },
        signal: controller.signal,
      });
      const applied = updateGraphCommunitySummaries(libraryPath, result.summaries);
      this.options.onLog?.(`[PIPELINE] 社区摘要完成：${result.report.counts.summarized}/${result.report.counts.communities} 个（继承 ${result.report.counts.inherited}，失败 ${result.report.failures.length}），写回 ${applied.updated} 条，耗时 ${result.report.durationMs}ms。`);
    } catch (error) {
      this.options.onLog?.(`[PIPELINE] 社区摘要失败（不影响图谱）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 实体/社区向量索引（方案 §4.5）：摘要写回后 best-effort 建立；图重建整体失效，
   * embedding 模型指纹变化只失效向量。失败仅记日志，不让图谱重建失败。
   * Entity/community vector index (plan §4.5): best-effort built after summaries are written back;
   * graph rebuild invalidates all; embedding model fingerprint changes only invalidate vectors.
   * Failures only log without failing the rebuild.
   */
  private async ensureLibraryGraphVectors(libraryPath: string, graphKey: string): Promise<void> {
    try {
      const profileStatus = readMaterialEmbeddingProfile(libraryPath);
      if (profileStatus.state !== 'LOCKED' || !profileStatus.profile) {
        this.options.onLog?.('[PIPELINE] 图向量索引跳过：资料库尚未锁定 embedding 模型。');
        return;
      }
      const profile = profileStatus.profile;
      const vectorKey = computeGraphVectorKey({ graphKey, modelFingerprint: profile.profileHash });
      if (isGraphVectorIndexCurrent(libraryPath, vectorKey)) {
        this.options.onLog?.('[PIPELINE] 图向量索引命中缓存。');
        return;
      }
      const adapter = await this.options.getMaterialEmbeddingAdapter?.({ libraryPath, profile });
      if (!adapter) {
        this.options.onLog?.('[PIPELINE] 图向量索引跳过：锁定的向量模型当前没有可用运行时凭据。');
        return;
      }
      const controller = new AbortController();
      const result = await buildGraphVectorIndex({
        libraryPath,
        graphKey,
        vectorKey,
        modelFingerprint: profile.profileHash,
        vectorDimension: profile.vectorDimension,
        callEmbed: async (texts) => {
          const batch = await adapter.embedBatch({ profile, texts, timeoutMs: GRAPH_VECTOR_EMBED_TIMEOUT_MS, signal: controller.signal });
          return batch.vectors;
        },
        signal: controller.signal,
      });
      this.options.onLog?.(`[PIPELINE] 图向量索引完成：${result.entityVectors} 个实体、${result.communityVectors} 个社区（维度 ${result.dimension}），复用 ${result.entityVectorsReused}/${result.communityVectorsReused}，耗时 ${result.durationMs}ms。`);
    } catch (error) {
      this.options.onLog?.(`[PIPELINE] 图向量索引失败（不影响图谱）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 别名裁决（方案 §4.6 先召回后裁决）：图装配前把新实体与既有向量索引做余弦召回，
   * LLM 严格契约仲裁后在 Electron 侧预映射（Python 侧零改动）。失败仅记日志回退原始产物；
   * 无向量索引/未锁定模型/无候选时静默跳过，不影响存量库行为。
   * Alias arbitration (plan §4.6 recall-then-arbitrate): before graph assembly, performs cosine
   * recall of new entities against the existing vector index, then applies LLM strict-contract
   * arbitration with Electron-side pre-mapping (zero changes on the Python side). Failures only
   * log and fall back to original artifacts; silently skipped when no vector index / profile is
   * locked / no candidates exist, without affecting existing library behavior.
   */
  private async prepareLibraryAliasArbitration(
    libraryPath: string,
    graphKey: string,
    entries: Array<{ documentId: string; stageKey: string; directory: string }>,
    stagingDirectory: string,
  ): Promise<{ entitiesDirs: string[]; aliasDirectory?: string }> {
    const defaultDirs = entries.map((entry) => entry.directory);
    let aliasDirectory: string | undefined;
    try {
      const config = this.getGraphEnhancementConfig(libraryPath);
      if (!config.aliasArbitrationEnabled) return { entitiesDirs: defaultDirs };
      const projectionStatus = readGraphProjectionStatus(libraryPath);
      if (!projectionStatus || projectionStatus.vectorCoverage <= 0) {
        this.options.onLog?.('[PIPELINE] 别名裁决跳过：尚无图实体向量索引。');
        return { entitiesDirs: defaultDirs };
      }
      const profileStatus = readMaterialEmbeddingProfile(libraryPath);
      if (profileStatus.state !== 'LOCKED' || !profileStatus.profile) {
        this.options.onLog?.('[PIPELINE] 别名裁决跳过：资料库尚未锁定 embedding 模型。');
        return { entitiesDirs: defaultDirs };
      }
      const profile = profileStatus.profile;
      const adapter = await this.options.getMaterialEmbeddingAdapter?.({ libraryPath, profile });
      if (!adapter) {
        this.options.onLog?.('[PIPELINE] 别名裁决跳过：锁定的向量模型当前没有可用运行时凭据。');
        return { entitiesDirs: defaultDirs };
      }
      const providerConfig = this.getPipelineLlmConfig(libraryPath);
      const availability = await this.pipelineLlmCoordinator.getAvailability(providerConfig);
      if (!availability.available) {
        this.options.onLog?.(`[PIPELINE] 别名裁决跳过：${availability.message ?? '模型不可用。'}`);
        return { entitiesDirs: defaultDirs };
      }
      const fingerprint = this.pipelineLlmCoordinator.fingerprint(providerConfig);

      // 召回：新实体批量 embedding 后对既有实体向量索引做 KNN，类型相容 + 阈值过滤。
      // Recall: batch-embeds new entities then queries the existing entity vector index with KNN, filtering by type compatibility + threshold.
      const entities = loadEntitiesFromArtifactDirs(entries);
      if (entities.size === 0) return { entitiesDirs: defaultDirs };
      const keys = [...entities.keys()];
      const controller = new AbortController();
      const vectors: number[][] = [];
      for (let start = 0; start < keys.length; start += 16) {
        const batchKeys = keys.slice(start, start + 16);
        const texts = batchKeys.map((key) => {
          const entity = entities.get(key);
          return buildGraphEntityVectorText({ mention: entity?.mention ?? key, type: entity?.type ?? 'concept', description: entity?.description ?? '' });
        });
        const batch = await adapter.embedBatch({ profile, texts, timeoutMs: GRAPH_VECTOR_EMBED_TIMEOUT_MS, signal: controller.signal });
        vectors.push(...batch.vectors);
      }
      const descriptions = readGraphEntityDescriptions(libraryPath);
      const groups: AliasArbitrationGroup[] = [];
      keys.forEach((key, index) => {
        const entity = entities.get(key);
        if (!entity || !vectors[index]) return;
        const neighbors = queryGraphEntityVectorNeighbors(libraryPath, vectors[index], ARBITRATION_MAX_CANDIDATES + 1, profile.profileHash);
        const candidates = filterAliasCandidates(neighbors, { sourceKey: key, type: entity.type })
          .map((candidate) => ({ ...candidate, description: descriptions.get(candidate.candidateKey) ?? '' }));
        if (candidates.length > 0) groups.push({ sourceKey: key, source: entity, candidates });
      });
      if (groups.length === 0) {
        this.options.onLog?.(`[PIPELINE] 别名裁决：${keys.length} 个实体无候选，跳过仲裁。`);
        return { entitiesDirs: defaultDirs };
      }

      // 裁决：缓存命中的候选组不重复调用；强契约输出校验失败该组记痕跳过。
      // Arbitration: cached candidate groups are not re-called; groups whose strict-contract output validation fails are stamped and skipped.
      const cachePath = path.join(libraryGraphRoot(libraryPath), ALIAS_ARBITRATION_CACHE_FILE_NAME);
      const { result, newRecords } = await arbitrateAliasGroups({
        groups,
        graphKey,
        modelFingerprint: fingerprint,
        callArbitrate: async (text) => {
          const responses = await this.pipelineLlmCoordinator.completeRequests({
            requests: [{
              requestId: `alias-arbitration-${crypto.randomUUID()}`,
              documentId: `graph:${graphKey.slice(0, 12)}`,
              text,
              inputHash: graphKey,
              maxChars: config.maxChars,
            }],
            callKind: 'graph-alias-arbitration',
            timeoutMs: config.llmTimeoutMs,
            maxOutputTokens: config.llmMaxOutputTokens,
            signal: controller.signal,
            ...(providerConfig ? { providerConfig } : {}),
            skipAvailabilityCheck: true,
          });
          return responses[0]?.output ?? '';
        },
        existingCache: readAliasArbitrationCache(cachePath),
        signal: controller.signal,
      });
      appendAliasArbitrationCache(cachePath, newRecords);
      writeAliasArtifacts(stagingDirectory, result.records, result.aliasMap);
      const mergedCount = Object.keys(result.aliasMap).length;
      const pendingCount = result.records.filter((record) => record.status === 'pending').length;
      const failedCount = result.records.filter((record) => record.status === 'failed').length;
      this.options.onLog?.(`[PIPELINE] 别名裁决完成：${groups.length} 组候选（新增调用 ${newRecords.length}），合并 ${mergedCount}，待复核 ${pendingCount}，失败 ${failedCount}。`);
      if (mergedCount === 0) return { entitiesDirs: defaultDirs };

      aliasDirectory = path.join(libraryGraphRoot(libraryPath), `.staging-alias-${graphKey.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`);
      fs.mkdirSync(aliasDirectory, { recursive: true });
      const entitiesDirs = applyAliasMapToEntitiesDirs({ entries, aliasMap: result.aliasMap, stagingRoot: aliasDirectory });
      return { entitiesDirs, aliasDirectory };
    } catch (error) {
      if (aliasDirectory && fs.existsSync(aliasDirectory)) fs.rmSync(aliasDirectory, { recursive: true, force: true });
      this.options.onLog?.(`[PIPELINE] 别名裁决失败（不影响图谱，回退原始产物）：${error instanceof Error ? error.message : String(error)}`);
      return { entitiesDirs: defaultDirs };
    }
  }

  /**
   * Enumerates committed entities artifact directories and stageKeys under the current config fingerprint.
   * 枚举各文档在当前配置指纹下已提交成功的 entities 产物目录与 stageKey。
   */
  private collectCommittedEntities(libraryPath: string): Array<{ documentId: string; stageKey: string; directory: string }> {
    const entries: Array<{ documentId: string; stageKey: string; directory: string }> = [];
    for (const document of listMaterialsDocuments(libraryPath)) {
      let layout: ReturnType<typeof prepareParseLayout>;
      try {
        layout = this.createLayout(libraryPath, document, this.getMineruConfig().endpoint);
      } catch {
        continue;
      }
      const stage = readPipelineManifest(layout)?.stages.entities;
      if (!stage || stage.status !== 'SUCCEEDED' || !stage.stageKey) continue;
      if (!fs.existsSync(path.join(layout.entitiesDirectory, 'entities.jsonl'))) continue;
      entries.push({ documentId: document.id, stageKey: stage.stageKey, directory: layout.entitiesDirectory });
    }
    return entries.sort((first, second) => first.documentId.localeCompare(second.documentId));
  }

  private async enqueueParse(libraryPath: string, documentId: string): Promise<PipelineDocumentStatus> {
    if (isRestorePaused(libraryPath)) throw new WorkerClientError('RESTORE_TASKS_PAUSED', '恢复的后台任务保持暂停，请在备份与恢复设置中主动恢复处理。', false);
    if (this.maintenancePaused) throw new Error('正在备份或恢复，请稍后开始资料处理。');
    const document = findMaterialsDocument(libraryPath, documentId);
    if (!document) throw new Error('找不到要处理的资料文档。');
    const key = jobKey(libraryPath, documentId);
    if (this.removingKeys.has(key)) throw new Error('该资料文档正在删除，请稍后重试。');
    const config = this.getMineruConfig();
    const layout = this.createLayout(libraryPath, document, config.endpoint);
    if (this.activeJobs.has(key) || this.queuedKeys.has(key)) return this.getStatus(libraryPath, document);
    if (layout.route === 'unsupported') {
      const unsupported = this.getStatus(libraryPath, document);
      this.options.onStatus?.(unsupported);
      return unsupported;
    }
    const pendingStage = await nextPendingStage(layout);
    if (!pendingStage) {
      const status = this.getStatus(libraryPath, document);
      this.options.onStatus?.(status);
      return status;
    }
    if (pendingStage === 'parse' && layout.route === 'mineru' && !this.cloudAuthorization.has(libraryPath, document)) {
      markStageState(layout, 'parse', 'WAITING_CONFIG', cloudAuthorizationRequired());
      const waiting = this.getStatus(libraryPath, document);
      this.options.onStatus?.(waiting);
      return waiting;
    }
    if (pendingStage === 'parse' && layout.route === 'mineru' && !this.hasMineruConfig()) {
      markStageState(layout, 'parse', 'WAITING_CONFIG', mineruConfigError());
      const waiting = this.getStatus(libraryPath, document);
      this.options.onStatus?.(waiting);
      return waiting;
    }
    if (pendingStage === 'vectors' && !hasLockedMaterialEmbeddingProfile(libraryPath)) {
      markStageState(layout, 'vectors', 'WAITING_CONFIG', embeddingProfileRequiredError());
      const waiting = this.getStatus(libraryPath, document);
      this.options.onStatus?.(waiting);
      return waiting;
    }

    markStageState(layout, pendingStage, 'QUEUED');
    this.queue.push({ key, libraryPath, documentId });
    this.queuedKeys.add(key);
    const queued = this.getStatus(libraryPath, document);
    this.options.onStatus?.(queued);
    void this.drainQueue();
    return queued;
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.maintenancePaused) {
        const queued = this.queue.shift()!;
        this.queuedKeys.delete(queued.key);
        if (this.removingKeys.has(queued.key) || isRestorePaused(queued.libraryPath)) continue;
        const document = findMaterialsDocument(queued.libraryPath, queued.documentId);
        if (!document) continue;
        const layout = this.createLayout(queued.libraryPath, document, this.getMineruConfig().endpoint);
        if (layout.route === 'unsupported') {
          this.options.onStatus?.(this.getStatus(queued.libraryPath, document));
          continue;
        }
        const pendingStage = await nextPendingStage(layout);
        if (this.removingKeys.has(queued.key)) continue;
        if (!pendingStage) {
          this.options.onStatus?.(this.getStatus(queued.libraryPath, document));
          continue;
        }
        if (pendingStage === 'parse' && layout.route === 'mineru' && !this.cloudAuthorization.has(queued.libraryPath, document)) {
          markStageState(layout, 'parse', 'WAITING_CONFIG', cloudAuthorizationRequired());
          this.options.onStatus?.(this.getStatus(queued.libraryPath, document));
          continue;
        }
        if (pendingStage === 'parse' && layout.route === 'mineru' && !this.hasMineruConfig()) {
          markStageState(layout, 'parse', 'WAITING_CONFIG', mineruConfigError());
          this.options.onStatus?.(this.getStatus(queued.libraryPath, document));
          continue;
        }
        if (pendingStage === 'vectors' && !hasLockedMaterialEmbeddingProfile(queued.libraryPath)) {
          markStageState(layout, 'vectors', 'WAITING_CONFIG', embeddingProfileRequiredError());
          this.options.onStatus?.(this.getStatus(queued.libraryPath, document));
          continue;
        }
        if (pendingStage === 'vectors' && readPipelineManifest(layout)?.stages.vectors?.status === 'RUNNING') {
          this.options.onStatus?.(this.getStatus(queued.libraryPath, document));
          continue;
        }

        const jobId = crypto.randomUUID();
        const active: ActiveJob = {
          ...queued,
          jobId,
          route: layout.route,
          currentStage: pendingStage,
          tempDirectories: {},
          abortController: new AbortController(),
          cancelRequested: false,
        };
        this.activeJobs.set(queued.key, active);
        const completion = this.executePipeline(layout, active);
        this.activeCompletions.set(queued.key, completion);
        try {
          await completion;
        } finally {
          this.activeJobs.delete(queued.key);
          this.activeCompletions.delete(queued.key);
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0 && !this.maintenancePaused) void this.drainQueue();
    }
  }

  private async executePipeline(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    try {
      if (!await isStageCacheValid(layout, 'parse')) {
        await this.executeParseStage(layout, active);
      }
      if (!await isStageCacheValid(layout, 'lines')) {
        await this.executeLinesStage(layout, active);
      }
      if (!await isStageCacheValid(layout, 'signals')) {
        await this.executeSignalsStage(layout, active);
      }
      if (!await isStageCacheValid(layout, 'ambiguity')) {
        await this.executeAmbiguityStage(layout, active);
      }
      if (!await isStageCacheValid(layout, 'tree')) {
        await this.executeTreeStage(layout, active);
      }
      if (!await isStageCacheValid(layout, 'chunks')) {
        await this.executeChunksStage(layout, active);
      }
      if (!await isStageCacheValid(layout, 'keywords')) {
        await this.executeKeywordsStage(layout, active);
      } else {
        const keywordStage = readPipelineManifest(layout)?.stages.keywords;
        const expectedChunks = Number(keywordStage?.counts?.chunks) || 0;
        const expectedKeywords = Number(keywordStage?.counts?.keywords) || 0;
        if (!keywordStage || !isKeywordIndexCurrent({
          libraryPath: layout.libraryPath,
          documentId: layout.document.id,
          sourceContentHash: layout.document.contentHash,
          stageKey: keywordStage.stageKey,
          expectedChunks,
          expectedKeywords,
        })) {
          await this.importCommittedKeywordsStage(layout);
        }
      }
      this.triggerAsyncVectorSync(layout, active.jobId);
      await this.executeEntitiesStage(layout, active);
      this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    } catch (error) {
      const normalized = normalizeError(error);
      const stage = active.currentStage;
      const tempDirectory = active.tempDirectories[stage];
      if (tempDirectory && !shouldPreserveCheckpoint(stage, normalized.code)) cleanupStageTempDirectory(tempDirectory);
      const state = active.cancelRequested || normalized.code === 'STAGE_CANCELLED'
        ? 'CANCELLED'
        : normalized.code === 'MINERU_CONFIG_REQUIRED' || normalized.code === 'MINERU_KEY_REQUIRED' || normalized.code === 'CHUNK_LLM_CONFIG_REQUIRED' || normalized.code === 'GRAPH_LLM_CONFIG_REQUIRED' || normalized.code === 'EMBEDDING_PROFILE_REQUIRED'
          ? 'WAITING_CONFIG'
        : normalized.retryable ? 'FAILED_RETRYABLE' : 'FAILED';
      markStageState(layout, stage, state, normalized, active.jobId);
      this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    }
  }

  private triggerAsyncVectorSync(layout: ReturnType<typeof prepareParseLayout>, jobId: string): void {
    const keywordStage = readPipelineManifest(layout)?.stages.keywords;
    if (!keywordStage || keywordStage.status !== 'SUCCEEDED') return;
    const expectedChunks = Number(keywordStage.counts?.chunks) || 0;
    const expectedKeywords = Number(keywordStage.counts?.keywords) || 0;
    if (!isKeywordIndexCurrent({
      libraryPath: layout.libraryPath,
      documentId: layout.document.id,
      sourceContentHash: layout.document.contentHash,
      stageKey: keywordStage.stageKey,
      expectedChunks,
      expectedKeywords,
    })) return;
    if (isVectorProjectionCurrent(layout)) return;
    const syncKey = `${path.resolve(layout.libraryPath)}:${layout.document.id}`;
    if (this.activeAsyncVectorSyncs.has(syncKey)) return;
    markStageState(layout, 'vectors', 'RUNNING', undefined, jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    const sync = this.runAsyncVectorSync(layout).finally(() => this.activeAsyncVectorSyncs.delete(syncKey));
    this.activeAsyncVectorSyncs.set(syncKey, sync);
  }

  private async runAsyncVectorSync(layout: ReturnType<typeof prepareParseLayout>): Promise<void> {
    try {
      const profileStatus = readMaterialEmbeddingProfile(layout.libraryPath);
      if (profileStatus.state !== 'LOCKED' || !profileStatus.profile) return;
      const adapter = await this.options.getMaterialEmbeddingAdapter?.({ libraryPath: layout.libraryPath, profile: profileStatus.profile });
      if (!adapter) return;
      const startedAt = new Date().toISOString();
      const result = await synchronizeMaterialVectors({
        libraryPath: layout.libraryPath,
        documentId: layout.document.id,
        profile: profileStatus.profile,
        adapter,
      });
      if (result.state === 'CANCELLED') {
        markStageState(layout, 'vectors', 'CANCELLED');
        markMaterialsDocumentVectorState(layout.libraryPath, layout.document.id, 'pending');
        this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
        return;
      }
      if (result.state !== 'SUCCEEDED') {
        const error: PipelineError = { code: result.errorCode ?? 'EMBEDDING_BATCH_FAILED', message: result.errorMessage ?? '向量批处理未完成。', retryable: result.state === 'FAILED_RETRYABLE' };
        markStageState(layout, 'vectors', result.state === 'FAILED_RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED', error);
        markMaterialsDocumentVectorState(layout.libraryPath, layout.document.id, 'pending');
        this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
        return;
      }
      const profileStatus2 = readMaterialEmbeddingProfile(layout.libraryPath);
      if (profileStatus2.state !== 'LOCKED' || !profileStatus2.profile) return;
      const report: PipelineVectorReport = {
        schemaVersion: 1,
        documentId: layout.document.id,
        stageKey: vectorsStageKey(layout),
        profileHash: profileStatus2.profile.profileHash,
        sourceId: profileStatus2.profile.sourceId,
        model: profileStatus2.profile.responseModel ?? profileStatus2.profile.requestedModel,
        dimension: profileStatus2.profile.vectorDimension,
        distanceMetric: profileStatus2.profile.distanceMetric,
        counts: { chunks: result.totalItems, indexed: result.completedItems, skipped: result.skippedItems, failed: result.failedItems, batches: result.batchCount, retries: result.retryCount },
        usage: { available: false },
        startedAt: result.startedAt ?? startedAt,
        completedAt: result.finishedAt ?? new Date().toISOString(),
      };
      const vectorsDir = stageDirectory(layout, 'vectors');
      fs.mkdirSync(vectorsDir, { recursive: true });
      fs.writeFileSync(path.join(vectorsDir, 'vector-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      commitVectorsStage(layout, vectorsDir);
      markMaterialsDocumentVectorState(layout.libraryPath, layout.document.id, 'indexed');
      this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markStageState(layout, 'vectors', 'FAILED_RETRYABLE', { code: 'EMBEDDING_ASYNC_FAILED', message, retryable: true });
      markMaterialsDocumentVectorState(layout.libraryPath, layout.document.id, 'pending');
      this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    }
  }

  private async executeParseStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'parse';
    const tempDirectory = createStageTempDirectory(layout, 'parse', active.jobId);
    active.tempDirectories.parse = tempDirectory;
    markStageState(layout, 'parse', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    if (layout.route === 'direct') {
      const sink = createParseImageSink(tempDirectory);
      planDirectMarkdownImages({
        sourcePath: layout.document.absolutePath,
        libraryPath: layout.libraryPath,
        sink,
      });
      await runDirectTextParse({
        inputPath: layout.document.absolutePath,
        outputDir: tempDirectory,
        extension: layout.document.extension,
        signal: active.abortController.signal,
        onProgress: (progress) => this.emitProgress(active, 'parse', progress.completed, progress.total, 'line', progress.message),
        imageRewrites: sink.rewriteMap(),
        extraCounts: { images: sink.savedCount(), imagesSkipped: sink.skippedCount() },
      });
      sink.writeManifest(tempDirectory);
    } else if (layout.route === 'mineru') {
      if (!this.cloudAuthorization.has(layout.libraryPath, layout.document)) throw new PipelineStageError('CLOUD_AUTHORIZATION_REQUIRED', cloudAuthorizationRequired().message, false);
      const config = this.getMineruConfig();
      if (!config.apiKey || !config.cloudParsingConsent) throw new PipelineStageError('MINERU_CONFIG_REQUIRED', '请先配置 MinerU API Key 并确认 PDF 云端解析授权。', false);
      await runMineruPdfParse({
        inputPath: layout.document.absolutePath,
        outputDir: tempDirectory,
        documentId: layout.document.id,
        expectedContentHash: layout.document.contentHash,
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        signal: active.abortController.signal,
        onProgress: (progress) => this.emitProgress(active, 'parse', progress.completed, progress.total, 'page', progress.message),
      });
    } else if (layout.route === 'mammoth') {
      await runMammothDocxParse({
        inputPath: layout.document.absolutePath,
        outputDir: tempDirectory,
        sourceName: layout.document.name,
        signal: active.abortController.signal,
        onProgress: (progress) => this.emitProgress(active, 'parse', progress.completed, progress.total, 'document', progress.message),
      });
    } else if (layout.route === 'custom') {
      const customRoute = getCustomParsingRoute(layout.document.extension);
      if (!customRoute) throw new PipelineStageError('UNSUPPORTED_FORMAT', unsupportedFormatError(layout.document.extension).message, false);
      const output = await customRoute.handler({
        inputPath: layout.document.absolutePath,
        outputDir: tempDirectory,
        extension: layout.document.extension,
        signal: active.abortController.signal,
        onProgress: (completed, total, message) => this.emitProgress(active, 'parse', completed, total, 'document', message),
      });
      // The plugin handler writes markdown into tempDirectory; verify it produced a manifest-ready output.
      // 插件处理器把 markdown 写入 tempDirectory；校验其产出可用。
      if (!output?.markdownFile) throw new PipelineStageError('PARSE_OUTPUT_INVALID', '插件解析器未返回 markdownFile。', false);
    } else {
      throw new PipelineStageError('UNSUPPORTED_FORMAT', unsupportedFormatError(layout.document.extension).message, false);
    }
    await verifySourceUnchanged(layout);
    await commitParseStage(layout, tempDirectory);
    active.tempDirectories.parse = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeLinesStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'lines';
    assertParseArtifactsAvailable(layout);
    const tempDirectory = createStageTempDirectory(layout, 'lines', active.jobId);
    active.tempDirectories.lines = tempDirectory;
    markStageState(layout, 'lines', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    await this.worker.runStage({
      jobId: active.jobId,
      stage: 'lines',
      inputPath: layout.parseDirectory,
      outputDir: tempDirectory,
      options: { stageKey: linesStageKey(layout) },
    });
    await verifySourceUnchanged(layout);
    await commitLinesStage(layout, tempDirectory);
    active.tempDirectories.lines = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeSignalsStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'signals';
    const tempDirectory = createStageTempDirectory(layout, 'signals', active.jobId);
    active.tempDirectories.signals = tempDirectory;
    markStageState(layout, 'signals', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    await this.worker.runStage({
      jobId: active.jobId,
      stage: 'signals',
      inputPath: pathJoin(layout.linesDirectory, 'lines.jsonl'),
      outputDir: tempDirectory,
      options: {
        stageKey: signalsStageKey(layout),
        documentId: layout.document.id,
        contentHash: layout.document.contentHash,
      },
    });
    await verifySourceUnchanged(layout);
    await commitSignalsStage(layout, tempDirectory);
    active.tempDirectories.signals = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeAmbiguityStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'ambiguity';
    const tempDirectory = createStageTempDirectory(layout, 'ambiguity', active.jobId);
    active.tempDirectories.ambiguity = tempDirectory;
    markStageState(layout, 'ambiguity', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    await runAmbiguityStage({
      inputPath: pathJoin(layout.signalsDirectory, 'signals.jsonl'),
      outputDir: tempDirectory,
      documentId: layout.document.id,
      contentHash: layout.document.contentHash,
      stageKey: ambiguityStageKey(layout),
      config: this.getAmbiguityConfig(),
      model: this.getAmbiguityModel(layout.libraryPath),
      signal: active.abortController.signal,
      onProgress: (completed, total, unit, message) => this.emitProgress(active, 'ambiguity', completed, total, unit, message),
    });
    await verifySourceUnchanged(layout);
    await commitAmbiguityStage(layout, tempDirectory);
    active.tempDirectories.ambiguity = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeTreeStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'tree';
    const tempDirectory = createStageTempDirectory(layout, 'tree', active.jobId);
    active.tempDirectories.tree = tempDirectory;
    markStageState(layout, 'tree', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    await this.worker.runStage({
      jobId: active.jobId,
      stage: 'tree',
      inputPath: layout.ambiguityDirectory,
      outputDir: tempDirectory,
      options: {
        stageKey: treeStageKey(layout),
        documentId: layout.document.id,
        contentHash: layout.document.contentHash,
      },
    });
    await verifySourceUnchanged(layout);
    await commitTreeStage(layout, tempDirectory);
    active.tempDirectories.tree = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeChunksStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'chunks';
    const tempDirectory = createStageTempDirectory(layout, 'chunks', active.jobId);
    active.tempDirectories.chunks = tempDirectory;
    markStageState(layout, 'chunks', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    const v2Config = layout.chunkingV2Enabled
      ? (this.options.getChunkingConfig?.(layout.libraryPath) ?? readLibraryChunkingConfig(layout.libraryPath))
      : undefined;
    const config = v2Config ?? this.getStructureConfig();
    const baseOptions = {
      stageKey: chunksStageKey(layout),
      documentId: layout.document.id,
      contentHash: layout.document.contentHash,
      chunkingV2: layout.chunkingV2Enabled,
      sourceBlocksPath: layout.chunkingV2Enabled ? path.join(layout.parseDirectory, 'blocks.jsonl') : undefined,
      config,
    };
    const mayUseLlm = Boolean(v2Config && isLlmEligibleChunkingConfig(v2Config));
    const manuallySelectedLlm = Boolean(v2Config && v2Config.mode === 'custom' && v2Config.childStrategies.includes('LLM'));
    const availability: PipelineLlmAvailability = mayUseLlm
      ? await this.pipelineLlmCoordinator.getAvailability(this.getPipelineLlmConfig(layout.libraryPath))
      : { available: false, model: '' };
    if (manuallySelectedLlm && !availability.available) {
      throw new PipelineStageError('CHUNK_LLM_CONFIG_REQUIRED', availability.message ?? '智能切块模型不可用。', false);
    }
    if (mayUseLlm && availability.available) {
      await this.worker.runStage({
        jobId: active.jobId,
        stage: 'chunks',
        inputPath: layout.treeDirectory,
        outputDir: tempDirectory,
        options: { ...baseOptions, llmPhase: 'prepare' },
      });
      const requestsPath = path.join(tempDirectory, 'chunk-llm-requests.jsonl');
      if (fs.existsSync(requestsPath)) {
        const requests = readChunkLlmRequests(requestsPath);
        const responses = await this.pipelineLlmCoordinator.completeRequests({
          requests,
          timeoutMs: v2Config!.llmTimeoutMs,
          maxOutputTokens: v2Config!.llmMaxOutputTokens,
          signal: active.abortController.signal,
          ...(this.getPipelineLlmConfig(layout.libraryPath) ? { providerConfig: this.getPipelineLlmConfig(layout.libraryPath) } : {}),
          onProgress: (completed, total) => this.emitProgress(active, 'chunks', completed, total, 'llm-request', `正在完成智能切块请求 ${completed}/${total}。`),
        });
        if (active.abortController.signal.aborted) throw new PipelineStageError('STAGE_CANCELLED', '处理任务已取消。', true);
        await this.worker.runStage({
          jobId: active.jobId,
          stage: 'chunks',
          inputPath: layout.treeDirectory,
          outputDir: tempDirectory,
          options: { ...baseOptions, llmPhase: 'finalize', llmResponses: responses },
        });
      }
    } else await this.worker.runStage({
      jobId: active.jobId,
      stage: 'chunks',
      inputPath: layout.treeDirectory,
      outputDir: tempDirectory,
      options: { ...baseOptions, llmAvailable: false },
    });
    await verifySourceUnchanged(layout);
    await commitChunksStage(layout, tempDirectory);
    active.tempDirectories.chunks = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeKeywordsStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'keywords';
    assertChunksArtifactsAvailable(layout);
    const resources = this.getKeywordResources(layout.libraryPath);
    if (resources.validationError) {
      throw new PipelineStageError(resources.validationError.code, resources.validationError.message, false);
    }
    const tempDirectory = createStageTempDirectory(layout, 'keywords', active.jobId);
    active.tempDirectories.keywords = tempDirectory;
    markStageState(layout, 'keywords', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    await this.worker.runStage({
      jobId: active.jobId,
      stage: 'keywords',
      inputPath: pathJoin(layout.chunksDirectory, 'chunks.jsonl'),
      outputDir: tempDirectory,
      options: {
        stageKey: keywordsStageKey(layout),
        documentId: layout.document.id,
        contentHash: layout.document.contentHash,
        tokenizer: resources.config.tokenizer,
        config: resources.config,
        dictionaryTerms: resources.dictionaryTerms,
        stopwords: resources.stopwords,
      },
    });
    await verifySourceUnchanged(layout);
    await commitKeywordsStage(layout, tempDirectory);
    await this.importCommittedKeywordsStage(layout);
    active.tempDirectories.keywords = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeVectorsStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'vectors';
    const keywordStage = readPipelineManifest(layout)?.stages.keywords;
    if (!keywordStage || keywordStage.status !== 'SUCCEEDED') {
      throw new PipelineStageError('KEYWORDS_ARTIFACT_MISSING', '关键词阶段尚未提交，无法开始向量阶段。', true);
    }
    const expectedChunks = Number(keywordStage.counts?.chunks) || 0;
    const expectedKeywords = Number(keywordStage.counts?.keywords) || 0;
    if (!isKeywordIndexCurrent({
      libraryPath: layout.libraryPath,
      documentId: layout.document.id,
      sourceContentHash: layout.document.contentHash,
      stageKey: keywordStage.stageKey,
      expectedChunks,
      expectedKeywords,
    })) {
      await this.importCommittedKeywordsStage(layout);
    }

    const tempDirectory = createStageTempDirectory(layout, 'vectors', active.jobId);
    active.tempDirectories.vectors = tempDirectory;
    markStageState(layout, 'vectors', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    const startedAt = new Date().toISOString();
    const snapshot = readMaterialVectorProjectionSnapshot(layout.libraryPath, layout.document.id);
    let result = snapshot && snapshot.profile.profileHash === layout.vectorProfileHash
      && snapshot.progress.totalItems === snapshot.progress.completedItems
      && snapshot.progress.pendingItems === 0
      && snapshot.progress.inFlightItems === 0
      && snapshot.progress.failedItems === 0
      ? {
        schemaVersion: 1 as const,
        jobId: `reconcile-${active.jobId}`,
        profileHash: snapshot.profile.profileHash,
        state: 'SUCCEEDED' as const,
        totalItems: snapshot.progress.totalItems,
        completedItems: snapshot.progress.completedItems,
        skippedItems: snapshot.progress.completedItems,
        failedItems: 0,
        batchCount: 0,
        retryCount: 0,
        startedAt,
        finishedAt: new Date().toISOString(),
      }
      : undefined;
    if (!result) {
      const profileStatus = readMaterialEmbeddingProfile(layout.libraryPath);
      if (profileStatus.state !== 'LOCKED' || !profileStatus.profile) {
        throw new PipelineStageError('EMBEDDING_PROFILE_REQUIRED', '资料库尚未锁定向量模型，无法开始 vectors 阶段。', false);
      }
      if (profileStatus.profile.profileHash !== layout.vectorProfileHash) {
        throw new PipelineStageError('EMBEDDING_PROFILE_MISMATCH', '流水线布局中的向量 profile 已过期，请重新入队。', true);
      }
      const adapter = await this.options.getMaterialEmbeddingAdapter?.({ libraryPath: layout.libraryPath, profile: profileStatus.profile });
      if (!adapter) throw new PipelineStageError('EMBEDDING_RUNTIME_UNAVAILABLE', '锁定的向量模型当前没有可用运行时凭据，请检查连接和授权。', true);
      result = await synchronizeMaterialVectors({
        libraryPath: layout.libraryPath,
        documentId: layout.document.id,
        profile: profileStatus.profile,
        adapter,
        signal: active.abortController.signal,
        shouldCancel: () => active.cancelRequested,
        onProgress: (progress) => this.emitProgress(active, 'vectors', progress.completedItems, progress.totalItems, 'chunk', `正在生成资料库向量 ${progress.completedItems}/${progress.totalItems}。`),
      });
    }
    if (result.state === 'CANCELLED') throw new PipelineStageError('STAGE_CANCELLED', '向量处理任务已取消。', true);
    if (result.state !== 'SUCCEEDED') {
      throw new PipelineStageError(result.errorCode ?? 'EMBEDDING_BATCH_FAILED', result.errorMessage ?? '向量批处理未完成。', result.state === 'FAILED_RETRYABLE');
    }
    const profileStatus = readMaterialEmbeddingProfile(layout.libraryPath);
    if (profileStatus.state !== 'LOCKED' || !profileStatus.profile) throw new PipelineStageError('EMBEDDING_PROFILE_REQUIRED', '向量报告生成前未找到锁定 profile。', false);
    const report: PipelineVectorReport = {
      schemaVersion: 1,
      documentId: layout.document.id,
      stageKey: vectorsStageKey(layout),
      profileHash: profileStatus.profile.profileHash,
      sourceId: profileStatus.profile.sourceId,
      model: profileStatus.profile.responseModel ?? profileStatus.profile.requestedModel,
      dimension: profileStatus.profile.vectorDimension,
      distanceMetric: profileStatus.profile.distanceMetric,
      counts: {
        chunks: result.totalItems,
        indexed: result.completedItems,
        skipped: result.skippedItems,
        failed: result.failedItems,
        batches: result.batchCount,
        retries: result.retryCount,
      },
      usage: { available: false },
      startedAt: result.startedAt ?? startedAt,
      completedAt: result.finishedAt ?? new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tempDirectory, 'vector-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await commitVectorsStage(layout, tempDirectory);
    active.tempDirectories.vectors = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
  }

  private async executeEntitiesStage(layout: ReturnType<typeof prepareParseLayout>, active: ActiveJob): Promise<void> {
    active.currentStage = 'entities';
    const graphConfig = this.getGraphEnhancementConfig(layout.libraryPath);
    if (!graphConfig.enabled) {
      // 图谱增强是 opt-in 阶段：关闭时不阻塞流水线，只留下可展示的状态。
      // Graph enhancement is an opt-in stage: when disabled it does not block the pipeline, only leaves a displayable state.
      markStageState(layout, 'entities', 'SKIPPED', undefined, active.jobId);
      this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
      return;
    }
    if (await isStageCacheValid(layout, 'entities')) return;
    assertChunksArtifactsAvailable(layout);
    const tempDirectory = createStageTempDirectory(layout, 'entities', active.jobId);
    active.tempDirectories.entities = tempDirectory;
    markStageState(layout, 'entities', 'RUNNING', undefined, active.jobId);
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    const baseOptions = {
      stageKey: entitiesStageKey(layout),
      documentId: layout.document.id,
      contentHash: layout.document.contentHash,
      config: {
        promptVersion: graphConfig.promptVersion,
        maxChars: graphConfig.maxChars,
        maxEntitiesPerChunk: graphConfig.maxEntitiesPerChunk,
        maxRelationsPerChunk: graphConfig.maxRelationsPerChunk,
      },
    };
    await this.worker.runStage({
      jobId: active.jobId,
      stage: 'entities',
      inputPath: layout.chunksDirectory,
      outputDir: tempDirectory,
      options: { ...baseOptions, llmPhase: 'prepare' },
    });
    const requestsPath = path.join(tempDirectory, 'entities-llm-requests.jsonl');
    if (!fs.existsSync(requestsPath)) {
      throw new PipelineStageError('ENTITIES_REQUESTS_MISSING', '实体抽取准备阶段没有生成请求产物。', true);
    }
    const requests = readEntitiesLlmRequests(requestsPath);
    const responses = await this.pipelineLlmCoordinator.completeRequests({
      requests,
      callKind: 'graph-entities',
      timeoutMs: graphConfig.llmTimeoutMs,
      maxOutputTokens: graphConfig.llmMaxOutputTokens,
      signal: active.abortController.signal,
      ...(this.getPipelineLlmConfig(layout.libraryPath) ? { providerConfig: this.getPipelineLlmConfig(layout.libraryPath) } : {}),
      onProgress: (completed, total) => this.emitProgress(active, 'entities', completed, total, 'llm-request', `正在完成实体抽取请求 ${completed}/${total}。`),
    });
    if (active.abortController.signal.aborted) throw new PipelineStageError('STAGE_CANCELLED', '处理任务已取消。', true);
    await this.worker.runStage({
      jobId: active.jobId,
      stage: 'entities',
      inputPath: layout.chunksDirectory,
      outputDir: tempDirectory,
      options: { ...baseOptions, llmPhase: 'finalize', llmResponses: responses },
    });
    await verifySourceUnchanged(layout);
    await commitEntitiesStage(layout, tempDirectory);
    active.tempDirectories.entities = undefined;
    this.options.onStatus?.(this.getStatus(layout.libraryPath, layout.document));
    this.scheduleLibraryGraphRebuild(layout.libraryPath);
  }

  private async importCommittedKeywordsStage(layout: ReturnType<typeof prepareParseLayout>): Promise<void> {
    const manifest = readPipelineManifest(layout);
    const stage = manifest?.stages.keywords;
    if (!stage || stage.status !== 'SUCCEEDED') {
      throw new PipelineStageError('KEYWORDS_ARTIFACT_MISSING', '关键词阶段产物尚未提交，无法更新检索索引。', true);
    }
    const result = await importKeywordsStage({
      libraryPath: layout.libraryPath,
      documentId: layout.document.id,
        sourceContentHash: layout.document.contentHash,
        stageKey: stage.stageKey,
        chunksPath: pathJoin(layout.chunksDirectory, 'chunks.jsonl'),
        ...(layout.chunkingV2Enabled ? { parentsPath: pathJoin(layout.chunksDirectory, 'parents.jsonl') } : {}),
        keywordsPath: pathJoin(layout.keywordsDirectory, 'keywords.jsonl'),
    });
    const expectedChunks = Number(stage.counts?.chunks);
    const expectedKeywords = Number(stage.counts?.keywords);
    if ((Number.isFinite(expectedChunks) && result.readBackChunks !== expectedChunks)
      || (Number.isFinite(expectedKeywords) && result.readBackKeywords !== expectedKeywords)) {
      throw new PipelineStageError('KEYWORDS_INDEX_COUNT_MISMATCH', '关键词索引数量与阶段产物不一致，事务已回滚。', true);
    }
  }

  private emitProgress(active: ActiveJob, stage: PipelineStageId, completed: number, total: number | undefined, unit: string, message: string): void {
    this.options.onProgress?.({
      libraryPath: active.libraryPath,
      documentId: active.documentId,
      jobId: active.jobId,
      stage,
      completed,
      ...(total === undefined ? {} : { total }),
      unit,
      message,
    });
  }

  private getMineruConfig(): MineruRuntimeConfig {
    return this.options.getMineruConfig?.() ?? { endpoint: '', cloudParsingConsent: true };
  }

  private getAmbiguityConfig(): PipelineAmbiguityConfig {
    return this.options.getAmbiguityConfig?.() ?? DEFAULT_PIPELINE_AMBIGUITY_CONFIG;
  }

  private getAmbiguityModel(libraryPath: string): AmbiguityModelClient {
    return this.options.getAmbiguityModel?.(libraryPath) ?? {
      provider: 'none',
      model: '',
      available: false,
      generateJson: async () => { throw new Error('没有可用的歧义消解模型。'); },
    };
  }

  private getPipelineLlmConfig(libraryPath: string): AiProviderConfig | undefined {
    return this.options.getPipelineLlmConfig?.(libraryPath);
  }

  private getStructureConfig(): PipelineStructureConfig {
    return this.options.getStructureConfig?.() ?? DEFAULT_PIPELINE_STRUCTURE_CONFIG;
  }

  private getKeywordResources(libraryPath: string): KeywordStageResources {
    return this.options.getKeywordResources?.(libraryPath) ?? readLibraryKeywordStageResources(libraryPath);
  }

  private getGraphEnhancementConfig(libraryPath: string): LibraryGraphEnhancementConfig {
    try {
      return this.options.getGraphEnhancementConfig?.(libraryPath) ?? readLibraryGraphEnhancementConfig(libraryPath);
    } catch {
      // 配置损坏时退回默认值（默认关闭），不能因此阻塞其他阶段。
      // When config is corrupted, fall back to defaults (disabled); must not block other stages.
      return this.options.getGraphEnhancementConfig?.(libraryPath) ?? { schemaVersion: 1, enabled: false, maxChars: 6000, maxEntitiesPerChunk: 20, maxRelationsPerChunk: 30, promptVersion: 'graph-entities-v3', llmTimeoutMs: 60_000, llmMaxOutputTokens: 4_000, leidenConfig: { ...DEFAULT_LIBRARY_LEIDEN_CONFIG } };
    }
  }

  private createLayout(libraryPath: string, document: MaterialsDocument, mineruEndpoint: string): ReturnType<typeof prepareParseLayout> {
    const config = this.getAmbiguityConfig();
    const model = this.getAmbiguityModel(libraryPath);
    const pipelineLlmConfig = this.getPipelineLlmConfig(libraryPath);
    const chunkingEnabled = pipelineChunkingV2Enabled();
    const chunkingConfig = chunkingEnabled ? (this.getChunkingConfig?.(libraryPath) ?? readLibraryChunkingConfig(libraryPath)) : undefined;
    const chunkingHash = chunkingConfig
      ? `${chunkingConfigHash(chunkingConfig)}:${isLlmEligibleChunkingConfig(chunkingConfig) ? this.pipelineLlmCoordinator.fingerprint(pipelineLlmConfig) : 'deterministic'}`
      : 'disabled';
    const vectorProfileHash = (() => {
      try { return readMaterialEmbeddingProfile(libraryPath).profile?.profileHash ?? 'UNBOUND'; } catch { return 'INVALID'; }
    })();
    const graphConfig = this.getGraphEnhancementConfig(libraryPath);
    const entitiesHash = graphConfig.enabled
      ? `${graphEnhancementConfigHash(graphConfig)}:${this.pipelineLlmCoordinator.fingerprint(pipelineLlmConfig)}`
      : 'disabled';
    return prepareParseLayout(libraryPath, document, mineruEndpoint, ambiguityConfigHash(config, {
      provider: model.provider,
      model: model.model,
      available: model.available,
      fingerprint: model.fingerprint,
    }), structureConfigHash(this.getStructureConfig()), keywordStageConfigHash(this.getKeywordResources(libraryPath)), chunkingHash, chunkingEnabled, vectorProfileHash, entitiesHash);
  }

  private hasMineruConfig(): boolean {
    const config = this.getMineruConfig();
    return Boolean(config.cloudParsingConsent && config.apiKey);
  }
}

function baseStatus(libraryPath: string, document: MaterialsDocument, route: ReturnType<typeof resolveParsingRoute>): PipelineDocumentStatus {
  return {
    libraryPath,
    documentId: document.id,
    documentName: document.name,
    extension: document.extension,
    route,
    sourceContentHash: document.contentHash,
    stage: 'parse',
    state: 'IDLE',
    updatedAt: new Date().toISOString(),
  };
}

function buildFtsIndexStatus(layout: ReturnType<typeof prepareParseLayout>, keywordStage: PipelineStageManifest | undefined): PipelineFtsIndexStatus {
  const expectedChunks = Number(keywordStage?.counts?.chunks) || 0;
  const expectedKeywords = Number(keywordStage?.counts?.keywords) || 0;
  const base = {
    tokenizer: 'jieba-accurate-hmm-off' as const,
    outputSchemaVersion: 3 as const,
    expectedChunks,
    expectedKeywords,
    indexedChunks: 0,
    ftsRows: 0,
    indexedKeywords: 0,
  };
  if (!keywordStage || !['SUCCEEDED', 'FAILED', 'FAILED_RETRYABLE', 'INTERRUPTED'].includes(keywordStage.status)) {
    return { ...base, state: 'PENDING' };
  }
  if (keywordStage.status !== 'SUCCEEDED') {
    return {
      ...base,
      state: 'FAILED',
      error: keywordStage.error ?? { code: 'FTS_INDEX_WRITE_FAILED', message: '关键词阶段未成功，FTS5 索引尚未写入。', retryable: true },
    };
  }
  try {
    const snapshot = readFtsIndexProjectionSnapshot(layout.libraryPath, layout.document.id);
    if (!snapshot) {
      return {
        ...base,
        state: 'MISSING',
        error: { code: 'FTS_INDEX_MISSING', message: '关键词产物已生成，但 SQLite FTS5 投影缺失。', retryable: true },
      };
    }
    const current = isKeywordIndexCurrent({
      libraryPath: layout.libraryPath,
      documentId: layout.document.id,
      sourceContentHash: layout.document.contentHash,
      stageKey: keywordStage.stageKey,
      expectedChunks,
      expectedKeywords,
    });
    return {
      ...base,
      state: current ? 'CURRENT' : 'STALE',
      indexedChunks: snapshot.indexedChunks,
      ftsRows: snapshot.ftsRows,
      indexedKeywords: snapshot.indexedKeywords,
      indexedAt: snapshot.indexedAt,
      ...(!current ? { error: { code: 'FTS_INDEX_STALE', message: 'SQLite FTS5 投影与当前关键词产物不一致，需要重建。', retryable: true } } : {}),
    };
  } catch {
    return {
      ...base,
      state: 'FAILED',
      error: { code: 'FTS_INDEX_STATUS_READ_FAILED', message: '无法读取 SQLite FTS5 索引状态，可以重试。', retryable: true },
    };
  }
}

function firstIncompleteStage(stages: Partial<Record<PipelineStageId, PipelineStageManifest>> | undefined, layout: ReturnType<typeof prepareParseLayout>, ftsCurrent: boolean): PipelineStageId | undefined {
  for (const stage of stageOrder) {
    if (stage === 'entities' && layout.entitiesConfigHash === 'disabled') continue;
    const entry = stages?.[stage];
    if (entry?.status === 'SKIPPED' && entry.stageKey === entitiesStageKey(layout)) continue;
    if (!entry
      || entry.status !== 'SUCCEEDED'
      || !isStageManifestCurrent(layout, stage)
      || (stage === 'keywords' && !ftsCurrent)
      || (stage === 'vectors' && !isVectorProjectionCurrent(layout))) return stage;
  }
  return undefined;
}

function aggregateCounts(stages: Partial<Record<PipelineStageId, PipelineStageManifest>> | undefined): Record<string, number> | undefined {
  if (!stages) return undefined;
  const counts: Record<string, number> = {};
  for (const stage of stageOrder) {
    for (const [key, value] of Object.entries(stages[stage]?.counts ?? {})) {
      if (typeof value === 'number') counts[key] = value;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function latestArtifactPath(stages: Partial<Record<PipelineStageId, PipelineStageManifest>> | undefined): string | undefined {
  for (const stage of [...stageOrder].reverse()) {
    const artifactPath = stages?.[stage]?.artifactPath;
    if (artifactPath) return artifactPath;
  }
  return undefined;
}

async function nextPendingStage(layout: ReturnType<typeof prepareParseLayout>): Promise<PipelineStageId | undefined> {
  const stages = readPipelineManifest(layout)?.stages;
  for (const stage of stageOrder) {
    if (stage === 'entities') {
      if (layout.entitiesConfigHash === 'disabled') continue;
      const entry = stages?.entities;
      if (entry?.status === 'SKIPPED' && entry.stageKey === entitiesStageKey(layout)) continue;
    }
    if (!await isStageCacheValid(layout, stage)
      || (stage === 'keywords' && buildFtsIndexStatus(layout, stages?.keywords).state !== 'CURRENT')
      || (stage === 'vectors' && !isVectorProjectionCurrent(layout))) return stage;
  }
  return undefined;
}

async function verifySourceUnchanged(layout: ReturnType<typeof prepareParseLayout>): Promise<void> {
  if (!fs.existsSync(layout.document.absolutePath)) throw new PipelineStageError('SOURCE_CHANGED', '原始文档在处理期间已不存在。', false);
  const currentHash = await hashFile(layout.document.absolutePath);
  if (currentHash !== layout.document.contentHash) throw new PipelineStageError('SOURCE_CHANGED', '原始文档在处理期间发生变化，请重新处理。', false);
}

function assertParseArtifactsAvailable(layout: ReturnType<typeof prepareParseLayout>): void {
  for (const fileName of ['document.md', 'blocks.jsonl']) {
    const filePath = path.join(layout.parseDirectory, fileName);
    try {
      if (!fs.statSync(filePath).isFile()) throw new Error('not-a-file');
    } catch {
      throw new PipelineStageError('PARSE_ARTIFACT_MISSING', `解析阶段产物不完整：缺少 ${fileName}，请先重试解析阶段。`, true);
    }
  }
}

function assertChunksArtifactsAvailable(layout: ReturnType<typeof prepareParseLayout>): void {
  const filePath = path.join(layout.chunksDirectory, 'chunks.jsonl');
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error('not-a-file');
  } catch {
    throw new PipelineStageError('CHUNKS_ARTIFACT_MISSING', '结构切块阶段产物不完整：缺少 chunks.jsonl，请先重试切块阶段。', true);
  }
}

function shouldPreserveCheckpoint(stage: PipelineStageId, code: string): boolean {
  return stage !== 'parse' && ['STAGE_CANCELLED', 'WORKER_TIMEOUT', 'WORKER_CRASHED', 'WORKER_START_FAILED'].includes(code);
}

function mineruConfigError(): PipelineError {
  return { code: 'MINERU_CONFIG_REQUIRED', message: 'PDF 需要先配置 MinerU API Key，并确认云端解析授权。', retryable: false };
}

function unsupportedFormatError(extension: string): PipelineError {
  const normalized = extension.trim().toLowerCase() || '该格式';
  return {
    code: 'UNSUPPORTED_FORMAT',
    message: `${normalized} 暂不支持解析。当前本地二进制文档仅支持 DOCX；旧 DOC、PPT/PPTX、XLS/XLSX 和 EPUB 请先转换为 DOCX、PDF 或纯文本。`,
    retryable: false,
  };
}

function isPythonWorkerStage(stage: PipelineStageId): boolean {
  return stage === 'lines' || stage === 'signals' || stage === 'tree' || stage === 'chunks' || stage === 'keywords' || stage === 'entities';
}

function embeddingProfileRequiredError(): PipelineError {
  return { code: 'EMBEDDING_PROFILE_REQUIRED', message: '资料库尚未锁定向量模型，请先测试并锁定一个向量 profile。', retryable: false };
}

function hasLockedMaterialEmbeddingProfile(libraryPath: string): boolean {
  try { return readMaterialEmbeddingProfile(libraryPath).state === 'LOCKED'; } catch { return false; }
}

/**
 * commit 前读取当前投影对应图目录的社区摘要，供重建时增量继承；任何缺失静默返回空。
 * Reads community summary records from the current projection's graph directory before commit,
 * for incremental inheritance during rebuild; returns empty silently on any missing state.
 */
function readPreviousGraphSummaryRecords(libraryPath: string): CommunitySummaryRecord[] {
  try {
    const status = readGraphProjectionStatus(libraryPath);
    if (!status?.graphKey) return [];
    return readCommunitySummaryRecords(libraryGraphDirectory(libraryPath, status.graphKey));
  } catch {
    return [];
  }
}

function normalizeError(error: unknown): PipelineError {
  if (error instanceof WorkerClientError || isPipelineStageError(error)) {
    return { code: error.code, message: error.message, diagnostic: error.diagnostic, retryable: error.retryable };
  }
  if (error instanceof MaterialEmbeddingProfileError) {
    return { code: error.code, message: error.message, diagnostic: error.diagnostic, retryable: error.retryable };
  }
  return { code: 'PIPELINE_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true };
}

function jobKey(libraryPath: string, documentId: string): string {
  return `${pathResolve(libraryPath)}:${documentId}`;
}

function pathResolve(value: string): string {
  return value.replace(/[\\/]+$/u, '').toLowerCase();
}

function pathJoin(left: string, right: string): string {
  return `${left.replace(/[\\/]+$/u, '')}/${right}`;
}

function isLlmEligibleChunkingConfig(config: LibraryChunkingConfig): boolean {
  return Boolean(config.llmEnabled && (
    config.childStrategies.includes('LLM')
    || (config.mode === 'recommended' && config.recommendLlmWhenLowQuality)
  ));
}

function readChunkLlmRequests(filePath: string): PipelineLlmRequest[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    throw new PipelineStageError('CHUNK_LLM_REQUESTS_MISSING', '智能切块请求产物无法读取。', true, error instanceof Error ? error.message : String(error));
  }
  const requests: PipelineLlmRequest[] = [];
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new PipelineStageError('CHUNK_LLM_REQUESTS_INVALID', '智能切块请求产物格式无效。', false); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PipelineStageError('CHUNK_LLM_REQUESTS_INVALID', '智能切块请求产物格式无效。', false);
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.requestId !== 'string' || typeof candidate.parentChunkId !== 'string' || typeof candidate.documentId !== 'string' || typeof candidate.text !== 'string' || typeof candidate.inputHash !== 'string' || typeof candidate.maxChars !== 'number') {
      throw new PipelineStageError('CHUNK_LLM_REQUESTS_INVALID', '智能切块请求产物字段不完整。', false);
    }
    requests.push({
      requestId: candidate.requestId,
      parentChunkId: candidate.parentChunkId,
      documentId: candidate.documentId,
      text: candidate.text,
      inputHash: candidate.inputHash,
      maxChars: candidate.maxChars,
    });
  }
  if (!requests.length) throw new PipelineStageError('CHUNK_LLM_REQUESTS_INVALID', '智能切块请求为空。', false);
  return requests;
}

function readEntitiesLlmRequests(filePath: string): PipelineLlmRequest[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    throw new PipelineStageError('GRAPH_LLM_REQUESTS_MISSING', '实体抽取请求产物无法读取。', true, error instanceof Error ? error.message : String(error));
  }
  const requests: PipelineLlmRequest[] = [];
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new PipelineStageError('GRAPH_LLM_REQUESTS_INVALID', '实体抽取请求产物格式无效。', false); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PipelineStageError('GRAPH_LLM_REQUESTS_INVALID', '实体抽取请求产物格式无效。', false);
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.requestId !== 'string' || typeof candidate.chunkId !== 'string' || typeof candidate.documentId !== 'string' || typeof candidate.text !== 'string' || typeof candidate.inputHash !== 'string' || typeof candidate.maxChars !== 'number') {
      throw new PipelineStageError('GRAPH_LLM_REQUESTS_INVALID', '实体抽取请求产物字段不完整。', false);
    }
    requests.push({
      requestId: candidate.requestId,
      chunkId: candidate.chunkId,
      parentChunkId: typeof candidate.parentChunkId === 'string' ? candidate.parentChunkId : '',
      documentId: candidate.documentId,
      text: candidate.text,
      inputHash: candidate.inputHash,
      maxChars: candidate.maxChars,
    });
  }
  if (!requests.length) throw new PipelineStageError('GRAPH_LLM_REQUESTS_INVALID', '实体抽取请求为空。', false);
  return requests;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
