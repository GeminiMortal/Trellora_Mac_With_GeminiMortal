/**
 * Selection expansion sizing policy: length accounting, target resolution, and receipts.
 * 选区扩写的尺寸策略：长度核算、目标解析与回执。
 */

import { expansionMarkdownText } from './selectionExpansionMarkdown';

/**
 * Expansion keeps its product threshold independent from current-note QA.
 * 扩写保持其产品阈值独立于当前笔记问答。
 */

/**
 * Character count at or above which the whole note is considered available for expansion.
 * 达到该字符数即视为整篇笔记可用于扩写。
 */
export const EXPANSION_FULL_NOTE_CHARACTERS = 12_000;

/**
 * Hard upper bound on the expansion target length.
 * 扩写目标长度的硬上限。
 */
export const EXPANSION_MAX_TARGET_CHARACTERS = 40_000;

/**
 * Default ratio applied to the original length to derive the target.
 * 用于由原文长度推导目标长度的默认倍数。
 */
export const EXPANSION_DEFAULT_RATIO = 1.8;

/**
 * Length accounting receipt comparing an expansion candidate against its targets.
 * 将扩写候选与目标长度进行比较的长度核算回执。
 */
export interface SelectionLengthReceipt {
  /** Meaningful characters in the original selection. / 原选区的有效字符数。 */
  originalCharacters: number;
  /** Requested target length. / 请求的目标长度。 */
  targetCharacters: number;
  /** Minimum acceptable length (80% of target). / 可接受的最小长度（目标的 80%）。 */
  minimumCharacters: number;
  /** Meaningful characters in the candidate. / 候选文本的有效字符数。 */
  actualCharacters: number;
  /** Characters still missing to reach the minimum. / 距最小长度仍缺的字符数。 */
  missingToMinimum: number;
  /** Characters still missing to reach the target. / 距目标长度仍缺的字符数。 */
  missingToTarget: number;
}

/**
 * Count meaningful characters in text; whitespace is ignored for output length, but punctuation and Unicode count.
 * 统计文本的有效字符数；输出长度忽略空白，但标点与 Unicode 字符计入。
 *
 * @param text - Text to measure / 要度量的文本
 * @returns Number of non-whitespace characters / 非空白字符数量
 */
export function countMeaningfulCharacters(text: string): number {
  return Array.from(text.replace(/\s/gu, '')).length;
}

/**
 * Count the total characters of a Markdown document after normalizing line endings.
 * 规范化换行后统计 Markdown 文档的总字符数。
 *
 * @param markdown - Markdown text to measure / 要度量的 Markdown 文本
 * @returns Character count of the normalized document / 规范化文档的字符数
 */
export function countFullNoteCharacters(markdown: string): number {
  return Array.from(markdown.replace(/\r\n?/gu, '\n')).length;
}

/**
 * Resolve the expansion target length, applying the default ratio and the hard maximum.
 * 解析扩写目标长度，应用默认倍数与硬上限。
 *
 * @param selectedText - Original selection / 原始选区文本
 * @param targetCharacters - Explicit target, or undefined to derive from the ratio / 显式目标；未提供时按倍数推导
 * @param ratio - Multiplier applied to the original length / 应用于原文长度的倍数
 * @returns Resolved target length in meaningful characters / 解析出的目标有效字符长度
 * @throws Error when the target is not greater than the original / 目标不大于原文时抛出异常
 */
export function resolveExpansionTarget(selectedText: string, targetCharacters?: number, ratio = EXPANSION_DEFAULT_RATIO): number {
  const original = countMeaningfulCharacters(selectedText);
  const target = Math.min(EXPANSION_MAX_TARGET_CHARACTERS, targetCharacters ?? Math.ceil(original * ratio));
  if (!Number.isSafeInteger(target) || target <= original) {
    throw new Error('扩写目标必须大于原文有效字符数，请缩小选区或提高目标长度。');
  }
  return target;
}

/**
 * Build a length receipt comparing a candidate expansion against the original and target lengths.
 * 构建长度核算回执，将扩写候选与原文及目标长度进行比较。
 *
 * @param selectedText - Original selection / 原始选区文本
 * @param candidateText - Expanded candidate text / 扩写后的候选文本
 * @param targetCharacters - Explicit target, or undefined for a minimum-growth check / 显式目标；未提供时执行最小增长检查
 * @returns Receipt with lengths and missing-character deltas / 含长度与缺字差值的回执
 */
export function createSelectionLengthReceipt(selectedText: string, candidateText: string, targetCharacters?: number): SelectionLengthReceipt {
  const originalCharacters = countMeaningfulCharacters(selectedText);
  // Without an explicit target, any growth above the original satisfies the check.
  // 未指定目标时，超过原文的任意增长即可满足检查。
  const target = targetCharacters ?? originalCharacters + 1;
  const minimumCharacters = Math.max(originalCharacters + 1, Math.ceil(target * 0.8));
  // Candidate length is measured on rendered text so Markdown markers do not pad it.
  // 候选长度按渲染文本度量，使 Markdown 标记不计入长度。
  const actualCharacters = countMeaningfulCharacters(expansionMarkdownText(candidateText));
  return {
    originalCharacters, targetCharacters: target, minimumCharacters, actualCharacters,
    missingToMinimum: Math.max(0, minimumCharacters - actualCharacters),
    missingToTarget: Math.max(0, target - actualCharacters),
  };
}

/**
 * Project text to its whitespace-free form used for coordinate mapping; coordinates in the source projection use UTF-16, just like JS strings.
 * 将文本投影为去空白形式以进行坐标映射；源投影中的坐标使用 UTF-16，与 JS 字符串一致。
 *
 * @param text - Text to project / 要投影的文本
 * @returns Text with all whitespace removed / 去除全部空白后的文本
 */
export function normalizeSelectionProjection(text: string): string {
  return text.replace(/\s/gu, '');
}
