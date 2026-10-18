/**
 * Ambiguity-resolution pipeline configuration: defaults, persisted store read/write,
 * value normalization with safe clamping, and cache-key hashing.
 * 歧义消解流水线配置：默认值、持久化存储读写、带安全夹取的取值归一化，以及缓存键哈希。
 */
import crypto from 'node:crypto';
import type { PipelineAmbiguityConfig } from './types.ts';

const storeKey = 'pipelineAmbiguity';

/**
 * Default ambiguity settings: feature off, confidence band 0.35–0.85,
 * up to 8 candidates per batch, and prompt revision 'p4-ambiguity-2'.
 * 歧义消解默认设置：功能关闭、置信度区间 0.35–0.85、每批最多 8 个候选，提示词版本 'p4-ambiguity-2'。
 */
export const DEFAULT_PIPELINE_AMBIGUITY_CONFIG: PipelineAmbiguityConfig = {
  enabled: false,
  minConfidence: 0.35,
  maxConfidence: 0.85,
  maxCandidatesPerBatch: 8,
  maxInputCharacters: 8_000,
  timeoutMs: 30_000,
  maxOutputTokens: 256,
  promptVersion: 'p4-ambiguity-2',
};

interface ConfigStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

/**
 * Read the persisted ambiguity configuration and normalize it to a safe shape.
 * 读取已持久化的歧义消解配置，并归一化为安全结构。
 *
 * @param store - Key/value config store (Electron Store style) / 键值配置存储（Electron Store 风格）
 * @returns Normalized ambiguity configuration / 归一化后的歧义消解配置
 */
export function readPipelineAmbiguityConfig(store: ConfigStore): PipelineAmbiguityConfig {
  const value = store.get(storeKey);
  return normalizePipelineAmbiguityConfig(value);
}

/**
 * Merge a partial patch into the stored ambiguity config, normalize and persist it.
 * 将局部补丁合并进已存储的歧义消解配置，归一化后写回持久化存储。
 *
 * @param store - Key/value config store / 键值配置存储
 * @param patch - Partial settings to merge; non-object values are ignored / 要合并的局部设置；非对象值会被忽略
 * @returns The normalized configuration actually persisted / 实际写入的归一化配置
 */
export function savePipelineAmbiguityConfig(store: ConfigStore, patch: Partial<PipelineAmbiguityConfig>): PipelineAmbiguityConfig {
  const next = normalizePipelineAmbiguityConfig({
    ...readPipelineAmbiguityConfig(store),
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  store.set(storeKey, next);
  return next;
}

/**
 * Coerce an unknown stored value into a valid PipelineAmbiguityConfig,
 * clamping every numeric field into its allowed range.
 * 将未知的存储值强制转换为合法的 PipelineAmbiguityConfig，
 * 并把每个数值字段夹取到允许区间。
 *
 * @param value - Raw stored value, may be null or malformed / 原始存储值，可能为 null 或格式错误
 * @returns Normalized configuration with clamped, rounded fields / 字段已夹取并取整的归一化配置
 */
export function normalizePipelineAmbiguityConfig(value: unknown): PipelineAmbiguityConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  // Numbers fall back to defaults and are clamped into bounds before use.
  // 数值回退到默认值并在使用前夹取到边界内。
  const minConfidence = clampNumber(record.minConfidence, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.minConfidence, 0, 1);
  // The max bound always stays at or above minConfidence to keep the band valid.
  // 上界始终保持不小于 minConfidence，以保证置信度区间有效。
  const maxConfidence = clampNumber(record.maxConfidence, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxConfidence, minConfidence, 1);
  const configuredPromptVersion = typeof record.promptVersion === 'string' && record.promptVersion.trim()
    ? record.promptVersion.trim().slice(0, 80)
    : '';
  return {
    enabled: record.enabled === true,
    minConfidence,
    maxConfidence,
    maxCandidatesPerBatch: Math.round(clampNumber(record.maxCandidatesPerBatch, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxCandidatesPerBatch, 1, 50)),
    maxInputCharacters: Math.round(clampNumber(record.maxInputCharacters, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxInputCharacters, 1_000, 20_000)),
    timeoutMs: Math.round(clampNumber(record.timeoutMs, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.timeoutMs, 1_000, 120_000)),
    maxOutputTokens: Math.round(clampNumber(record.maxOutputTokens, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxOutputTokens, 32, 2_000)),
    // Legacy prompt revision 'p4-ambiguity-1' and empty values upgrade to the current default.
    // 旧版提示词版本 'p4-ambiguity-1' 与空值会升级为当前默认版本。
    promptVersion: configuredPromptVersion === 'p4-ambiguity-1' || !configuredPromptVersion
      ? DEFAULT_PIPELINE_AMBIGUITY_CONFIG.promptVersion
      : configuredPromptVersion,
  };
}

/**
 * Build a cache key covering the ambiguity config and the resolved LLM model identity.
 * 基于歧义消解配置与所用 LLM 模型标识生成缓存键。
 *
 * @param config - Ambiguity settings / 歧义消解设置
 * @param model - Provider/model identity including availability and fingerprint / 模型提供方与标识（含可用性与指纹）
 * @returns Hex hash string, or 'disabled' when the feature is off / 十六进制哈希；功能关闭时返回 'disabled'
 */
export function ambiguityConfigHash(config: PipelineAmbiguityConfig, model: { provider: string; model: string; available: boolean; fingerprint?: string }): string {
  if (!config.enabled) return 'disabled';
  return crypto.createHash('sha256').update(JSON.stringify({ config, model })).digest('hex');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
