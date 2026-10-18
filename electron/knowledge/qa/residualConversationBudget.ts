/**
 * Residual conversation budget calculation and prefix selection for QA memory compression.
 * 问答记忆压缩的剩余会话预算计算与前缀选择。
 */
import type { QaStoredTurn } from './qaMemoryTypes.ts';
import { QA_HOT_TURN_STATUSES } from './qaMemoryTypes.ts';
import {
  calculateQaCheckpointTargets,
  renderQaCheckpointSourceTurn,
} from './qaConversationCheckpoint.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';

/**
 * Input parameters for residual conversation budget calculation.
 * 剩余会话预算计算的输入参数。
 */
export interface ResidualConversationBudgetInput {
  /** Total context window tokens / 上下文窗口总 token 数 */
  contextWindowTokens: number;
  /** Maximum output token reserve / 最大输出 token 预留 */
  maxOutputTokens: number;
  /** Safety reserve tokens / 安全余量 token 数 */
  safetyReserveTokens: number;
  /** Optimized non-conversation material tokens / 优化后的非会话材料 token 数 */
  optimizedNonConversationTokens: number;
  /** Checkpoint summary tokens / 检查点摘要 token 数 */
  checkpointTokens: number;
  /** Raw conversation tail tokens (optional) / 原始会话尾部 token 数（可选） */
  rawConversationTokens?: number;
  /** Hard prompt ratio upper bound (0,1] / Prompt 硬上限比例 (0,1] */
  hardPromptRatio?: number;
  /** Target prompt ratio for hysteresis (0,1] / 回滞目标比例 (0,1] */
  targetPromptRatio?: number;
}

/**
 * Computed residual conversation budget breakdown.
 * 计算得出的剩余会话预算分解。
 */
export interface ResidualConversationBudget {
  /** Context window size (W) / 上下文窗口大小 (W) */
  W: number;
  /** Output reserve (O) / 输出预留 (O) */
  O: number;
  /** Safety reserve (G) / 安全余量 (G) */
  G: number;
  /** Non-conversation material tokens (N) / 非会话材料 token 数 (N) */
  N: number;
  /** Conversation pool hard max (C = hardMaxPrompt - N) / 会话池硬上限 (C) */
  C: number;
  /** Checkpoint tokens (M) / 检查点 token 数 (M) */
  M: number;
  /** Headroom for new turns (H = C - M) / 新轮次空间 (H) */
  H: number;
  /** Current window utilization ratio / 当前窗口利用率 */
  UWindow: number;
  /** Absolute hard prompt budget / 绝对 Prompt 硬上限 */
  hardMaxPromptTokens: number;
  /** Target prompt budget with hysteresis / 回滞目标 Prompt 预算 */
  targetPromptTokens: number;
  /** Hard conversation pool capacity / 会话池硬容量 */
  hardConversationPool: number;
  /** Target conversation pool capacity / 会话池目标容量 */
  targetConversationPool: number;
  /** Reentry reserve (hard - target) / 重入预留（硬上限 - 目标） */
  reentryReserve: number;
}

/**
 * Result of selecting the oldest conversation prefix that fits the target budget.
 * 选择满足目标预算的最旧会话前缀的结果。
 */
export interface QaConversationPrefixSelection {
  /** Selected older turns for checkpoint compression / 选中的较旧轮次用于检查点压缩 */
  selectedPrefix: QaStoredTurn[];
  /** Remaining recent turns kept as short-term / 保留为短期记忆的后续新轮次 */
  recentSuffix: QaStoredTurn[];
  /** Last turnSeq included in the prefix / 前缀中包含的最后一个 turnSeq */
  selectedThroughSeq: number;
  /** Raw token count of selected prefix / 选中前缀的原始 token 数 */
  selectedRawTokens: number;
  /** Token count of the recent suffix / 后续新轮次的 token 数 */
  recentSuffixTokens: number;
  /** Total source tokens (checkpoint + prefix) / 总源 token 数（检查点 + 前缀） */
  sourceTokens: number;
  /** Summary hard max token cap / 摘要硬上限 token 数 */
  summaryHardMaxTokens: number;
  /** Summary target token cap / 摘要目标 token 数 */
  summaryTargetTokens: number;
  /** Projected total conversation tokens after compression / 压缩后预估总对话 token 数 */
  projectedConversationTokens: number;
}

/**
 * Recalculate the residual conversation window after optimizing non-conversation occupancy; no fixed M1/M2 slots.
 * 以优化后的非会话占用重算剩余窗口；不保留固定 M1/M2 槽位。
 *
 * @param input - Budget input parameters / 预算输入参数
 * @returns Complete budget breakdown / 完整预算分解
 */
export function calculateResidualConversationBudget(input: ResidualConversationBudgetInput): ResidualConversationBudget {
  const W = positiveInteger(input.contextWindowTokens, '上下文窗口');
  const O = nonNegativeInteger(input.maxOutputTokens, '输出预算');
  const G = nonNegativeInteger(input.safetyReserveTokens, '安全余量');
  const N = nonNegativeInteger(input.optimizedNonConversationTokens, '非会话材料');
  const M = nonNegativeInteger(input.checkpointTokens, 'Checkpoint');
  const rawConversationTokens = nonNegativeInteger(input.rawConversationTokens ?? 0, '原始会话尾部');
  const hardPromptRatio = validRatio(input.hardPromptRatio ?? 1, 'Prompt 硬上限比例');
  const targetPromptRatio = validRatio(input.targetPromptRatio ?? 0.92, '回滞目标比例');
  if (targetPromptRatio > hardPromptRatio) throw new Error('会话回滞目标不得高于 Prompt 硬上限。');

  const hardMaxPromptTokens = Math.max(0, Math.floor(W * hardPromptRatio) - O - G);
  const targetPromptTokens = Math.max(0, Math.floor(W * targetPromptRatio) - O - G);
  const C = Math.max(0, hardMaxPromptTokens - N);
  const H = Math.max(0, C - M);
  const hardConversationPool = C;
  const targetConversationPool = Math.max(0, targetPromptTokens - N);
  return {
    W,
    O,
    G,
    N,
    C,
    M,
    H,
    UWindow: (N + M + rawConversationTokens + O + G) / W,
    hardMaxPromptTokens,
    targetPromptTokens,
    hardConversationPool,
    targetConversationPool,
    reentryReserve: Math.max(0, hardConversationPool - targetConversationPool),
  };
}

/**
 * Select the minimal, oldest, turn-atomic prefix that satisfies the hysteresis target.
 * Seq numbers may have gaps due to failed turns, but input must be a complete
 * memorable-terminal stream after coveredThroughSeq.
 *
 * 选择满足回滞目标的最小、最旧、Turn 原子前缀。数字 seq 可因失败轮而有空洞，
 * 但输入必须是 coveredThroughSeq 之后完整的可记忆终态流。
 *
 * @param input - Turn selection parameters / 轮次选择参数
 * @returns Prefix selection result or undefined if no compression needed / 前缀选择结果，无需压缩时返回 undefined
 */
export function selectOldestQaConversationPrefix(input: {
  turns: readonly QaStoredTurn[];
  coveredThroughSeq: number;
  previousCheckpointTokens: number;
  originalShortTermCapacity: number;
  targetConversationPoolTokens: number;
}): QaConversationPrefixSelection | undefined {
  const coveredThroughSeq = nonNegativeInteger(input.coveredThroughSeq, 'Checkpoint 覆盖边界');
  const previousCheckpointTokens = nonNegativeInteger(input.previousCheckpointTokens, '上一版 Checkpoint token');
  const originalShortTermCapacity = nonNegativeInteger(input.originalShortTermCapacity, '原短期会话容量');
  const targetConversationPoolTokens = nonNegativeInteger(input.targetConversationPoolTokens, '目标会话池');
  validateTurns(input.turns, coveredThroughSeq);
  if (input.turns.length === 0) return undefined;

  const turnTokens = input.turns.map((turn) => estimateTokenCount(renderQaCheckpointSourceTurn(turn)));
  let selectedRawTokens = 0;
  let recentSuffixTokens = turnTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (previousCheckpointTokens + recentSuffixTokens <= targetConversationPoolTokens) return undefined;
  for (let index = 0; index < input.turns.length; index += 1) {
    selectedRawTokens += turnTokens[index];
    recentSuffixTokens -= turnTokens[index];
    const sourceTokens = previousCheckpointTokens + selectedRawTokens;
    const targets = calculateQaCheckpointTargets(originalShortTermCapacity, sourceTokens);
    const projectedConversationTokens = targets.summaryTargetTokens + recentSuffixTokens;
    if (projectedConversationTokens <= targetConversationPoolTokens) {
      const selectedPrefix = input.turns.slice(0, index + 1);
      return {
        selectedPrefix,
        recentSuffix: input.turns.slice(index + 1),
        selectedThroughSeq: selectedPrefix.at(-1)!.turnSeq,
        selectedRawTokens,
        recentSuffixTokens,
        sourceTokens,
        ...targets,
        projectedConversationTokens,
      };
    }
  }
  return undefined;
}

/**
 * Calculate the total raw token count of stored turns.
 * 计算存储轮次的原始 token 总数。
 *
 * @param turns - Array of stored turns / 存储轮次数组
 * @returns Total estimated token count / 估计 token 总数
 */
export function calculateQaRawConversationTokens(turns: readonly QaStoredTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateTokenCount(renderQaCheckpointSourceTurn(turn)), 0);
}

function validateTurns(turns: readonly QaStoredTurn[], coveredThroughSeq: number): void {
  let previous = coveredThroughSeq;
  const ids = new Set<string>();
  for (const turn of turns) {
    if (!Number.isSafeInteger(turn.turnSeq) || turn.turnSeq <= previous
      || ids.has(turn.turnId) || !QA_HOT_TURN_STATUSES.includes(turn.status)) {
      throw new Error('会话压缩候选必须是覆盖边界后的升序、唯一、可记忆终态 Turn。');
    }
    previous = turn.turnSeq;
    ids.add(turn.turnId);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正整数。`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数。`);
  return value;
}

function validRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${label}必须位于 (0, 1]。`);
  return value;
}
