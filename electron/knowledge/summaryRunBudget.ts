/**
 * Summary run budget: tracks model calls, wall time, and token budgets for summary generation.
 * 摘要运行预算：跟踪摘要生成的模型调用、墙钟时间和 token 预算。
 */

import { estimateTokenCount } from './tokenEstimator';
import { ModelCallBudgetGate, type ModelCallTicket } from './modelCallBudget';
import { PromptBudgetScheduler, type PromptBudgetPlan } from './currentNoteContextBudget';

/** Default budget limits for a summary run. / 摘要运行的默认预算限制。 */
export const DEFAULT_SUMMARY_RUN_BUDGET = Object.freeze({
  maxModelCalls: 8,
  maxWallTimeMs: 60_000,
  maxInputTokens: 160_000,
  maxOutputTokens: 32_768,
});

/** Options for creating a summary run budget. / 创建摘要运行预算的选项。 */
export interface SummaryRunBudgetOptions {
  maxModelCalls?: number;
  maxWallTimeMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  startedAt?: number;
}

/** Input for preflight budget check before summary generation. / 摘要生成前的预检预算输入。 */
export interface SummaryRunPreflightInput {
  uncachedSectionCount: number;
  maxDigestAttempts: number;
  estimatedReduceCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/** Result of the preflight budget check. / 预检预算的结果。 */
export interface SummaryRunPreflightResult {
  ok: boolean;
  worstCaseModelCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  reason?: 'model-budget' | 'token-budget' | 'wall-time';
}

/** A prepared model call with ticket and budget plan. / 含票据和预算计划的已准备模型调用。 */
export interface SummaryRunPreparedCall {
  ticket: ModelCallTicket;
  plan: PromptBudgetPlan;
}

/** Checkpoint state for resumable summary generation. / 可恢复摘要生成的检查点状态。 */
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

/** Budget tracker for a summary run with model call gating and token accounting. / 摘要运行的预算跟踪器，含模型调用门控与 token 计量。 */
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

  recordOutput(prepared: SummaryRunPreparedCall, value: unknown): void {
    this.reservedOutputTokens = Math.max(0, this.reservedOutputTokens - prepared.plan.maxOutputTokens);
    this.outputTokensUsed += estimateTokenCount(JSON.stringify(value));
  }

  releaseOutputReservation(prepared: SummaryRunPreparedCall): void {
    this.reservedOutputTokens = Math.max(0, this.reservedOutputTokens - prepared.plan.maxOutputTokens);
  }

  isWithinBudget(): boolean {
    return this.gate.isWithinDeadline() && this.inputTokensUsed <= this.maxInputTokens && this.outputTokensUsed + this.reservedOutputTokens <= this.maxOutputTokens;
  }
}
