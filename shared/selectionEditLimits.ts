/**
 * Admission limits for ordinary selection editing, counted in CJK-aware editing units.
 * 普通选区编辑的准入上限，按中日韩感知的编辑单位计数。
 */

/**
 * User-visible admission limit for ordinary selection editing.
 * 面向用户的普通选区编辑准入上限。
 *
 * CJK text usually has no whitespace word boundary, so each Han character is
 * counted as one editing unit. Latin and numeric runs remain one word. The
 * model-context check is a separate, request-specific boundary.
 * 中日韩文本通常没有空格词边界，因此每个汉字计为一个编辑单位。
 * 拉丁字母与数字连续段仍算一个词。模型上下文检查是独立的、按请求确定的边界。
 */
export const MAX_SELECTION_EDIT_WORDS = 1_000;

/**
 * Count editing units in a selection, treating each Han character as one unit and each Latin/numeric run as one word.
 * 统计选区中的编辑单位：每个汉字计为一个单位，每段拉丁字母/数字连续段计为一个词。
 *
 * @param value - Selected text to count / 要计数的选中文本
 * @returns Number of editing units / 编辑单位数量
 */
export function countSelectionEditWords(value: string): number {
  return value.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/**
 * Throw when a selection exceeds the ordinary editing limit.
 * 当选区超过普通编辑上限时抛出异常。
 *
 * @param value - Selected text to validate / 要校验的选中文本
 * @throws Error when the editing-unit count exceeds the limit / 编辑单位数超过上限时抛出异常
 */
export function assertSelectionEditWordLimit(value: string): void {
  const count = countSelectionEditWords(value);
  if (count > MAX_SELECTION_EDIT_WORDS) {
    throw new Error(`选中文字不能超过 ${MAX_SELECTION_EDIT_WORDS.toLocaleString('zh-CN')} 词（中文按字计）。`);
  }
}
