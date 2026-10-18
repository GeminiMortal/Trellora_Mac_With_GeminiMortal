/**
 * Chunking configuration draft defaults and validation.
 * 切块配置草稿的默认值与校验。
 */
import type { LibraryChunkingConfig } from '../../electron';

/**
 * Per-field validation errors for a chunking draft.
 * 切块草稿的逐字段校验错误。
 */
export type ChunkingDraftFieldErrors = Partial<Record<'parent' | 'parentOverlap' | 'childRecursive' | 'childFixed' | 'strategies' | 'regex' | 'llm', string>>;

/**
 * Recommended starter values for the chunking configuration editor.
 * 切块配置编辑器的推荐初始值。
 */
export const RECOMMENDED_CHUNKING_DRAFT: LibraryChunkingConfig = {
  schemaVersion: 2,
  mode: 'recommended',
  parentStrategies: ['STRUCTURE', 'RECURSIVE'],
  childStrategies: [],
  parentMinChars: 1200,
  parentTargetChars: 2400,
  parentMaxChars: 3500,
  parentOverlapChars: 200,
  childRecursiveMaxChars: 700,
  childRecursiveOverlapChars: 100,
  semanticMaxChars: 700,
  semanticMinChars: 240,
  semanticSimilarityThreshold: 0.18,
  llmEnabled: false,
  llmMaxChars: 3500,
  llmTimeoutMs: 45_000,
  llmMaxOutputTokens: 2_000,
  llmPromptVersion: 'chunk-boundary-v1',
  recommendLlmWhenLowQuality: true,
  pageMinMetadataCoverage: 0.8,
  regexPattern: '',
  regexFlags: [],
  regexBoundary: 'before',
  regexKeepDelimiter: true,
  childFixedTargetChars: 700,
  childFixedMinChars: 160,
  childFixedMaxChars: 900,
  childFixedOverlapChars: 100,
};

/**
 * Deep-clones a chunking config through a JSON round-trip.
 * 通过 JSON 往返深拷贝切块配置。
 *
 * @param config - Config to clone, defaults to the recommended draft / 要拷贝的配置，默认为推荐草稿
 * @returns A deep copy safe to mutate / 可安全修改的深拷贝
 */
export function cloneChunkingDraft(config: LibraryChunkingConfig = RECOMMENDED_CHUNKING_DRAFT): LibraryChunkingConfig {
  return JSON.parse(JSON.stringify(config)) as LibraryChunkingConfig;
}

/**
 * Validates a chunking draft and collects field-level error messages.
 * 校验切块草稿并收集字段级错误信息。
 *
 * @param config - Draft to validate / 待校验的草稿
 * @returns Errors keyed by field, empty when valid / 按字段索引的错误；校验通过时为空
 */
export function validateChunkingDraft(config: LibraryChunkingConfig): ChunkingDraftFieldErrors {
  const errors: ChunkingDraftFieldErrors = {};
  if (config.parentMinChars > config.parentTargetChars || config.parentTargetChars > config.parentMaxChars) {
    errors.parent = '父块长度需满足：最低字数 ≤ 目标字数 ≤ 最大字数。';
  }
  if (config.parentOverlapChars >= config.parentMaxChars) errors.parentOverlap = '父块 overlap 必须小于最大字数。';
  if (config.childRecursiveOverlapChars >= config.childRecursiveMaxChars) errors.childRecursive = '子块 overlap 必须小于子块最大字数。';
  if (config.childFixedMinChars > config.childFixedTargetChars || config.childFixedTargetChars > config.childFixedMaxChars || config.childFixedOverlapChars >= config.childFixedMaxChars) {
    errors.childFixed = '固定长度子块需满足 min ≤ target ≤ max，且 overlap 小于 max。';
  }
  if (config.mode === 'custom' && (!config.parentStrategies.length || !config.childStrategies.length)) errors.strategies = '自定义策略需各选择一个父块与子块策略。';
  if ((config.parentStrategies.includes('REGEX') || config.childStrategies.includes('REGEX')) && !config.regexPattern.trim()) errors.regex = '选择正则切块后，请填写用于识别边界的表达式。';
  if (config.mode === 'custom' && config.childStrategies.includes('LLM') && !config.llmEnabled) errors.llm = '使用 LLM 子块前，需先开启 LLM 智能切块。';
  return errors;
}
