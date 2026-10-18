/**
 * Summary run budget management: enforces model-call, wall-time, and token
 * limits across the entire summary pipeline (map + reduce phases).
 * 摘要运行预算管理：在整个摘要流水线（map + reduce 阶段）中强制执行模型调用、
 * 墙钟时间和 token 用量限制。
 */

import { estimateTokenCount } from '../model/tokenEstimator.ts';
import { ModelCallBudgetGate, type ModelCallTicket } from '../ai/modelCallBudget.ts';
import { PromptBudgetScheduler, type PromptBudgetPlan } from '../currentNote/currentNoteContextBudget.ts';

/** Default budget limits for a summary run / 摘要运行的默认预算限制。 */
export const DEFAULT_SUMMARY_RUN_BUDGET = Object.freeze({
  maxModelCalls: 8,
  maxWallTimeMs: 60_000,
  maxInputTokens: 160_000,
  maxOutputTokens: 32_768,
});

/**
 * Options for constructing a SummaryRunBudget instance.
 * 构造 SummaryRunBudget 实例的选项。
 */
export interface SummaryRunBudgetOptions {
  maxModelCalls?: number;
  maxWallTimeMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  startedAt?: number;
}

/**
 * Input for the preflight budget feasibility check.
 * 预检预算可行性检查的输入。
 */
export interface SummaryRunPreflightInput {
  uncachedSectionCount: number;
  maxDigestAttempts: number;
  estimatedReduceCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/**
 * Result of the preflight budget feasibility check.
 * 预检预算可行性检查的结果。
 */
export interface SummaryRunPreflightResult {
  ok: boolean;
  worstCaseModelCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  reason?: 'model-budget' | 'token-budget' | 'wall-time';
}

/**
 * A prepared model call with its ticket and prompt budget plan.
 * 已准备的模型调用，包含票据和 prompt 预算计划。
 */
export interface SummaryRunPreparedCall {
  ticket: ModelCallTicket;
  plan: PromptBudgetPlan;
}

/**
 * Serialized checkpoint for resumable summary runs across app restarts.
 * 用于应用重启后恢复摘要运行的序列化检查点。
 */
export interface SummaryRunCheckpoint {
  schemaVersion: 1;
  mode: 'summary-quick' | 'summary-complete';
  snapshotId: string;
  contentHash: string;
  libraryId: string;
  relativePath: string;
  providerFingerprint: string;
  model: string;
  completedSectionIds: string[];
  reduceLevel?: number;
  reduceBatchIndex?: number;
  reduceItems?: Array<{
    headingPath: string[];
    summary: string;
    keyPoints: string[];
    sourceRefs: Array<{ blockId: string; lineFrom: number; lineTo: number; textHash: string }>;
  }>;
  reduceCompletedItems?: SummaryRunCheckpoint['reduceItems'];
}

/**
 * Enforces cumulative budget limits (model calls, wall time, input/output tokens)
 * across a multi-step summary pipeline. Supports preflight checks, per-call
 * reservation, output recording, and deadline enforcement.
 * 在多步摘要流水线中强制执行累计预算限制（模型调用、墙钟时间、输入/输出 token）。
 * 支持预检、单次调用预留、输出记录和截止时间强制执行。
 */
export class SummaryRunBudget {
  readonly gate: ModelCallBudgetGate;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  private readonly scheduler = new PromptBudgetScheduler();
  private inputTokensUsed = 0;
  private outputTokensUsed = 0;
  private reservedOutputTokens = 0;

  constructor(options: SummaryRunBudgetOptions = {}) {
    const maxModelCalls = options.maxModelCalls ?? DEFAULT_SUMMARY_RUN_BUDGET.maxModelCalls;
    const maxWallTimeMs = options.maxWallTimeMs ?? DEFAULT_SUMMARY_RUN_BUDGET.maxWallTimeMs;
    this.maxInputTokens = options.maxInputTokens ?? DEFAULT_SUMMARY_RUN_BUDGET.maxInputTokens;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_SUMMARY_RUN_BUDGET.maxOutputTokens;
    if (!Number.isSafeInteger(this.maxInputTokens) || this.maxInputTokens < 1) throw new Error('摘要累计输入 token 上限必须是正整数。');
    if (!Number.isSafeInteger(this.maxOutputTokens) || this.maxOutputTokens < 1) throw new Error('摘要累计输出 token 上限必须是正整数。');
    this.gate = new ModelCallBudgetGate({ maxModelCalls, maxWallTimeMs, startedAt: options.startedAt });
  }

  get inputTokens(): number { return this.inputTokensUsed; }
  get outputTokens(): number { return this.outputTokensUsed; }
  get modelCalls(): number { return this.gate.modelCalls; }
  get deadlineAt(): number {
    const deadlineAt = this.gate.deadlineAtMs;
    if (deadlineAt === undefined) throw new Error('摘要预算必须配置墙钟截止。');
    return deadlineAt;
  }

  /**
   * Run a preflight feasibility check before starting the summary pipeline.
   * 在开始摘要流水线之前运行预检可行性检查。
   *
   * @param input - Estimated call counts and token usage / 预估的调用次数和 token 用量
   * @returns Preflight result indicating if the budget is sufficient / 预检结果，指示预算是否充足
   */
  preflight(input: SummaryRunPreflightInput): SummaryRunPreflightResult {
    const worstCaseModelCalls = input.uncachedSectionCount * input.maxDigestAttempts + input.estimatedReduceCalls;
    const inputTokens = Math.max(0, Math.ceil(input.estimatedInputTokens));
    const outputTokens = Math.max(0, Math.ceil(input.estimatedOutputTokens));
    const reason = worstCaseModelCalls > this.gate.maxCalls
      ? 'model-budget'
      : inputTokens > this.maxInputTokens || outputTokens > this.maxOutputTokens
        ? 'token-budget'
        : !this.gate.isWithinDeadline()
          ? 'wall-time'
          : undefined;
    return { ok: reason === undefined, worstCaseModelCalls, estimatedInputTokens: inputTokens, estimatedOutputTokens: outputTokens, ...(reason ? { reason } : {}) };
  }

  /**
   * Reserve budget for a single model call. Returns undefined if budget is exceeded.
   * 为单次模型调用预留预算。超出预算时返回 undefined。
   *
   * @param input - Prompt text and call metadata / prompt 文本和调用元数据
   * @returns Prepared call with ticket and plan, or undefined if over budget / 包含票据和计划的已准备调用，超预算时返回 undefined
   */
  prepare(input: { prompt: string; contextWindowTokens?: number; callKind: 'summary-map' | 'summary-reduce'; retryOfTicketId?: string }): SummaryRunPreparedCall | undefined {
    const ticket = this.gate.reserve({ callKind: input.callKind, budgetKind: 'summary-run', ...(input.retryOfTicketId ? { retryOfTicketId: input.retryOfTicketId } : {}) });
    if (!ticket) return undefined;
    const plan = this.scheduler.plan({ prompt: input.prompt, contextWindowTokens: input.contextWindowTokens, callKind: input.callKind });
    const projectedInput = this.inputTokensUsed + plan.predictedPromptTokens;
    const projectedOutput = this.outputTokensUsed + this.reservedOutputTokens + plan.maxOutputTokens;
    if (!plan.fits || projectedInput > this.maxInputTokens || projectedOutput > this.maxOutputTokens) {
      this.gate.cancelUnsent(ticket);
      return undefined;
    }
    this.gate.markSent(ticket);
    this.inputTokensUsed += plan.predictedPromptTokens;
    this.reservedOutputTokens += plan.maxOutputTokens;
    return { ticket, plan };
  }

  /**
   * Record actual output tokens from a completed call and release the reservation.
   * 记录已完成调用的实际输出 token 并释放预留。
   *
   * @param prepared - The prepared call to settle / 要结算的已准备调用
   * @param value - The actual output value / 实际输出值
   */
  recordOutput(prepared: SummaryRunPreparedCall, value: unknown): void {
    this.reservedOutputTokens = Math.max(0, this.reservedOutputTokens - prepared.plan.maxOutputTokens);
    this.outputTokensUsed += estimateTokenCount(JSON.stringify(value));
  }

  /**
   * Release the output token reservation without recording actual usage (e.g., on cancellation).
   * 释放输出 token 预留但不记录实际用量（如取消时）。
   *
   * @param prepared - The prepared call whose reservation to release / 要释放预留的已准备调用
   */
  releaseOutputReservation(prepared: SummaryRunPreparedCall): void {
    this.reservedOutputTokens = Math.max(0, this.reservedOutputTokens - prepared.plan.maxOutputTokens);
  }

  /**
   * Check if the current usage is still within all budget constraints.
   * 检查当前用量是否仍在所有预算约束内。
   *
   * @returns True if within budget / 在预算内返回 true
   */
  isWithinBudget(): boolean {
    return this.gate.isWithinDeadline() && this.inputTokensUsed <= this.maxInputTokens && this.outputTokensUsed + this.reservedOutputTokens <= this.maxOutputTokens;
  }
}
