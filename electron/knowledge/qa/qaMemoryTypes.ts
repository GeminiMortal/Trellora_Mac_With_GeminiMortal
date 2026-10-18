/**
 * Unified type definitions for the QA memory pipeline: turns, summaries, checkpoints, and agent messages.
 * 问答记忆链路统一类型定义：轮次、摘要、检查点与 Agent 消息。
 */
import type { AssistantTurnResult } from '../assistant/assistantTurnTypes.ts';
import type { ContextMemoryResult, ContextProjectInput } from '../context/contextMemoryTypes.ts';
import type { MemoryProjectionMode, MemoryProjectionReadDiagnostics } from '../memory/memoryCutover.ts';
import type { MemoryUsedSnapshot } from '../memory/memoryTypes.ts';

/**
 * 问答区统一记忆链路类型。该链路与 assistant-memory.db /
 * conversation-memory.db 零交叉；开放式问答和知识库问答使用独立会话。
 */

/**
 * Session-fixed QA mode; a session with content must not continue writing across modes.
 * 会话固定的问答模式；一个有内容的会话不得跨模式继续写入。
 */
export type QaSessionScope = 'chat' | 'knowledge-base';

/**
 * Possible statuses of a QA turn lifecycle.
 * 问答轮次生命周期的可能状态。
 */
export type QaTurnStatus =
  | 'pending'
  | 'complete'
  | 'partial'
  | 'not-found'
  | 'cancelled'
  | 'error'
  | 'interrupted';

/**
 * Turn statuses eligible for the short-term memory window; cancelled/failed turns are excluded.
 * 进入短期记忆窗口的轮次状态；取消/失败轮不入窗。
 */
export const QA_HOT_TURN_STATUSES: readonly QaTurnStatus[] = ['complete', 'partial', 'not-found'];

/** Compressor type for summary generation / 摘要生成的压缩器类型 */
export type QaSummaryCompressor = 'llm' | 'fallback';
/** Summary completion status / 摘要完成状态 */
export type QaSummaryStatus = 'done' | 'failed';
/** Hierarchical rollup level (L2 or L3) / 层级汇总级别（L2 或 L3） */
export type QaSummaryRollupLevel = 2 | 3;
/** Rollup completion status / 汇总完成状态 */
export type QaSummaryRollupStatus = 'done' | 'failed' | 'stale';

/**
 * Summary metadata for a QA session.
 * 问答会话的摘要元数据。
 */
export interface QaSessionSummary {
  /** Unique session identifier / 唯一会话标识 */
  sessionId: string;
  /**
   * Session mode; prevents open QA and knowledge-base QA from sharing history.
   * 会话模式；用于阻止开放式问答与知识库问答共用历史。
   */
  scope: QaSessionScope;
  /** Session display title / 会话显示标题 */
  title: string;
  /** Whether the session is pinned / 是否置顶 */
  pinned: boolean;
  /** Associated library path (knowledge-base only) / 关联资料库路径（仅知识库） */
  libraryPath?: string;
  /** Total turn count / 总轮次数 */
  turnCount: number;
  /** Last assigned turn sequence number / 最后分配的轮次序号 */
  lastTurnSeq: number;
  /** Summarized through this sequence number / 已摘要到此序号 */
  summarizedThroughSeq: number;
  /** Creation timestamp / 创建时间戳 */
  createdAt: string;
  /** Last update timestamp / 最后更新时间戳 */
  updatedAt: string;
}

/**
 * Paginated result for QA memory queries.
 * 问答记忆查询的分页结果。
 */
export interface QaMemoryPage<T> {
  /** Page items / 分页条目 */
  items: T[];
  /** Cursor for the next page / 下一页游标 */
  nextCursor?: number;
}

/**
 * A persisted QA turn with user text, assistant response, and lifecycle metadata.
 * 持久化的问答轮次，包含用户文本、助手回复和生命周期元数据。
 */
export interface QaStoredTurn {
  /** Unique turn identifier / 唯一轮次标识 */
  turnId: string;
  /** Associated request ID / 关联请求 ID */
  requestId?: string;
  /** Attempt number within the request / 请求内的尝试编号 */
  attemptNo?: number;
  /** Sequential turn number within session / 会话内轮次序号 */
  turnSeq: number;
  /** User input text / 用户输入文本 */
  userText: string;
  /** Assistant response text / 助手回复文本 */
  assistantText?: string;
  /** Scope label for display / 显示用范围标签 */
  scopeLabel: string;
  /** Turn lifecycle status / 轮次生命周期状态 */
  status: QaTurnStatus;
  /** Structured turn result / 结构化轮次结果 */
  result?: AssistantTurnResult;
  /** Creation timestamp / 创建时间戳 */
  createdAt: string;
  /** Completion timestamp / 完成时间戳 */
  finishedAt?: string;
  /** Memory snapshots used in this turn / 此轮次使用的记忆快照 */
  usedMemories?: MemoryUsedSnapshot[];
}

/**
 * A compressed summary block covering a range of turns.
 * 覆盖一定轮次范围的压缩摘要块。
 */
export interface QaSummaryBlock {
  /** Unique batch identifier / 唯一批次标识 */
  batchId: string;
  /** First turn sequence in range / 范围内首个轮次序号 */
  turnFrom: number;
  /** Last turn sequence in range / 范围内最后一个轮次序号 */
  turnTo: number;
  /** Compressed summary text / 压缩后的摘要文本 */
  summaryText: string;
  /** Estimated token count / 估计 token 数 */
  tokens: number;
  /** Compressor used / 使用的压缩器 */
  compressor: QaSummaryCompressor;
  /** Processing status / 处理状态 */
  status: QaSummaryStatus;
  /** Number of retry attempts / 重试次数 */
  retryCount: number;
  /** Last update timestamp / 最后更新时间戳 */
  updatedAt: string;
}

/**
 * Full detail of a QA session including its turns and summaries.
 * 问答会话的完整详情，包含轮次和摘要。
 */
export interface QaSessionDetail {
  /** Session summary metadata / 会话摘要元数据 */
  session: QaSessionSummary;
  /** All stored turns / 所有存储轮次 */
  turns: QaStoredTurn[];
  /** All summary blocks / 所有摘要块 */
  summaries: QaSummaryBlock[];
}

/**
 * Actual token counts per zone for debug trace display.
 * 调试轨展示的各分区实际 token。
 */
export interface QaMemoryZoneTokens {
  /** Static prefix zone tokens / 静态前缀分区 token 数 */
  staticPrefix: number;
  /** Rolling summary (M1) tokens / 滚动摘要（M1）token 数 */
  rollingSummary: number;
  /** Short-term (M2) tokens / 短期记忆（M2）token 数 */
  shortTerm: number;
  /** Dynamic evidence tokens / 动态证据 token 数 */
  dynamic: number;
  /** Question constraint tokens / 问题约束 token 数 */
  questionConstraint: number;
}

/**
 * Raw material for query rewrite <history>: original completed turn text + answer head (chronological order).
 * 改写 prompt 的 <history> 原料：已完成轮次原文 + 回答头部（时间正序）。
 */
export interface QaRecentTurn {
  /** Original user text / 原始用户文本 */
  userText: string;
  /** Head of the assistant answer / 助手回答头部 */
  answerHead: string;
}

/**
 * Main-process-only source data for the Phase 0 residual-window observer.
 * 仅主进程使用的 Phase 0 剩余窗口观测器源数据。
 */
export interface QaResidualMemoryObservationInput {
  /** Memorable turns for observation / 用于观测的可记忆轮次 */
  memorableTurns: QaStoredTurn[];
  /** Legacy memory zone diagnostics / 旧版记忆分区诊断 */
  legacy: {
    /** Rolling summary token count / 滚动摘要 token 数 */
    rollingSummaryTokens: number;
    /** Short-term token count / 短期记忆 token 数 */
    shortTermTokens: number;
    /** Number of summary materials / 摘要材料数量 */
    summaryMaterialCount: number;
    /** Turn ranges covered by summaries / 摘要覆盖的轮次范围 */
    summaryTurnRanges?: Array<{ turnFrom: number; turnTo: number }>;
    /** Hot turn sequence numbers / 热轮次序号列表 */
    hotTurnSeqs: number[];
  };
}

/**
 * Fully assembled QA memory preparation for a single turn.
 * 单轮问答的完整记忆装配结果。
 */
export interface QaMemoryPreparation {
  /** Session identifier / 会话标识 */
  sessionId: string;
  /**
   * Independent project, summary, and hot-history materials for ContextEnvelope.
   * 独立的项目、摘要和热历史材料，供 ContextEnvelope 使用。
   */
  contextMemory: ContextMemoryResult;
  /** Zone token counts / 分区 token 计数 */
  zoneTokens: Pick<QaMemoryZoneTokens, 'rollingSummary' | 'shortTerm'>;
  /**
   * Recent completed turns (chronological) for query rewrite <history>.
   * 最近已完成轮次（正序），供问题改写 <history> 使用。
   */
  recentTurns: QaRecentTurn[];
  /**
   * Canonical L2 turns and their transport-neutral replay messages.
   * 规范 L2 轮次及其传输无关的重放消息。
   */
  recentCompleteTurns: QaRecentCompleteTurn[];
  /** Canonical history messages for replay / 用于重放的规范历史消息 */
  recentHistoryMessages: QaCanonicalHistoryMessage[];
  /** Memory projection mode and dual-reader results / 记忆投影模式和双读取器结果 */
  memoryProjection: {
    /** Projection mode / 投影模式 */
    mode: MemoryProjectionMode;
    /** Currently active reader / 当前活跃读取器 */
    activeReader: 'legacy' | 'canonical';
    /** Legacy context materials / 旧版上下文材料 */
    legacyContext: ContextMemoryResult;
    /** Canonical context materials / 规范上下文材料 */
    canonicalContext: ContextMemoryResult;
    /** Read diagnostics / 读取诊断信息 */
    readDiagnostics: MemoryProjectionReadDiagnostics;
  };
  /**
   * Shadow-only input; never rendered into the active legacy Prompt.
   * 仅作影子输入；不会渲染到活跃的旧版 Prompt 中。
   */
  residualObservation: QaResidualMemoryObservationInput;
  /** Current turn sequence number / 当前轮次序号 */
  turnSeq: number;
  /** Current turn identifier / 当前轮次标识 */
  turnId: string;
}

/**
 * Hierarchical rollup aggregating multiple L1 summaries into L2 or L3.
 * 层级汇总，将多个 L1 摘要聚合为 L2 或 L3。
 */
export interface QaSummaryRollup {
  /** Unique rollup identifier / 唯一汇总标识 */
  rollupId: string;
  /** Rollup level (2 or 3) / 汇总级别（2 或 3） */
  level: QaSummaryRollupLevel;
  /** Source start sequence / 来源起始序号 */
  sourceStartSeq: number;
  /** Source end sequence / 来源结束序号 */
  sourceEndSeq: number;
  /** Source block identifiers / 来源块标识列表 */
  sourceIds: string[];
  /** Hash of source content / 来源内容哈希 */
  sourceHash: string;
  /** Aggregated summary text / 聚合摘要文本 */
  summaryText: string;
  /** Estimated token count / 估计 token 数 */
  tokens: number;
  /** Compressor used / 使用的压缩器 */
  compressor: QaSummaryCompressor;
  /** Processing status / 处理状态 */
  status: QaSummaryRollupStatus;
  /** Summary version counter / 摘要版本计数器 */
  summaryVersion: number;
  /** Creation timestamp / 创建时间戳 */
  createdAt: string;
  /** Last update timestamp / 最后更新时间戳 */
  updatedAt: string;
}

/**
 * A decision extracted during conversation checkpoint generation.
 * 对话检查点生成期间提取的决策。
 */
export interface QaConversationCheckpointDecision {
  /** Decision statement / 决策声明 */
  statement: string;
  /** Current status of the decision / 决策的当前状态 */
  status: 'active' | 'superseded' | 'uncertain';
  /** Source turn sequences / 来源轮次序号 */
  sourceTurnSeqs: number[];
}

/**
 * A user correction captured during checkpoint generation.
 * 检查点生成期间捕获的用户纠正。
 */
export interface QaConversationCheckpointCorrection {
  /** Original corrected statement / 被纠正的原始声明 */
  corrected: string;
  /** Replacement text / 替换文本 */
  replacement: string;
  /** Turn where the correction occurred / 纠正发生的轮次序号 */
  sourceTurnSeq: number;
}

/**
 * An artifact referenced during checkpoint generation.
 * 检查点生成期间引用的产物。
 */
export interface QaConversationCheckpointArtifact {
  /** Artifact identifier / 产物标识 */
  id: string;
  /** Display label / 显示标签 */
  label: string;
  /** Source turn sequence / 来源轮次序号 */
  sourceTurnSeq: number;
}

/**
 * Structured, untrusted memory payload for a single rolling conversation checkpoint.
 * 单一滚动会话 Checkpoint 的结构化、不可信记忆载荷。
 */
export interface QaConversationCheckpointV1 {
  /** Schema version / 模式版本 */
  schemaVersion: 1;
  /** Session identifier / 会话标识 */
  sessionId: string;
  /** Checkpoint version number / 检查点版本号 */
  checkpointVersion: number;
  /** Coverage starts from sequence 1 / 覆盖从序号 1 开始 */
  coveredFromSeq: 1;
  /** Coverage extends through this sequence / 覆盖延伸到此序号 */
  coveredThroughSeq: number;
  /** Hash of source turns / 来源轮次哈希 */
  sourceHash: string;
  /** User goals extracted / 提取的用户目标 */
  userGoals: string[];
  /** Active constraints / 活跃约束 */
  activeConstraints: string[];
  /** Extracted decisions / 提取的决策 */
  decisions: QaConversationCheckpointDecision[];
  /** User corrections / 用户纠正 */
  userCorrections: QaConversationCheckpointCorrection[];
  /** Resolved discussion topics / 已解决的讨论主题 */
  resolvedTopics: string[];
  /** Unresolved discussion topics / 未解决的讨论主题 */
  unresolvedTopics: string[];
  /** Referenced artifacts / 引用的产物 */
  referencedArtifacts: QaConversationCheckpointArtifact[];
  /** Recent handoff context / 最近交接上下文 */
  recentHandoff: string;
  /** Summary token count / 摘要 token 数 */
  summaryTokens: number;
  /** Compressor used / 使用的压缩器 */
  compressor: QaSummaryCompressor;
  /** Model profile used / 使用的模型配置 */
  modelProfile?: string;
}

/**
 * Persisted conversation checkpoint with summary and metadata.
 * 持久化的对话检查点，包含摘要和元数据。
 */
export interface QaConversationCheckpoint {
  /** Session identifier / 会话标识 */
  sessionId: string;
  /** Checkpoint version number / 检查点版本号 */
  checkpointVersion: number;
  /** Coverage start / 覆盖起始 */
  coveredFromSeq: 1;
  /** Coverage end / 覆盖结束 */
  coveredThroughSeq: number;
  /** Source content hash / 来源内容哈希 */
  sourceHash: string;
  /** Structured checkpoint payload / 结构化检查点载荷 */
  payload: QaConversationCheckpointV1;
  /** Rendered summary text / 渲染后的摘要文本 */
  summaryText: string;
  /** Summary token count / 摘要 token 数 */
  summaryTokens: number;
  /** Target token budget / 目标 token 预算 */
  targetTokens: number;
  /** Source token count / 来源 token 数 */
  sourceTokens: number;
  /** Compression ratio / 压缩比 */
  compressionRatio: number;
  /** Compressor used / 使用的压缩器 */
  compressor: QaSummaryCompressor;
  /** Model profile / 模型配置 */
  modelProfile?: string;
  /** Creation timestamp / 创建时间戳 */
  createdAt: string;
  /** Last update timestamp / 最后更新时间戳 */
  updatedAt: string;
}

/**
 * Candidate checkpoint awaiting validation before persistence.
 * 等待验证后持久化的候选检查点。
 */
export interface QaConversationCheckpointCandidate {
  /** Structured checkpoint payload / 结构化检查点载荷 */
  payload: QaConversationCheckpointV1;
  /** Rendered summary text / 渲染后的摘要文本 */
  summaryText: string;
  /** Summary token count / 摘要 token 数 */
  summaryTokens: number;
  /** Hard max token cap for summary / 摘要硬上限 token 数 */
  summaryHardMaxTokens: number;
  /** Target token budget / 目标 token 预算 */
  targetTokens: number;
  /** Source token count / 来源 token 数 */
  sourceTokens: number;
  /** Compression ratio / 压缩比 */
  compressionRatio: number;
}

/**
 * Status of a memory compaction run.
 * 记忆压缩运行的状态。
 */
export type QaMemoryCompactionRunStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'conflict'
  | 'interrupted';

/**
 * Record of a memory compaction run with source/target metadata.
 * 记忆压缩运行记录，包含来源/目标元数据。
 */
export interface QaMemoryCompactionRun {
  /** Unique run identifier / 唯一运行标识 */
  runId: string;
  /** Session identifier / 会话标识 */
  sessionId: string;
  /** Base checkpoint version / 基准检查点版本 */
  baseCheckpointVersion: number;
  /** Source range start / 来源范围起始 */
  sourceFromSeq: number;
  /** Source range end / 来源范围结束 */
  sourceToSeq: number;
  /** Source content hash / 来源内容哈希 */
  sourceHash: string;
  /** Source token count / 来源 token 数 */
  sourceTokens: number;
  /** Target token budget / 目标 token 预算 */
  targetTokens: number;
  /** Output token count (on success) / 输出 token 数（成功时） */
  outputTokens?: number;
  /** Run status / 运行状态 */
  status: QaMemoryCompactionRunStatus;
  /** Error code on failure / 失败时的错误码 */
  errorCode?: string;
  /** Creation timestamp / 创建时间戳 */
  createdAt: string;
  /** Completion timestamp / 完成时间戳 */
  finishedAt?: string;
}

/**
 * Historical attachment metadata; image bytes and local paths never persist.
 * 历史附件元数据；图片字节和本地路径永不持久化。
 */
export interface QaTurnAttachmentDescriptor {
  /** Unique attachment identifier / 唯一附件标识 */
  attachmentId: string;
  /** Attachment kind / 附件类型 */
  kind: 'image' | 'document' | 'text';
  /** Display name / 显示名称 */
  name: string;
  /** MIME type / MIME 类型 */
  mimeType?: string;
  /** Size in bytes / 字节大小 */
  sizeBytes: number;
}

/**
 * A tool call made by the agent during a turn.
 * Agent 在轮次期间发起的工具调用。
 */
export interface QaAgentToolCall {
  /** Unique call identifier / 唯一调用标识 */
  callId: string;
  /** Call sequence within the turn / 轮次内调用序号 */
  callSeq: number;
  /** Tool name / 工具名称 */
  toolName: string;
  /** Call arguments / 调用参数 */
  arguments: Record<string, unknown>;
}

/**
 * One persisted assistant/tool message inside an Agent turn.
 * Agent 轮次中一条持久化的助手/工具消息。
 */
export interface QaAgentMessage {
  /** Unique message identifier / 唯一消息标识 */
  messageId: string;
  /** Message sequence within the agent turn / Agent 轮次内消息序号 */
  messageSeq: number;
  /** Message role / 消息角色 */
  role: 'assistant' | 'tool';
  /** Message content / 消息内容 */
  content: string;
  /** Reasoning content (assistant only) / 推理内容（仅助手） */
  reasoningContent: string;
  /** Associated tool call ID (tool only) / 关联工具调用 ID（仅工具） */
  toolCallId?: string;
  /** Tool name (tool only) / 工具名称（仅工具） */
  toolName?: string;
  /** Artifact reference / 产物引用 */
  artifactRef?: Record<string, unknown>;
  /** Tool calls made (assistant only) / 发起的工具调用（仅助手） */
  toolCalls: QaAgentToolCall[];
  /** Creation timestamp / 创建时间戳 */
  createdAt: string;
}

/**
 * Input for creating a tool call record.
 * 创建工具调用记录的输入。
 */
export interface QaAgentToolCallInput {
  /** Unique call identifier / 唯一调用标识 */
  callId: string;
  /** Tool name / 工具名称 */
  toolName: string;
  /** Call arguments / 调用参数 */
  arguments: Record<string, unknown>;
}

/**
 * Input for creating an agent message record.
 * 创建 Agent 消息记录的输入。
 */
export interface QaAgentMessageInput {
  /** Message role / 消息角色 */
  role: 'assistant' | 'tool';
  /** Message content / 消息内容 */
  content?: string;
  /** Reasoning content / 推理内容 */
  reasoningContent?: string;
  /** Associated tool call ID / 关联工具调用 ID */
  toolCallId?: string;
  /** Tool name / 工具名称 */
  toolName?: string;
  /** Artifact reference / 产物引用 */
  artifactRef?: Record<string, unknown>;
  /** Tool calls / 工具调用列表 */
  toolCalls?: QaAgentToolCallInput[];
}

/**
 * Canonical routing paths for QA turns.
 * 问答轮次的规范路由路径。
 */
export type QaCanonicalRoute =
  | 'chat'
  | 'knowledge-base'
  | 'current-note-direct'
  | 'current-note-react';

/**
 * Metadata attached to a QA turn for routing, attachments, and memory extraction.
 * 问答轮次附加的元数据，用于路由、附件和记忆提取。
 */
export interface QaTurnMetadata {
  /** Schema version / 模式版本 */
  schemaVersion: 1;
  /** Canonical route / 规范路由 */
  route: QaCanonicalRoute;
  /** Turn attachments / 轮次附件 */
  attachments: QaTurnAttachmentDescriptor[];
  /** Memory extraction generation counter / 记忆提取代数计数器 */
  memoryExtractionGeneration?: number;
  /** Whether memory extraction is eligible / 是否可进行记忆提取 */
  memoryExtractionEligible?: boolean;
  /**
   * New explicit requests only; old conversations are never retroactively claimed.
   * 仅限新的显式请求；旧对话不会被追溯认领。
   */
  memoryExplicitSaveEnabled?: boolean;
  /** Whether explicit save is pending / 是否有待处理的显式保存 */
  memoryExplicitSavePending?: boolean;
  /** Agent ID for memory extraction / 记忆提取的 Agent ID */
  memoryExtractionAgentId?: string;
  /**
   * Trusted main-process scope used by the recoverable WK-M6 archive index.
   * 可恢复 WK-M6 归档索引使用的可信主进程作用域。
   */
  memoryScope?: {
    /** Workspace identifier / 工作区标识 */
    workspaceId: string;
    /** Principal identifier / 主体标识 */
    principalId: string;
  };
}

/**
 * Canonical, replayable L2 turn returned in chronological order.
 * 按时间正序返回的规范、可重放 L2 轮次。
 */
export interface QaRecentCompleteTurn {
  /** Unique turn identifier / 唯一轮次标识 */
  turnId: string;
  /** Associated request ID / 关联请求 ID */
  requestId: string;
  /** Attempt number / 尝试编号 */
  attemptNo: number;
  /** Turn sequence number / 轮次序号 */
  turnSeq: number;
  /** User input text / 用户输入文本 */
  userText: string;
  /** Assistant response text / 助手回复文本 */
  assistantText: string;
  /** Scope label / 范围标签 */
  scopeLabel: string;
  /** Turn status (only complete/partial/not-found) / 轮次状态（仅 complete/partial/not-found） */
  status: Extract<QaTurnStatus, 'complete' | 'partial' | 'not-found'>;
  /** Turn metadata / 轮次元数据 */
  metadata: QaTurnMetadata;
  /** Agent messages in this turn / 此轮次的 Agent 消息 */
  agentMessages: QaAgentMessage[];
  /** Creation timestamp / 创建时间戳 */
  createdAt: string;
  /** Completion timestamp / 完成时间戳 */
  finishedAt: string;
}

/**
 * A single message in the canonical history replay format.
 * 规范历史重放格式中的单条消息。
 */
export interface QaCanonicalHistoryMessage {
  /** Message role / 消息角色 */
  role: 'user' | 'assistant' | 'tool';
  /** Message content / 消息内容 */
  content: string;
  /** Reasoning content (optional) / 推理内容（可选） */
  reasoningContent?: string;
  /** Tool calls in this message / 此消息中的工具调用 */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Associated tool call ID / 关联工具调用 ID */
  toolCallId?: string;
  /** Tool name / 工具名称 */
  toolName?: string;
  /** Artifact reference / 产物引用 */
  artifactRef?: Record<string, unknown>;
}

/**
 * Project context input re-exported from context types.
 * 从上下文类型重新导出的项目上下文输入。
 */
export type QaProjectContextInput = ContextProjectInput;
