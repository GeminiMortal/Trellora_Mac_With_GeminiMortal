/**
 * Authorization and budget coordination for assistant and maintenance model calls.
 * 助手与维护类模型调用的授权与预算协调。
 */
import { ModelCallBudgetGate, type ModelCallBudgetKind, type ModelCallKind, type ModelCallTicket } from './modelCallBudget.ts';
import { PromptBudgetScheduler, type PromptBudgetPlan } from '../currentNote/currentNoteContextBudget.ts';
import type { AiProviderKind } from './aiTypes.ts';
import { sharedTokenCalibrationStore, type TokenCalibrationStore } from '../model/tokenCalibration.ts';
import type { EvidencePromptManifest } from '../assistant/assistantTurnTypes.ts';

/**
 * Reason codes for rejected model-call preparation.
 * 模型调用准备被拒绝的原因码。
 */
export type ModelCallPreparationFailure = 'model-budget' | 'context-budget' | 'timeout';

/**
 * Error thrown when the coordinator rejects a model-call preparation.
 * 协调器拒绝模型调用准备时抛出的错误。
 */
export class ModelCallPreparationError extends Error {
  /** Stable machine-readable error code / 稳定的机器可读错误码 */
  readonly code = 'MODEL_CALL_NOT_AUTHORIZED';
  /** The rejection reason / 拒绝原因 */
  readonly reason: ModelCallPreparationFailure;

  /**
   * Create a preparation error with a human-readable Chinese message.
   * 创建带有中文可读消息的准备错误。
   *
   * @param reason - Why the call was rejected / 调用被拒绝的原因
   */
  constructor(reason: ModelCallPreparationFailure) {
    super(reason === 'context-budget'
      ? '当前模型窗口不足，未发送模型请求。'
      : reason === 'timeout' ? '模型调用已超时或取消，未发送模型请求。' : '当前模型调用预算已用尽，未发送模型请求。');
    this.reason = reason;
    this.name = 'ModelCallPreparationError';
  }
}

/**
 * Bundled ticket and prompt-budget plan returned when preparation succeeds.
 * 准备成功时打包返回的票据与提示词预算计划。
 */
export interface PreparedModelCall {
  /** Reserved call ticket / 已预留的调用票据 */
  ticket: ModelCallTicket;
  /** Sizing plan for the complete prompt / 完整提示词的规模计划 */
  plan: PromptBudgetPlan;
}

/**
 * Successful preparation result.
 * 准备成功的结果。
 */
export interface ModelCallPreparationResult {
  ready: true;
  /** The prepared call bundle / 已准备的调用包 */
  call: PreparedModelCall;
}

/**
 * Rejected preparation result with a reason code.
 * 被拒绝的准备结果及原因码。
 */
export interface ModelCallPreparationRejected {
  ready: false;
  /** The rejection reason / 拒绝原因 */
  reason: ModelCallPreparationFailure;
}

/**
 * Input for preparing an evidence-compression model call.
 * 证据压缩模型调用的准备输入。
 */
export interface EvidenceCompressionPreparationInput {
  /** The compression prompt / 压缩提示词 */
  prompt: string;
  /** Pre-computed budget text to inject / 预算注入的预算文本 */
  serializedBudgetText?: string;
  /** Envelope version for calibration / 用于校准的信封版本 */
  requestEnvelopeVersion?: string;
  /** Caller-requested max output tokens / 调用方请求的最大输出 token 数 */
  requestedMaxOutputTokens?: number;
  /** Provider-imposed max output tokens / 供应商限制的最大输出 token 数 */
  providerMaxOutputTokens?: number;
}

/**
 * The only shared authorization helper for assistant model sends. It performs
 * the ticket reservation and complete-prompt sizing in one operation; callers
 * must not invoke a provider unless this returns ready=true.
 * 助手模型发送的唯一共享授权助手。它在一次操作中完成票据预留与完整提示词规模估算；
 * 除非返回 ready=true，否则调用方不得请求供应商。
 */
export class ModelCallCoordinator {
  /** Budget gate instance / 预算门控实例 */
  readonly gate: ModelCallBudgetGate;
  private readonly scheduler: PromptBudgetScheduler;
  private readonly contextWindowTokens?: number;
  private readonly budgetKind: ModelCallBudgetKind;
  private readonly tokenCalibrationStore: TokenCalibrationStore;
  private readonly providerKind?: AiProviderKind;
  private readonly model?: string;
  private readonly maxEvidenceCompressionCalls: number;
  private readonly finalSynthesisReserveMs: number;
  private evidenceCompressionCallCount = 0;

  /**
   * Create a coordinator bound to a budget gate and optional calibration context.
   * 创建绑定预算门控与可选校准上下文的协调器。
   *
   * @param gate - Ticket reservation gate / 票据预留门控
   * @param contextWindowTokens - Context window size in tokens / 上下文窗口 token 数
   * @param budgetKind - Budget category for this call class / 本调用类别的预算类型
   * @param scheduler - Prompt-budget scheduler instance / 提示词预算调度器
   * @param options - Optional provider/model/calibration overrides / 可选的厂商/模型/校准覆盖
   */
  constructor(
    gate: ModelCallBudgetGate,
    contextWindowTokens?: number,
    budgetKind: ModelCallBudgetKind = 'react-turn',
    scheduler = new PromptBudgetScheduler(),
    options: { providerKind?: AiProviderKind; model?: string; tokenCalibrationStore?: TokenCalibrationStore; maxEvidenceCompressionCalls?: number; finalSynthesisReserveMs?: number } = {},
  ) {
    this.gate = gate;
    this.contextWindowTokens = contextWindowTokens;
    this.budgetKind = budgetKind;
    this.scheduler = scheduler;
    this.providerKind = options.providerKind;
    this.model = options.model;
    this.tokenCalibrationStore = options.tokenCalibrationStore ?? sharedTokenCalibrationStore;
    this.maxEvidenceCompressionCalls = options.maxEvidenceCompressionCalls ?? 5;
    this.finalSynthesisReserveMs = options.finalSynthesisReserveMs ?? 0;
    if (!Number.isSafeInteger(this.maxEvidenceCompressionCalls) || this.maxEvidenceCompressionCalls < 1) throw new Error('证据压缩调用上限必须是正整数。');
    if (!Number.isSafeInteger(this.finalSynthesisReserveMs) || this.finalSynthesisReserveMs < 0) throw new Error('最终合成保留时间必须是非负整数。');
  }

  /** Number of evidence-compression calls already consumed in this coordinator. / 本协调器已消耗的证据压缩调用次数。 */
  get evidenceCompressionCallsUsed(): number {
    return this.evidenceCompressionCallCount;
  }

  /**
   * Return the token-calibration multiplier for a given call kind and envelope version.
   * 返回给定调用类型与信封版本的 token 校准倍率。
   *
   * @param callKind - Type of model call / 模型调用类型
   * @param requestEnvelopeVersion - Envelope version for calibration / 用于校准的信封版本
   * @returns Multiplier value, defaulting to 1 / 倍率值，默认为 1
   */
  getCalibrationMultiplier(callKind: ModelCallKind, requestEnvelopeVersion?: string): number {
    return this.providerKind && this.model
      ? this.tokenCalibrationStore.getMultiplier({
        providerKind: this.providerKind,
        model: this.model,
        callKind,
        requestEnvelopeVersion,
      })
      : 1;
  }

  /**
   * Prepare an evidence-compression call using the existing total-call/deadline gate
   * without wiring compression into Agent synthesis (Stage 4).
   * 阶段4 使用已有的总调用/截止时间门控准备证据压缩调用，暂不将压缩接入 Agent 合成流程。
   *
   * @param input - Compression prompt and budget parameters / 压缩提示词与预算参数
   * @returns Preparation result or rejection / 准备结果或拒绝信息
   */
  prepareEvidenceCompression(input: EvidenceCompressionPreparationInput): ModelCallPreparationResult | ModelCallPreparationRejected {
    if (this.evidenceCompressionCallCount >= this.maxEvidenceCompressionCalls) return { ready: false, reason: 'model-budget' };
    const deadlineAt = this.gate.deadlineAtMs;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt - this.finalSynthesisReserveMs) return { ready: false, reason: 'timeout' };
    const prepared = this.prepare({
      // Compression is an intermediate derivation call. Reuse the existing
      // non-terminal gate kind so a final synthesis slot remains reserved.
      // 压缩是中间派生调用；复用已有的非终态门控类型，为最终合成保留一个调用槽位。
      callKind: 'decide',
      prompt: input.prompt,
      ...(input.serializedBudgetText !== undefined ? { serializedBudgetText: input.serializedBudgetText } : {}),
      ...(input.requestEnvelopeVersion ? { requestEnvelopeVersion: input.requestEnvelopeVersion } : {}),
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
      providerMaxOutputTokens: input.providerMaxOutputTokens,
    });
    if (prepared.ready) this.evidenceCompressionCallCount += 1;
    return prepared;
  }

  /**
   * Prepare a model call by reserving a ticket and sizing the prompt against the context window.
   * 通过预留票据和按上下文窗口估算提示词来准备模型调用。
   *
   * @param input - Call kind, prompt, budget and manifest details / 调用类型、提示词、预算与清单详情
   * @returns Preparation result or rejection / 准备结果或拒绝信息
   */
  prepare(input: {
    callKind: ModelCallKind;
    prompt: string;
    serializedBudgetText?: string;
    requestEnvelopeVersion?: string;
    retryOfTicketId?: string;
    requestedMaxOutputTokens?: number;
    providerMaxOutputTokens?: number;
    evidencePromptManifest?: EvidencePromptManifest;
  }): ModelCallPreparationResult | ModelCallPreparationRejected {
    const ticket = this.gate.reserve({
      callKind: input.callKind,
      budgetKind: this.budgetKind,
      ...(input.retryOfTicketId ? { retryOfTicketId: input.retryOfTicketId } : {}),
    });
    if (!ticket) {
      return { ready: false, reason: this.gate.isWithinDeadline() ? 'model-budget' : 'timeout' };
    }
    const plan = this.scheduler.plan({
      prompt: input.prompt,
      ...(input.serializedBudgetText !== undefined ? { serializedBudgetText: input.serializedBudgetText } : {}),
      ...(input.requestEnvelopeVersion ? { requestEnvelopeVersion: input.requestEnvelopeVersion } : {}),
      contextWindowTokens: this.contextWindowTokens,
      callKind: input.callKind,
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
      providerMaxOutputTokens: input.providerMaxOutputTokens,
      calibrationMultiplier: this.getCalibrationMultiplier(input.callKind, input.requestEnvelopeVersion),
    });
    if (!plan.fits) {
      this.gate.cancelUnsent(ticket);
      return { ready: false, reason: 'context-budget' };
    }
    if (input.evidencePromptManifest) {
      try {
        assertEvidencePromptManifest(input.evidencePromptManifest, plan);
      } catch (error) {
        this.gate.cancelUnsent(ticket);
        throw error;
      }
    }
    // A provider rejection still consumes the call. Mark before crossing the
    // provider boundary so overflow and invalid JSON cannot mint a refund.
    // 供应商拒绝仍消耗调用次数；在穿越供应商边界前标记已发送，
    // 防止溢出或无效 JSON 触发退款。
    this.gate.markSent(ticket);
    return { ready: true, call: { ticket, plan } };
  }
}

/**
 * Options for constructing a MaintenanceModelCallCoordinator.
 * MaintenanceModelCallCoordinator 的构造选项。
 */
export interface MaintenanceModelCallCoordinatorOptions {
  /** Maximum concurrent maintenance jobs / 最大并发维护任务数 */
  maxConcurrent?: number;
  /** Maximum model calls per single job / 单个任务的最大模型调用次数 */
  maxModelCallsPerJob?: number;
  /** Wall-clock budget per job in milliseconds / 单个任务的墙钟预算（毫秒） */
  maxWallTimeMs?: number;
  /** Custom prompt-budget scheduler / 自定义提示词预算调度器 */
  scheduler?: PromptBudgetScheduler;
  /** Custom token-calibration store / 自定义 token 校准存储 */
  tokenCalibrationStore?: TokenCalibrationStore;
}

/**
 * Input for a single maintenance-model-call run.
 * 单次维护模型调用运行的输入。
 */
export interface MaintenanceModelCallRunInput<T> {
  /** Unique job identifier / 唯一任务标识 */
  jobId: string;
  /** Optional session id for cancellation grouping / 可选的会话 id，用于按会话取消 */
  sessionId?: string;
  /** Allowed call kind for maintenance / 维护允许的调用类型 */
  callKind: Extract<ModelCallKind, 'memory-compress' | 'conversation-maintenance' | 'follow-up-suggest' | 'user-profile-extract'>;
  /** The prompt to send / 待发送的提示词 */
  prompt: string;
  /** Pre-computed budget text / 预算文本 */
  serializedBudgetText?: string;
  /** Envelope version for calibration / 用于校准的信封版本 */
  requestEnvelopeVersion?: string;
  /** Context window size in tokens / 上下文窗口 token 数 */
  contextWindowTokens: number;
  /** Provider kind for calibration / 用于校准的厂商类型 */
  providerKind?: AiProviderKind;
  /** Model name / 模型名 */
  model: string;
  /** Caller-requested max output tokens / 调用方请求的最大输出 token 数 */
  requestedMaxOutputTokens?: number;
  /** Provider-imposed max output tokens / 供应商限制的最大输出 token 数 */
  providerMaxOutputTokens?: number;
  /** External abort signal / 外部中止信号 */
  signal?: AbortSignal;
  /** Actual provider invocation callback / 实际供应商调用回调 */
  execute: (input: { call: PreparedModelCall; signal: AbortSignal }) => Promise<T>;
}

/**
 * Runtime statistics of the maintenance coordinator.
 * 维护协调器的运行时统计。
 */
export interface MaintenanceModelCallStats {
  /** Jobs waiting for a concurrency slot / 等待并发槽位的任务数 */
  queued: number;
  /** Currently running jobs / 当前运行中的任务数 */
  active: number;
  /** Successfully sent jobs / 已成功发送的任务数 */
  sent: number;
  /** Failed jobs / 失败的任务数 */
  failed: number;
  /** Cancelled jobs / 已取消的任务数 */
  cancelled: number;
}

interface MaintenanceWaiter {
  sessionId?: string;
  resolve: (granted: boolean) => void;
}

/**
 * Low-concurrency model lane for background work. Each job gets its own gate,
 * deadline, and abort scope, so maintenance cannot consume an interactive
 * ReAct ticket or extend the current answer's wall-clock budget.
 * 低并发后台模型通道。每个任务拥有独立的门控、截止时间和中止作用域，
 * 使得维护任务不会消耗交互式 ReAct 票据或延长当前回答的墙钟预算。
 */
export class MaintenanceModelCallCoordinator {
  private readonly maxConcurrent: number;
  private readonly maxModelCallsPerJob: number;
  private readonly maxWallTimeMs: number;
  private readonly scheduler: PromptBudgetScheduler;
  private readonly tokenCalibrationStore: TokenCalibrationStore;
  private readonly waiters: MaintenanceWaiter[] = [];
  private readonly controllers = new Map<string, { sessionId?: string; controller: AbortController }>();
  private readonly cancelledSessions = new Set<string>();
  private active = 0;
  private sent = 0;
  private failed = 0;
  private cancelled = 0;
  private stopped = false;

  /**
   * Create a maintenance coordinator with the given concurrency and budget limits.
   * 创建具有指定并发与预算限制的维护协调器。
   *
   * @param options - Concurrency, call limits and calibration overrides / 并发、调用限制与校准覆盖
   */
  constructor(options: MaintenanceModelCallCoordinatorOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxModelCallsPerJob = options.maxModelCallsPerJob ?? 1;
    this.maxWallTimeMs = options.maxWallTimeMs ?? 30_000;
    this.scheduler = options.scheduler ?? new PromptBudgetScheduler();
    this.tokenCalibrationStore = options.tokenCalibrationStore ?? sharedTokenCalibrationStore;
    assertPositiveInteger(this.maxConcurrent, '维护调用并发上限');
    assertPositiveInteger(this.maxModelCallsPerJob, '维护任务调用上限');
    assertPositiveInteger(this.maxWallTimeMs, '维护任务墙钟预算');
  }

  /**
   * Return a snapshot of current coordinator statistics.
   * 返回协调器当前统计的快照。
   *
   * @returns Stats object / 统计对象
   */
  getStats(): MaintenanceModelCallStats {
    return {
      queued: this.waiters.length,
      active: this.active,
      sent: this.sent,
      failed: this.failed,
      cancelled: this.cancelled,
    };
  }

  /**
   * Acquire a concurrency slot, prepare a gate-scoped call, and execute it.
   * 获取并发槽位，准备门控作用域内的调用并执行。
   *
   * @param input - Job descriptor with prompt, model and execution callback / 含提示词、模型与执行回调的任务描述
   * @returns Result of the execute callback / execute 回调的返回值
   */
  async run<T>(input: MaintenanceModelCallRunInput<T>): Promise<T> {
    if (!input.jobId.trim()) throw new Error('维护任务标识不能为空。');
    if (this.stopped || input.sessionId && this.cancelledSessions.has(input.sessionId)) throw createMaintenanceAbortError();
    await this.acquire(input.sessionId);
    if (this.stopped || input.sessionId && this.cancelledSessions.has(input.sessionId)) {
      this.release();
      throw createMaintenanceAbortError();
    }

    const controller = new AbortController();
    this.controllers.set(input.jobId, { ...(input.sessionId ? { sessionId: input.sessionId } : {}), controller });
    const timeoutSignal = AbortSignal.timeout(this.maxWallTimeMs);
    const signal = input.signal
      ? AbortSignal.any([controller.signal, timeoutSignal, input.signal])
      : AbortSignal.any([controller.signal, timeoutSignal]);
    const gate = new ModelCallBudgetGate({ maxModelCalls: this.maxModelCallsPerJob, maxWallTimeMs: this.maxWallTimeMs });
    const coordinator = new ModelCallCoordinator(gate, input.contextWindowTokens, 'maintenance-job', this.scheduler, {
      providerKind: input.providerKind,
      model: input.model,
      tokenCalibrationStore: this.tokenCalibrationStore,
    });
    try {
      const prepared = coordinator.prepare({
        callKind: input.callKind,
        prompt: input.prompt,
        ...(input.serializedBudgetText !== undefined ? { serializedBudgetText: input.serializedBudgetText } : {}),
        ...(input.requestEnvelopeVersion ? { requestEnvelopeVersion: input.requestEnvelopeVersion } : {}),
        requestedMaxOutputTokens: input.requestedMaxOutputTokens,
        providerMaxOutputTokens: input.providerMaxOutputTokens,
      });
      if (!prepared.ready) throw new ModelCallPreparationError(prepared.reason);
      this.sent += 1;
      return await input.execute({ call: prepared.call, signal });
    } catch (error) {
      if (signal.aborted || this.stopped || input.sessionId && this.cancelledSessions.has(input.sessionId)) this.cancelled += 1;
      else this.failed += 1;
      throw error;
    } finally {
      this.controllers.delete(input.jobId);
      this.release();
    }
  }

  /**
   * Cancel all running and queued jobs belonging to a session.
   * 取消属于指定会话的所有运行中与排队中的任务。
   *
   * @param sessionId - The session to cancel / 待取消的会话标识
   */
  cancelSession(sessionId: string): void {
    if (!sessionId.trim()) return;
    this.cancelledSessions.add(sessionId);
    for (const entry of this.controllers.values()) {
      if (entry.sessionId === sessionId) entry.controller.abort();
    }
    this.drain();
  }

  /**
   * Abort all running jobs and drain the waiter queue.
   * 中止所有运行中的任务并清空等待队列。
   */
  abortAll(): void {
    this.stopped = true;
    for (const entry of this.controllers.values()) entry.controller.abort();
    while (this.waiters.length) this.waiters.shift()?.resolve(false);
  }

  private async acquire(sessionId?: string): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    const granted = await new Promise<boolean>((resolve) => this.waiters.push({ ...(sessionId ? { sessionId } : {}), resolve }));
    if (!granted) throw createMaintenanceAbortError();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (this.stopped || waiter.sessionId && this.cancelledSessions.has(waiter.sessionId)) {
        waiter.resolve(false);
        continue;
      }
      this.active += 1;
      waiter.resolve(true);
    }
  }
}

/**
 * Validate that the evidence manifest achieves 100% representation coverage before sending.
 * 验证证据清单在发送前是否达到 100% 表示覆盖率。
 */
function assertEvidencePromptManifest(manifest: EvidencePromptManifest, plan: PromptBudgetPlan): void {
  const retrieved = new Set(manifest.turnRetrievedEvidenceIds);
  const represented = new Set(manifest.representedEvidenceIds);
  if (manifest.missingEvidenceIds.length !== 0
    || retrieved.size !== represented.size
    || [...retrieved].some((evidenceId) => !represented.has(evidenceId))
    || manifest.representationCoverage !== 1) {
    throw new Error('最终模型发送前的 EvidencePromptManifest 未达到 100% 表示覆盖。');
  }
  if (plan.predictedPromptTokens > plan.maxPromptTokens) {
    throw new Error('最终模型发送前的完整 Prompt 超出 maxPromptTokens。');
  }
}

/** Assert a value is a positive integer, throwing a labeled Chinese error otherwise. / 断言值为正整数，否则抛出带标签的中文错误。 */
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
}

/** Create a standard abort error for cancelled maintenance jobs. / 创建维护任务取消时使用的标准中止错误。 */
function createMaintenanceAbortError(): Error {
  const error = new Error('维护模型任务已取消。');
  error.name = 'AbortError';
  return error;
}
