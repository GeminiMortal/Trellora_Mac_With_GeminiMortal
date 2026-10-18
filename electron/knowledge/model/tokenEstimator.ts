/**
 * Token estimation and context usage tracking for the assistant pipeline.
 * Provides a lightweight CJK-aware token counter (no external tokenizer),
 * evidence token estimation from search metadata, and context window usage
 * aggregation from provider or local estimates.
 * 助手流水线的 token 估算与上下文使用跟踪。提供轻量级 CJK 感知的 token 计数器
 * （无外部 tokenizer）、从搜索元数据估算证据 token、以及从提供商或本地估算聚合上下文窗口用量。
 */

import type { EffectiveContextWindowConfidence, EffectiveContextWindowSource } from '../../../shared/effectiveContextWindow.ts';
import type { AssistantEvidenceProjectionMode, EvidenceCompressionMode } from '../assistant/assistantMode.ts';

/**
 * Statistics about the evidence context assembled for an assistant turn.
 * 助手轮次中组装的证据上下文统计。
 */
export interface AssistantEvidenceContextStats {
  /** Stage 1 deliberately exposes estimates only; exact values belong to Stage 2+. */
  accuracy: 'estimate' | 'exact';
  projectionMode: AssistantEvidenceProjectionMode;
  compressionMode: EvidenceCompressionMode;
  manifestStatus: 'not-materialized' | 'materialized';
  /** Includes repeated search-hit events, matching the search observation rail. */
  searchHitCount: number;
  uniqueSearchHitCount: number;
  estimatedRawEvidenceTokens: number;
  mayNeedCompression: boolean;
  evidenceBudgetTokens?: number;
  /** Exact Stage 2+ values are optional until the source evidence is materialized. */
  retrievedCount?: number;
  representedCount?: number;
  rawCount?: number;
  compressedCount?: number;
  rawTokens?: number;
  finalEvidenceTokens?: number;
  compressionRatio?: number;
  compressionRounds?: number;
  compressionBatchCount?: number;
  representationCoverage?: number;
}

/**
 * Token usage reported by the AI provider after a model call.
 * AI 提供商在模型调用后报告的 token 用量。
 */
export interface AssistantTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

/**
 * Per-zone partition statistics in the assembled prompt.
 * 已组装 prompt 中每区域的分区统计。
 */
export interface AssistantPromptPartitionStat {
  zone: string;
  tokens: number;
  protectedTokens: number;
  segmentIds: string[];
}

/**
 * Aggregate prompt assembly statistics for an assistant model call.
 * 助手模型调用的聚合 prompt 组装统计。
 */
export interface AssistantPromptStats {
  callKind: string;
  projectionLevel: 0 | 1 | 3 | 4;
  planId?: string;
  planVersion?: number;
  activeGoalId?: string | null;
  predictedPromptTokens: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
  safetyReserveTokens?: number;
  protectedTokens: number;
  evidenceHotTokens: number;
  evidenceWarmTokens: number;
  evidenceColdTokens: number;
  partitions: AssistantPromptPartitionStat[];
  evidenceContextStats?: AssistantEvidenceContextStats;
}

/**
 * Context window usage for an assistant turn, either from provider or local estimate.
 * 助手轮次的上下文窗口用量，来自提供商或本地估算。
 */
export interface AssistantContextUsage {
  inputTokens: number;
  contextWindowTokens?: number;
  contextWindowSource?: EffectiveContextWindowSource;
  contextWindowConfidence?: EffectiveContextWindowConfidence;
  contextWindowWarning?: string;
  estimated: boolean;
  source: 'estimate' | 'provider';
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  promptStats?: AssistantPromptStats;
}

/**
 * Estimate token count without a provider-specific tokenizer. CJK characters
 * are counted individually; Latin runs use a conservative 4-chars-per-token approximation.
 * 在没有提供商特定 tokenizer 的情况下估算 token 数。CJK 字符逐字计数；
 * 拉丁文连续段使用保守的每 token 4 字符近似。
 *
 * @param value - Text to estimate / 要估算的文本
 * @returns Estimated token count / 估算的 token 数
 */
export function estimateTokenCount(value: string): number {
  let tokens = 0;
  let latinRun = 0;

  const flushLatinRun = () => {
    if (latinRun > 0) {
      tokens += Math.ceil(latinRun / 4);
      latinRun = 0;
    }
  };

  for (const character of value) {
    if (/\s/u.test(character)) {
      flushLatinRun();
      continue;
    }
    if (/^[\u3400-\u9fff]$/u.test(character)) {
      flushLatinRun();
      tokens += 1;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code <= 0x7f && /[A-Za-z0-9]/u.test(character)) {
      latinRun += 1;
      continue;
    }
    flushLatinRun();
    tokens += 1;
  }

  flushLatinRun();
  return tokens;
}

/**
 * Search hit metadata used for evidence token estimation.
 * 用于证据 token 估算的搜索命中元数据。
 */
export interface SearchHitEvidenceTokenMetadata {
  blockId?: string;
  lineFrom: number;
  lineTo: number;
  snippet: string;
  headingPath?: readonly string[];
}

/**
 * Input for observing assistant evidence context during Stage 1.
 * Stage 1 观察助手证据上下文的输入。
 */
export interface AssistantEvidenceObserveInput {
  projectionMode: AssistantEvidenceProjectionMode;
  compressionMode: EvidenceCompressionMode;
  searchHits: readonly SearchHitEvidenceTokenMetadata[];
  evidenceBudgetTokens?: number;
}

/**
 * Estimate original block size from search metadata only. The snippet is a
 * lower-bound signal; line span and heading metadata add a conservative,
 * deterministic allowance. Must never be presented as materialized text.
 * 仅从搜索元数据估算原始块大小。snippet 是下限信号；行跨度和标题元数据
 * 添加保守的确定性余量。绝不能作为已物化文本呈现。
 *
 * @param hits - Search hit metadata array / 搜索命中元数据数组
 * @returns Token estimation with hit counts / 包含命中计数的 token 估算
 */
export function estimateSearchHitEvidenceTokens(hits: readonly SearchHitEvidenceTokenMetadata[]): {
  searchHitCount: number;
  uniqueSearchHitCount: number;
  estimatedRawEvidenceTokens: number;
} {
  const seen = new Set<string>();
  let estimatedRawEvidenceTokens = 0;
  for (const hit of hits) {
    const lineFrom = Number.isSafeInteger(hit.lineFrom) ? hit.lineFrom : 1;
    const lineTo = Number.isSafeInteger(hit.lineTo) ? Math.max(lineFrom, hit.lineTo) : lineFrom;
    const key = `${hit.blockId ?? ''}:${lineFrom}:${lineTo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lineCount = Math.max(1, lineTo - lineFrom + 1);
    const snippetTokens = estimateTokenCount(hit.snippet);
    const headingTokens = estimateTokenCount((hit.headingPath ?? []).join(' '));
    const signalTokens = snippetTokens + Math.ceil(headingTokens / 2);
    const tokensPerLine = Math.max(8, Math.ceil(signalTokens / Math.min(lineCount, 4)));
    estimatedRawEvidenceTokens += Math.min(32_000, Math.max(snippetTokens, tokensPerLine * lineCount));
  }
  return {
    searchHitCount: hits.length,
    uniqueSearchHitCount: seen.size,
    estimatedRawEvidenceTokens,
  };
}

/**
 * Stage 1 side-channel evidence context estimation. Does not create a Manifest,
 * read source text, select prompt evidence, invoke a model, or change the provider prompt.
 * Stage 1 侧通道证据上下文估算。不创建 Manifest、不读取源文本、不选择 prompt 证据、
 * 不调用模型、不更改提供商 prompt。
 *
 * @param input - Evidence observation input / 证据观察输入
 * @returns Evidence context stats or undefined if not in observe mode / 证据上下文统计，非观察模式时返回 undefined
 */
export function estimateAssistantEvidenceContextStats(input: AssistantEvidenceObserveInput): AssistantEvidenceContextStats | undefined {
  if (input.compressionMode !== 'observe') return undefined;
  const estimate = estimateSearchHitEvidenceTokens(input.searchHits);
  const evidenceBudgetTokens = input.evidenceBudgetTokens !== undefined
    && Number.isSafeInteger(input.evidenceBudgetTokens)
    && input.evidenceBudgetTokens >= 0
    ? input.evidenceBudgetTokens
    : undefined;
  return {
    accuracy: 'estimate',
    projectionMode: input.projectionMode,
    compressionMode: input.compressionMode,
    manifestStatus: 'not-materialized',
    ...estimate,
    ...(evidenceBudgetTokens !== undefined ? { evidenceBudgetTokens } : {}),
    mayNeedCompression: evidenceBudgetTokens !== undefined && estimate.estimatedRawEvidenceTokens > evidenceBudgetTokens,
  };
}

/**
 * Estimate or report context usage for an assistant turn. Prefers provider-reported
 * tokens when available; falls back to local estimation otherwise.
 * 估算或报告助手轮次的上下文用量。优先使用提供商报告的 token；不可用时回退到本地估算。
 *
 * @param prompt - The assembled prompt text / 已组装的 prompt 文本
 * @param contextWindowTokens - Context window size / 上下文窗口大小
 * @param providerUsage - Provider-reported token usage / 提供商报告的 token 用量
 * @param contextWindow - Context window source metadata / 上下文窗口来源元数据
 * @returns Context usage with source attribution / 带来源归属的上下文用量
 */
export function estimateAssistantContextUsage(
  prompt: string,
  contextWindowTokens?: number,
  providerUsage?: AssistantTokenUsage,
  contextWindow?: { source: EffectiveContextWindowSource; confidence: EffectiveContextWindowConfidence; warning?: string },
): AssistantContextUsage {
  if (providerUsage?.inputTokens !== undefined) {
    return {
      inputTokens: providerUsage.inputTokens,
      contextWindowTokens,
      ...(contextWindow ? { contextWindowSource: contextWindow.source, contextWindowConfidence: contextWindow.confidence, ...(contextWindow.warning ? { contextWindowWarning: contextWindow.warning } : {}) } : {}),
      estimated: false,
      source: 'provider',
      ...(providerUsage.outputTokens !== undefined ? { outputTokens: providerUsage.outputTokens } : {}),
      ...(providerUsage.totalTokens !== undefined ? { totalTokens: providerUsage.totalTokens } : {}),
      ...(providerUsage.cachedInputTokens !== undefined ? { cachedInputTokens: providerUsage.cachedInputTokens } : {}),
    };
  }
  return {
    inputTokens: estimateTokenCount(prompt),
    contextWindowTokens,
    ...(contextWindow ? { contextWindowSource: contextWindow.source, contextWindowConfidence: contextWindow.confidence, ...(contextWindow.warning ? { contextWindowWarning: contextWindow.warning } : {}) } : {}),
    estimated: true,
    source: 'estimate',
  };
}
