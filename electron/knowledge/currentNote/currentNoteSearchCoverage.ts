/**
 * Tracks main-process search/read coverage for the current note so goals can
 * declare whether original-text evidence is complete, partial, or insufficient.
 * 在主进程中跟踪当前笔记的搜索与读取覆盖情况，使目标能够判定原文证据是完整、部分还是不足。
 */
import type { CurrentNoteSearchScope, CurrentNoteCoveragePolicy } from './currentNoteSearchScope.ts';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot.ts';
import type { CurrentNoteSearchHit } from './currentNoteLexicalIndex.ts';
import type { AssistantSearchGoalCoverage } from '../assistant/assistantMemoryTypes.ts';

/** Fallback goal key for callers that never supply a goal id. 未提供目标 id 的调用方使用的回退目标键。 */
const TURN_GOAL_ID = '__turn__';
const MAX_SUMMARY_ASPECTS = 6;

/**
 * Coverage verdict for one goal: complete, partial, or insufficient.
 * 单个目标的覆盖判定：完整、部分或不足。
 */
export type CurrentNoteCoverageStatus = 'complete' | 'partial' | 'insufficient';

/**
 * One accepted read observation fed into the coverage ledger.
 * 写入覆盖台账的一条已接受读取观测。
 */
export interface CurrentNoteCoverageReadInput {
  snapshotId?: string;
  /** Evidence Ledger identifier for this read. 本次读取在证据台账中的标识。 */
  evidenceId: string;
  blockIds: readonly string[];
  headingPath: readonly string[];
  lineFrom: number;
  lineTo: number;
  text: string;
  /** Explicit section id when the caller read a named section. 调用方读取命名章节时的显式章节 id。 */
  headingId?: string;
  /** Present when the read stopped early and more text remains. 读取提前结束时存在，表示仍有未读文本。 */
  nextCursor?: number;
}

/**
 * Immutable per-goal coverage counters and status snapshot.
 * 按目标的不可变覆盖计数与状态快照。
 */
export interface CurrentNoteGoalCoverageSummary {
  goalId: string;
  mode: CurrentNoteSearchScope['mode'];
  coveragePolicy: CurrentNoteCoveragePolicy;
  discoveredHeadingCount: number;
  readHeadingCount: number;
  matchedBlockCount: number;
  /** Blocks covered by search; currently mirrors matchedBlockCount. 搜索覆盖的块数；当前与 matchedBlockCount 一致。 */
  searchedBlockCount: number;
  materializedBlockCount: number;
  materializedEvidenceCount: number;
  evidenceCount: number;
  targetAspectCount: number;
  coveredAspectCount: number;
  /** Target aspects not yet backed by any read evidence. 尚无读取证据支撑的目标方面。 */
  remainingAspects: readonly string[];
  /** True when candidate pagination or term batches were truncated. 候选分页或查询词批次被截断时为 true。 */
  candidateTruncated: boolean;
  /** True when all planned terms and pages have been exhausted. 所有计划词与分页已穷尽时为 true。 */
  candidateExhausted: boolean;
  /** All query terms the planner intended to execute. Planner 计划执行的全部查询词。 */
  plannedQueryTerms: readonly string[];
  /** Query terms actually executed so far. 迄今实际执行过的查询词。 */
  executedQueryTerms: readonly string[];
  /** Planned terms not yet executed. 尚未执行的计划查询词。 */
  unexecutedQueryTerms: readonly string[];
  status: CurrentNoteCoverageStatus;
  /** Human-readable explanation for the current status. 当前状态的可读说明。 */
  reason: string;
}

/**
 * All-goals aggregate of per-goal coverage summaries.
 * 跨全部目标的覆盖摘要聚合。
 */
export interface CurrentNoteSearchCoverageSummary extends CurrentNoteGoalCoverageSummary {
  /** Per-goal breakdown excluding the implicit turn goal. 逐目标明细，不含隐式 turn 目标。 */
  goalSummaries: readonly CurrentNoteGoalCoverageSummary[];
}

/** Mutable per-goal accumulator behind the frozen summaries. 冻结摘要背后的按目标可变累加器。 */
interface MutableGoalCoverage {
  discoveredHeadingIds: Set<string>;
  readHeadingIds: Set<string>;
  matchedBlockIds: Set<string>;
  materializedBlockIds: Set<string>;
  materializedEvidenceIds: Set<string>;
  evidenceIds: Set<string>;
  discoveredAspects: Set<string>;
  coveredAspects: Set<string>;
  candidateTruncated: boolean;
  candidateExhausted: boolean;
  truncatedHeadingIds: Set<string>;
  queryFingerprint?: string;
  nextSearchCursor?: string;
  plannedQueryTerms: string[];
  executedQueryTerms: Set<string>;
}

/**
 * Main-process-only coverage state. Search observations can add candidates,
 * but only successful reads which have already been accepted by Evidence
 * Ledger can add readable coverage. No model-facing patch can mutate this
 * object or submit counts.
 * 仅在主进程维护的覆盖状态。搜索观测只能添加候选，只有已被 Evidence Ledger
 * 接受的成功读取才能增加可读覆盖。任何面向模型的补丁都不能修改此对象或提交计数。
 */
export class CurrentNoteSearchCoverageLedger {
  private scope: CurrentNoteSearchScope;
  private readonly goals = new Map<string, MutableGoalCoverage>();

  /**
   * Creates the ledger for one snapshot with a cloned initial scope.
   * 为单个快照创建台账，并克隆初始范围。
   *
   * @param snapshot - Snapshot whose coverage is tracked / 被跟踪覆盖情况的快照
   * @param scope - Initial search scope / 初始搜索范围
   */
  constructor(private readonly snapshot: CurrentNoteSnapshot, scope: CurrentNoteSearchScope) {
    this.scope = cloneScope(scope);
  }

  /**
   * Called by the main-process scope resolver after Planner validation.
   * 由主进程范围解析器在 Planner 校验后调用。
   *
   * @param scope - Validated scope to adopt / 要采纳的已校验范围
   * @returns void / 无返回值
   */
  adoptResolvedScope(scope: CurrentNoteSearchScope): void {
    this.scope = cloneScope(scope);
  }

  /**
   * Records one search page: matched candidates, discovered headings/aspects,
   * auto-materialized reads, and cursor/term progress.
   * 记录一次搜索分页：匹配候选、发现的标题与方面、自动物化读取，以及游标与查询词进度。
   *
   * @param goalId - Goal key; undefined falls back to the turn goal / 目标键；未定义时落到 turn 目标
   * @param hits - Lexical hits observed in this page / 本页观测到的词法命中
   * @param limit - Page size used, 1..20 / 本次使用的分页大小，1..20
   * @param page - Optional cursor page metadata / 可选的游标分页元数据
   * @returns void / 无返回值
   */
  recordSearch(
    goalId: string | undefined,
    hits: readonly CurrentNoteSearchHit[],
    limit: number,
    page?: {
      candidateExhausted: boolean;
      nextCursor?: string;
      queryFingerprint?: string;
      plannedQueryTerms?: readonly string[];
      executedQueryTerms?: readonly string[];
      materialized?: readonly CurrentNoteCoverageReadInput[];
    },
  ): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Coverage 搜索上限无效。');
    const state = this.stateFor(goalId);
    if (page?.plannedQueryTerms) state.plannedQueryTerms = appendOrderedTerms(state.plannedQueryTerms, page.plannedQueryTerms);
    if (page?.executedQueryTerms) {
      for (const term of orderedUniqueTerms(page.executedQueryTerms)) state.executedQueryTerms.add(term);
    }
    for (const hit of hits) {
      if (!hit.blockId || !Number.isInteger(hit.lineFrom) || !Number.isInteger(hit.lineTo)) continue;
      state.matchedBlockIds.add(hit.blockId);
      const headingId = hit.headingId ?? this.headingIdAtLine(hit.lineFrom);
      if (headingId) state.discoveredHeadingIds.add(headingId);
      for (const aspect of this.scope.targetAspects) {
        if (matchesAspect(aspect, [hit.snippet, ...hit.headingPath, ...hit.matchedTerms])) state.discoveredAspects.add(aspect);
      }
    }
    for (const materialized of page?.materialized ?? []) {
      if (materialized.snapshotId !== undefined && materialized.snapshotId !== this.snapshot.snapshotId) {
        throw new Error('Coverage 自动物化结果不属于当前笔记快照。');
      }
      state.evidenceIds.add(materialized.evidenceId);
      state.materializedEvidenceIds.add(materialized.evidenceId);
      for (const blockId of materialized.blockIds) {
        if (blockId) state.materializedBlockIds.add(blockId);
      }
      for (const readHeadingId of this.headingIdsForRangeRead(materialized)) state.readHeadingIds.add(readHeadingId);
      for (const aspect of this.scope.targetAspects) {
        if (matchesAspect(aspect, [materialized.text, ...materialized.headingPath])) state.coveredAspects.add(aspect);
      }
    }
    if (page) {
      // `page.candidateExhausted` only describes the current QueryTerm batch.
      // A goal is exhausted after every planned term has been executed and the
      // final batch has reached its last candidate page.
      // `page.candidateExhausted` 只描述当前查询词批次。
      // 只有所有计划词都已执行且最后批次到达末页时，目标才算穷尽。
      const hasUnexecutedPlannedTerms = state.plannedQueryTerms.some((term) => !state.executedQueryTerms.has(term));
      state.candidateExhausted = page.candidateExhausted && !hasUnexecutedPlannedTerms;
      state.candidateTruncated = !state.candidateExhausted;
      state.nextSearchCursor = page.nextCursor;
      state.queryFingerprint = page.queryFingerprint;
    } else {
      // The legacy array API has no search cursor. Reaching the public limit
      // is therefore deliberately treated as a possible truncation.
      // 旧的数组 API 没有搜索游标，因此故意将触及公开上限视为可能的截断。
      state.candidateExhausted = false;
      state.nextSearchCursor = undefined;
      state.queryFingerprint = undefined;
      if (hits.length >= limit || this.scope.coveragePolicy === 'occurrence-complete') state.candidateTruncated = true;
    }
  }

  /**
   * Records one accepted original-text read and its heading/aspect effects.
   * 记录一次已接受的原文读取及其标题与方面影响。
   *
   * @param goalId - Goal key; undefined falls back to the turn goal / 目标键；未定义时落到 turn 目标
   * @param input - Validated read observation / 已校验的读取观测
   * @returns void / 无返回值
   */
  recordRead(goalId: string | undefined, input: CurrentNoteCoverageReadInput): void {
    if (input.snapshotId !== undefined && input.snapshotId !== this.snapshot.snapshotId) throw new Error('Coverage 读取结果不属于当前笔记快照。');
    if (!/^evidence-[a-f0-9]{24}$/u.test(input.evidenceId)) throw new Error('Coverage 证据标识无效。');
    if (!Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo) || input.lineFrom < 1 || input.lineTo < input.lineFrom) {
      throw new Error('Coverage 原文行范围无效。');
    }
    if (input.headingId && !this.snapshot.headings.some((heading) => heading.headingId === input.headingId && input.lineFrom <= heading.lineTo && input.lineTo >= heading.lineFrom)) {
      throw new Error('Coverage 章节不属于当前原文范围。');
    }
    const state = this.stateFor(goalId);
    state.evidenceIds.add(input.evidenceId);
    // A section tool result is authoritative: do not infer its parent from the
    // returned line range, otherwise one read is counted as both parent and
    // child. Range reads have no explicit heading and therefore derive one
    // most-specific heading per actually returned block.
    // 命名章节的工具结果是权威的：不要从返回的行范围推断其父章节，
    // 否则一次读取会被同时计入父章节和子章节。行范围读取没有显式标题，
    // 因此按实际返回的块推导最具体的标题。
    const readHeadingIds = input.headingId
      ? new Set([input.headingId])
      : this.headingIdsForRangeRead(input);
    for (const readHeadingId of readHeadingIds) state.readHeadingIds.add(readHeadingId);
    for (const aspect of this.scope.targetAspects) {
      if (matchesAspect(aspect, [input.text, ...input.headingPath])) state.coveredAspects.add(aspect);
    }
    for (const readHeadingId of readHeadingIds) {
      if (input.nextCursor !== undefined) state.truncatedHeadingIds.add(readHeadingId);
      else state.truncatedHeadingIds.delete(readHeadingId);
    }
  }

  /**
   * Whether the ledger holds any state for the given goal.
   * 台账中是否已有该目标的状态。
   *
   * @param goalId - Goal key / 目标键
   * @returns True when state exists / 存在状态时返回 true
   */
  hasGoal(goalId: string | undefined): boolean {
    return this.goals.has(normalizeGoalId(goalId));
  }

  /**
   * Whether the goal's coverage status is complete.
   * 目标的覆盖状态是否为完整。
   *
   * @param goalId - Goal key / 目标键
   * @param requiredEvidenceCount - Minimum accepted evidence count / 需要的最少已接受证据数
   * @returns True when status is complete / 状态为完整时返回 true
   */
  isComplete(goalId: string | undefined, requiredEvidenceCount = 1): boolean {
    return this.evaluate(goalId, requiredEvidenceCount).status === 'complete';
  }

  /**
   * Whether any goal still has planned query terms that were never executed.
   * 是否仍有目标存在计划了但从未执行的查询词。
   *
   * @returns True when at least one planned term is unexecuted / 至少有一个计划词未执行时返回 true
   */
  hasUnexecutedPlannedTerms(): boolean {
    for (const state of this.goals.values()) {
      if (state.plannedQueryTerms.some((term) => !state.executedQueryTerms.has(term))) return true;
    }
    return false;
  }

  /**
   * Returns the planned/executed/unexecuted query-term audit for one goal.
   * 返回单个目标的计划/已执行/未执行查询词审计数据。
   *
   * @param goalId - Goal key; undefined falls back to the turn goal / 目标键；未定义时落到 turn 目标
   * @returns Term audit arrays / 查询词审计数组
   */
  getQueryTermAudit(goalId?: string): {
    plannedQueryTerms: string[];
    executedQueryTerms: string[];
    unexecutedQueryTerms: string[];
  } {
    const state = this.stateFor(goalId);
    return {
      plannedQueryTerms: [...state.plannedQueryTerms],
      executedQueryTerms: [...state.executedQueryTerms],
      unexecutedQueryTerms: state.plannedQueryTerms.filter((term) => !state.executedQueryTerms.has(term)),
    };
  }

  /**
   * Computes the immutable coverage summary and status for one goal.
   * 计算单个目标的不可变覆盖摘要与状态。
   *
   * @param goalId - Goal key; undefined falls back to the turn goal / 目标键；未定义时落到 turn 目标
   * @param requiredEvidenceCount - Minimum accepted evidence count / 需要的最少已接受证据数
   * @returns Frozen coverage summary / 冻结的覆盖摘要
   */
  evaluate(goalId: string | undefined, requiredEvidenceCount = 1): CurrentNoteGoalCoverageSummary {
    const normalizedRequiredEvidence = Number.isInteger(requiredEvidenceCount) && requiredEvidenceCount > 0 ? requiredEvidenceCount : 1;
    const key = normalizeGoalId(goalId);
    const state = this.stateFor(goalId);
    const targetAspects = this.completionTargetAspects();
    const remainingAspects = targetAspects.filter((aspect) => !state.coveredAspects.has(aspect));
    const coveredAspects = targetAspects.filter((aspect) => state.coveredAspects.has(aspect));
    const evidenceReady = state.evidenceIds.size >= normalizedRequiredEvidence;
    const minimumSections = this.minimumSections();
    // Status ladder: truncated reads or unvisited aspects keep the goal at
    // `partial`; `sufficient` policy only requires ready evidence and no
    // truncated sections.
    // 状态阶梯：存在截断读取或未覆盖方面时目标保持 `partial`；
    // `sufficient` 策略只要求证据齐备且无截断章节。
    let status: CurrentNoteCoverageStatus = 'insufficient';
    let reason = '尚未读取当前笔记原文证据。';
    if (this.scope.coveragePolicy === 'sufficient') {
      if (evidenceReady && remainingAspects.length === 0 && state.truncatedHeadingIds.size === 0) {
        status = 'complete';
        reason = '当前原文范围已达到进入合成的前提；最终答案完整性仍由模型判断。';
      } else if (evidenceReady && state.truncatedHeadingIds.size > 0) {
        status = 'partial';
        reason = '章节原文仍有未读取部分，不能结束当前原文读取。';
      } else if (state.evidenceIds.size > 0 && remainingAspects.length > 0) {
        status = 'partial';
        reason = `仍有 ${remainingAspects.length} 个方面未读取原文。`;
      } else if (state.evidenceIds.size > 0) {
        status = 'partial';
        reason = '已有原文证据，但数量尚未满足当前目标。';
      }
    } else if (state.evidenceIds.size > 0 && state.candidateTruncated) {
      status = 'partial';
      reason = '候选分页或 QueryTerm 批次尚未遍历完，不能声称已覆盖全部范围。';
    } else if (state.evidenceIds.size > 0 && state.truncatedHeadingIds.size > 0) {
      status = 'partial';
      reason = '章节原文仍有未读取部分，不能声称已完成覆盖。';
    } else if (state.evidenceIds.size > 0 && remainingAspects.length > 0) {
      status = 'partial';
      reason = `仍有 ${remainingAspects.length} 个方面未读取原文。`;
    } else if (state.evidenceIds.size > 0 && state.readHeadingIds.size < minimumSections) {
      status = 'partial';
      reason = `主题范围至少需要读取 ${minimumSections} 个不同章节。`;
    } else if (state.evidenceIds.size > 0 && this.scope.coveragePolicy === 'occurrence-complete' && !state.candidateExhausted) {
      status = 'partial';
      reason = '逐处覆盖需要遍历全部候选；搜索分页尚未到达末页。';
    } else if (evidenceReady) {
      status = 'complete';
      reason = '目标方面和章节范围已达到进入合成的前提；最终答案完整性仍由模型判断。';
    }
    return Object.freeze({
      goalId: key,
      mode: this.scope.mode,
      coveragePolicy: this.scope.coveragePolicy,
      discoveredHeadingCount: state.discoveredHeadingIds.size,
      readHeadingCount: state.readHeadingIds.size,
      matchedBlockCount: state.matchedBlockIds.size,
      searchedBlockCount: state.matchedBlockIds.size,
      materializedBlockCount: state.materializedBlockIds.size,
      materializedEvidenceCount: state.materializedEvidenceIds.size,
      evidenceCount: state.evidenceIds.size,
      targetAspectCount: targetAspects.length,
      coveredAspectCount: coveredAspects.length,
      remainingAspects: Object.freeze([...remainingAspects]),
      candidateTruncated: state.candidateTruncated,
      candidateExhausted: state.candidateExhausted,
      plannedQueryTerms: Object.freeze([...state.plannedQueryTerms]),
      executedQueryTerms: Object.freeze([...state.executedQueryTerms]),
      unexecutedQueryTerms: Object.freeze(state.plannedQueryTerms.filter((term) => !state.executedQueryTerms.has(term))),
      status,
      reason,
    });
  }

  /**
   * Returns the compact immutable summary that may be sent to a model.
   * 返回可以发送给模型的紧凑不可变摘要。
   *
   * @param goalId - Goal key; undefined falls back to the turn goal / 目标键；未定义时落到 turn 目标
   * @param requiredEvidenceCount - Minimum accepted evidence count / 需要的最少已接受证据数
   * @returns Frozen coverage summary / 冻结的覆盖摘要
   */
  toModelSummary(goalId?: string, requiredEvidenceCount = 1): CurrentNoteGoalCoverageSummary {
    // A compact immutable summary is the only representation sent to a model.
    // 紧凑的不可变摘要是唯一允许发送给模型的表示。
    return this.evaluate(goalId, requiredEvidenceCount);
  }

  /**
   * Aggregates every goal into one all-goals coverage summary.
   * 将所有目标聚合成一份全目标覆盖摘要。
   *
   * @param requiredEvidenceCount - Minimum evidence per goal / 每个目标的最少证据数
   * @returns Frozen all-goals summary / 冻结的全目标摘要
   */
  toSummary(requiredEvidenceCount = 1): CurrentNoteSearchCoverageSummary {
    const goalSummaries = [...this.goals.keys()]
      .filter((goalId) => goalId !== TURN_GOAL_ID)
      .map((goalId) => this.evaluate(goalId, requiredEvidenceCount));
    if (goalSummaries.length === 0) {
      const primary = this.evaluate(undefined, requiredEvidenceCount);
      return Object.freeze({ ...primary, goalSummaries: Object.freeze([primary]) });
    }
    const remainingAspects = [...new Set(goalSummaries.flatMap((summary) => summary.remainingAspects))].slice(0, MAX_SUMMARY_ASPECTS);
    const status = goalSummaries.every((summary) => summary.status === 'complete')
      ? 'complete'
      : goalSummaries.some((summary) => summary.evidenceCount > 0)
        ? 'partial'
        : 'insufficient';
    const incomplete = goalSummaries.find((summary) => summary.status !== 'complete');
    return Object.freeze({
      goalId: 'all-goals',
      mode: this.scope.mode,
      coveragePolicy: this.scope.coveragePolicy,
      discoveredHeadingCount: goalSummaries.reduce((total, summary) => total + summary.discoveredHeadingCount, 0),
      readHeadingCount: goalSummaries.reduce((total, summary) => total + summary.readHeadingCount, 0),
      matchedBlockCount: goalSummaries.reduce((total, summary) => total + summary.matchedBlockCount, 0),
      searchedBlockCount: goalSummaries.reduce((total, summary) => total + summary.searchedBlockCount, 0),
      materializedBlockCount: goalSummaries.reduce((total, summary) => total + summary.materializedBlockCount, 0),
      materializedEvidenceCount: goalSummaries.reduce((total, summary) => total + summary.materializedEvidenceCount, 0),
      evidenceCount: goalSummaries.reduce((total, summary) => total + summary.evidenceCount, 0),
      targetAspectCount: goalSummaries.reduce((total, summary) => total + summary.targetAspectCount, 0),
      coveredAspectCount: goalSummaries.reduce((total, summary) => total + summary.coveredAspectCount, 0),
      remainingAspects: Object.freeze(remainingAspects),
      candidateTruncated: goalSummaries.some((summary) => summary.candidateTruncated),
      candidateExhausted: goalSummaries.every((summary) => summary.candidateExhausted),
      plannedQueryTerms: Object.freeze([...new Set(goalSummaries.flatMap((summary) => summary.plannedQueryTerms))]),
      executedQueryTerms: Object.freeze([...new Set(goalSummaries.flatMap((summary) => summary.executedQueryTerms))]),
      unexecutedQueryTerms: Object.freeze([...new Set(goalSummaries.flatMap((summary) => summary.unexecutedQueryTerms))]),
      status,
      reason: incomplete?.reason ?? '所有目标的原文范围均已达到进入合成的前提；最终答案完整性仍由模型判断。',
      goalSummaries: Object.freeze(goalSummaries),
    });
  }

  /**
   * Stage 6 broad-coverage view: one current source is enough for navigation status.
   * 阶段 6 的宽覆盖视图：一份当前来源即可满足导航状态判断。
   *
   * @returns Frozen all-goals summary with evidence requirement 1 / 证据要求为 1 的冻结全目标摘要
   */
  toAllRetrievedSummary(): CurrentNoteSearchCoverageSummary {
    return this.toSummary(1);
  }

  /**
   * Main-process-only durable projection.  The returned data contains only
   * stable identifiers, hashes, counts and the opaque cursor token.
   * 仅在主进程使用的持久化投影。返回数据只包含稳定标识、哈希、
   * 计数与不透明的游标令牌。
   *
   * @param nextSearchCursors - Optional per-goal cursor overrides / 可选的按目标游标覆盖
   * @returns Durable per-goal coverage rows / 可持久化的逐目标覆盖行
   */
  toPersistence(nextSearchCursors?: ReadonlyMap<string, string>): AssistantSearchGoalCoverage[] {
    return [...this.goals.entries()]
      .filter(([goalId]) => goalId !== TURN_GOAL_ID)
      .map(([goalId, state]) => {
        // Persistence describes the authoritative Search Scope. It must not
        // reuse the relaxed `sufficient` completion projection below.
        // 持久化描述的是权威搜索范围，不能复用下方宽松的 `sufficient` 完成投影。
        const targetAspects = this.scope.targetAspects.slice(0, MAX_SUMMARY_ASPECTS);
        const coveredAspects = targetAspects.filter((aspect) => state.coveredAspects.has(aspect));
        const nextSearchCursor = nextSearchCursors?.get(goalId) ?? state.nextSearchCursor;
        return {
          goalId,
          snapshotId: this.snapshot.snapshotId,
          contentHash: this.snapshot.contentHash,
          queryFingerprint: state.queryFingerprint ?? '',
          matchedBlockCount: state.matchedBlockIds.size,
          searchedBlockCount: state.matchedBlockIds.size,
          materializedBlockCount: state.materializedBlockIds.size,
          materializedEvidenceCount: state.materializedEvidenceIds.size,
          matchedHeadingCount: state.discoveredHeadingIds.size,
          readHeadingCount: state.readHeadingIds.size,
          coveredAspectCount: coveredAspects.length,
          targetAspectCount: targetAspects.length,
          discoveredHeadingIds: [...state.discoveredHeadingIds],
          readHeadingIds: [...state.readHeadingIds],
          coveredAspects,
          missingAspects: targetAspects.filter((aspect) => !state.coveredAspects.has(aspect)),
          candidateExhausted: state.candidateExhausted,
          candidateTruncated: state.candidateTruncated,
          plannedQueryTerms: [...state.plannedQueryTerms],
          executedQueryTerms: [...state.executedQueryTerms],
          unexecutedQueryTerms: state.plannedQueryTerms.filter((term) => !state.executedQueryTerms.has(term)),
          ...(nextSearchCursor ? { nextSearchCursor } : {}),
        };
      });
  }

  private stateFor(goalId: string | undefined): MutableGoalCoverage {
    const key = normalizeGoalId(goalId);
    const existing = this.goals.get(key);
    if (existing) return existing;
    const created: MutableGoalCoverage = {
      discoveredHeadingIds: new Set(),
      readHeadingIds: new Set(),
      matchedBlockIds: new Set(),
      materializedBlockIds: new Set(),
      materializedEvidenceIds: new Set(),
      evidenceIds: new Set(),
      discoveredAspects: new Set(),
      coveredAspects: new Set(),
      candidateTruncated: false,
      candidateExhausted: false,
      truncatedHeadingIds: new Set(),
      plannedQueryTerms: [],
      executedQueryTerms: new Set(),
    };
    this.goals.set(key, created);
    return created;
  }

  private minimumSections(): number {
    if (this.scope.mode !== 'topic-wide') return 1;
    const nonEmptyHeadings = this.snapshot.headings.filter((heading) => heading.lineTo >= heading.lineFrom).length;
    return Math.min(2, Math.max(1, nonEmptyHeadings));
  }

  private completionTargetAspects(): string[] {
    // `sufficient` asks whether the existing original evidence is enough to
    // answer the focused goal. Aspect labels remain navigation hints, not a
    // mandatory checklist; strict policies continue to enforce every aspect.
    // `sufficient` 判断现有原文证据是否足以回答聚焦目标。方面标签仍为导航提示，
    // 而非强制清单；严格策略会继续强制要求每个方面。
    return this.scope.coveragePolicy === 'sufficient'
      ? []
      : this.scope.targetAspects.slice(0, MAX_SUMMARY_ASPECTS);
  }

  private headingIdAtLine(line: number): string | undefined {
    // Among headings covering the line, pick the most specific one: smallest
    // span first, then deepest level, with deterministic tie-breaks.
    // 在覆盖该行的标题中选取最具体的：先取跨度最小的，再取层级最深的，
    // 并有确定性平局规则。
    return this.snapshot.headings
      .filter((heading) => line >= heading.lineFrom && line <= heading.lineTo)
      .sort((first, second) => {
        const firstSpan = first.lineTo - first.lineFrom;
        const secondSpan = second.lineTo - second.lineFrom;
        return firstSpan - secondSpan || second.level - first.level || second.lineFrom - first.lineFrom || first.headingId.localeCompare(second.headingId);
      })[0]?.headingId;
  }

  private headingIdsForRangeRead(input: CurrentNoteCoverageReadInput): Set<string> {
    const readHeadingIds = new Set<string>();
    const blocks = input.blockIds
      .map((blockId) => this.snapshot.blocks.find((candidate) => candidate.blockId === blockId))
      .filter((block): block is CurrentNoteSnapshot['blocks'][number] => block !== undefined);
    for (const block of blocks) {
      const headingId = this.headingIdAtLine(block.lineFrom);
      if (headingId) readHeadingIds.add(headingId);
    }
    // Heading-only ranges (or legacy callers without block IDs) still get a
    // deterministic line-based association, but never add an ancestor when a
    // concrete block already identified the read chapter(s).
    // 纯标题范围（或没有 block id 的旧调用方）仍通过行号得到确定性关联，
    // 但当具体块已识别出所读章节时，不会额外添加祖先标题。
    if (readHeadingIds.size === 0) {
      const headingId = this.headingIdAtLine(input.lineFrom);
      if (headingId) readHeadingIds.add(headingId);
    }
    return readHeadingIds;
  }
}

function normalizeGoalId(goalId: string | undefined): string {
  return goalId?.trim() || TURN_GOAL_ID;
}

function cloneScope(scope: CurrentNoteSearchScope): CurrentNoteSearchScope {
  return { ...scope, targetAspects: [...scope.targetAspects] };
}

function matchesAspect(aspect: string, values: readonly string[]): boolean {
  const normalizedAspect = normalize(aspect);
  if (!normalizedAspect) return false;
  return values.some((value) => normalize(value).includes(normalizedAspect));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function orderedUniqueTerms(values: readonly string[]): string[] {
  return appendOrderedTerms([], values);
}

function appendOrderedTerms(existing: readonly string[], values: readonly string[]): string[] {
  const result = [...existing];
  const seen = new Set(result);
  for (const value of values) {
    const term = value.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}
