/**
 * QA memory zone assembly: builds M1 rolling summary and M2 short-term memory zones with budget control.
 * 问答记忆分区装配：构建 M1 滚动摘要和 M2 短期记忆分区，带预算控制。
 */
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import { ASSISTANT_CONTEXT_BUDGET_TOKENS } from '../../../shared/assistantContextBudget.ts';
import type { QaSessionScope, QaStoredTurn, QaSummaryBlock } from './qaMemoryTypes.ts';
import { QA_HOT_TURN_COUNT } from './qaMemoryRepository.ts';

/**
 * Absolute token limits per zone (design §4.2, 128K baseline).
 * 分区绝对 token 上限（设计 §4.2 分区预算表，128K 基准）。
 */
export const QA_ZONE_ABSOLUTE_LIMITS = Object.freeze({
  /** Static prefix zone limit / 静态前缀分区上限 */
  staticPrefix: 2_000,
  /** Rolling summary (M1) zone limit / 滚动摘要（M1）分区上限 */
  rollingSummary: 4_000,
  /** Short-term (M2) zone limit / 短期记忆（M2）分区上限 */
  shortTerm: 8_000,
  /**
   * Chat profile M2 elastic upper bound (consumes 4,000 from D idle reserve, design §4.4).
   * chat 剖面 M2 弹性上限（只消耗 D 空闲预留中的 4,000，设计 §4.4）。
   */
  shortTermChatElastic: 12_000,
  /** Dynamic evidence zone limit / 动态证据分区上限 */
  dynamic: 20_000,
  /** Question constraint zone limit / 问题约束分区上限 */
  questionConstraint: 1_500,
  /**
   * Knowledge-base ReAct memory envelope (M1 summary + user profile) absolute limit; normal value driven by profile ratio.
   * 知识库 ReAct 记忆信封（M1 摘要 + 用户画像）绝对上限，常态取值由剖面比例决定。
   */
  memoryEnvelope: 6_000,
  /**
   * Knowledge-base ReAct in-turn consolidation summary output absolute limit (P2); normal value driven by profile ratio.
   * 知识库 ReAct 轮内固化摘要输出绝对上限（P2），常态取值由剖面比例决定。
   */
  consolidationSummary: 2_000,
});

/**
 * Per-turn token caps: question ≤500, answer ≤1,000 (design §2.1).
 * 每轮封顶：问 ≤500，答 ≤1,000（设计 §2.1）。
 */
export const QA_TURN_QUESTION_MAX_TOKENS = 500;
export const QA_TURN_ANSWER_MAX_TOKENS = 1_000;

/**
 * Resolved zone budget for a specific session scope and context window.
 * 针对特定会话范围和上下文窗口的分区预算。
 */
export interface QaZoneBudget {
  /** Context window size / 上下文窗口大小 */
  contextWindowTokens: number;
  /** Output token reserve / 输出 token 预留 */
  outputReserveTokens: number;
  /** Safety reserve tokens / 安全余量 token 数 */
  safetyReserveTokens: number;
  /** Total prompt budget / Prompt 总预算 */
  promptBudgetTokens: number;
  /** Static prefix budget / 静态前缀预算 */
  staticPrefix: number;
  /** Rolling summary (M1) budget / 滚动摘要（M1）预算 */
  rollingSummary: number;
  /** Short-term (M2) budget / 短期记忆（M2）预算 */
  shortTerm: number;
  /** Dynamic evidence budget (knowledge-base only) / 动态证据预算（仅知识库） */
  dynamic: number;
  /** Question constraint budget / 问题约束预算 */
  questionConstraint: number;
  /**
   * Knowledge-base ReAct memory envelope budget; 0 for non-knowledge-base profiles.
   * 知识库 ReAct 记忆信封预算；非知识库剖面为 0。
   */
  memoryEnvelope: number;
  /**
   * Knowledge-base ReAct in-turn consolidation summary budget (P2); 0 for non-knowledge-base profiles.
   * 知识库 ReAct 轮内固化摘要输出预算（P2）；非知识库剖面为 0。
   */
  consolidationSummary: number;
}

/**
 * Resolve scenario-specific budget profile (design §4.1–§4.4).
 * Component cap = min(absolute limit, ratio × P); knowledge-base D is a fixed reserve,
 * shortfall goes to headroom when evidence is insufficient, not redistributed to memory zones.
 *
 * 场景化预算剖面（设计 §4.1–§4.4）。
 * 组件上限 = min(绝对上限, 比例 × P)；知识库剖面 D 为固定预留，
 * 实际证据不足时差额归 headroom，不回分给记忆分区。
 *
 * @param scope - Session scope ('chat' or 'knowledge-base') / 会话范围（'chat' 或 'knowledge-base'）
 * @param contextWindowTokens - Optional context window override / 可选的上下文窗口覆盖
 * @returns Resolved zone budget / 解析后的分区预算
 */
export function resolveQaZoneBudget(scope: QaSessionScope, contextWindowTokens?: number): QaZoneBudget {
  const windowTokens = Number.isSafeInteger(contextWindowTokens) && (contextWindowTokens ?? 0) > 0
    ? contextWindowTokens!
    : ASSISTANT_CONTEXT_BUDGET_TOKENS;
  const outputReserveTokens = Math.min(8_192, Math.floor(windowTokens * 0.125));
  const safetyReserveTokens = Math.max(2_048, Math.floor(windowTokens * 0.04));
  const promptBudgetTokens = Math.max(0, windowTokens - outputReserveTokens - safetyReserveTokens);
  const proportional = (ratio: number) => Math.floor(promptBudgetTokens * ratio);
  const staticPrefix = Math.min(QA_ZONE_ABSOLUTE_LIMITS.staticPrefix, Math.max(500, proportional(0.017)));
  const rollingSummary = Math.min(QA_ZONE_ABSOLUTE_LIMITS.rollingSummary, proportional(0.034));
  const shortTerm = scope === 'chat'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.shortTermChatElastic, proportional(0.102))
    : Math.min(QA_ZONE_ABSOLUTE_LIMITS.shortTerm, proportional(0.068));
  const dynamic = scope === 'knowledge-base'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.dynamic, proportional(0.17))
    : 0;
  const questionConstraint = Math.min(QA_ZONE_ABSOLUTE_LIMITS.questionConstraint, proportional(0.013));
  const memoryEnvelope = scope === 'knowledge-base'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.memoryEnvelope, proportional(0.05))
    : 0;
  const consolidationSummary = scope === 'knowledge-base'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.consolidationSummary, proportional(0.025))
    : 0;
  return {
    contextWindowTokens: windowTokens,
    outputReserveTokens,
    safetyReserveTokens,
    promptBudgetTokens,
    staticPrefix,
    rollingSummary,
    shortTerm,
    dynamic,
    questionConstraint,
    memoryEnvelope,
    consolidationSummary,
  };
}

/**
 * Assembled M2 short-term zone output.
 * 装配后的 M2 短期记忆分区输出。
 */
export interface QaShortTermZone {
  /** Rendered zone text / 渲染后的分区文本 */
  text: string;
  /** Estimated token count / 估计 token 数 */
  tokens: number;
  /** Turn sequences included in this zone / 包含的轮次序列号 */
  includedTurnSeqs: number[];
}

/**
 * A single entry in the M2 short-term zone.
 * M2 短期记忆分区中的单个条目。
 */
export interface QaShortTermEntry {
  /** Source stored turn / 来源存储轮次 */
  turn: QaStoredTurn;
  /** Truncated question text / 截断后的问题文本 */
  question: string;
  /** Truncated answer text / 截断后的回答文本 */
  answer: string;
  /** Rendered content lines / 渲染后的内容行 */
  content: string;
}

/**
 * Build the M2 short-term memory zone (design §2.3, keep-newest-first):
 * fills budget from the newest turn, oldest truncated then discarded on overflow;
 * rendered in chronological order. User questions keep tail, assistant answers keep head.
 *
 * M2 短期记忆装配（设计 §2.3，保新弃旧）：
 * 从最新轮开始填充预算，超额时最旧轮先被截短再整体丢弃；
 * 渲染时反转为时间正序。用户问题保尾部，助手回答保头部。
 *
 * @param hotTurnsNewestFirst - Hot turns sorted newest-first / 按最新优先排序的热轮次
 * @param budgetTokens - Token budget for this zone / 此分区的 token 预算
 * @returns Assembled short-term zone / 装配后的短期记忆分区
 */
export function buildQaShortTermZone(hotTurnsNewestFirst: QaStoredTurn[], budgetTokens: number): QaShortTermZone {
  const entries = selectQaShortTermEntries(hotTurnsNewestFirst, budgetTokens);
  if (entries.length === 0) return { text: '', tokens: 0, includedTurnSeqs: [] };
  const text = ['[Zone M2 短期记忆]', ...entries.map((entry) => entry.content)].join('\n');
  return { text, tokens: estimateTokenCount(text), includedTurnSeqs: entries.map((entry) => entry.turn.turnSeq) };
}

/**
 * Same M2 selection as the legacy renderer, but keeps one record per Turn.
 * 与旧版渲染器相同的 M2 选择逻辑，但保留每轮一条记录。
 *
 * @param hotTurnsNewestFirst - Hot turns sorted newest-first / 按最新优先排序的热轮次
 * @param budgetTokens - Token budget / token 预算
 * @returns Selected short-term entries in chronological order / 按时间正序排列的短期记忆条目
 */
export function selectQaShortTermEntries(hotTurnsNewestFirst: QaStoredTurn[], budgetTokens: number): QaShortTermEntry[] {
  if (budgetTokens <= 0 || hotTurnsNewestFirst.length === 0) return [];
  let remaining = budgetTokens - estimateTokenCount('[Zone M2 短期记忆]');
  if (remaining <= 0) return [];
  const selected: QaShortTermEntry[] = [];
  for (const turn of hotTurnsNewestFirst.slice(0, QA_HOT_TURN_COUNT)) {
    const question = truncateByTokens(turn.userText, Math.min(QA_TURN_QUESTION_MAX_TOKENS, remaining), 'tail');
    remaining -= estimateTokenCount(question);
    const answer = truncateByTokens(turn.assistantText ?? '', Math.min(QA_TURN_ANSWER_MAX_TOKENS, remaining), 'head');
    remaining -= estimateTokenCount(answer);
    if (!question && !answer) break;
    const lines: string[] = [];
    if (question) lines.push(`轮${turn.turnSeq} 用户：${question}`);
    if (answer) lines.push(`轮${turn.turnSeq} 助手：${answer}`);
    selected.push({ turn, question, answer, content: lines.join('\n') });
    if (remaining <= 0) break;
  }
  return selected.reverse();
}

/**
 * Assembled M1 rolling summary zone output.
 * 装配后的 M1 滚动摘要分区输出。
 */
export interface QaRollingSummaryZone {
  /** Rendered zone text / 渲染后的分区文本 */
  text: string;
  /** Estimated token count / 估计 token 数 */
  tokens: number;
  /** Number of summary batches included / 包含的摘要批次数 */
  includedBatchCount: number;
}

/**
 * Selected rolling summary blocks with total token count.
 * 选中的滚动摘要块及总 token 数。
 */
export interface QaRollingSummarySelection {
  /** Selected summary blocks / 选中的摘要块 */
  blocks: QaSummaryBlock[];
  /** Total estimated tokens / 总估计 token 数 */
  tokens: number;
}

/**
 * Build the M1 rolling summary zone (design §3.3): batches in ascending order,
 * backfill from newest within the total cap; oldest batch discarded whole on overflow (no intra-block truncation).
 *
 * M1 滚动摘要装配（设计 §3.3）：批次正序拼接、总封顶内
 * 从最新批次回填，超额时整块丢弃最旧批次（不做块内截断）。
 *
 * @param blocksAscending - Summary blocks in ascending order / 按正序排列的摘要块
 * @param budgetTokens - Token budget / token 预算
 * @returns Assembled rolling summary zone / 装配后的滚动摘要分区
 */
export function buildQaRollingSummaryZone(blocksAscending: QaSummaryBlock[], budgetTokens: number): QaRollingSummaryZone {
  const selected = selectQaRollingSummaryBlocks(blocksAscending, budgetTokens);
  if (selected.blocks.length === 0) return { text: '', tokens: 0, includedBatchCount: 0 };
  const text = ['[Zone M1 滚动摘要]', ...selected.blocks.map((block) => renderQaSummaryBlock(block))].join('\n');
  return { text, tokens: estimateTokenCount(text), includedBatchCount: selected.blocks.length };
}

/**
 * Same M1 selection as the legacy renderer, retaining independent batches.
 * 与旧版渲染器相同的 M1 选择逻辑，保留独立批次。
 *
 * @param blocksAscending - Summary blocks in ascending order / 按正序排列的摘要块
 * @param budgetTokens - Token budget / token 预算
 * @returns Selected blocks with total tokens / 选中块及总 token 数
 */
export function selectQaRollingSummaryBlocks(blocksAscending: QaSummaryBlock[], budgetTokens: number): QaRollingSummarySelection {
  const usable = blocksAscending.filter((block) => block.status === 'done' && block.summaryText.trim() !== '');
  if (budgetTokens <= 0 || usable.length === 0) return { blocks: [], tokens: 0 };
  const selected: QaSummaryBlock[] = [];
  let used = estimateTokenCount('[Zone M1 滚动摘要]');
  if (used > budgetTokens) return { blocks: [], tokens: 0 };
  for (const block of [...usable].reverse()) {
    const blockTokens = estimateTokenCount(renderQaSummaryBlock(block));
    if (used + blockTokens > budgetTokens) {
      if (selected.length === 0) break;
      continue; // 超预算的更旧批次整块丢弃，不做块内截断（设计 §3.3）
    }
    selected.push(block);
    used += blockTokens;
  }
  selected.sort((left, right) => left.turnFrom - right.turnFrom);
  return { blocks: selected, tokens: used };
}

/**
 * Render a summary block (design §3.5): header line annotates batch index, turn range, and compressor.
 * 摘要块渲染（设计 §3.5）：头行标注批次、轮次范围与压缩器。
 *
 * @param block - Summary block to render / 待渲染的摘要块
 * @returns Rendered summary text / 渲染后的摘要文本
 */
export function renderQaSummaryBlock(block: QaSummaryBlock): string {
  const batchIndex = Math.floor((block.turnFrom - (QA_HOT_TURN_COUNT + 1)) / 3) + 1;
  return `[批次 #${batchIndex} · 轮${block.turnFrom}-${block.turnTo} · ${block.compressor}]\n${block.summaryText.trim()}`;
}

/**
 * Concatenate M1 and M2 in §1 order (static prefix, D/Q/C handled by caller).
 * 按 §1 顺序拼接 M1 与 M2（静态策略与 D/Q/C 由调用方负责）。
 *
 * @param rollingSummary - M1 rolling summary zone / M1 滚动摘要分区
 * @param shortTerm - M2 short-term zone / M2 短期记忆分区
 * @returns Combined memory zones text with token counts / 合并后的记忆分区文本及 token 数
 */
export function combineQaMemoryZones(rollingSummary: QaRollingSummaryZone, shortTerm: QaShortTermZone): {
  memoryZonesText: string;
  rollingSummaryTokens: number;
  shortTermTokens: number;
} {
  const parts = [rollingSummary.text, shortTerm.text].filter((part) => part !== '');
  return {
    memoryZonesText: parts.join('\n\n'),
    rollingSummaryTokens: rollingSummary.tokens,
    shortTermTokens: shortTerm.tokens,
  };
}

/**
 * Token-level truncation: keep='head' preserves head, keep='tail' preserves tail (design §2.2).
 * token 级截断：keep='head' 保头部，keep='tail' 保尾部（设计 §2.2）。
 *
 * @param value - Input text / 输入文本
 * @param maximumTokens - Maximum allowed tokens / 最大允许 token 数
 * @param keep - Which end to preserve / 保留哪一端
 * @returns Truncated text / 截断后的文本
 */
export function truncateByTokens(value: string, maximumTokens: number, keep: 'head' | 'tail'): string {
  const trimmed = value.trim();
  if (maximumTokens <= 0 || !trimmed) return '';
  if (estimateTokenCount(trimmed) <= maximumTokens) return trimmed;
  let low = 0;
  let high = trimmed.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const slice = keep === 'head' ? trimmed.slice(0, middle) : trimmed.slice(trimmed.length - middle);
    if (estimateTokenCount(slice) <= maximumTokens) low = middle;
    else high = middle - 1;
  }
  if (low <= 0) return '';
  const slice = keep === 'head' ? trimmed.slice(0, low) : trimmed.slice(trimmed.length - low);
  return keep === 'head' ? `${slice}…` : `…${slice}`;
}
