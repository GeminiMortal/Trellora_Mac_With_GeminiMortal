/**
 * Model-call budgeting: ticket-based reservations that cap retries and wall-clock time per agent run.
 * 模型调用预算：基于票据的预留机制，限制每次智能体运行的重试次数与墙钟时间。
 */

import type { PromptCallKind } from '../currentNote/currentNoteContextBudget.ts';

/**
 * Kind of prompt call being budgeted; aliases the shared prompt-call taxonomy.
 * 纳入预算的提示调用类型；别名指向共享的提示调用分类。
 */
export type ModelCallKind = PromptCallKind;

/**
 * Budget pool the call is charged against: a ReAct turn, a summary run, shadow evaluation, or maintenance job.
 * 调用记账的预算池：ReAct 回合、摘要运行、影子评估或维护任务。
 */
export type ModelCallBudgetKind = 'react-turn' | 'summary-run' | 'shadow' | 'maintenance-job';

/**
 * Reservation for one model call, recording its ordinal, remaining budget and retry lineage.
 * 单次模型调用的预留票据，记录序号、剩余预算与重试来源。
 */
export interface ModelCallTicket {
  /** Unique ticket identifier. / 票据唯一标识。 */
  ticketId: string;
  /** Prompt-call kind being budgeted. / 纳入预算的提示调用类型。 */
  callKind: ModelCallKind;
  /** Budget pool this call is charged against. / 本次调用记账的预算池。 */
  budgetKind: ModelCallBudgetKind;
  /** 1-based ordinal of this call within the gate. / 闸门内本次调用的序号（从 1 开始）。 */
  modelCallOrdinal: number;
  /** Number of model calls remaining after this one is sent. / 本次发送后剩余的模型调用次数。 */
  remainingModelCallsAfterSend: number;
  /**
   * Absent when the caller explicitly allows the turn to run until cancellation.
   * 当调用方明确允许本轮运行直到取消时，该字段不存在。
   */
  deadlineAt?: number;
  /** Whether a slot is held for the final synthesis step. / 是否为最终综合步骤保留了名额。 */
  finalSynthesisReserved: boolean;
  /** Ticket id this call retries, if any. / 本票据重试的原票据标识（如有）。 */
  retryOfTicketId?: string;
}

/**
 * Options for constructing a ModelCallBudgetGate.
 * 构造 ModelCallBudgetGate 的选项。
 */
export interface ModelCallBudgetGateOptions {
  /** Maximum number of model calls allowed. / 允许的最大模型调用次数。 */
  maxModelCalls: number;
  /** Clock origin for the wall-time deadline; defaults to Date.now(). / 墙钟截止的计时起点；默认为 Date.now()。 */
  startedAt?: number;
  /**
   * Omit to disable the wall-clock deadline while retaining the call-count budget.
   * 省略此字段可关闭墙钟截止，仅保留调用次数预算。
   */
  maxWallTimeMs?: number;
}

/**
 * Reserves model calls without giving prompt sizing code permission to mint
 * retries. Unsent tickets can be cancelled; once marked sent they consume the
 * ordinal even when the provider later rejects the request.
 * 预留模型调用额度但不赋予提示词构造代码自行发起重试的权限。未发送的票据可取消；
 * 标记为已发送后，即使服务商随后拒绝该请求，序号也已消耗。
 */
export class ModelCallBudgetGate {
  private readonly maxModelCalls: number;
  private readonly deadlineAt?: number;
  private modelCallsUsed = 0;
  private nextTicketOrdinal = 0;
  private readonly pending = new Map<string, ModelCallTicket>();

  /**
   * Create a gate with fixed call-count and optional wall-clock budgets.
   * 创建具有固定调用次数预算与可选墙钟预算的闸门。
   *
   * @param options - Budget limits and timing origin / 预算上限与计时起点
   */
  constructor(options: ModelCallBudgetGateOptions) {
    if (!Number.isSafeInteger(options.maxModelCalls) || options.maxModelCalls < 1) throw new Error('模型调用上限必须是正整数。');
    if (options.maxWallTimeMs !== undefined && (!Number.isSafeInteger(options.maxWallTimeMs) || options.maxWallTimeMs < 1)) throw new Error('模型调用墙钟预算必须是正整数。');
    this.maxModelCalls = options.maxModelCalls;
    // Deadline is measured from startedAt (default: now) plus the wall budget. / 截止时间由 startedAt（默认当前时刻）加墙钟预算得出。
    this.deadlineAt = options.maxWallTimeMs === undefined
      ? undefined
      : (options.startedAt ?? Date.now()) + options.maxWallTimeMs;
  }

  /** Number of model calls already sent. / 已发送的模型调用次数。 */
  get modelCalls(): number { return this.modelCallsUsed; }
  /** Configured maximum model calls. / 配置的模型调用上限。 */
  get maxCalls(): number { return this.maxModelCalls; }
  /** Absolute wall-clock deadline in ms, or undefined when disabled. / 绝对墙钟截止时间（毫秒）；未启用时为 undefined。 */
  get deadlineAtMs(): number | undefined { return this.deadlineAt; }
  /** Calls still available, counting pending (unsent) reservations. / 仍可用的调用次数（含已预留未发送）。 */
  get remainingModelCalls(): number { return Math.max(0, this.maxModelCalls - this.modelCallsUsed - this.pending.size); }
  /** True when at least one call slot can still be kept for final synthesis. / 仍至少可为最终综合保留一个调用名额时为 true。 */
  get finalSynthesisReserved(): boolean { return this.hasPendingOrRemainingFinalTicket(); }

  /**
   * Try to reserve one model call ticket, honoring the deadline and final-synthesis reserve.
   * 尝试预留一张模型调用票据，遵守截止时间与最终综合名额保留规则。
   *
   * @param input - Call kind, budget pool and optional retry linkage / 调用类型、预算池与可选重试关联
   * @returns The reserved ticket, or undefined when the budget is exhausted / 预留成功返回票据；预算耗尽时返回 undefined
   */
  reserve(input: { callKind: ModelCallKind; budgetKind: ModelCallBudgetKind; retryOfTicketId?: string }): ModelCallTicket | undefined {
    if (this.deadlineAt !== undefined && Date.now() > this.deadlineAt) return undefined;
    const reservedBefore = this.modelCallsUsed + this.pending.size;
    const remainingAfterSend = this.maxModelCalls - reservedBefore - 1;
    // Only calls that can be followed by more ReAct work must preserve the final
    // synthesis slot. Route/chat/direct calls are terminal even though they share
    // the turn gate with the current-note agent.
    // 只有后续可能继续 ReAct 工作的调用才需要为最终综合保留名额；
    // route/chat/direct 是终态调用，即使它们与当前笔记智能体共用同一轮闸门。
    const requiresFinalReserve = input.budgetKind === 'react-turn'
      && (input.callKind === 'plan' || input.callKind === 'decide');
    if (remainingAfterSend < 0 || (requiresFinalReserve && remainingAfterSend < 1)) return undefined;

    const ticketId = `model-ticket-${++this.nextTicketOrdinal}`;
    const ticket: ModelCallTicket = {
      ticketId,
      callKind: input.callKind,
      budgetKind: input.budgetKind,
      modelCallOrdinal: reservedBefore + 1,
      remainingModelCallsAfterSend: remainingAfterSend,
      finalSynthesisReserved: requiresFinalReserve && remainingAfterSend >= 1,
      ...(this.deadlineAt !== undefined ? { deadlineAt: this.deadlineAt } : {}),
      ...(input.retryOfTicketId ? { retryOfTicketId: input.retryOfTicketId } : {}),
    };
    this.pending.set(ticketId, ticket);
    return ticket;
  }

  /**
   * Mark a reserved ticket as sent, consuming one call from the budget.
   * 将已预留票据标记为已发送，消耗一次调用预算。
   *
   * @param ticket - Ticket previously returned by reserve / 之前由 reserve 返回的票据
   */
  markSent(ticket: ModelCallTicket): void {
    const pending = this.pending.get(ticket.ticketId);
    if (!pending) throw new Error('模型调用票据不存在或已提交。');
    this.pending.delete(ticket.ticketId);
    this.modelCallsUsed += 1;
  }

  /**
   * Release a reserved ticket that was never sent, returning its slot to the budget.
   * 释放从未发送的预留票据，将其名额归还预算。
   *
   * @param ticket - Ticket to release / 要释放的票据
   */
  cancelUnsent(ticket: ModelCallTicket): void {
    this.pending.delete(ticket.ticketId);
  }

  /**
   * Whether the wall-clock deadline has not yet passed.
   * 墙钟截止时间是否尚未到达。
   *
   * @returns True when no deadline is set or it is still in the future / 未设置截止或仍在期限内时返回 true
   */
  isWithinDeadline(): boolean { return this.deadlineAt === undefined || Date.now() <= this.deadlineAt; }

  private hasPendingOrRemainingFinalTicket(): boolean {
    return this.maxModelCalls - (this.modelCallsUsed + this.pending.size) >= 1;
  }
}
