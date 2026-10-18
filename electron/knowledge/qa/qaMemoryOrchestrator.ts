/**
 * QA memory orchestrator: the single main-process authority for turn lifecycle and memory assembly.
 * Owns session/turn persistence, M1/M2 zone preparation, background compression batching, and residual-memory enforcement.
 * 问答记忆编排器：主进程内轮次生命周期与记忆装配的单一权威。
 * 负责会话/轮次落库、M1/M2 分区装配、后台压缩批次与残余记忆强制执行。
 */
import type { AssistantAttachment, AssistantTurnResult } from '../assistant/assistantTurnTypes.ts';
import type { AiProviderConfig } from '../ai/aiTypes.ts';
import type { QaMemoryRepository } from './qaMemoryRepository.ts';
import { QaMemoryCompressionQueue, buildQaFallbackSummaryBody } from './qaMemoryCompressor.ts';
import { resolveQaZoneBudget } from './qaMemoryAssembler.ts';
import type { QaAgentMessageInput, QaCanonicalRoute, QaMemoryPreparation, QaProjectContextInput, QaSessionScope } from './qaMemoryTypes.ts';
import { UserProfileExtractionQueue } from '../userProfile/userProfileExtractionQueue.ts';
import type { UserProfileExtractionScheduleInput } from '../userProfile/userProfileTypes.ts';
import { ContextMemoryRegistry } from '../context/contextMemoryRegistry.ts';
import { ProjectContextAdapter } from '../projectContextAdapter.ts';
import { QaContextMemoryAdapter } from './qaContextMemoryAdapter.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import { UserProfileContextAdapter } from '../userProfile/userProfileContextAdapter.ts';
import type { UserProfileRepository } from '../userProfile/userProfileRepository.ts';
import {
  QaResidualMemoryEnforcer,
  type QaResidualMemoryEnforcementInput,
  type QaResidualMemoryEnforcementResult,
} from './qaResidualMemoryEnforcer.ts';
import type { AssistantContextRuntimeMode } from '../context/contextRuntimeTypes.ts';
import type { TrustedMemoryScope } from '../memory/memoryTypes.ts';
import { isCanonicalMemoryProjection, normalizeMemoryProjectionMode, selectMemoryProjection, type MemoryProjectionMode } from '../memory/memoryCutover.ts';
import type { ContextMemoryResult } from '../context/contextMemoryTypes.ts';

/**
 * Model selection resolved for a memory-maintenance call: model id plus optional provider config.
 * 记忆维护调用解析出的模型选择：模型 id 与可选的 provider 配置。
 */
export interface QaMemoryModelSelection {
  model: string;
  providerConfig?: AiProviderConfig;
}

/**
 * QA memory orchestrator (design §6, single main-process authority): validates
 * re-entry pressure at session start, evaluates per-turn batches (writes fallback
 * placeholders before enqueueing LLM work), assembles M1/M2 zones, and persists
 * turns. The renderer never participates in trimming or joining.
 * 问答区记忆编排器（设计 §6，主进程单一权威）：
 * 会话开始校验补压、每轮批次评估（先写 fallback 占位再入队 LLM）、
 * M1/M2 分区装配与轮次落库。渲染进程不参与裁剪与拼接。
 */
export class QaMemoryOrchestrator {
  readonly compressionQueue: QaMemoryCompressionQueue;
  readonly qaContextMemoryAdapter: QaContextMemoryAdapter;
  readonly contextMemoryRegistry: ContextMemoryRegistry;
  readonly residualMemoryEnforcer: QaResidualMemoryEnforcer;
  private readonly projectContextAdapter: ProjectContextAdapter;

  constructor(
    readonly repository: QaMemoryRepository,
    resolveModel: () => QaMemoryModelSelection | undefined,
    private readonly workspaceId = 'qa-workspace',
    readonly userProfileExtractionQueue?: UserProfileExtractionQueue,
    userProfileRepository?: UserProfileRepository,
  ) {
    this.compressionQueue = new QaMemoryCompressionQueue(repository, resolveModel);
    this.residualMemoryEnforcer = new QaResidualMemoryEnforcer(repository);
    this.qaContextMemoryAdapter = new QaContextMemoryAdapter(repository);
    this.projectContextAdapter = new ProjectContextAdapter();
    this.contextMemoryRegistry = new ContextMemoryRegistry(
      this.projectContextAdapter,
      [this.qaContextMemoryAdapter],
      userProfileRepository ? [new UserProfileContextAdapter(userProfileRepository)] : [],
    );
  }

  /**
   * Phase 3 chat enforce: two-pass assembly, P1/P2 recomputation, and on-demand foreground checkpoint.
   * Phase 3 会话 enforce：两遍装配、P1/P2 重算与按需前台 checkpoint。
   */
  enforceChatContext(input: QaResidualMemoryEnforcementInput): Promise<QaResidualMemoryEnforcementResult> {
    return this.residualMemoryEnforcer.enforce(input);
  }

  /**
   * Phase 4 knowledge-base enforce: pins dynamic parent-chunk evidence first, then allocates the true residual window to the conversation.
   * Phase 4 知识库 enforce：先固定动态父块证据，再把真实剩余窗口分给会话。
   */
  enforceKnowledgeBaseContext(input: QaResidualMemoryEnforcementInput): Promise<QaResidualMemoryEnforcementResult> {
    return this.residualMemoryEnforcer.enforce(input);
  }

  /**
   * Turn start (design §6 steps 1–4): persist pending turn → session-start validation (first turn) →
   * batch evaluation (placeholder + enqueue) → assemble M1/M2 → return memory zones ready for the prompt.
   * 每轮开始（设计 §6 步骤 1–4）：落库 pending → 会话开始校验（首次）→
   * 批次评估（占位 + 入队）→ 装配 M1/M2 → 返回可拼入 prompt 的记忆分区。
   *
   * @param input - Session/turn identity, user text, scope, project context, and projection modes / 会话/轮次标识、用户文本、作用域、项目上下文与投影模式
   * @returns Preparation payload with memory zones, recent turns, and residual observation / 含记忆分区、近期轮次与残余观测的装配结果
   */
  async prepareTurn(input: {
    sessionId?: string;
    /**
     * Fixed session scope; a sessionId that already has content may not continue across scopes.
     * 会话固定模式；已有内容的 sessionId 不允许跨模式继续。
     */
    scope: QaSessionScope;
    turnId: string;
    userText: string;
    scopeLabel: string;
    route?: QaCanonicalRoute;
    attachments?: readonly AssistantAttachment[];
    libraryPath?: string;
    contextWindowTokens?: number;
    projectContext: QaProjectContextInput;
    residualMemoryMode?: AssistantContextRuntimeMode;
    memoryProjectionMode?: MemoryProjectionMode;
  }): Promise<QaMemoryPreparation> {
    const session = input.sessionId
      ? this.repository.ensureSession(input.sessionId, input.scope, input.libraryPath ? { libraryPath: input.libraryPath } : {})
      : this.repository.createSession(input.scope, input.libraryPath ? { libraryPath: input.libraryPath } : {});
    const sessionId = session.sessionId;
    const started = this.repository.startTurn(sessionId, {
      turnId: input.turnId,
      userText: input.userText,
      scopeLabel: input.scopeLabel,
      route: input.route ?? input.scope,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    const budget = resolveQaZoneBudget(input.scope, input.contextWindowTokens);
    const memoryRequest = {
      route: input.scope,
      workspaceId: this.workspaceId,
      ...(input.libraryPath ? { libraryId: input.libraryPath } : {}),
      sessionId,
      currentQuestion: input.userText,
      budgets: {
        summaryTokens: budget.rollingSummary,
        hotTokens: budget.shortTerm,
        recallTokens: 0,
      },
      projectContext: input.projectContext,
    } as const;
    const memoryProjectionMode = normalizeMemoryProjectionMode(input.memoryProjectionMode);
    let contextMemory: QaMemoryPreparation['contextMemory'];
    let legacyContext: ContextMemoryResult;
    let canonicalContext: ContextMemoryResult;
    let recentTurns: QaMemoryPreparation['recentTurns'];
    let recentCompleteTurns: QaMemoryPreparation['recentCompleteTurns'];
    let recentHistoryMessages: QaMemoryPreparation['recentHistoryMessages'];
    try {
      // Dual-read: canonical history is always loaded; the legacy registry is skipped once
      // canonical projection is authoritative. The active projection is then selected.
      // 双读：规范历史始终加载；规范投影生效后跳过 legacy 注册表。随后选定生效投影。
      const canonicalStartedAt = Date.now();
      const [projectContext, canonicalHistoryContext] = await Promise.all([
        this.projectContextAdapter.load(memoryRequest),
        this.qaContextMemoryAdapter.loadCanonical(memoryRequest),
      ]);
      canonicalContext = combineContextMemoryResults(projectContext, canonicalHistoryContext);
      const canonicalReadMs = Math.max(0, Date.now() - canonicalStartedAt);
      let legacyReadMs = 0;
      if (isCanonicalMemoryProjection(memoryProjectionMode)) {
        legacyContext = emptyContextMemory('legacy-reader:disabled-after-cutover');
      } else {
        const legacyStartedAt = Date.now();
        legacyContext = await this.contextMemoryRegistry.load(memoryRequest);
        legacyReadMs = Math.max(0, Date.now() - legacyStartedAt);
      }
      contextMemory = selectMemoryProjection(memoryProjectionMode, legacyContext, canonicalContext).active;
      recentTurns = await this.qaContextMemoryAdapter.loadQueryRewriteHistory(memoryRequest);
      recentCompleteTurns = this.qaContextMemoryAdapter.loadRecentCompleteTurns(memoryRequest);
      recentHistoryMessages = this.qaContextMemoryAdapter.loadRecentHistoryMessages(memoryRequest);
      const activeReader = memoryProjectionMode === 'canonical' ? 'canonical' : 'legacy';
      const residualContext = legacyContext;
      return {
        sessionId,
        contextMemory,
        zoneTokens: {
          rollingSummary: sumMaterialTokens(contextMemory, 'conversation-summary'),
          shortTerm: sumMaterialTokens(contextMemory, 'conversation-hot'),
        },
        recentTurns,
        recentCompleteTurns,
        recentHistoryMessages,
        memoryProjection: {
          mode: memoryProjectionMode,
          activeReader,
          legacyContext,
          canonicalContext,
          readDiagnostics: { legacyReadMs, canonicalReadMs },
        },
        residualObservation: {
          memorableTurns: this.repository.loadMemorableTurnsAfter(sessionId),
          // Derive legacy zone token counts and turn ranges from material provenance for residual observation.
          // 从材料 provenance 推导 legacy 分区 token 与轮次区间，供残余观测使用。
          legacy: {
            rollingSummaryTokens: sumMaterialTokens(residualContext, 'conversation-summary'),
            shortTermTokens: sumMaterialTokens(residualContext, 'conversation-hot'),
            summaryMaterialCount: residualContext.materials.filter((material) => material.zone === 'conversation-summary').length,
            summaryTurnRanges: residualContext.materials
              .filter((material) => material.zone === 'conversation-summary')
              .map((material) => material.provenance?.turnSeqs ?? [])
              .filter((turnSeqs) => turnSeqs.length > 0)
              .map((turnSeqs) => ({ turnFrom: Math.min(...turnSeqs), turnTo: Math.max(...turnSeqs) })),
            hotTurnSeqs: residualContext.materials
              .filter((material) => material.zone === 'conversation-hot')
              .flatMap((material) => material.provenance?.turnSeqs ?? []),
          },
        },
        turnSeq: started.turnSeq,
        turnId: started.turnId,
      };
    } catch (error) {
      this.finishAbortedTurn(sessionId, started.turnId, 'error');
      throw error;
    }
  }

  /**
   * Successful turn end: persists the full result, then evaluates whether new complete batches exist.
   * 轮次成功结束：落库完整结果，再评估是否产生新的完整批次。
   */
  finalizeTurn(
    sessionId: string,
    turnId: string,
    result: AssistantTurnResult,
    profileExtraction?: Omit<UserProfileExtractionScheduleInput, 'sourceTurnId' | 'sessionId'>,
    options?: {
      residualMemoryMode?: AssistantContextRuntimeMode;
      agentMessages?: readonly QaAgentMessageInput[];
      finalReasoningContent?: string;
      route?: QaCanonicalRoute;
      archiveScope?: TrustedMemoryScope;
    },
  ): void {
    this.repository.finalizeTurn(sessionId, turnId, result, {
      ...(options?.agentMessages ? { agentMessages: options.agentMessages } : {}),
      ...(options?.finalReasoningContent ? { finalReasoningContent: options.finalReasoningContent } : {}),
      ...(options?.route ? { route: options.route } : {}),
      ...(options?.archiveScope ? { archiveScope: options.archiveScope } : {}),
    });
    // WK-M9: legacy summaries/checkpoints/profile are read-only rollback data.
    // Canonical L4 extraction is scheduled by completeTurnPostProcess instead.
    // WK-M9：legacy 摘要/检查点/画像仅作只读回退数据；规范 L4 抽取改由 completeTurnPostProcess 调度。
    void profileExtraction;
  }

  /**
   * Cancelled/failed turn: persists the terminal status; aborted turns never enter the hot window or compression.
   * 轮次取消/失败：落库终止状态；取消与失败轮不进热窗也不参与压缩。
   */
  finishAbortedTurn(sessionId: string, turnId: string, status: 'cancelled' | 'error', assistantText?: string): void {
    this.repository.finishAbortedTurn(sessionId, turnId, status, assistantText);
  }

  /**
   * Application exit: aborts background compression to avoid dangling requests.
   * 应用退出：中止后台压缩，避免悬挂请求。
   */
  shutdown(): void {
    this.compressionQueue.abortAll();
    this.residualMemoryEnforcer.abortAll();
    this.userProfileExtractionQueue?.abortAll();
  }

  /**
   * Before deleting a session: cancels that session's background maintenance calls.
   * 删除会话前取消该会话的后台维护调用。
   */
  cancelSession(sessionId: string): void {
    this.compressionQueue.cancelSession(sessionId);
    this.residualMemoryEnforcer.cancelSession(sessionId);
    this.userProfileExtractionQueue?.cancelSession(sessionId);
  }

  /**
   * Batch evaluation (design §3.1 / §3.4 / §6 step 3): missing batches immediately get a
   * deterministic placeholder and advance seq; then all batches are enqueued for LLM work
   * in ascending order. Never blocks the current turn's answer.
   * 批次评估（设计 §3.1 / §3.4 / §6 步骤 3）：
   * missing 批次立即写确定性占位并推进 seq，随后全部批次按升序入队 LLM。
   * 全程不阻塞当轮回答。
   */
  private evaluatePendingBatches(sessionId: string): void {
    const planned = this.repository.planPendingBatches(sessionId);
    if (planned.length === 0) return;
    for (const batch of planned) {
      if (batch.need !== 'missing') continue;
      const turns = this.repository.loadTurnRange(sessionId, batch.turnFrom, batch.turnTo);
      if (turns.length === 0) continue;
      this.repository.upsertSummary({
        sessionId,
        turnFrom: batch.turnFrom,
        turnTo: batch.turnTo,
        summaryText: buildQaFallbackSummaryBody(turns),
        compressor: 'fallback',
        status: 'done',
      });
    }
    this.compressionQueue.enqueue(sessionId, planned);
  }
}

/**
 * Merges multiple context-memory results into one: concatenates materials and sums diagnostics.
 * 将多个上下文记忆结果合并为一个：拼接材料并汇总诊断指标。
 */
function combineContextMemoryResults(...results: readonly ContextMemoryResult[]): ContextMemoryResult {
  const materials = results.flatMap((result) => result.materials);
  return {
    materials,
    version: results.map((result) => result.version).join(':'),
    diagnostics: {
      source: results.map((result) => result.diagnostics.source).join('+'),
      loadedTurns: results.reduce((sum, result) => sum + result.diagnostics.loadedTurns, 0),
      loadedSummaries: results.reduce((sum, result) => sum + result.diagnostics.loadedSummaries, 0),
      recalledTurns: results.reduce((sum, result) => sum + result.diagnostics.recalledTurns, 0),
      staleItems: results.reduce((sum, result) => sum + result.diagnostics.staleItems, 0),
    },
  };
}

/**
 * Builds an empty context-memory result tagged with a diagnostic source label.
 * 构造带诊断来源标签的空上下文记忆结果。
 */
function emptyContextMemory(source: string): ContextMemoryResult {
  return {
    materials: [],
    version: source,
    diagnostics: { source, loadedTurns: 0, loadedSummaries: 0, recalledTurns: 0, staleItems: 0 },
  };
}

/**
 * Sums estimated tokens of materials belonging to the given conversation zone.
 * 汇总指定会话分区材料的估算 token 数。
 */
function sumMaterialTokens(
  contextMemory: QaMemoryPreparation['contextMemory'],
  zone: 'conversation-summary' | 'conversation-hot',
): number {
  return contextMemory.materials
    .filter((material) => material.zone === zone)
    .reduce((total, material) => total + estimateTokenCount(material.content), 0);
}
