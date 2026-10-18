/**
 * Context-window budget calculations for the current-note retrieval pipeline.
 * 当前笔记检索流水线的上下文窗口预算计算模块。
 */
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import { ASSISTANT_CONTEXT_BUDGET_TOKENS, ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS } from '../../../shared/assistantContextBudget.ts';

/**
 * Configuration for context-window budget checks. Context capacity is a veto
 * only — it never decides that a note may be sent in full; that authorization
 * remains exclusively in currentNotePolicy.
 *
 * 上下文窗口预算检查配置。上下文容量仅作为否决条件，不决定笔记是否可以完整发送；
 * 该授权仅由 currentNotePolicy 负责。
 */
export interface CurrentNoteContextBudgetConfig {
  contextWindowTokens?: number;
  reservedOutputTokens: number;
  reservedHistoryTokens: number;
  reservedDynamicTokens: number;
}

/**
 * Result of assessing whether a stable prefix fits within the context budget.
 * 评估稳定前缀是否在上下文预算范围内的结果。
 */
export interface CurrentNoteContextBudgetAssessment {
  stablePrefixTokens: number;
  contextWindowKnown: boolean;
  maxStablePrefixTokens?: number;
  fits: boolean;
  rejection?: 'stable-prefix-over-budget';
}

/**
 * Result of assessing whether a prompt input fits within the context budget.
 * 评估提示词输入是否在上下文预算范围内的结果。
 */
export interface CurrentNotePromptBudgetAssessment {
  inputTokens: number;
  contextWindowKnown: boolean;
  maxInputTokens?: number;
  fits: boolean;
  rejection?: 'prompt-over-budget';
}

/**
 * All recognized prompt call kinds that require per-kind output token limits.
 * 所有已识别的提示词调用类型，每种类型有独立的输出 token 上限。
 */
export type PromptCallKind = 'plan' | 'decide' | 'synthesize' | 'citation-repair' | 'summary-map' | 'summary-reduce' | 'shadow-plan' | 'conversation-maintenance' | 'route-classify' | 'query-rewrite' | 'chat' | 'follow-up-suggest' | 'user-profile-extract' | 'direct' | 'learning-plan' | 'organize' | 'memory-compress';

/**
 * Detailed budget plan produced before an authorized prompt send, including
 * predicted token counts, safety reserves, and utilization metrics.
 *
 * 在授权发送提示词之前生成的详细预算计划，包含预测 token 数、安全预留和利用率指标。
 */
export interface PromptBudgetPlan {
  callKind: PromptCallKind;
  contextWindowTokens: number;
  predictedPromptTokens: number;
  maxPromptTokens: number;
  maxOutputTokens: number;
  safetyReserveTokens: number;
  rawPromptTokens: number;
  calibrationMultiplier: number;
  requestEnvelopeVersion: string;
  budgetTextSource: 'serialized-envelope' | 'legacy-prompt';
  utilization: number;
  fits: boolean;
  rejection?: 'prompt-over-budget';
}

/**
 * Stage 3 keeps the scheduler's provider safety reserve intact and allocates
 * the remaining prompt space from the same complete-prompt budget.
 *
 * Stage 3 保留调度器的 provider 安全预留，从同一完整提示预算中分配剩余空间。
 *
 * @param maxPromptTokens - Maximum prompt tokens available / 最大可用提示词 token 数
 * @param allNonEvidenceAndFramingTokens - Tokens consumed by non-evidence content / 非证据内容消耗的 token 数
 * @returns Tokens available for the evidence payload / 证据载荷可用的 token 数
 */
export function calculateEvidencePayloadBudgetTokens(
  maxPromptTokens: number,
  allNonEvidenceAndFramingTokens: number,
): number {
  if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens < 0) throw new Error('maxPromptTokens 必须是非负整数。');
  if (!Number.isSafeInteger(allNonEvidenceAndFramingTokens) || allNonEvidenceAndFramingTokens < 0) {
    throw new Error('非证据与包装 token 数必须是非负整数。');
  }
  // Reserve 2% for provider framing overhead before subtracting non-evidence tokens.
  // 在减去非证据 token 前，为 provider 框架开销预留 2%。
  return Math.max(0, Math.floor(maxPromptTokens * 0.98) - allNonEvidenceAndFramingTokens);
}

const callKindOutputLimits: Record<PromptCallKind, number> = {
  plan: 4_096,
  decide: 4_096,
  synthesize: 16_384,
  'citation-repair': 4_096,
  'summary-map': 4_096,
  'summary-reduce': 8_192,
  'shadow-plan': 4_096,
  'conversation-maintenance': 4_096,
  'route-classify': 4_096,
  'query-rewrite': 1_024,
  chat: 8_192,
  'follow-up-suggest': 1_024,
  'user-profile-extract': 800,
  direct: 16_384,
  'learning-plan': 8_192,
  organize: 8_192,
  'memory-compress': 8_192,
};

/**
 * Counts the complete prompt immediately before an authorized send.
 * 在授权发送前对完整提示词进行 token 计数的调度器。
 */
export class PromptBudgetScheduler {
  plan(input: {
    prompt: string;
    /** Exact role/envelope serialization used for budget accounting. */
    serializedBudgetText?: string;
    requestEnvelopeVersion?: string;
    contextWindowTokens?: number;
    callKind: PromptCallKind;
    requestedMaxOutputTokens?: number;
    providerMaxOutputTokens?: number;
    safetyRatio?: number;
    calibrationMultiplier?: number;
  }): PromptBudgetPlan {
    const contextWindowTokens = input.contextWindowTokens ?? ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) throw new Error('上下文窗口必须是正整数。');
    // Cap output at 12.5% of context window, with a minimum of 1 024 tokens.
    // 输出上限为上下文窗口的 12.5%，最低 1 024 token。
    const scaledOutputCeiling = Math.max(1_024, Math.floor(contextWindowTokens * 0.125));
    const maxOutputTokens = Math.min(
      callKindOutputLimits[input.callKind],
      scaledOutputCeiling,
      input.providerMaxOutputTokens ?? Number.MAX_SAFE_INTEGER,
      input.requestedMaxOutputTokens ?? Number.MAX_SAFE_INTEGER,
    );
    // Small contexts use a higher safety ratio (5%) to absorb variance; large ones use 3.125%.
    // 小上下文使用较高的安全比率 (5%) 以吸收方差；大上下文使用 3.125%。
    const safetyRatio = input.safetyRatio ?? (contextWindowTokens < ASSISTANT_CONTEXT_BUDGET_TOKENS ? 0.05 : 0.03125);
    const safetyReserveTokens = Math.max(2_048, Math.floor(contextWindowTokens * safetyRatio));
    const maxPromptTokens = Math.max(0, contextWindowTokens - maxOutputTokens - safetyReserveTokens);
    const budgetTextSource = input.serializedBudgetText === undefined ? 'legacy-prompt' : 'serialized-envelope';
    const rawPromptTokens = estimateTokenCount(input.serializedBudgetText ?? input.prompt);
    const calibrationMultiplier = Math.max(1, input.calibrationMultiplier ?? 1);
    const predictedPromptTokens = Math.ceil(rawPromptTokens * calibrationMultiplier);
    const fits = predictedPromptTokens <= maxPromptTokens;
    return {
      callKind: input.callKind,
      contextWindowTokens,
      predictedPromptTokens,
      maxPromptTokens,
      maxOutputTokens,
      safetyReserveTokens,
      rawPromptTokens,
      calibrationMultiplier,
      requestEnvelopeVersion: input.requestEnvelopeVersion?.trim() || (budgetTextSource === 'serialized-envelope' ? 'context-envelope-unknown' : 'legacy-prompt-v1'),
      budgetTextSource,
      utilization: contextWindowTokens > 0 ? predictedPromptTokens / contextWindowTokens : 1,
      fits,
      ...(fits ? {} : { rejection: 'prompt-over-budget' as const }),
    };
  }
}

/**
 * Emergency-only, deterministic projection compaction. It never edits the
 * ledger or plan; it only shortens non-protected prompt blocks while keeping
 * identifiers and the beginning/end of each observation visible to the model.
 *
 * 仅用于紧急情况的确定性投影压缩。不修改账本或计划；仅缩短非保护提示块，
 * 同时保持标识符和每个观察的首尾对模型可见。
 *
 * @param prompt - The full prompt text to compact / 需要压缩的完整提示词文本
 * @param callKind - The prompt call kind that determines compression limits / 决定压缩限制的提示词调用类型
 * @returns The compacted prompt, or the original if no compaction was needed / 压缩后的提示词，若无需压缩则返回原文
 */
export function compactPromptForOverflowRetry(prompt: string, callKind: PromptCallKind): string {
  const protectedMarkers = ['[Zone A', '[Zone D', '[Zone G', '[当前问题]', '[最终回答]', '输出 JSON'];
  const blocks = prompt.split(/\n{2,}/u);
  let changed = false;
  const compacted = blocks.map((block) => {
    if (block.length <= 1_800 || protectedMarkers.some((marker) => block.includes(marker))) return block;
    // synthesize calls get a larger limit since they aggregate more evidence.
    // synthesize 调用获得更大的限制，因为它们需要聚合更多证据。
    const limit = callKind === 'synthesize' ? 1_200 : 900;
    // Keep 62% from the start and 28% from the end; the middle is dropped.
    // 保留前 62% 和后 28%；中间部分被丢弃。
    const head = Math.ceil(limit * 0.62);
    const tail = Math.floor(limit * 0.28);
    changed = true;
    return `${block.slice(0, head)}\n…（仅压缩本次模型投影，完整内容仍保留在主进程权威状态）…\n${block.slice(-tail)}`;
  });
  return changed ? compacted.join('\n\n') : prompt;
}

/** Default budget reservations when the context window size is unknown. 默认的预算预留值，用于上下文窗口大小未知时。 */
export const DEFAULT_CURRENT_NOTE_CONTEXT_BUDGET: Readonly<Omit<CurrentNoteContextBudgetConfig, 'contextWindowTokens'>> = Object.freeze({
  reservedOutputTokens: 1_200,
  reservedHistoryTokens: 800,
  reservedDynamicTokens: 400,
});

/**
 * Manages context-window budget assessments for stable prefixes and prompt inputs.
 * 管理稳定前缀和提示词输入的上下文窗口预算评估。
 */
export class ContextBudgetManager {
  private readonly config: CurrentNoteContextBudgetConfig;

  constructor(config: CurrentNoteContextBudgetConfig) {
    assertNonNegativeInteger(config.reservedOutputTokens, '输出预留');
    assertNonNegativeInteger(config.reservedHistoryTokens, '历史预留');
    assertNonNegativeInteger(config.reservedDynamicTokens, '动态预留');
    if (config.contextWindowTokens !== undefined) assertPositiveInteger(config.contextWindowTokens, '上下文窗口');
    this.config = { ...config };
  }

  /**
   * Checks whether the context window can accommodate both output and history reserves.
   * The policy can use this only as a second-level rejection condition.
   *
   * 检查上下文窗口是否能容纳输出和历史预留。策略仅可将其作为二级否决条件。
   *
   * @returns True if the window is large enough for both reserves / 窗口是否足够容纳两项预留
   */
  hasOutputAndHistoryReserve(): boolean {
    const contextWindowTokens = this.config.contextWindowTokens;
    return contextWindowTokens !== undefined
      && contextWindowTokens > this.config.reservedOutputTokens + this.config.reservedHistoryTokens;
  }

  /**
   * Assesses whether the stable prefix fits within the available budget after reserves.
   * 评估稳定前缀是否在扣除预留后的可用预算范围内。
   *
   * @param stablePrefixTokens - Token count of the stable prefix / 稳定前缀的 token 数
   * @returns Budget assessment with fit status and optional rejection reason / 包含适配状态和可选拒绝原因的预算评估
   */
  assessStablePrefix(stablePrefixTokens: number): CurrentNoteContextBudgetAssessment {
    assertNonNegativeInteger(stablePrefixTokens, '稳定前缀 token 数');
    const contextWindowTokens = this.config.contextWindowTokens;
    if (contextWindowTokens === undefined) {
      // An unknown window still rejects direct-full through StrictSmallNotePolicy.
      // A bounded Capsule remains usable because this class does not authorize
      // raw-note disclosure in either direction.
      return { stablePrefixTokens, contextWindowKnown: false, fits: true };
    }
    const maxStablePrefixTokens = contextWindowTokens
      - this.config.reservedOutputTokens
      - this.config.reservedHistoryTokens
      - this.config.reservedDynamicTokens;
    if (maxStablePrefixTokens < 0 || stablePrefixTokens > maxStablePrefixTokens) {
      return { stablePrefixTokens, contextWindowKnown: true, maxStablePrefixTokens: Math.max(0, maxStablePrefixTokens), fits: false, rejection: 'stable-prefix-over-budget' };
    }
    return { stablePrefixTokens, contextWindowKnown: true, maxStablePrefixTokens, fits: true };
  }

  /**
   * Assesses whether the prompt input fits within the context window minus output reserve.
   * 评估提示词输入是否在上下文窗口减去输出预留后的范围内。
   *
   * @param inputTokens - Token count of the prompt input / 提示词输入的 token 数
   * @returns Budget assessment with fit status and optional rejection reason / 包含适配状态和可选拒绝原因的预算评估
   */
  assessPrompt(inputTokens: number): CurrentNotePromptBudgetAssessment {
    assertNonNegativeInteger(inputTokens, '提示词 token 数');
    const contextWindowTokens = this.config.contextWindowTokens;
    if (contextWindowTokens === undefined) return { inputTokens, contextWindowKnown: false, fits: true };
    const maxInputTokens = contextWindowTokens - this.config.reservedOutputTokens;
    if (maxInputTokens < 0 || inputTokens > maxInputTokens) {
      return { inputTokens, contextWindowKnown: true, maxInputTokens: Math.max(0, maxInputTokens), fits: false, rejection: 'prompt-over-budget' };
    }
    return { inputTokens, contextWindowKnown: true, maxInputTokens, fits: true };
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数。`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
}
