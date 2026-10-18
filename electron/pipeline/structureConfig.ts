/**
 * Pipeline structure config: defaults, persistence, normalization and hashing for chunk structuring.
 * 流水线结构配置：结构切块的默认值、持久化、规范化与哈希。
 */

import type { PipelineStructureConfig } from './types.ts';

const storeKey = 'pipelineStructure';

/**
 * Default structure settings used when no stored config exists.
 * 无已存配置时使用的结构默认设置。
 */
export const DEFAULT_PIPELINE_STRUCTURE_CONFIG: PipelineStructureConfig = {
  strategy: 'heading',
  targetChars: 800,
  overlapChars: 120,
  minChars: 160,
  maxChars: 1800,
};

/**
 * Minimal key-value store abstraction used for config persistence.
 * 用于配置持久化的最小键值存储抽象。
 */
export interface ConfigStore {
  /** Reads a raw stored value / 读取原始存储值 */
  get: (key: string) => unknown;
  /** Writes a raw stored value / 写入原始存储值 */
  set: (key: string, value: unknown) => void;
}

/**
 * Reads and normalizes the structure config from a store.
 * 从存储读取并规范化结构配置。
 *
 * @param store - Config store instance / 配置存储实例
 * @returns Normalized structure config / 规范化后的结构配置
 */
export function readPipelineStructureConfig(store: ConfigStore): PipelineStructureConfig {
  return normalizePipelineStructureConfig(store.get(storeKey));
}

/**
 * Merges a patch into the stored structure config and persists the result.
 * 将补丁合并进已存结构配置并持久化结果。
 *
 * @param store - Config store instance / 配置存储实例
 * @param patch - Partial config overrides / 局部配置覆盖项
 * @returns The newly saved normalized config / 新保存的规范化配置
 */
export function savePipelineStructureConfig(store: ConfigStore, patch: Partial<PipelineStructureConfig>): PipelineStructureConfig {
  const next = normalizePipelineStructureConfig({ ...readPipelineStructureConfig(store), ...patch });
  store.set(storeKey, next);
  return next;
}

/**
 * Coerces unknown input into a valid structure config, clamping every numeric field.
 * 将未知输入强制为合法结构配置，并对每个数值字段做夹取。
 *
 * @param value - Raw config value / 原始配置值
 * @returns Normalized structure config / 规范化后的结构配置
 */
export function normalizePipelineStructureConfig(value: unknown): PipelineStructureConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const targetChars = clampInt(record.targetChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.targetChars, 200, 4000);
  const maxChars = clampInt(record.maxChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.maxChars, targetChars, 8000);
  return {
    strategy: record.strategy === 'fixed' ? 'fixed' : DEFAULT_PIPELINE_STRUCTURE_CONFIG.strategy,
    targetChars,
    overlapChars: clampInt(record.overlapChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.overlapChars, 0, Math.max(0, maxChars - 1)),
    minChars: clampInt(record.minChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.minChars, 0, targetChars),
    maxChars,
  };
}

/**
 * Builds the cache-key string for a structure config.
 * 构建结构配置的缓存键字符串。
 *
 * @param config - Structure config to hash / 待哈希的结构配置
 * @returns Versioned config hash / 带版本前缀的配置哈希
 */
export function structureConfigHash(config: PipelineStructureConfig): string {
  const normalized = normalizePipelineStructureConfig(config);
  return `p5-${JSON.stringify(normalized)}`;
}

// Rounds finite numbers and clamps them into [minimum, maximum]; otherwise uses the fallback.
// 对有限数取整并夹取到 [minimum, maximum]；否则使用回退值。
function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
