/**
 * Audit-only execution trace store for plan-aware controller actions.
 * 仅审计的执行轨迹存储，记录计划感知控制器的动作和观察。
 *
 * Accepts controller-produced summaries only; raw tool output stays in the
 * Evidence Ledger. Events are compacted via L1 folding for prompt injection.
 */
import { createHash } from 'node:crypto';

/**
 * Allowed trace event kinds.
 * 允许的轨迹事件类型。
 */
export const planExecutionTraceKinds = ['action', 'observation', 'correction'] as const;
/**
 * Union type of allowed trace event kinds.
 * 允许的轨迹事件类型的联合类型。
 */
export type PlanExecutionTraceKind = typeof planExecutionTraceKinds[number];

/**
 * Input for recording a new trace event.
 * 记录新轨迹事件的输入。
 */
export interface PlanExecutionTraceInput {
  planId: string;
  planVersion: number;
  goalId: string;
  kind: PlanExecutionTraceKind;
  tool?: string;
  summary: string;
  evidenceIds?: readonly string[];
}

/**
 * Recorded trace event with sequence number and deterministic ID.
 * 已记录的轨迹事件，附带序列号和确定性 ID。
 */
export interface PlanExecutionTraceEvent extends PlanExecutionTraceInput {
  seq: number;
  traceId: string;
}

/**
 * L1-compacted trace event with deduplicated evidence IDs and sequence range.
 * L1 压缩后的轨迹事件，包含去重的证据 ID 和序列范围。
 */
export interface PlanExecutionTraceL1Event {
  planId: string;
  planVersion: number;
  goalId: string;
  kind: PlanExecutionTraceKind;
  tool?: string;
  summary: string;
  evidenceIds: string[];
  firstSeq: number;
  lastSeq: number;
  count: number;
}

/**
 * Audit-only execution trace. It accepts controller-produced summaries, never
 * raw tool output. Evidence text remains exclusively in the Evidence Ledger.
 *
 * 仅审计的执行轨迹存储。只接受控制器生成的摘要，不存储原始工具输出。
 * 证据文本仅保留在 Evidence Ledger 中。
 */
export class PlanExecutionTraceStore {
  private events: PlanExecutionTraceEvent[] = [];
  private nextSeq = 1;

  /**
   * Records a new trace event and returns the immutable copy.
   * 记录新的轨迹事件并返回不可变副本。
   *
   * @param input - Trace input / 轨迹输入
   * @returns Recorded event / 已记录的事件
   */
  record(input: PlanExecutionTraceInput): PlanExecutionTraceEvent {
    assertTraceInput(input);
    const evidenceIds = normalizeEvidenceIds(input.evidenceIds ?? []);
    const summary = normalizeTraceSummary(input.summary);
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const event: PlanExecutionTraceEvent = {
      planId: input.planId,
      planVersion: input.planVersion,
      goalId: input.goalId,
      kind: input.kind,
      ...(input.tool ? { tool: input.tool } : {}),
      summary,
      evidenceIds,
      seq,
      traceId: createTraceId(input.planId, input.planVersion, input.goalId, input.kind, input.tool, summary, seq),
    };
    this.events = [...this.events, event];
    return copyEvent(event);
  }

  /**
   * Returns a copy of all recorded events.
   * 返回所有已记录事件的副本。
   *
   * @returns Array of trace events / 轨迹事件数组
   */
  list(): PlanExecutionTraceEvent[] {
    return this.events.map(copyEvent);
  }

  /**
   * Returns events up to and including the given sequence number.
   * 返回到给定序列号（含）为止的事件。
   *
   * @param seq - Maximum sequence number (inclusive) / 最大序列号（含）
   * @returns Filtered events / 过滤后的事件
   */
  throughSeq(seq = Number.MAX_SAFE_INTEGER): PlanExecutionTraceEvent[] {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('trace seq 必须是非负安全整数。');
    return this.events.filter((event) => event.seq <= seq).map(copyEvent);
  }

  /**
   * Returns the latest sequence number, or 0 if no events exist.
   * 返回最新序列号，如果没有事件则返回 0。
   */
  get latestSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  /**
   * L1 is deliberately model-free: identical controller observations are
   * folded, evidence IDs are unioned, and active-goal events stay first.
   *
   * L1 压缩故意不含模型：相同的控制器观察被折叠，证据 ID 取并集，
   * 活跃目标事件排在最前。
   *
   * @param input - Compaction parameters / 压缩参数
   * @returns Compacted L1 events / 压缩后的 L1 事件
   */
  compactL1(input: {
    planId: string;
    planVersion: number;
    activeGoalId?: string | null;
    throughSeq?: number;
    maxEvents?: number;
  }): PlanExecutionTraceL1Event[] {
    assertPlanIdentity(input.planId, input.planVersion);
    const maxEvents = input.maxEvents ?? 24;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error('L1 trace 事件上限无效。');
    const source = this.events.filter((event) => event.planId === input.planId
      && event.planVersion <= input.planVersion
      && (input.throughSeq === undefined || event.seq <= input.throughSeq));
    const folded = new Map<string, PlanExecutionTraceL1Event>();
    for (const event of source) {
      const key = `${event.planVersion}\u0000${event.goalId}\u0000${event.kind}\u0000${event.tool ?? ''}\u0000${event.summary}`;
      const existing = folded.get(key);
      if (existing) {
        existing.lastSeq = event.seq;
        existing.count += 1;
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...event.evidenceIds])].sort(compareText);
      } else {
        folded.set(key, {
          planId: event.planId,
          planVersion: event.planVersion,
          goalId: event.goalId,
          kind: event.kind,
          ...(event.tool ? { tool: event.tool } : {}),
          summary: event.summary,
          evidenceIds: [...event.evidenceIds].sort(compareText),
          firstSeq: event.seq,
          lastSeq: event.seq,
          count: 1,
        });
      }
    }
    const events = [...folded.values()].sort((first, second) => {
      const firstActive = input.activeGoalId !== null && input.activeGoalId !== undefined && first.goalId === input.activeGoalId;
      const secondActive = input.activeGoalId !== null && input.activeGoalId !== undefined && second.goalId === input.activeGoalId;
      return Number(secondActive) - Number(firstActive) || second.lastSeq - first.lastSeq || first.goalId.localeCompare(second.goalId);
    });
    return events.slice(0, maxEvents).map(copyL1Event);
  }
}

function assertTraceInput(input: PlanExecutionTraceInput): void {
  assertPlanIdentity(input.planId, input.planVersion);
  if (!/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u.test(input.goalId)) throw new Error('trace goalId 格式无效。');
  if (!planExecutionTraceKinds.includes(input.kind)) throw new Error('trace kind 无效。');
  if (input.tool !== undefined && (!input.tool.trim() || input.tool.length > 120)) throw new Error('trace tool 无效。');
  if (!input.summary.trim() || input.summary.length > 1_000) throw new Error('trace summary 必须是受控短摘要。');
}

function assertPlanIdentity(planId: string, planVersion: number): void {
  if (!/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u.test(planId)) throw new Error('trace planId 格式无效。');
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) throw new Error('trace planVersion 无效。');
}

function normalizeTraceSummary(summary: string): string {
  return summary.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, 360);
}

function normalizeEvidenceIds(evidenceIds: readonly string[]): string[] {
  return [...new Set(evidenceIds.filter((evidenceId) => /^evidence-[a-f0-9]{24}$/u.test(evidenceId)))].sort(compareText);
}

function createTraceId(planId: string, planVersion: number, goalId: string, kind: PlanExecutionTraceKind, tool: string | undefined, summary: string, seq: number): string {
  return `trace-${createHash('sha256').update(`${planId}\u0000${planVersion}\u0000${goalId}\u0000${kind}\u0000${tool ?? ''}\u0000${summary}\u0000${seq}`, 'utf8').digest('hex').slice(0, 24)}`;
}

function copyEvent(event: PlanExecutionTraceEvent): PlanExecutionTraceEvent {
  return { ...event, evidenceIds: [...event.evidenceIds] };
}

function copyL1Event(event: PlanExecutionTraceL1Event): PlanExecutionTraceL1Event {
  return { ...event, evidenceIds: [...event.evidenceIds] };
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
