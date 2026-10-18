/**
 * Product authorization for putting an entire current note into a model prompt.
 *
 * This is intentionally independent from a provider's context window. The
 * latter may reject an otherwise eligible note, but it can never promote a
 * large note to direct-full mode.
 * 将整篇当前笔记放入模型提示的产品授权策略。
 * 此策略有意与提供商的上下文窗口无关。后者可能拒绝符合条件的笔记，但绝不会将大笔记提升为 direct-full 模式。
 */
export interface StrictSmallNotePolicy {
  maxCharacters: number;
  maxLines: number;
  maxTokens: number;
  maxContextRatio: number;
}

/** Measured size metrics of the current note. 当前笔记的度量尺寸指标。 */
export interface CurrentNoteSize {
  characters: number;
  lineCount: number;
  tokenEstimate: number;
}

/** Available context capacity reported by the model provider. 模型提供商报告的可用上下文容量。 */
export interface CurrentNoteContextCapacity {
  contextWindowTokens?: number;
  hasOutputAndHistoryReserve: boolean;
}

/** Reason codes for rejecting a note from direct-full mode. 将笔记排除在 direct-full 模式之外的原因代码。 */
export type StrictSmallNoteRejection =
  | 'max-characters'
  | 'max-lines'
  | 'max-tokens'
  | 'context-ratio'
  | 'context-reserve';

/** Decision result from the strict-small-note policy evaluation. 严格小笔记策略评估的决策结果。 */
export interface StrictSmallNoteDecision {
  allowed: boolean;
  rejections: StrictSmallNoteRejection[];
}

/** Default thresholds for the strict-small-note policy. 严格小笔记策略的默认阈值。 */
export const DEFAULT_STRICT_SMALL_NOTE_POLICY: Readonly<StrictSmallNotePolicy> = Object.freeze({
  maxCharacters: 1_200,
  maxLines: 30,
  maxTokens: 1_600,
  maxContextRatio: 0.08,
});

/**
 * Evaluates whether a note qualifies for direct-full injection into the model prompt.
 * 评估笔记是否符合直接注入模型提示的条件。
 *
 * @param note - Measured size of the current note / 当前笔记的度量尺寸
 * @param capacity - Available context capacity from the model provider / 模型提供商的可用上下文容量
 * @param policy - Thresholds to evaluate against; defaults to DEFAULT_STRICT_SMALL_NOTE_POLICY / 评估阈值，默认为 DEFAULT_STRICT_SMALL_NOTE_POLICY
 * @returns Decision with allowed flag and any rejection reasons / 包含允许标志和拒绝原因的决策
 */
export function evaluateStrictSmallNotePolicy(
  note: CurrentNoteSize,
  capacity: CurrentNoteContextCapacity,
  policy: StrictSmallNotePolicy = DEFAULT_STRICT_SMALL_NOTE_POLICY,
): StrictSmallNoteDecision {
  const rejections: StrictSmallNoteRejection[] = [];
  if (note.characters > policy.maxCharacters) rejections.push('max-characters');
  if (note.lineCount > policy.maxLines) rejections.push('max-lines');
  if (note.tokenEstimate > policy.maxTokens) rejections.push('max-tokens');

  // An unknown context window is not an authorization to send the full note.
  if (!capacity.contextWindowTokens || note.tokenEstimate > capacity.contextWindowTokens * policy.maxContextRatio) {
    rejections.push('context-ratio');
  }
  if (!capacity.hasOutputAndHistoryReserve) rejections.push('context-reserve');
  return { allowed: rejections.length === 0, rejections };
}

/**
 * Throws if the note does not satisfy the strict-small-note policy thresholds.
 * 如果笔记不满足严格小笔记策略阈值，则抛出异常。
 *
 * @param note - Measured size of the current note / 当前笔记的度量尺寸
 * @param capacity - Available context capacity from the model provider / 模型提供商的可用上下文容量
 * @param policy - Thresholds to evaluate against; defaults to DEFAULT_STRICT_SMALL_NOTE_POLICY / 评估阈值，默认为 DEFAULT_STRICT_SMALL_NOTE_POLICY
 * @returns void / 无返回值
 */
export function assertStrictSmallNoteAllowed(
  note: CurrentNoteSize,
  capacity: CurrentNoteContextCapacity,
  policy: StrictSmallNotePolicy = DEFAULT_STRICT_SMALL_NOTE_POLICY,
): void {
  const decision = evaluateStrictSmallNotePolicy(note, capacity, policy);
  if (!decision.allowed) {
    throw new Error(`当前笔记不满足全文直读硬门槛：${decision.rejections.join('、')}。`);
  }
}
