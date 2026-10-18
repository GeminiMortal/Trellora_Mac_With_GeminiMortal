/**
 * Shared type definitions for the context runtime: materials, envelopes, projections, pressure levels, and diagnostic interfaces.
 * 上下文运行时共享类型定义：材料、信封、投影、压力等级和诊断接口。
 */
import type { PromptCallKind } from '../currentNote/currentNoteContextBudget.ts';
import type { AssistantModelRuntimeProfile } from '../../../shared/effectiveContextWindow.ts';

/** Re-export of AssistantModelRuntimeProfile for downstream context modules. 为下游上下文模块重导出 AssistantModelRuntimeProfile。 */
export type { AssistantModelRuntimeProfile } from '../../../shared/effectiveContextWindow.ts';

/** Allowed context runtime modes. 上下文运行时允许的模式。 */
export const assistantContextRuntimeModes = ['off', 'observe', 'enforce'] as const;
/** One of the allowed context runtime modes. 上下文运行时允许的模式之一。 */
export type AssistantContextRuntimeMode = typeof assistantContextRuntimeModes[number];

/** Schema version for context runtime persisted structures. 上下文运行时持久化结构的 Schema 版本。 */
export const CONTEXT_RUNTIME_SCHEMA_VERSION = 1 as const;
/** Envelope wire-format version string used by the context runtime. 上下文运行时使用的信封线路格式版本字符串。 */
export const CONTEXT_REQUEST_ENVELOPE_VERSION = 'context-envelope-v1';

/**
 * Routing destination for a context request.
 * 上下文请求的路由目标。
 */
export type ContextRoute = 'chat' | 'knowledge-base' | 'current-note';
/**
 * Message channel within a context envelope.
 * 上下文信封内的消息通道。
 */
export type ContextChannel = 'system' | 'user' | 'tool';

/**
 * Semantic zone a context material occupies within the prompt structure.
 * 上下文材料在 Prompt 结构中占据的语义区域。
 */
export type ContextZone =
  | 'stable-policy'
  | 'project-context'
  | 'user-profile'
  | 'long-term-memory'
  | 'agent-state'
  | 'conversation-summary'
  | 'conversation-hot'
  | 'conversation-recall'
  | 'note-capsule'
  | 'dynamic-evidence'
  | 'tool-observation'
  | 'current-request'
  | 'output-contract';

/**
 * Trust classification that determines which channel combinations are valid.
 * 信任分类，决定哪些通道组合是合法的。
 */
export type ContextTrust =
  | 'trusted-policy'
  | 'trusted-state'
  | 'untrusted-memory'
  | 'untrusted-evidence';

/**
 * Compression strategy available for a context material.
 * 上下文材料可用的压缩策略。
 */
export type ContextCompressStrategy =
  | 'none'
  | 'dedupe'
  | 'reference'
  | 'truncate'
  | 'summary'
  | 'drop';

/**
 * Phase-1 admission kind for context materials.
 * 上下文材料的 Phase-1 准入类型。
 */
export type ContextAdmissionKind =
  | 'tool-catalog'
  | 'tool-definition'
  | 'skill-description'
  | 'skill-body'
  | 'attachment-metadata'
  | 'attachment-content';

/**
 * Phase-1 admission metadata for a context material.
 * 上下文材料的 Phase-1 准入元数据。
 */
export interface ContextMaterialAdmission {
  kind: ContextAdmissionKind;
  key: string;
  phase?: string;
  activeByDefault: boolean;
  activationReason: string;
}

/**
 * Optional lifecycle hints for deterministic cleanup of tool/trace projections.
 * 用于工具/轨迹投影确定性清理的可选生命周期提示。
 */
export interface ContextMaterialLifecycle {
  sequence?: number;
  status?: 'active' | 'completed' | 'superseded' | 'stale' | 'error' | 'correction';
  rereadable?: boolean;
  activeDependency?: boolean;
}

/**
 * Identifies the upstream source of a context material.
 * 标识上下文材料的上游来源。
 */
export interface ContextMaterialSource {
  kind: string;
  id: string;
  version: string;
  contentHash?: string;
}

/**
 * Provenance trace linking a material to its originating session, turns, plan, and evidence.
 * 材料的出处追踪，将其关联到来源会话、回合、计划和证据。
 */
export interface ContextMaterialProvenance {
  sessionId?: string;
  turnSeqs?: number[];
  planId?: string;
  sourceIds?: string[];
  goalIds?: string[];
  requirementIds?: string[];
  evidenceIds?: string[];
  snapshotId?: string;
  contentHash?: string;
}

/**
 * Base fields shared by all context materials before trust/channel specialization.
 * 所有上下文材料在信任/通道特化之前共享的基础字段。
 */
export interface ContextMaterialBase {
  id: string;
  zone: ContextZone;
  content: string;
  priority: number;
  protected: boolean;
  compressStrategy: ContextCompressStrategy;
  source: ContextMaterialSource;
  tokenBudget?: {
    absoluteMax?: number;
    ratio?: number;
  };
  /**
   * Optional pre-selection size used only by renderer-safe diagnostics. The
   * projected content remains the sole source of final token accounting.
   * 可选的预选大小，仅用于渲染层安全诊断。投影内容仍然是最终 token 计量的唯一来源。
   */
  diagnosticCandidateTokens?: number;
  /** Phase-1 admission metadata. It never grants filesystem or tool authority. Phase-1 准入元数据，不授予文件系统或工具权限。 */
  admission?: ContextMaterialAdmission;
  /** Optional deterministic cleanup hints for Tool/trace projections. 用于工具/轨迹投影的可选确定性清理提示。 */
  lifecycle?: ContextMaterialLifecycle;
  stalePolicy: 'keep' | 'invalidate' | 'refresh';
  overflowPolicy: 'fail' | 'compress' | 'drop';
  provenance?: ContextMaterialProvenance;
  cache: {
    stability: 'stable' | 'session' | 'turn';
    prefixEligible: boolean;
  };
  toolName?: string;
}

/**
 * The discriminated union makes illegal trust/channel combinations fail at
 * compile time. Runtime validation still protects deserialized inputs.
 * 判别联合类型在编译期阻止非法的信任/通道组合。运行时校验仍保护反序列化输入。
 */
export type ContextMaterial =
  | (ContextMaterialBase & { trust: 'trusted-policy'; channel: 'system' })
  | (ContextMaterialBase & { trust: 'trusted-state'; channel: 'system' | 'user' })
  | (ContextMaterialBase & { trust: 'untrusted-memory'; channel: 'user' })
  | (ContextMaterialBase & { trust: 'untrusted-evidence'; channel: 'user' | 'tool' });

/**
 * Scope identifiers for a context envelope: workspace, library, note, session, turn.
 * 上下文信封的作用域标识：工作区、资料库、笔记、会话、回合。
 */
export interface ContextEnvelopeScope {
  workspaceId: string;
  libraryId?: string;
  noteId?: string;
  sessionId?: string;
  turnId?: string;
}

/**
 * Complete context envelope sent to the model: route, scope, window profile, materials, and invariants.
 * 发送给模型的完整上下文信封：路由、作用域、窗口配置、材料和不变量。
 */
export interface ContextEnvelope {
  schemaVersion: typeof CONTEXT_RUNTIME_SCHEMA_VERSION;
  route: ContextRoute;
  callKind: PromptCallKind;
  scope: ContextEnvelopeScope;
  windowProfile: AssistantModelRuntimeProfile;
  materials: ContextMaterial[];
  invariants: string[];
  stateVector: {
    snapshotId?: string;
    contentHash?: string;
    planId?: string;
    memoryVersion?: string;
  };
}

/**
 * Projected material summary after serialization: zone, channel, trust, token estimate, and ordering.
 * 序列化后的投影材料摘要：区域、通道、信任、token 估算和排序。
 */
export interface ProjectedContextMaterial {
  id: string;
  zone: ContextZone;
  channel: ContextChannel;
  trust: ContextTrust;
  priority: number;
  protected: boolean;
  source: ContextMaterialSource;
  estimatedTokens: number;
  contentSha256: string;
  order: number;
}

/**
 * Records a material that was omitted from projection and the reason.
 * 记录被投影省略的材料及其原因。
 */
export interface ContextOmission {
  materialId: string;
  reason: 'duplicate' | 'budget' | 'stale' | 'invalid' | 'policy';
  estimatedTokens: number;
  detail?: string;
}

/**
 * Aggregate statistics for a context projection: material counts and token totals by channel.
 * 上下文投影的聚合统计：按通道统计的材料数量和 token 总量。
 */
export interface ContextProjectionStats {
  candidateMaterials: number;
  includedMaterials: number;
  omittedMaterials: number;
  systemMaterials: number;
  userMaterials: number;
  toolMaterials: number;
  systemTokens: number;
  userTokens: number;
  toolTokens: number;
  serializedTokens: number;
}

/**
 * Full context projection: serialized system/user/tool prompts, pressure level, included/omitted materials, and stats.
 * 完整上下文投影：序列化的系统/用户/工具 Prompt、压力等级、包含/省略的材料及统计。
 */
export interface ContextProjection {
  systemPrompt: string;
  userPrompt: string;
  toolMessages?: Array<{ name: string; content: string }>;
  serializedBudgetText: string;
  requestEnvelopeVersion: string;
  pressureLevel: 0 | 1 | 2 | 3 | 4 | 5;
  included: ProjectedContextMaterial[];
  omitted: ContextOmission[];
  stats: ContextProjectionStats;
  stablePrefixFingerprint: string;
}

/**
 * Digest of a single role's (system/user) content: char count, estimated tokens, and SHA-256.
 * 单个角色（系统/用户）内容的摘要：字符数、估算 token 和 SHA-256。
 */
export interface ContextRuntimeRoleDigest {
  chars: number;
  estimatedTokens: number;
  sha256: string;
}

/**
 * Digest of the full prompt structure: role layout plus per-role and combined digests.
 * 完整 Prompt 结构的摘要：角色布局及每个角色和合并后的摘要。
 */
export interface ContextRuntimePromptDigest {
  roleStructure: ContextChannel[];
  system: ContextRuntimeRoleDigest;
  user: ContextRuntimeRoleDigest;
  combined: ContextRuntimeRoleDigest;
}

/**
 * Code path identifier for how a context was sent to the provider.
 * 上下文如何发送给提供者的代码路径标识。
 */
export type ContextRuntimeSendPath = 'legacy-phase-1' | 'legacy-observe' | 'projection-enforce';

/**
 * Window-level diagnostics: physical tokens, product cap, effective tokens, and output/safety reserves.
 * 窗口级诊断：物理 token 数、产品上限、有效 token 数以及输出/安全预留。
 */
export interface ContextProjectionWindowDiagnostics {
  runtimeProfileId?: AssistantModelRuntimeProfile['runtimeProfileId'];
  physicalTokens?: number;
  physicalSource: AssistantModelRuntimeProfile['physicalSource'];
  productCapMode?: AssistantModelRuntimeProfile['productCapMode'];
  productCeilingTokens: number;
  userCapTokens?: number;
  effectiveTokens: number;
  autoCompactAtTokens: number;
  outputReserveTokens: number;
  safetyTokens: number;
  availablePromptTokens: number;
}

/**
 * Per-zone projection diagnostics: candidate vs. final tokens, channels, trusts, and compression actions.
 * 按区域的投影诊断：候选与最终 token 数、通道、信任和压缩动作。
 */
export interface ContextProjectionZoneDiagnostics {
  zone: ContextZone;
  candidateTokens: number;
  finalTokens: number;
  candidateMaterials: number;
  includedMaterials: number;
  omittedMaterials: number;
  channels: ContextChannel[];
  trusts: ContextTrust[];
  protectedMaterials: number;
  compressionActions: string[];
}

/**
 * Per-material omission diagnostics recorded during projection.
 * 投影期间记录的按材料省略诊断。
 */
export interface ContextProjectionOmissionDiagnostics {
  materialId: string;
  zone: ContextZone;
  reason: ContextOmission['reason'];
  estimatedTokens: number;
}

/**
 * Progressive pressure level used in QA residual memory diagnostics.
 * QA 残差记忆诊断中使用的渐进压力等级。
 */
export type QaResidualPressureLevel = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

/**
 * Observation-only residual memory diagnostics: budget breakdown, optimization decisions, and compaction projections.
 * 仅观测的残差记忆诊断：预算分解、优化决策和压缩投影。
 */
export interface QaResidualMemoryDiagnostics {
  schemaVersion: 1;
  observationOnly: true;
  legacy: {
    /** Legacy M1: non-conversation material slot (tokens and material count). 旧版 M1：非会话材料槽位（token 数和材料计数）。 */
    M1: { tokens: number; materialCount: number };
    /** Legacy M2: conversation tail slot (tokens, turn count, and seq range). 旧版 M2：会话尾部槽位（token 数、轮次数和序号范围）。 */
    M2: { tokens: number; turnCount: number; turnSeqFrom?: number; turnSeqTo?: number };
  };
  budget: {
    /** W: effective context window tokens. W：有效上下文窗口 token 数。 */
    W: number;
    /** O: reserved output tokens. O：预留输出 token 数。 */
    O: number;
    /** G: safety guard tokens. G：安全余量 token 数。 */
    G: number;
    /** N: optimized non-conversation material tokens. N：优化后的非会话材料 token 数。 */
    N: number;
    /** C: conversation pool = hard max prompt - N. C：会话池 = 硬上限 Prompt - N。 */
    C: number;
    /** M: checkpoint tokens already committed to conversation history. M：已提交到会话历史的 Checkpoint token 数。 */
    M: number;
    /** H: remaining conversation pool after checkpoint deduction (C - M). H：扣除 Checkpoint 后的剩余会话池（C - M）。 */
    H: number;
    /** UWindow: window utilization ratio = (N + M + rawConversation + O + G) / W. UWindow：窗口利用率 = (N + M + 原始会话 + O + G) / W。 */
    UWindow: number;
    /** Raw non-conversation tokens before optimization. 优化前的原始非会话 token 数。 */
    rawNonConversationTokens: number;
    /** Raw conversation tail tokens. 原始会话尾部 token 数。 */
    rawConversationTokens: number;
    /** Hysteresis target prompt tokens for conversation re-entry. 会话回滞目标 Prompt token 数。 */
    reentryTargetPromptTokens: number;
  };
  wouldOptimize: {
    required: boolean;
    pressureLevel: QaResidualPressureLevel;
    actions: Array<'cleanup-old-tool-output' | 'artifact-and-cold-reference'>;
  };
  wouldInclude: {
    allRawTurns: boolean;
    turnCount: number;
    turnSeqFrom?: number;
    turnSeqTo?: number;
    estimatedTokens: number;
  };
  wouldCompact: {
    candidate: boolean;
    /** Always true: compaction is only evaluated when optimization alone is insufficient. 始终为 true：仅当优化不足时才评估压缩。 */
    conditionalOnOptimizationInsufficient: true;
    sourceTurnCount: number;
    sourceTokens: number;
    estimatedSummaryTargetTokens: number;
    compactThroughTurnSeq?: number;
    /** UWindow after projected compaction. 投影压缩后的 UWindow。 */
    projectedUWindowAfter: number;
    reachesReentryTarget: boolean;
  };
}

/**
 * Enforcement-mode residual memory diagnostics: actual state transitions, budget, conversation details, and compaction results.
 * 强制模式的残差记忆诊断：实际状态转换、预算、会话详情和压缩结果。
 */
export interface QaResidualMemoryEnforcementDiagnostics {
  schemaVersion: 1;
  observationOnly: false;
  state: 'stable' | 'optimized' | 'compacted' | 'pressure-degraded' | 'hard-veto' | 'circuit-open';
  initialPressureLevel: QaResidualPressureLevel;
  finalPressureLevel: QaResidualPressureLevel;
  budget: {
    /** W: effective context window tokens. W：有效上下文窗口 token 数。 */
    W: number;
    /** O: reserved output tokens. O：预留输出 token 数。 */
    O: number;
    /** G: safety guard tokens. G：安全余量 token 数。 */
    G: number;
    /** N: optimized non-conversation material tokens. N：优化后的非会话材料 token 数。 */
    N: number;
    /** C: conversation pool = hard max prompt - N. C：会话池 = 硬上限 Prompt - N。 */
    C: number;
    /** M: checkpoint tokens already committed to conversation history. M：已提交到会话历史的 Checkpoint token 数。 */
    M: number;
    /** H: remaining conversation pool after checkpoint deduction (C - M). H：扣除 Checkpoint 后的剩余会话池（C - M）。 */
    H: number;
    /** UWindow: window utilization ratio. UWindow：窗口利用率。 */
    UWindow: number;
    /** Hysteresis target prompt tokens for conversation re-entry. 会话回滞目标 Prompt token 数。 */
    reentryTargetPromptTokens: number;
    /** Reserve tokens between hard max and reentry target. 硬上限与回滞目标之间的预留 token 数。 */
    reentryReserveTokens: number;
  };
  conversation: {
    checkpointVersion: number;
    checkpointTokens: number;
    coveredThroughSeq: number;
    rawTurnCount: number;
    rawTokens: number;
    rawTurnSeqFrom?: number;
    rawTurnSeqTo?: number;
    originalShortTermCapacity: number;
    /** Always true in observation output: all raw turns are projected to be included. 在观测输出中始终为 true：所有原始轮次均被投影为包含。 */
    allRawTurnsIncluded: true;
  };
  /** Phase 4: marginal, fully serialized token cost of admitted knowledge-base parent evidence. Phase 4：准入的知识库父证据的边际完整序列化 token 成本。 */
  evidence?: {
    actualTokens: number;
    materialCount: number;
    parentIdentityCount: number;
    references: number[];
    /** Always true: all admitted evidence materials are protected. 始终为 true：所有准入的证据材料均受保护。 */
    allProtected: true;
    /** Always true: original evidence content is preserved verbatim. 始终为 true：原始证据内容逐字保留。 */
    contentPreserved: true;
    /** Always true: cross-reference pointers to evidence are preserved. 始终为 true：到证据的交叉引用指针被保留。 */
    referencesPreserved: true;
    /** Always true: parent identity metadata is preserved. 始终为 true：父身份元数据被保留。 */
    parentIdentityPreserved: true;
  };
  compaction: {
    triggered: boolean;
    attempts: number;
    modelCalls: number;
    memoryWrites: number;
    casConflicts: number;
    fallbackUsed: boolean;
    compactedFromSeq?: number;
    compactedThroughSeq?: number;
    sourceTokens?: number;
    outputTokens?: number;
    compressionRatio?: number;
    releasedTokens: number;
    errorCode?: string;
  };
}

/**
 * Token usage diagnostics comparing local estimates against provider-reported values.
 * Token 用量诊断：将本地估算与提供者报告值进行对比。
 */
export interface ContextProviderUsageDiagnostics {
  responseCompleted: boolean;
  reported: boolean;
  localRawInputTokens: number;
  localCalibratedInputTokens: number;
  calibrationMultiplierUsed: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
  providerCachedInputTokens?: number;
  rawEstimateSignedErrorTokens?: number;
  rawEstimateAbsoluteErrorTokens?: number;
  rawEstimateRelativeError?: number;
  calibratedEstimateSignedErrorTokens?: number;
  calibratedEstimateAbsoluteErrorTokens?: number;
  calibratedEstimateRelativeError?: number;
}

/**
 * Call kind for dynamic memory S0 observations.
 * 动态记忆 S0 观测的调用类型。
 */
export type DynamicMemoryS0CallKind =
  | 'chat-answer'
  | 'query-rewrite'
  | 'react-decide'
  | 'react-synthesize';

/**
 * Route for dynamic memory S0 observations.
 * 动态记忆 S0 观测的路由。
 */
export type DynamicMemoryS0Route =
  | 'chat-direct'
  | 'knowledge-base-direct'
  | 'knowledge-base-react';

/**
 * Coverage-map diagnostics showing how eligible conversation turns are covered by summaries and hot turns.
 * 覆盖图诊断：显示可记忆会话轮次如何被摘要和热轮次覆盖。
 */
export interface ConversationCoverageMapDiagnostics {
  schemaVersion: 1;
  eligibleTurnCount: number;
  eligibleTurnSeqFrom?: number;
  eligibleTurnSeqTo?: number;
  summaryRanges: Array<{ turnFrom: number; turnTo: number }>;
  hotTurnSeqs: number[];
  uncoveredTurnSeqs: number[];
  multiplyCoveredTurnSeqs: number[];
  complete: boolean;
  /** Current hard-coded projection parameters used for coverage analysis. 当前用于覆盖分析的硬编码投影参数。 */
  currentProjection: {
    fixedHotTurnLimit: 6;
    queryRewriteAnswerHeadChars: 200;
    reactHistoryAnswerHeadChars: 1_500;
    storedAssistantTextLimitChars: 60_000;
    recallTokens: 0;
  };
  risks: string[];
}

/**
 * S0 observation diagnostics for a single dynamic-memory provider call: budget, partitions, payload stats, coverage, and wiring.
 * 单次动态记忆提供者调用的 S0 观测诊断：预算、分区、载荷统计、覆盖和接线。
 */
export interface DynamicMemoryS0Diagnostics {
  schemaVersion: 1;
  observationOnly: true;
  route: DynamicMemoryS0Route;
  callKind: DynamicMemoryS0CallKind;
  recordedAt: string;
  budget: {
    /** W: effective context window tokens. W：有效上下文窗口 token 数。 */
    W: number;
    /** O: reserved output tokens. O：预留输出 token 数。 */
    O: number;
    /** G: safety guard tokens. G：安全余量 token 数。 */
    G: number;
    /** P: available prompt budget = W - O - G. P：可用 Prompt 预算 = W - O - G。 */
    P: number;
    /** RNext: tokens reserved for the next turn. RNext：为下一回合预留的 token 数。 */
    RNext: number;
  };
  partitions: {
    /** F: unclassified/fallback partition tokens (messages minus known partitions). F：未分类/回退分区 token 数（消息减去已知分区）。 */
    F: number;
    /** T: tool schema + skill tokens. T：工具 Schema + 技能 token 数。 */
    T: number;
    /** A: agent-state partition tokens. A：Agent 状态分区 token 数。 */
    A: number;
    /** E: evidence partition tokens. E：证据分区 token 数。 */
    E: number;
    /** M: memory partition tokens. M：记忆分区 token 数。 */
    M: number;
    total: number;
    totalWithRNext: number;
    remainingPromptTokens: number;
    partitionOverflowTokens: number;
  };
  providerPayload: {
    chars: number;
    bytes: number;
    estimatedTokens: number;
    sha256: string;
    messageCount: number;
    toolSchemaCount: number;
    toolSchemaChars: number;
    toolSchemaBytes: number;
    toolSchemaTokens: number;
    skillCount: number;
    skillTokens: number;
    attachmentCount: number;
    attachmentBytes: number;
    /** True when images are present but per-image token estimation is unavailable. 存在图片但无法按图片估算 token 时为 true。 */
    mediaTokenEstimateUnavailable: boolean;
    messageOnlyEstimatedTokens: number;
    payloadDeltaFromMessageOnlyTokens: number;
    uncountedToolSchemaTokens: number;
    providerInputTokens?: number;
    estimateSignedErrorTokens?: number;
    estimateAbsoluteErrorTokens?: number;
    estimateRelativeError?: number;
    responseCompleted: boolean;
  };
  coverage: ConversationCoverageMapDiagnostics;
  wiring: {
    /** Name of the prepare function. 准备函数的名称。 */
    prepare: string;
    contextEnvelope: { status: 'wired' | 'unwired'; entry: string };
    /** Whether the residual memory enforcer is wired in. 残差记忆强制器是否已接入。 */
    residualEnforcer: { status: 'wired' | 'conditional' | 'unwired'; entry: string };
    provider: string;
    finalize: string;
    pressureController: {
      relieveNonConversation: 'wired';
      projectAtLevel: 'source-only';
      projectToFit: 'source-only';
    };
    summaryRollups: 'stored-unwired';
    oldTurnLexicalRecall: 'source-only';
    databases: {
      qa: 'qa-memory.db';
      currentNote: 'assistant-memory.db';
      legacyWorkspace: 'conversation-memory.db';
    };
    /** Always true: current-note route is excluded from residual memory processing. 始终为 true：current-note 路由不参与残差记忆处理。 */
    currentNoteExcluded: true;
  };
  sideEffects: {
    /** Always 0: S0 observation never mutates the provider request. 始终为 0：S0 观测从不修改提供者请求。 */
    providerRequestMutations: 0;
    /** Always 0: S0 observation never writes to semantic memory. 始终为 0：S0 观测从不写入语义记忆。 */
    semanticMemoryMutations: 0;
    diagnosticArtifactWrites: number;
    /** Always true: trace writes are allowed during S0 observation. 始终为 true：S0 观测期间允许写入轨迹。 */
    traceWritesAllowed: true;
  };
}

/**
 * S0 observation diagnostics for a single tool observation: raw vs. provider-visible sizes, truncation, and artifactization.
 * 单个工具观察的 S0 观测诊断：原始与提供者可见大小、截断和制品化。
 */
export interface ToolObservationS0Diagnostics {
  schemaVersion: 1;
  raw: { chars: number; bytes: number; estimatedTokens: number; sha256: string };
  providerVisible: { chars: number; bytes: number; estimatedTokens: number; sha256: string };
  truncated: boolean;
  artifactized: boolean;
  artifactId?: string;
  releasedChars: number;
  releasedBytes: number;
}

/**
 * Progressive pressure level used by the context pressure controller.
 * 上下文压力控制器使用的渐进压力等级。
 */
export type ContextProgressivePressureLevel = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

/**
 * Phase-1 admission diagnostics: candidate, admitted, and deferred material counts with per-kind token totals.
 * Phase-1 准入诊断：候选、准入和延期材料计数及按类型的 token 总量。
 */
export interface ContextAdmissionDiagnostics {
  candidateMaterials: number;
  admittedMaterials: number;
  deferredMaterials: number;
  toolCatalogTokens: number;
  activeToolDefinitionTokens: number;
  skillDescriptionTokens: number;
  selectedSkillBodyTokens: number;
  attachmentMetadataTokens: number;
  attachmentContentTokens: number;
  activationReasons: string[];
}

/**
 * Diagnostics for a single pressure-relief action: level, kind, affected materials, and token delta.
 * 单次压力缓解动作的诊断：等级、类型、受影响材料和 token 变化量。
 */
export interface ContextPressureActionDiagnostics {
  level: ContextProgressivePressureLevel;
  kind: string;
  materialIds: string[];
  beforeTokens: number;
  afterTokens: number;
  releasedTokens: number;
  reason: string;
  artifactId?: string;
}

/**
 * Full diagnostics for a pressure episode: initial/final levels, UWindow values, actions taken, and stop reason.
 * 压力事件的完整诊断：初始/最终等级、UWindow 值、已执行动作和停止原因。
 */
export interface ContextPressureEpisodeDiagnostics {
  pressureEpisodeId: string;
  materialFingerprint: string;
  initialLevel: ContextProgressivePressureLevel;
  finalLevel: ContextProgressivePressureLevel;
  initialUWindow: number;
  finalUWindow: number;
  minPressureGainTokens: number;
  stoppedReason:
    | 'below-p1'
    | 'below-p2'
    | 'below-p3'
    | 'p1-complete'
    | 'p2-complete'
    | 'p3-complete'
    | 'pressure-degraded'
    | 'hard-veto'
    | 'circuit-open'
    | 'ineffective-gain'
    | 'repeated-zero-gain';
  ineffectiveGain: boolean;
  actions: ContextPressureActionDiagnostics[];
  skippedZeroGainActions: string[];
}

/**
 * Renderer-safe context diagnostics. It intentionally excludes prompt text,
 * material content, API credentials and provider-cache-hit claims.
 * 渲染层安全的上下文诊断。故意排除了 Prompt 文本、材料内容、API 凭据和提供者缓存命中声明。
 */
export interface ContextProjectionDiagnostics {
  schemaVersion: 1;
  recordedAt: string;
  turnId?: string;
  route: ContextRoute;
  callKind: PromptCallKind;
  mode: Exclude<AssistantContextRuntimeMode, 'off'>;
  sendPath: ContextRuntimeSendPath;
  providerId: string;
  modelId: string;
  pressureLevel: ContextProjection['pressureLevel'];
  window: ContextProjectionWindowDiagnostics;
  tokens: {
    candidate: number;
    final: number;
    outputReserve: number;
    safety: number;
  };
  zones: ContextProjectionZoneDiagnostics[];
  omissions: ContextProjectionOmissionDiagnostics[];
  stablePrefix: {
    fingerprint?: string;
    cacheEligible: boolean;
    /** Always false: only a Provider usage response may report a real hit. 始终为 false：仅提供者用量响应可报告真实命中。 */
    providerCacheHitClaimed: false;
  };
  residualMemory?: QaResidualMemoryDiagnostics;
  residualMemoryEnforcement?: QaResidualMemoryEnforcementDiagnostics;
  providerUsage?: ContextProviderUsageDiagnostics;
  dynamicMemoryS0?: DynamicMemoryS0Diagnostics;
  admission?: ContextAdmissionDiagnostics;
  pressureEpisode?: ContextPressureEpisodeDiagnostics;
  invariantViolations: string[];
}

/**
 * Observation report comparing legacy prompt digests against the new projection path.
 * 观测报告：将旧版 Prompt 摘要与新的投影路径进行对比。
 */
export interface ContextRuntimeObservationReport {
  schemaVersion: 1;
  mode: Exclude<AssistantContextRuntimeMode, 'off'>;
  route: ContextRoute;
  callKind: PromptCallKind;
  requestEnvelopeVersion: string;
  legacy: ContextRuntimePromptDigest;
  projection?: ContextRuntimePromptDigest;
  differences: {
    systemPromptEqual: boolean;
    userPromptEqual: boolean;
    roleStructureEqual: boolean;
    serializedTokenDelta?: number;
  };
  invariantViolations: string[];
  stablePrefixFingerprint?: string;
  candidateMaterials: number;
  includedMaterials: number;
  modelCallsAdded: number;
  memoryWritesAdded: number;
  turnStateMutations: 0;
  sendPath: ContextRuntimeSendPath;
  diagnostics: ContextProjectionDiagnostics;
}

/**
 * Result of a context runtime observation: the report and optional projection.
 * 上下文运行时观测的结果：报告及可选的投影。
 */
export interface ContextRuntimeObservationResult {
  report: ContextRuntimeObservationReport;
  projection?: ContextProjection;
}

/**
 * Normalizes an unknown value into a valid AssistantContextRuntimeMode, defaulting to 'observe'.
 * 将未知值规范化为合法的 AssistantContextRuntimeMode，默认回退到 'observe'。
 *
 * @param value - Raw value to normalize / 要规范化的原始值
 * @returns A valid runtime mode / 合法的运行时模式
 */
export function normalizeAssistantContextRuntimeMode(value: unknown): AssistantContextRuntimeMode {
  return typeof value === 'string' && (assistantContextRuntimeModes as readonly string[]).includes(value)
    ? value as AssistantContextRuntimeMode
    : 'observe';
}
