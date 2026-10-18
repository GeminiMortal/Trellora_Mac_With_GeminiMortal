/**
 * Deterministic rolling conversation summary built from per-turn digests.
 * 基于逐轮摘要构建的确定性滚动会话摘要。
 */
import { createHash } from 'node:crypto';
import type { SearchPlan } from '../search/searchPlanTypes.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';

/**
 * Schema version of the persisted rolling summary payload.
 * 持久化滚动摘要载荷的结构版本。
 */
export const ROLLING_SUMMARY_SCHEMA_VERSION = 1;

/**
 * Version of the deterministic turn digest projection.
 * 确定性轮次摘要投影的版本。
 */
export const DETERMINISTIC_TURN_DIGEST_VERSION = 1;

/**
 * Number of latest turns treated as hot context for prompts.
 * 作为提示词热上下文保留的最近轮次数。
 */
export const HOT_TERMINAL_TURN_COUNT = 3;

/**
 * Max turn digests retained in one rolling summary payload.
 * 单个滚动摘要载荷中保留的轮次摘要上限。
 */
export const MAX_ROLLING_SUMMARY_DIGESTS = 500;

/**
 * Max characters of a rendered rolling summary.
 * 渲染后滚动摘要的最大字符数。
 */
export const MAX_ROLLING_SUMMARY_CHARS = 4_000;

/**
 * Terminal status of a finished turn digest.
 * 已完成轮次摘要的终态。
 */
export type RollingTerminalStatus = 'complete' | 'partial' | 'not-found';

/**
 * Lightweight reference to the SearchPlan outcome of a finished turn.
 * 已完成轮次的 SearchPlan 结果轻量引用。
 */
export interface PlanOutcomeReference {
  planId: string;
  planVersion: number;
  status: SearchPlan['status'];
  activeGoalId: string | null;
  goals: Array<{ goalId: string; status: SearchPlan['goals'][number]['status']; evidenceCount: number }>;
}

/**
 * Deterministic, bounded projection of one finished turn.
 * 单个已完成轮次的确定性有界投影。
 */
export interface DeterministicTurnDigest {
  /** Stable content-derived digest id / 基于内容的稳定摘要 ID */
  digestId: string;
  digestVersion: number;
  turnId: string;
  turnSeq: number;
  /** Conversation content hash the digest belongs to / 摘要所属会话的内容哈希 */
  contentHash: string;
  status: RollingTerminalStatus;
  question: string;
  answer: string;
  /** Sorted, de-duplicated evidence ids / 已排序去重的证据 ID */
  evidenceIds: string[];
  /** Plan result summary, when the turn ran a plan / 轮次执行过计划时的结果摘要 */
  planOutcome?: PlanOutcomeReference;
}

/**
 * Persisted rolling summary: turn digests plus unresolved follow-ups.
 * 持久化滚动摘要：轮次摘要加待跟进问题。
 */
export interface RollingSummaryPayload {
  schemaVersion: typeof ROLLING_SUMMARY_SCHEMA_VERSION;
  contentHash: string;
  /** Highest turn sequence covered by digests / 摘要已覆盖的最高轮次序号 */
  coveredThroughSeq: number;
  turnDigests: DeterministicTurnDigest[];
  /** Questions not yet resolved by a complete turn / 尚未被完整轮次解决的问题 */
  unresolvedQuestions: string[];
  /**
   * Preserves a v3 string summary alongside digests for backward compatibility.
   * 为向后兼容，在摘要之外保留 v3 字符串摘要。
   */
  legacyText?: string;
}

/**
 * Full rolling summary state: payload, rendered text, and budget metadata.
 * 完整滚动摘要状态：载荷、渲染文本与预算元数据。
 */
export interface RollingSummaryState {
  version: number;
  contentHash: string;
  coveredThroughSeq: number;
  payload: RollingSummaryPayload;
  /** Prompt-ready rendered text / 可直接用于提示词的渲染文本 */
  rendered: string;
  budget: RollingSummaryBudgetMetadata;
}

/**
 * Explicit budget accounting for a rendered summary.
 * 渲染后摘要的显式预算计量。
 */
export interface RollingSummaryBudgetMetadata {
  /** Unicode-aware character count / 按 Unicode 码点计的字符数 */
  characterCount: number;
  estimatedTokens: number;
  /** Hard character limit used for rendering / 渲染时使用的硬字符上限 */
  explicitCharacterLimit: number;
}

/**
 * Input required to build one deterministic turn digest.
 * 构建单条确定性轮次摘要所需的输入。
 */
export interface DeterministicTurnDigestInput {
  turnId: string;
  turnSeq: number;
  contentHash: string;
  question: string;
  answer: string;
  status: RollingTerminalStatus;
  /** Evidence ids referenced by the turn / 该轮次引用的证据 ID */
  evidenceIds?: readonly string[];
  /** Search plan executed for the turn, if any / 该轮次执行的检索计划（若有） */
  plan?: SearchPlan;
}

/**
 * Create an empty rolling summary payload bound to a conversation content hash.
 * 创建绑定到会话内容哈希的空滚动摘要载荷。
 *
 * @param contentHash - Conversation content hash / 会话内容哈希
 * @param legacyText - Optional legacy v3 summary text / 可选的 v3 旧版摘要文本
 * @returns Empty payload with no digests / 无轮次摘要的空载荷
 */
export function emptyRollingSummaryPayload(contentHash: string, legacyText = ''): RollingSummaryPayload {
  assertContentHash(contentHash);
  return {
    schemaVersion: ROLLING_SUMMARY_SCHEMA_VERSION,
    contentHash,
    coveredThroughSeq: 0,
    turnDigests: [],
    unresolvedQuestions: [],
    ...(legacyText.trim() ? { legacyText: legacyText.trim().slice(-MAX_ROLLING_SUMMARY_CHARS) } : {}),
  };
}

/**
 * No provider call: the digest is a bounded, reproducible projection of a finished turn.
 * 不调用模型：摘要只是已完成轮次的有界、可复现投影。
 *
 * @param input - Finished turn data / 已完成轮次的数据
 * @returns Deterministic turn digest / 确定性轮次摘要
 */
export function createDeterministicTurnDigest(input: DeterministicTurnDigestInput): DeterministicTurnDigest {
  assertTurnIdentity(input.turnId, input.turnSeq, input.contentHash);
  if (!input.question.trim() || input.question.length > 2_000) throw new Error('turn digest 问题长度无效。');
  if (!input.answer.trim() || input.answer.length > 20_000) throw new Error('turn digest 回答长度无效。');
  if (!['complete', 'partial', 'not-found'].includes(input.status)) throw new Error('turn digest 终态无效。');
  const question = normalizeDigestText(input.question, 480);
  const answer = normalizeDigestText(input.answer, 1_200);
  const evidenceIds = [...new Set((input.evidenceIds ?? []).filter((value) => typeof value === 'string' && value.trim()))].sort(compareText);
  const digest: DeterministicTurnDigest = {
    digestId: createDigestId(input.turnId, input.turnSeq, input.contentHash, input.status, question, answer, evidenceIds),
    digestVersion: DETERMINISTIC_TURN_DIGEST_VERSION,
    turnId: input.turnId,
    turnSeq: input.turnSeq,
    contentHash: input.contentHash,
    status: input.status,
    question,
    answer,
    evidenceIds,
    ...(input.plan ? { planOutcome: createPlanOutcomeReference(input.plan) } : {}),
  };
  return cloneDigest(digest);
}

/**
 * Merge new turn digests into a payload, replacing same-turn entries and
 * tracking unresolved questions; a content-hash change starts a fresh payload.
 * 将新的轮次摘要合并进载荷：同轮次替换、跟踪待跟进问题；内容哈希变化时从空载荷重新开始。
 *
 * @param current - Existing payload / 现有载荷
 * @param contentHash - Target conversation content hash / 目标会话内容哈希
 * @param digests - Digests to merge / 待合并的轮次摘要
 * @returns New merged payload / 合并后的新载荷
 */
export function mergeRollingSummaryPayload(
  current: RollingSummaryPayload,
  contentHash: string,
  digests: readonly DeterministicTurnDigest[],
): RollingSummaryPayload {
  assertRollingSummaryPayload(current);
  assertContentHash(contentHash);
  // A hash mismatch means the conversation identity changed: restart coverage.
  // 哈希不一致说明会话身份已变，覆盖进度从零开始。
  const base = current.contentHash === contentHash ? current : emptyRollingSummaryPayload(contentHash);
  const byTurn = new Map(base.turnDigests.map((digest) => [digest.turnId, cloneDigest(digest)]));
  const unresolved = new Map(base.unresolvedQuestions.map((question) => [normalizeQuestion(question), question]));
  let coveredThroughSeq = base.contentHash === contentHash ? base.coveredThroughSeq : 0;
  for (const digest of digests) {
    if (digest.contentHash !== contentHash) throw new Error('turn digest contentHash 与滚动摘要不一致。');
    assertDeterministicTurnDigest(digest);
    byTurn.set(digest.turnId, cloneDigest(digest));
    coveredThroughSeq = Math.max(coveredThroughSeq, digest.turnSeq);
    const questionKey = normalizeQuestion(digest.question);
    if (digest.status === 'complete') unresolved.delete(questionKey);
    else unresolved.set(questionKey, digest.question);
  }
  const turnDigests = [...byTurn.values()].sort((first, second) => first.turnSeq - second.turnSeq || first.turnId.localeCompare(second.turnId)).slice(-MAX_ROLLING_SUMMARY_DIGESTS);
  return {
    schemaVersion: ROLLING_SUMMARY_SCHEMA_VERSION,
    contentHash,
    coveredThroughSeq,
    turnDigests,
    unresolvedQuestions: [...unresolved.values()].sort(compareText).slice(-20),
    ...(base.legacyText ? { legacyText: base.legacyText } : {}),
  };
}

/**
 * Render the full summary text including plan/evidence references and follow-ups.
 * 渲染完整摘要文本，含 plan/证据引用与待跟进问题。
 *
 * @param payload - Rolling summary payload / 滚动摘要载荷
 * @param maxChars - Max rendered characters / 渲染文本最大字符数
 * @returns Rendered summary text, tail-trimmed to maxChars / 渲染后的摘要文本（尾部裁剪至 maxChars）
 */
export function renderRollingSummary(payload: RollingSummaryPayload, maxChars = MAX_ROLLING_SUMMARY_CHARS): string {
  assertRollingSummaryPayload(payload);
  const blocks: string[] = [];
  if (payload.legacyText) blocks.push(payload.legacyText);
  for (const digest of payload.turnDigests) {
    const outcome = digest.planOutcome ? `；plan=${digest.planOutcome.planId}@v${digest.planOutcome.planVersion}/${digest.planOutcome.status}` : '';
    blocks.push(`轮次 ${digest.turnSeq}（${digest.status}${outcome}）\n问：${digest.question}\n答：${digest.answer}${digest.evidenceIds.length ? `\n证据：${digest.evidenceIds.join(',')}` : ''}`);
  }
  if (payload.unresolvedQuestions.length) blocks.push(`待跟进问题：${payload.unresolvedQuestions.join('；')}`);
  return blocks.join('\n\n').slice(-maxChars);
}

/**
 * Prompt-facing current-note memory contains conversation semantics only.
 * Persisted plan/evidence references remain available to their repositories,
 * but never become an alternative SearchPlan or Evidence Ledger fact source.
 * 面向提示词的当前笔记记忆仅包含会话语义；持久化的 plan/证据引用留在其仓库中供单独
 * 查询，绝不成为 SearchPlan 或 Evidence Ledger 的替代事实来源。
 *
 * @param payload - Rolling summary payload / 滚动摘要载荷
 * @param maxChars - Max rendered characters / 渲染文本最大字符数
 * @returns Conversation-memory summary without plan details / 不含 plan 细节的会话记忆摘要
 */
export function renderConversationMemorySummary(payload: RollingSummaryPayload, maxChars = MAX_ROLLING_SUMMARY_CHARS): string {
  assertRollingSummaryPayload(payload);
  const blocks: string[] = [];
  if (payload.legacyText) blocks.push(payload.legacyText);
  for (const digest of payload.turnDigests) {
    blocks.push(`轮次 ${digest.turnSeq}（${digest.status}）\n问：${digest.question}\n答：${digest.answer}`);
  }
  if (payload.unresolvedQuestions.length) blocks.push(`待跟进问题：${payload.unresolvedQuestions.join('；')}`);
  return blocks.join('\n\n').slice(-maxChars);
}

/**
 * Budget metadata is explicit so later prompt adapters never infer an 800-char hot-message limit.
 * 预算元数据是显式的，后续提示词适配器无需推断 800 字符的消息热区限制。
 *
 * @param rendered - Rendered summary text / 渲染后的摘要文本
 * @returns Budget metadata with character and token counts / 含字符数和 token 数的预算元数据
 */
export function createRollingSummaryBudgetMetadata(rendered: string): RollingSummaryBudgetMetadata {
  return {
    characterCount: Array.from(rendered).length,
    estimatedTokens: estimateTokenCount(rendered),
    explicitCharacterLimit: MAX_ROLLING_SUMMARY_CHARS,
  };
}

/**
 * Parse a stored JSON string into a validated rolling summary payload,
 * falling back to an empty payload on any mismatch or corruption.
 * 将存储的 JSON 字符串解析为校验通过的滚动摘要载荷；任何不匹配或损坏时回退为空载荷。
 *
 * @param value - Raw JSON string to parse / 待解析的原始 JSON 字符串
 * @param contentHash - Expected conversation content hash / 预期的会话内容哈希
 * @param legacyText - Fallback legacy text when parsing fails / 解析失败时的旧版摘要文本
 * @returns Validated or empty payload / 校验通过或空的载荷
 */
export function parseRollingSummaryPayload(value: string, contentHash: string, legacyText = ''): RollingSummaryPayload {
  assertContentHash(contentHash);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    const payload = parsed as RollingSummaryPayload;
    assertRollingSummaryPayload(payload);
    if (payload.contentHash !== contentHash) return emptyRollingSummaryPayload(contentHash);
    return clonePayload(payload);
  } catch {
    return emptyRollingSummaryPayload(contentHash, legacyText);
  }
}

/**
 * Assert that a payload satisfies all structural invariants; throws on violation.
 * 断言载荷满足所有结构不变量；违规时抛出错误。
 *
 * @param payload - Rolling summary payload to validate / 待校验的滚动摘要载荷
 */
export function assertRollingSummaryPayload(payload: RollingSummaryPayload): void {
  if (!payload || payload.schemaVersion !== ROLLING_SUMMARY_SCHEMA_VERSION
    || !Number.isSafeInteger(payload.coveredThroughSeq) || payload.coveredThroughSeq < 0
    || !Array.isArray(payload.turnDigests) || payload.turnDigests.length > MAX_ROLLING_SUMMARY_DIGESTS
    || !Array.isArray(payload.unresolvedQuestions) || payload.unresolvedQuestions.length > 20
    || (payload.legacyText !== undefined && (typeof payload.legacyText !== 'string' || payload.legacyText.length > MAX_ROLLING_SUMMARY_CHARS))) {
    throw new Error('滚动摘要 payload 无效。');
  }
  assertContentHash(payload.contentHash);
  for (const digest of payload.turnDigests) assertDeterministicTurnDigest(digest);
  if (payload.turnDigests.some((digest) => digest.contentHash !== payload.contentHash || digest.turnSeq > payload.coveredThroughSeq)) throw new Error('滚动摘要覆盖序号或 contentHash 无效。');
}

function assertDeterministicTurnDigest(digest: DeterministicTurnDigest): void {
  assertTurnIdentity(digest.turnId, digest.turnSeq, digest.contentHash);
  if (digest.digestVersion !== DETERMINISTIC_TURN_DIGEST_VERSION || !digest.digestId.startsWith('turn-digest-')
    || !['complete', 'partial', 'not-found'].includes(digest.status)
    || !digest.question.trim() || digest.question.length > 480
    || !digest.answer.trim() || digest.answer.length > 1_200
    || !Array.isArray(digest.evidenceIds) || digest.evidenceIds.some((value) => typeof value !== 'string' || !value.trim())) throw new Error('确定性 turn digest 无效。');
  if (digest.planOutcome) {
    if (!digest.planOutcome.planId.trim() || !Number.isSafeInteger(digest.planOutcome.planVersion) || digest.planOutcome.planVersion < 1
      || !Array.isArray(digest.planOutcome.goals) || digest.planOutcome.goals.some((goal) => !goal.goalId.trim() || !Number.isSafeInteger(goal.evidenceCount) || goal.evidenceCount < 0)) throw new Error('turn digest 的 plan outcome 引用无效。');
  }
}

function createPlanOutcomeReference(plan: SearchPlan): PlanOutcomeReference {
  return {
    planId: plan.planId,
    planVersion: plan.version,
    status: plan.status,
    activeGoalId: plan.activeGoalId,
    goals: plan.goals.map((goal) => ({
      goalId: goal.goalId,
      status: goal.status,
      evidenceCount: new Set([
        ...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds),
        ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]),
      ]).size,
    })),
  };
}

function assertTurnIdentity(turnId: string, turnSeq: number, contentHash: string): void {
  if (!turnId.trim() || !Number.isSafeInteger(turnSeq) || turnSeq < 1) throw new Error('turn digest 标识无效。');
  assertContentHash(contentHash);
}

function assertContentHash(contentHash: string): void {
  // Existing databases and fixtures may use an opaque content-hash token;
  // production snapshots still provide the full SHA-256 value.
  // 已有数据库和测试夹具可能使用不透明的 contentHash 标记；生产快照仍使用完整 SHA-256 值。
  if (typeof contentHash !== 'string' || !contentHash.trim() || contentHash.length > 256) throw new Error('滚动摘要 contentHash 无效。');
}

function normalizeDigestText(value: string, maxChars: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

function normalizeQuestion(value: string): string {
  return normalizeDigestText(value, 480).toLocaleLowerCase('zh-CN');
}

function createDigestId(turnId: string, turnSeq: number, contentHash: string, status: RollingTerminalStatus, question: string, answer: string, evidenceIds: readonly string[]): string {
  return `turn-digest-${sha256([turnId, turnSeq, contentHash, status, question, answer, ...evidenceIds].join('\u0000')).slice(0, 24)}`;
}

function cloneDigest(digest: DeterministicTurnDigest): DeterministicTurnDigest {
  return { ...digest, evidenceIds: [...digest.evidenceIds], ...(digest.planOutcome ? { planOutcome: { ...digest.planOutcome, goals: digest.planOutcome.goals.map((goal) => ({ ...goal })) } } : {}) };
}

function clonePayload(payload: RollingSummaryPayload): RollingSummaryPayload {
  return { ...payload, turnDigests: payload.turnDigests.map(cloneDigest), unresolvedQuestions: [...payload.unresolvedQuestions] };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
