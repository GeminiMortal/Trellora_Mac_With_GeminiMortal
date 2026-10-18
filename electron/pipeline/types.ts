/**
 * Shared pipeline domain types: protocol versions, stage manifests, status events and config shapes.
 * 流水线共享领域类型：协议版本、阶段清单、状态事件与配置结构。
 */

/** NDJSON worker protocol version / NDJSON Worker 协议版本 */
export const PIPELINE_PROTOCOL_VERSION = 1;
/** On-disk artifact schema version / 磁盘产物结构版本 */
export const PIPELINE_SCHEMA_VERSION = 1;
/** Engine version embedded in stage cache keys / 计入阶段缓存键的引擎版本 */
export const PIPELINE_ENGINE_VERSION = 'p5';

/** Which parser handles a document / 处理文档所用的解析器 */
export type ParsingRoute = 'direct' | 'mammoth' | 'mineru' | 'unsupported';
/** Ordered pipeline stage identifiers / 有序的流水线阶段标识 */
export type PipelineStageId = 'parse' | 'lines' | 'signals' | 'ambiguity' | 'tree' | 'chunks' | 'keywords' | 'vectors' | 'entities';
/** Lifecycle states of a pipeline stage / 流水线阶段的生命周期状态 */
export type PipelineStageState =
  | 'IDLE'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED_RETRYABLE'
  | 'FAILED'
  | 'WAITING_CONFIG'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'INTERRUPTED';

/**
 * Stable, user-facing error payload stored in manifests and sent over IPC.
 * 存于清单并通过 IPC 发送的稳定、面向用户的错误载荷。
 */
export interface PipelineError {
  /** Stable machine-readable code / 稳定的机器可读错误码 */
  code: string;
  /** Human-readable message / 可读的错误信息 */
  message: string;
  /** Optional developer diagnostics / 可选的开发者诊断信息 */
  diagnostic?: string;
  /** Whether retrying may succeed / 重试是否可能成功 */
  retryable: boolean;
}

/**
 * Per-stage record inside the pipeline manifest.
 * 流水线清单中的单阶段记录。
 */
export interface PipelineStageManifest {
  /** Cache key binding config and inputs / 绑定配置与输入的缓存键 */
  stageKey: string;
  /** Current stage state / 当前阶段状态 */
  status: PipelineStageState;
  /** Owning job id while running / 运行时的所属任务 ID */
  jobId?: string;
  /** Primary artifact path / 主产物路径 */
  artifactPath?: string;
  /** Start timestamp / 开始时间戳 */
  startedAt?: string;
  /** Finish timestamp / 结束时间戳 */
  finishedAt?: string;
  /** Last update timestamp / 最后更新时间戳 */
  updatedAt: string;
  /** Stage counters / 阶段计数 */
  counts?: Record<string, number>;
  /** Declared outputs with integrity hashes / 带完整性哈希的声明输出 */
  outputs?: Record<string, { relativePath: string; sha256: string; bytes: number }>;
  /** Last error if any / 如有则为最后一次错误 */
  error?: PipelineError;
}

/**
 * Root manifest tracking every stage of one document pipeline.
 * 跟踪单文档流水线全部阶段的根清单。
 */
export interface PipelineManifest {
  /** Manifest schema version / 清单结构版本 */
  schemaVersion: number;
  /** Document id / 文档 ID */
  documentId: string;
  /** Document display name / 文档显示名称 */
  documentName: string;
  /** Source file content hash / 源文件内容哈希 */
  sourceContentHash: string;
  /** Source path relative to the library / 相对资料库的源路径 */
  sourceRelativePath: string;
  /** Parsing route / 解析路由 */
  route: ParsingRoute;
  /** Engine identifier / 引擎标识 */
  engine: string;
  /** Protocol version / 协议版本 */
  protocolVersion: number;
  /** Cache fingerprint for this run / 本次运行的缓存指纹 */
  pipelineFingerprint: string;
  /** Last update timestamp / 最后更新时间戳 */
  updatedAt: string;
  /** Stage manifests by stage id / 按阶段 ID 索引的阶段清单 */
  stages: Partial<Record<PipelineStageId, PipelineStageManifest>>;
}

/** FTS projection freshness states / FTS 投影新鲜度状态 */
export type PipelineFtsIndexState = 'PENDING' | 'CURRENT' | 'MISSING' | 'STALE' | 'FAILED';

/**
 * FTS5 projection status as actually read back from SQLite by Electron,
 * not a static mapping of Python stage outputs.
 * Electron 从 SQLite 实际读回的 FTS5 投影状态，不是 Python 阶段产物的静态映射。
 */
export interface PipelineFtsIndexStatus {
  /** Freshness state / 新鲜度状态 */
  state: PipelineFtsIndexState;
  /** Tokenizer in use / 使用的分词器 */
  tokenizer: 'jieba-accurate-hmm-off';
  /** Indexed output schema version / 已索引输出结构版本 */
  outputSchemaVersion: 3;
  /** Expected chunk count / 期望块数 */
  expectedChunks: number;
  /** Expected keyword count / 期望关键词数 */
  expectedKeywords: number;
  /** Actually indexed chunks / 实际已索引块数 */
  indexedChunks: number;
  /** Rows present in the FTS table / FTS 表中的行数 */
  ftsRows: number;
  /** Actually indexed keywords / 实际已索引关键词数 */
  indexedKeywords: number;
  /** Last index timestamp / 最后索引时间戳 */
  indexedAt?: string;
  /** Last error if any / 如有则为最后一次错误 */
  error?: PipelineError;
}

/**
 * Aggregated pipeline status for one document, sent to the renderer.
 * 单文档的聚合流水线状态，发送给渲染进程。
 */
export interface PipelineDocumentStatus {
  /** Library root path / 资料库根路径 */
  libraryPath: string;
  /** Document id / 文档 ID */
  documentId: string;
  /** Document display name / 文档显示名称 */
  documentName: string;
  /** Source extension / 源扩展名 */
  extension: string;
  /** Parsing route / 解析路由 */
  route: ParsingRoute;
  /** Source content hash / 源内容哈希 */
  sourceContentHash: string;
  /** Stage currently reported / 当前汇报的阶段 */
  stage: PipelineStageId;
  /** Stage state / 阶段状态 */
  state: PipelineStageState;
  /** Primary artifact path / 主产物路径 */
  artifactPath?: string;
  /** Stage counters / 阶段计数 */
  counts?: Record<string, number>;
  /** Last error if any / 如有则为最后一次错误 */
  error?: PipelineError;
  /** All stage manifests / 全部阶段清单 */
  stages?: Partial<Record<PipelineStageId, PipelineStageManifest>>;
  /** FTS projection status / FTS 投影状态 */
  ftsIndex?: PipelineFtsIndexStatus;
  /** Last update timestamp / 最后更新时间戳 */
  updatedAt: string;
}

/**
 * Progress event pushed to the renderer while a stage runs.
 * 阶段运行期间推送给渲染进程的进度事件。
 */
export interface PipelineProgressEvent {
  /** Library root path / 资料库根路径 */
  libraryPath: string;
  /** Document id / 文档 ID */
  documentId: string;
  /** Job id / 任务 ID */
  jobId: string;
  /** Reporting stage / 汇报阶段 */
  stage: PipelineStageId;
  /** Completed units / 已完成单位数 */
  completed: number;
  /** Total units when known / 已知时的总单位数 */
  total?: number;
  /** Unit label (pages, chunks, ...) / 单位标签（页、块等） */
  unit?: string;
  /** Human-readable message / 可读的进度信息 */
  message: string;
}

/**
 * Single line of an artifact preview window.
 * 产物预览窗口中的单行。
 */
export interface PipelineArtifactPreviewRow {
  /** 1-based line number / 从 1 开始的行号 */
  lineNumber: number;
  /** Line text / 行文本 */
  text: string;
}

/**
 * Paginated preview of one stage artifact file.
 * 单个阶段产物文件的分页预览。
 */
export interface PipelineArtifactPreview {
  /** Document id / 文档 ID */
  documentId: string;
  /** Stage owning the artifact / 所属阶段 */
  stage: PipelineStageId;
  /** Artifact file name / 产物文件名 */
  fileName: string;
  /** Path relative to the stage directory / 相对阶段目录的路径 */
  relativePath: string;
  /** File size in bytes / 文件字节大小 */
  bytes: number;
  /** Integrity hash / 完整性哈希 */
  sha256: string;
  /** Requested line offset / 请求的行偏移 */
  offset: number;
  /** Requested page size / 请求的页大小 */
  limit: number;
  /** Lines in this page / 本页行数 */
  lineCount: number;
  /** Whether more lines remain / 是否还有更多行 */
  hasMore: boolean;
  /** Preview rows / 预览行 */
  rows: PipelineArtifactPreviewRow[];
}

/**
 * One in-chunk occurrence of a keyword.
 * 关键词在块内的一次出现。
 */
export interface PipelineKeywordPreviewOccurrence {
  /** Start offset in the chunk text / 块文本内起始偏移 */
  start: number;
  /** End offset in the chunk text / 块文本内结束偏移 */
  end: number;
  /** Sentence index within the chunk / 块内句子序号 */
  sentenceIndex: number;
}

/**
 * Keyword candidate with ranking features for one chunk.
 * 单块的关键词候选及其排序特征。
 */
export interface PipelineKeywordPreviewItem {
  /** Surface form / 表面词形 */
  term: string;
  /** Normalized form used for indexing / 用于索引的归一化词形 */
  normalizedTerm: string;
  /** Keyword kind / 关键词类别 */
  kind: string;
  /** Rank within the chunk / 块内排名 */
  rank: number;
  /** Relevance score / 相关性得分 */
  score: number;
  /** Occurrence spans / 出现跨度 */
  occurrences: PipelineKeywordPreviewOccurrence[];
  /** Scoring features for debugging / 用于调试的打分特征 */
  features: Record<string, number | boolean>;
  /** Whether forced to rank 1 / 是否强制置顶 */
  forcedTop1: boolean;
}

/**
 * One chunk row of a keyword preview.
 * 关键词预览中的单块行。
 */
export interface PipelineKeywordPreviewRow {
  /** Chunk id / 块 ID */
  chunkId: string;
  /** Parent chunk id when hierarchical / 层级切块时的父块 ID */
  parentChunkId: string | null;
  /** Chunk ordinal / 块序号 */
  ordinal: number;
  /** Chunk text / 块文本 */
  text: string;
  /** Source location references / 来源位置引用 */
  sourceLocations: string[];
  /** Keyword candidates / 关键词候选 */
  keywords: PipelineKeywordPreviewItem[];
  /** Why the list is empty, if applicable / 列表为空时的原因 */
  emptyReason: string | null;
}

/**
 * Paginated keyword preview over a document's chunks.
 * 覆盖文档各块的关键词分页预览。
 */
export interface PipelineKeywordPreview {
  /** Document id / 文档 ID */
  documentId: string;
  /** Requested row offset / 请求的行偏移 */
  offset: number;
  /** Requested page size / 请求的页大小 */
  limit: number;
  /** Rows in this page / 本页行数 */
  rowCount: number;
  /** Whether more rows remain / 是否还有更多行 */
  hasMore: boolean;
  /** Preview rows / 预览行 */
  rows: PipelineKeywordPreviewRow[];
}

/**
 * Report written after a document's vectors are indexed.
 * 文档向量索引完成后写入的报告。
 */
export interface PipelineVectorReport {
  /** Report schema version / 报告结构版本 */
  schemaVersion: 1;
  /** Document id / 文档 ID */
  documentId: string;
  /** Stage cache key / 阶段缓存键 */
  stageKey: string;
  /** Locked embedding profile hash / 锁定嵌入配置哈希 */
  profileHash: string;
  /** Embedding source id / 嵌入来源 ID */
  sourceId: string;
  /** Embedding model name / 嵌入模型名 */
  model: string;
  /** Vector dimension / 向量维度 */
  dimension: number;
  /** Distance metric used / 使用的距离度量 */
  distanceMetric: 'cosine';
  /** Indexing counters / 索引计数 */
  counts: {
    /** Total chunks / 总块数 */
    chunks: number;
    /** Successfully indexed / 成功索引数 */
    indexed: number;
    /** Skipped chunks / 跳过块数 */
    skipped: number;
    /** Failed chunks / 失败块数 */
    failed: number;
    /** Batch count / 批次数 */
    batches: number;
    /** Retry count / 重试次数 */
    retries: number;
  };
  /** Token usage when reported / 有汇报时的 token 用量 */
  usage: {
    /** Whether usage is available / 是否有用量信息 */
    available: boolean;
    /** Input tokens / 输入 token 数 */
    inputTokens?: number;
    /** Total tokens / 总 token 数 */
    totalTokens?: number;
  };
  /** Start timestamp / 开始时间戳 */
  startedAt: string;
  /** Completion timestamp / 完成时间戳 */
  completedAt: string;
}

/**
 * Result of one runStage call returned by the Python worker.
 * Python Worker 的一次 runStage 调用结果。
 */
export interface WorkerRunStageResult {
  /** Path to the stage artifact manifest / 阶段产物清单路径 */
  artifactManifest: string;
  /** Stage counters / 阶段计数 */
  counts: Record<string, number>;
}

/**
 * MinerU cloud parsing credentials and consent state (held only in the main process).
 * MinerU 云解析的凭据与同意状态（仅存于主进程）。
 */
export interface MineruRuntimeConfig {
  /** MinerU API endpoint / MinerU API 端点 */
  endpoint: string;
  /** Optional API key held via safeStorage / 可选的经 safeStorage 保管的 API Key */
  apiKey?: string;
  /** Whether the user consented to cloud parsing / 用户是否同意云解析 */
  cloudParsingConsent: boolean;
}

/**
 * Tuning knobs for the ambiguity disambiguation stage.
 * 歧义消解阶段的调节参数。
 */
export interface PipelineAmbiguityConfig {
  /** Whether the stage is enabled / 是否启用该阶段 */
  enabled: boolean;
  /** Minimum confidence to accept a disambiguation / 接受消歧的最低置信度 */
  minConfidence: number;
  /** Maximum confidence value / 最高置信度值 */
  maxConfidence: number;
  /** Max candidates sent per batch / 每批最多发送的候选数 */
  maxCandidatesPerBatch: number;
  /** Max input characters per request / 每次请求的最大输入字符数 */
  maxInputCharacters: number;
  /** Request timeout in ms / 请求超时（毫秒） */
  timeoutMs: number;
  /** Max output tokens / 最大输出 token 数 */
  maxOutputTokens: number;
  /** Prompt version for cache invalidation / 用于缓存失效的提示词版本 */
  promptVersion: string;
}

/**
 * Structure-strategy settings for the tree stage.
 * 结构树阶段的结构策略设置。
 */
export interface PipelineStructureConfig {
  /** Splitting strategy / 切分策略 */
  strategy: 'heading' | 'fixed';
  /** Target chunk size in characters / 目标块字符数 */
  targetChars: number;
  /** Overlap between chunks in characters / 块间重叠字符数 */
  overlapChars: number;
  /** Minimum chunk size in characters / 最小块字符数 */
  minChars: number;
  /** Maximum chunk size in characters / 最大块字符数 */
  maxChars: number;
}

/** Recommended presets vs user-tuned chunking / 推荐预设与用户自定义切块 */
export type ChunkingMode = 'recommended' | 'custom';

/** Parent/child chunking strategy codes / 父子切块策略代码 */
export type ChunkStrategyCode =
  | 'STRUCTURE'
  | 'RECURSIVE'
  | 'SEMANTIC'
  | 'LLM'
  | 'PAGE'
  | 'REGEX'
  | 'FIXED';

/** Strategies allowed for parent chunks / 父块允许的策略 */
export type ParentStrategyCode = 'STRUCTURE' | 'RECURSIVE' | 'PAGE' | 'REGEX' | 'FIXED';
/** Child chunks may use any strategy / 子块可使用任意策略 */
export type ChildStrategyCode = ChunkStrategyCode;

/**
 * Per-library chunking configuration (schema v2).
 * 资料库级切块配置（schema v2）。
 */
export interface LibraryChunkingConfig {
  /** Config schema version / 配置结构版本 */
  schemaVersion: 2;
  /** Recommended vs custom / 推荐或自定义 */
  mode: ChunkingMode;
  /** Parent strategy chain in order / 父块策略链（有序） */
  parentStrategies: ParentStrategyCode[];
  /** Child strategy chain in order / 子块策略链（有序） */
  childStrategies: ChildStrategyCode[];
  /** Parent minimum chunk chars / 父块最小字符数 */
  parentMinChars: number;
  /** Parent target chunk chars / 父块目标字符数 */
  parentTargetChars: number;
  /** Parent maximum chunk chars / 父块最大字符数 */
  parentMaxChars: number;
  /** Parent overlap chars / 父块重叠字符数 */
  parentOverlapChars: number;
  /** Child recursive max chars / 子块递归最大字符数 */
  childRecursiveMaxChars: number;
  /** Child recursive overlap chars / 子块递归重叠字符数 */
  childRecursiveOverlapChars: number;
  /** Semantic split max chars / 语义切分最大字符数 */
  semanticMaxChars: number;
  /** Semantic split min chars / 语义切分最小字符数 */
  semanticMinChars: number;
  /** Similarity threshold for semantic splits / 语义切分相似度阈值 */
  semanticSimilarityThreshold: number;
  /** Whether LLM boundary selection is enabled / 是否启用 LLM 边界选择 */
  llmEnabled: boolean;
  /** Max chars per LLM request / 每次 LLM 请求最大字符数 */
  llmMaxChars: number;
  /** LLM request timeout in ms / LLM 请求超时（毫秒） */
  llmTimeoutMs: number;
  /** LLM max output tokens / LLM 最大输出 token 数 */
  llmMaxOutputTokens: number;
  /** LLM prompt version / LLM 提示词版本 */
  llmPromptVersion: string;
  /** Whether to recommend LLM mode on low-quality splits / 低质量切分时是否推荐 LLM 模式 */
  recommendLlmWhenLowQuality: boolean;
  /** Minimum page-metadata coverage for PAGE strategy / PAGE 策略的最低元数据覆盖率 */
  pageMinMetadataCoverage: number;
  /** Regex pattern for REGEX strategy / REGEX 策略的正则模式 */
  regexPattern: string;
  /** Regex flags / 正则标志 */
  regexFlags: Array<'i' | 'm'>;
  /** Whether the delimiter lands before or after the split / 分隔符落在切分点前还是后 */
  regexBoundary: 'before' | 'after';
  /** Whether to keep the delimiter text / 是否保留分隔符文本 */
  regexKeepDelimiter: boolean;
  /** Child fixed-strategy target chars / 子块定长策略目标字符数 */
  childFixedTargetChars: number;
  /** Child fixed-strategy min chars / 子块定长策略最小字符数 */
  childFixedMinChars: number;
  /** Child fixed-strategy max chars / 子块定长策略最大字符数 */
  childFixedMaxChars: number;
  /** Child fixed-strategy overlap chars / 子块定长策略重叠字符数 */
  childFixedOverlapChars: number;
  /** Migration provenance when upgraded from v1 / 自 v1 升级时的迁移来源 */
  migration?: { source: 'pipelineStructure-v1'; migratedAt: string };
}

/**
 * Hierarchical Leiden community detection parameters.
 * 层次化 Leiden 社区检测参数。
 */
export interface LibraryLeidenConfig {
  /** Resolution parameter (higher = more communities) / 分辨率参数（越大社区越多） */
  resolution: number;
  /** Maximum hierarchy depth / 最大层级深度 */
  maxDepth: number;
  /** Minimum community size before splitting / 切分前的最小社区规模 */
  minSplitSize: number;
  /** Random seed for reproducibility / 保证可复现的随机种子 */
  seed: number;
}

/**
 * Graph enhancement settings for entity extraction and community summaries.
 * 图增强设置：实体抽取与社区摘要。
 */
export interface LibraryGraphEnhancementConfig {
  /** Config schema version / 配置结构版本 */
  schemaVersion: 1;
  /** Whether enhancement is enabled / 是否启用图增强 */
  enabled: boolean;
  /** Max chars per extraction request / 每次抽取请求的最大字符数 */
  maxChars: number;
  /** Max entities extracted per chunk / 每块最多抽取实体数 */
  maxEntitiesPerChunk: number;
  /** Max relations extracted per chunk / 每块最多抽取关系数 */
  maxRelationsPerChunk: number;
  /** Extraction prompt version / 抽取提示词版本 */
  promptVersion: string;
  /** LLM request timeout in ms / LLM 请求超时（毫秒） */
  llmTimeoutMs: number;
  /** LLM max output tokens / LLM 最大输出 token 数 */
  llmMaxOutputTokens: number;
  /**
   * Hierarchical community detection parameters; they only affect library-level
   * graph assembly (graphKey), not entity-extraction caching.
   * 层级社区检测参数；只影响库级图装配（graphKey），不影响实体抽取缓存。
   */
  leidenConfig: LibraryLeidenConfig;
  /**
   * Community-summary prompt version; changing it only invalidates summaries and
   * their projection, not entity extraction or graph assembly.
   * 社区摘要提示词版本；变化只失效摘要及其投影，不重跑实体抽取与图装配。
   */
  summaryPromptVersion: string;
  /**
   * Per-summary context budget in tokens, minimum 4000 (tuned for local small
   * models, plan §3.3/§8).
   * 单次摘要上下文预算（token），下限 4000（适配本地小模型，方案 §3.3/§8）。
   */
  summaryBudgetTokens: number;
  /**
   * Default community level for global search (0–3, plan §4.2), clamped to the
   * highest level that actually exists.
   * 全局检索默认社区层级（0–3，方案 §4.2），超出实际层数时钳制到最高层。
   */
  globalSearchLevel: number;
  /**
   * Alias arbitration (vector recall + LLM arbitration to merge synonymous
   * entities); off by default, opt-in, affects graph assembly (part of graphKey).
   * 别名仲裁（向量召回 + LLM 仲裁合并同义实体）；默认关闭，显式开启，影响图装配（入 graphKey）。
   */
  aliasArbitrationEnabled: boolean;
}

/**
 * Minimal LLM client contract used by the ambiguity stage.
 * 歧义阶段使用的最小 LLM 客户端契约。
 */
export interface AmbiguityModelClient {
  /** Provider id / 提供方标识 */
  provider: string;
  /** Model name / 模型名 */
  model: string;
  /** Whether the model is usable / 模型是否可用 */
  available: boolean;
  /** Config fingerprint for caching / 用于缓存的配置指纹 */
  fingerprint?: string;
  /**
   * Generates a JSON answer for one disambiguation request.
   * 为一次消歧请求生成 JSON 答案。
   *
   * @param input - Request parameters / 请求参数
   * @returns Parsed JSON output / 解析后的 JSON 输出
   */
  generateJson: (input: {
    model: string;
    prompt: string;
    timeoutMs: number;
    maxOutputTokens: number;
    signal: AbortSignal;
  }) => Promise<unknown>;
}
