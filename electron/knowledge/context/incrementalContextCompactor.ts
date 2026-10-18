/**
 * Deterministic L1 prompt compaction that deduplicates segments by zone+text
 * and truncates oversized non-protected segments to a fixed character budget.
 * 确定性 L1 prompt 压缩，按 zone+text 去重片段，并将超长的非保护片段截断至固定字符预算。
 */
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import type { PromptSegment } from '../plan/planAwarePromptProjector.ts';

/**
 * Result of L1 prompt compaction: the deduplicated segment list, the compaction
 * level applied (0 = no change, 1 = L1), and whether the content changed.
 * L1 prompt 压缩结果：去重后的片段列表、应用的压缩级别（0 = 无变化，1 = L1）以及内容是否发生变化。
 */
export interface L1PromptCompactionResult {
  segments: PromptSegment[];
  level: 0 | 1;
  changed: boolean;
}

/**
 * Deterministic L1 compaction. Protected segments are copied byte-for-byte.
 * 确定性 L1 压缩。受保护片段按字节原样复制。
 *
 * @param segments - Input prompt segments to compact / 需要压缩的输入 prompt 片段
 * @returns Compaction result with deduplicated segments and level / 包含去重片段和级别的压缩结果
 */
export function compactPromptSegmentsL1(segments: readonly PromptSegment[]): L1PromptCompactionResult {
  const folded = new Map<string, PromptSegment>();
  let changed = false;
  for (const segment of segments) {
    const normalized = normalizeSegment(segment);
    const key = `${normalized.zone}\u0000${normalized.text}`;
    const existing = folded.get(key);
    if (!existing) {
      folded.set(key, normalized);
      changed ||= normalized.text !== segment.text || normalized.estimatedTokens !== segment.estimatedTokens;
      continue;
    }
    changed = true;
    existing.sourceIds = merge(existing.sourceIds, normalized.sourceIds);
    existing.goalIds = merge(existing.goalIds, normalized.goalIds);
    existing.requirementIds = merge(existing.requirementIds, normalized.requirementIds);
    existing.evidenceIds = merge(existing.evidenceIds, normalized.evidenceIds);
  }
  return { segments: [...folded.values()], level: changed ? 1 : 0, changed };
}

// Truncates non-protected segments exceeding zone-specific character limits (1000 for
// execution traces/tool observations, 2400 otherwise). Keeps 68% head + 22% tail.
// 将超过 zone 特定字符限制的非保护片段截断（execution-trace/tool-observation 为 1000，其余为 2400）。
// 保留 68% 头部 + 22% 尾部。
function normalizeSegment(segment: PromptSegment): PromptSegment {
  if (segment.protected || segment.compressStrategy === 'none') return copySegment(segment);
  const limit = segment.zone === 'execution-trace' || segment.zone === 'tool-observation' ? 1_000 : 2_400;
  if (segment.text.length <= limit) return copySegment(segment);
  const head = Math.ceil(limit * 0.68);
  const tail = Math.floor(limit * 0.22);
  const text = `${segment.text.slice(0, head)}\n…（L1 确定性压缩，完整原文仍在 Ledger）…\n${segment.text.slice(-tail)}`;
  return { ...copySegment(segment), text, estimatedTokens: estimateTokenCount(text) };
}

// Deep-copies a PromptSegment including its optional ID arrays to avoid shared mutation.
// 深拷贝 PromptSegment，包括可选的 ID 数组，避免共享可变状态。
function copySegment(segment: PromptSegment): PromptSegment {
  return {
    ...segment,
    ...(segment.sourceIds ? { sourceIds: [...segment.sourceIds] } : {}),
    ...(segment.goalIds ? { goalIds: [...segment.goalIds] } : {}),
    ...(segment.requirementIds ? { requirementIds: [...segment.requirementIds] } : {}),
    ...(segment.evidenceIds ? { evidenceIds: [...segment.evidenceIds] } : {}),
  };
}

// Merges two optional string arrays into a sorted, deduplicated array; returns undefined if empty.
// 将两个可选字符串数组合并为排序去重数组；为空时返回 undefined。
function merge(first: string[] | undefined, second: string[] | undefined): string[] | undefined {
  const values = [...new Set([...(first ?? []), ...(second ?? [])])].sort();
  return values.length ? values : undefined;
}
