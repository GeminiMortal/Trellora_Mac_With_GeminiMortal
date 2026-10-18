/**
 * Chunking configuration: per-library v2 chunking config persistence, normalization with
 * strict/lenient validation, legacy migration, and cache-key hashing.
 * 切块配置：资料库级 v2 切块配置持久化、严格/宽松归一化校验、旧版迁移与缓存键哈希。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertExistingDirectory } from '../files/pathGuards.ts';
import { atomicWriteJson } from './pathLayout.ts';
import { normalizePipelineStructureConfig, type ConfigStore } from './structureConfig.ts';
import type {
  ChunkStrategyCode,
  ChunkingMode,
  LibraryChunkingConfig,
} from './types.ts';

/**
 * Schema version of the chunking v2 config format.
 * 切块 v2 配置格式的 schema 版本号。
 */
export const CHUNKING_CONFIG_SCHEMA_VERSION = 2;

/**
 * File name used to persist the library chunking config under `.menghan-meta/config/`.
 * 在 `.menghan-meta/config/` 下持久化资料库切块配置的文件名。
 */
export const CHUNKING_CONFIG_FILE_NAME = 'chunking-v2.json';

/**
 * Engine version included in the chunking config hash for cache invalidation.
 * 包含在切块配置哈希中用于缓存失效的引擎版本。
 */
export const CHUNKING_CONFIG_ENGINE_VERSION = 'chunking-v2-config-1';

/**
 * The phase-5 development default exposes the v2 Parent/Child pipeline. Set
 * MENGHAN_PIPELINE_CHUNKING_V2=0 to immediately return to the legacy path;
 * an explicit 1 remains supported for controlled rollout environments.
 */
/**
 * Whether the phase-5 v2 Parent/Child chunking pipeline is enabled.
 * Set `MENGHAN_PIPELINE_CHUNKING_V2=0` to immediately return to the legacy path;
 * an explicit `1` remains supported for controlled rollout environments.
 * 第 5 阶段 v2 Parent/Child 切块流水线是否启用。
 * 设置 `MENGHAN_PIPELINE_CHUNKING_V2=0` 可立即回退到旧路径；显式 `1` 仍可用于受控灰度环境。
 *
 * @returns True when v2 chunking is active / v2 切块处于启用状态时返回 true
 */
export function pipelineChunkingV2Enabled(): boolean {
  return process.env.MENGHAN_PIPELINE_CHUNKING_V2 !== '0';
}

/**
 * Recommended default chunking config for new libraries: STRUCTURE + RECURSIVE parent strategies,
 * 2400-char target, LLM disabled, semantic thresholds at defaults.
 * 新资料库的推荐默认切块配置：STRUCTURE + RECURSIVE 父策略，目标 2400 字符，LLM 关闭，语义阈值为默认值。
 */
export const DEFAULT_RECOMMENDED_CHUNKING_CONFIG: LibraryChunkingConfig = {
  schemaVersion: CHUNKING_CONFIG_SCHEMA_VERSION,
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
 * Typed error for chunking config validation and persistence failures.
 * 切块配置校验与持久化失败的类型化错误。
 */
export class ChunkingConfigError extends Error {
  readonly code: 'CHUNK_CONFIG_INVALID' | 'CHUNK_CONFIG_WRITE_FAILED';

  constructor(code: ChunkingConfigError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ChunkingConfigError';
    this.code = code;
  }
}

/**
 * Return the absolute path to the library chunking config file.
 * 返回资料库切块配置文件的绝对路径。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @returns Absolute config file path / 配置文件绝对路径
 */
export function chunkingConfigPath(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta', 'config', CHUNKING_CONFIG_FILE_NAME);
}

/**
 * Read the library chunking config from disk, migrating from legacy store if present.
 * 从磁盘读取资料库切块配置，如存在旧版存储则自动迁移。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @param legacyStore - Optional legacy Electron Store for migration / 可选的旧版 Electron Store，用于迁移
 * @returns Normalized library chunking config / 归一化的资料库切块配置
 */
export function readLibraryChunkingConfig(libraryPath: string, legacyStore?: ConfigStore): LibraryChunkingConfig {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  const configPath = chunkingConfigPath(normalizedLibraryPath);
  if (fs.existsSync(configPath)) {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    } catch (error) {
      throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', `切块配置文件无法读取：${error instanceof Error ? error.message : String(error)}`, error);
    }
    return normalizeLibraryChunkingConfig(value);
  }

  const legacyValue = legacyStore?.get('pipelineStructure');
  if (legacyValue !== undefined && legacyValue !== null) {
    const migrated = migratePipelineStructureConfig(legacyValue);
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      atomicWriteJson(configPath, migrated);
    } catch (error) {
      throw new ChunkingConfigError('CHUNK_CONFIG_WRITE_FAILED', `旧切块配置迁移写入失败：${error instanceof Error ? error.message : String(error)}`, error);
    }
    return migrated;
  }

  return cloneConfig(DEFAULT_RECOMMENDED_CHUNKING_CONFIG);
}

/**
 * Merge a partial patch into the library chunking config, validate, and persist to disk.
 * 将局部补丁合并进资料库切块配置，校验后持久化到磁盘。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @param patch - Partial config object to merge / 要合并的局部配置对象
 * @param legacyStore - Optional legacy Electron Store for migration / 可选的旧版 Electron Store，用于迁移
 * @returns The normalized configuration actually persisted / 实际写入的归一化配置
 */
export function saveLibraryChunkingConfig(libraryPath: string, patch: unknown, legacyStore?: ConfigStore): LibraryChunkingConfig {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  if (!isRecord(patch) || Array.isArray(patch)) {
    throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', '切块配置必须是 JSON 对象。');
  }
  validatePatchShape(patch);
  const current = readLibraryChunkingConfig(normalizedLibraryPath, legacyStore);
  const next = normalizeLibraryChunkingConfig({ ...current, ...patch }, true);
  const configPath = chunkingConfigPath(normalizedLibraryPath);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    atomicWriteJson(configPath, next);
  } catch (error) {
    throw new ChunkingConfigError('CHUNK_CONFIG_WRITE_FAILED', `切块配置写入失败：${error instanceof Error ? error.message : String(error)}`, error);
  }
  return next;
}

/**
 * Coerce an unknown value into a valid LibraryChunkingConfig, clamping numeric fields
 * and validating strategy arrays. In strict mode, invalid fields throw; in lenient mode,
 * they fall back to defaults.
 * 将未知值强制转换为合法的 LibraryChunkingConfig，夹取数值字段并校验策略数组。
 * 严格模式下无效字段抛异常；宽松模式下回退到默认值。
 *
 * @param value - Raw stored value, may be null or malformed / 原始存储值，可能为 null 或格式错误
 * @param strict - When true, throw on invalid fields; when false, use defaults / 为 true 时无效字段抛异常；为 false 时使用默认值
 * @returns Normalized library chunking config / 归一化的资料库切块配置
 */
export function normalizeLibraryChunkingConfig(value: unknown, strict = false): LibraryChunkingConfig {
  const record = isRecord(value) ? value : {};
  const mode = normalizeMode(record.mode, strict);
  const parentStrategies = normalizeStrategies(record.parentStrategies, ['STRUCTURE', 'RECURSIVE'], strict, 'Parent');
  const childStrategies = normalizeStrategies(record.childStrategies, [], strict, 'Child');
  const parentMinChars = numberValue(record.parentMinChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.parentMinChars, 0, 200_000, strict, 'parentMinChars');
  const parentTargetChars = numberValue(record.parentTargetChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.parentTargetChars, 1, 200_000, strict, 'parentTargetChars');
  const parentMaxChars = numberValue(record.parentMaxChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.parentMaxChars, 1, 200_000, strict, 'parentMaxChars');
  const parentOverlapChars = numberValue(record.parentOverlapChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.parentOverlapChars, 0, 200_000, strict, 'parentOverlapChars');
  const childRecursiveMaxChars = numberValue(record.childRecursiveMaxChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.childRecursiveMaxChars, 1, 200_000, strict, 'childRecursiveMaxChars');
  const childRecursiveOverlapChars = numberValue(record.childRecursiveOverlapChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.childRecursiveOverlapChars, 0, 200_000, strict, 'childRecursiveOverlapChars');
  const semanticMaxChars = numberValue(record.semanticMaxChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.semanticMaxChars, 1, 200_000, strict, 'semanticMaxChars');
  const semanticMinChars = numberValue(record.semanticMinChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.semanticMinChars, 0, 200_000, strict, 'semanticMinChars');
  const semanticSimilarityThreshold = numberValue(record.semanticSimilarityThreshold, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.semanticSimilarityThreshold, 0, 1, strict, 'semanticSimilarityThreshold', false);
  const llmMaxChars = numberValue(record.llmMaxChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.llmMaxChars, 1, 200_000, strict, 'llmMaxChars');
  const llmTimeoutMs = numberValue(record.llmTimeoutMs, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.llmTimeoutMs, 1_000, 300_000, strict, 'llmTimeoutMs');
  const llmMaxOutputTokens = numberValue(record.llmMaxOutputTokens, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.llmMaxOutputTokens, 1, 65_536, strict, 'llmMaxOutputTokens');
  const pageMinMetadataCoverage = numberValue(record.pageMinMetadataCoverage, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.pageMinMetadataCoverage, 0, 1, strict, 'pageMinMetadataCoverage', false);
  const childFixedTargetChars = numberValue(record.childFixedTargetChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.childFixedTargetChars, 1, 200_000, strict, 'childFixedTargetChars');
  const childFixedMinChars = numberValue(record.childFixedMinChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.childFixedMinChars, 0, 200_000, strict, 'childFixedMinChars');
  const childFixedMaxChars = numberValue(record.childFixedMaxChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.childFixedMaxChars, 1, 200_000, strict, 'childFixedMaxChars');
  const childFixedOverlapChars = numberValue(record.childFixedOverlapChars, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.childFixedOverlapChars, 0, 200_000, strict, 'childFixedOverlapChars');
  const regexPattern = stringValue(record.regexPattern, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.regexPattern, strict, 'regexPattern');
  const regexFlags = normalizeFlags(record.regexFlags, strict);
  const regexBoundary = record.regexBoundary === 'after' || record.regexBoundary === 'before'
    ? record.regexBoundary
    : record.regexBoundary === undefined ? 'before' : strict ? invalid('regexBoundary', '必须是 before 或 after') : 'before';
  const llmPromptVersion = stringValue(record.llmPromptVersion, DEFAULT_RECOMMENDED_CHUNKING_CONFIG.llmPromptVersion, strict, 'llmPromptVersion');

  const next: LibraryChunkingConfig = {
    schemaVersion: CHUNKING_CONFIG_SCHEMA_VERSION,
    mode,
    parentStrategies,
    childStrategies,
    parentMinChars,
    parentTargetChars,
    parentMaxChars,
    parentOverlapChars,
    childRecursiveMaxChars,
    childRecursiveOverlapChars,
    semanticMaxChars,
    semanticMinChars,
    semanticSimilarityThreshold,
    llmEnabled: booleanValue(record.llmEnabled, false, strict, 'llmEnabled'),
    llmMaxChars,
    llmTimeoutMs,
    llmMaxOutputTokens,
    llmPromptVersion,
    recommendLlmWhenLowQuality: booleanValue(record.recommendLlmWhenLowQuality, true, strict, 'recommendLlmWhenLowQuality'),
    pageMinMetadataCoverage,
    regexPattern,
    regexFlags,
    regexBoundary,
    regexKeepDelimiter: booleanValue(record.regexKeepDelimiter, true, strict, 'regexKeepDelimiter'),
    childFixedTargetChars,
    childFixedMinChars,
    childFixedMaxChars,
    childFixedOverlapChars,
    ...(isMigration(record.migration) ? { migration: record.migration } : {}),
  };

  validateRelationships(next, strict);
  return next;
}

/**
 * Build a stable hash covering the chunking config, schema version, and engine version.
 * 生成覆盖切块配置、schema 版本和引擎版本的稳定哈希。
 *
 * @param config - Library chunking config / 资料库切块配置
 * @returns Prefixed hex hash string ('v2-...') / 带前缀的十六进制哈希字符串（'v2-...'）
 */
export function chunkingConfigHash(config: LibraryChunkingConfig): string {
  const normalized = normalizeLibraryChunkingConfig(config);
  const hashInput = {
    schemaVersion: CHUNKING_CONFIG_SCHEMA_VERSION,
    engineVersion: CHUNKING_CONFIG_ENGINE_VERSION,
    ...withoutMigration(normalized),
  };
  return `v2-${crypto.createHash('sha256').update(stableStringify(hashInput)).digest('hex')}`;
}

function migratePipelineStructureConfig(value: unknown): LibraryChunkingConfig {
  const old = normalizePipelineStructureConfig(value);
  const maxOverlap = Math.max(0, old.maxChars - 1);
  const migrated = normalizeLibraryChunkingConfig({
    ...DEFAULT_RECOMMENDED_CHUNKING_CONFIG,
    mode: 'custom',
    parentStrategies: old.strategy === 'heading' ? ['STRUCTURE', 'RECURSIVE'] : ['FIXED', 'RECURSIVE'],
    childStrategies: old.strategy === 'heading' ? ['RECURSIVE'] : ['FIXED', 'RECURSIVE'],
    parentMinChars: Math.min(1200, old.targetChars, old.maxChars),
    parentTargetChars: old.targetChars,
    parentMaxChars: old.maxChars,
    parentOverlapChars: Math.min(old.overlapChars, maxOverlap),
    childRecursiveMaxChars: old.maxChars,
    childRecursiveOverlapChars: Math.min(old.overlapChars, maxOverlap),
    childFixedTargetChars: old.targetChars,
    childFixedMinChars: old.minChars,
    childFixedMaxChars: old.maxChars,
    childFixedOverlapChars: Math.min(old.overlapChars, maxOverlap),
    migration: { source: 'pipelineStructure-v1', migratedAt: new Date().toISOString() },
  });
  return migrated;
}

function validatePatchShape(patch: Record<string, unknown>): void {
  if (patch.schemaVersion !== undefined && patch.schemaVersion !== 2) invalid('schemaVersion', '只支持 schemaVersion=2');
  if (patch.mode !== undefined && patch.mode !== 'recommended' && patch.mode !== 'custom') invalid('mode', '必须是 recommended 或 custom');
  for (const key of numericFields) {
    if (patch[key] !== undefined && (typeof patch[key] !== 'number' || !Number.isFinite(patch[key]))) invalid(key, '必须是有限数字');
  }
  for (const key of strategyFields) {
    if (patch[key] !== undefined && !Array.isArray(patch[key])) invalid(key, '必须是策略数组');
    for (const code of (Array.isArray(patch[key]) ? patch[key] : [])) {
      if (typeof code !== 'string' || !isKnownStrategy(code)) invalid(key, `包含未知策略：${String(code)}`);
    }
  }
  if (patch.regexPattern !== undefined && typeof patch.regexPattern !== 'string') invalid('regexPattern', '必须是文本');
  if (typeof patch.regexPattern === 'string' && patch.regexPattern.length > 256) invalid('regexPattern', '长度不能超过 256');
  if (patch.regexFlags !== undefined && !Array.isArray(patch.regexFlags)) invalid('regexFlags', '必须是数组');
  if (Array.isArray(patch.regexFlags) && patch.regexFlags.some((flag) => flag !== 'i' && flag !== 'm')) invalid('regexFlags', '只支持 i、m');
  for (const key of ['llmEnabled', 'recommendLlmWhenLowQuality', 'regexKeepDelimiter'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') invalid(key, '必须是布尔值');
  }
  for (const key of ['llmPromptVersion'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'string') invalid(key, '必须是文本');
  }
}

function validateRelationships(config: LibraryChunkingConfig, strict: boolean): void {
  const fail = (message: string) => {
    if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', message);
  };
  if (config.parentMinChars > config.parentTargetChars || config.parentTargetChars > config.parentMaxChars) {
    if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', 'Parent 长度必须满足 min ≤ target ≤ max。');
    config.parentTargetChars = Math.max(config.parentMinChars, config.parentTargetChars);
    config.parentMaxChars = Math.max(config.parentTargetChars, config.parentMaxChars);
  }
  if (config.parentOverlapChars >= config.parentMaxChars) strict ? fail('Parent overlap 必须小于 parentMaxChars。') : config.parentOverlapChars = Math.max(0, config.parentMaxChars - 1);
  if (config.childRecursiveOverlapChars >= config.childRecursiveMaxChars) strict ? fail('Child Recursive overlap 必须小于 childRecursiveMaxChars。') : config.childRecursiveOverlapChars = Math.max(0, config.childRecursiveMaxChars - 1);
  if (config.childFixedMinChars > config.childFixedTargetChars || config.childFixedTargetChars > config.childFixedMaxChars) {
    if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', 'Child Fixed 长度必须满足 min ≤ target ≤ max。');
    config.childFixedTargetChars = Math.max(config.childFixedMinChars, config.childFixedTargetChars);
    config.childFixedMaxChars = Math.max(config.childFixedTargetChars, config.childFixedMaxChars);
  }
  if (config.childFixedOverlapChars >= config.childFixedMaxChars) strict ? fail('Child Fixed overlap 必须小于 childFixedMaxChars。') : config.childFixedOverlapChars = Math.max(0, config.childFixedMaxChars - 1);
  if (config.mode === 'custom' && (config.parentStrategies.length === 0 || config.childStrategies.length === 0)) {
    if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', '自定义模式必须至少选择一个 Parent 和 Child 策略。');
    config.mode = 'recommended';
    config.parentStrategies = [...DEFAULT_RECOMMENDED_CHUNKING_CONFIG.parentStrategies];
    config.childStrategies = [...DEFAULT_RECOMMENDED_CHUNKING_CONFIG.childStrategies];
  }
  if (config.parentStrategies.filter((code) => code === 'STRUCTURE').length > 1 || (config.parentStrategies.includes('STRUCTURE') && config.parentStrategies[0] !== 'STRUCTURE')) {
    if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', 'Parent STRUCTURE 只能出现一次且必须是第一步。');
    config.parentStrategies = ['STRUCTURE', ...config.parentStrategies.filter((code) => code !== 'STRUCTURE')];
  }
  if (config.childStrategies.includes('STRUCTURE') && config.childStrategies.length !== 1) {
    if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', 'Child STRUCTURE 必须是唯一策略。');
    config.childStrategies = config.childStrategies.filter((code) => code !== 'STRUCTURE');
  }
  if (config.mode === 'custom' && config.childStrategies.includes('LLM') && !config.llmEnabled) {
    if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', '自定义 Child 使用 LLM 时必须先启用 llmEnabled。');
  }
  if (config.parentStrategies.includes('REGEX') || config.childStrategies.includes('REGEX')) {
    if (!config.regexPattern) {
      if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', '选择 REGEX 时必须填写正则表达式。');
    } else {
      try {
        // JS does not expose a regex timeout. Restrict the phase-1 contract to
        // compilable expressions and reject common backreference/lookaround forms.
        if (/\\[1-9]|\(\?<|\(\?>/.test(config.regexPattern)) throw new Error('包含不支持的回溯或前瞻语法');
        new RegExp(config.regexPattern, config.regexFlags.join(''));
      } catch (error) {
        if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', `正则表达式无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

const numericFields = [
  'parentMinChars', 'parentTargetChars', 'parentMaxChars', 'parentOverlapChars',
  'childRecursiveMaxChars', 'childRecursiveOverlapChars', 'semanticMaxChars',
  'semanticMinChars', 'semanticSimilarityThreshold', 'llmMaxChars', 'llmTimeoutMs',
  'llmMaxOutputTokens', 'pageMinMetadataCoverage', 'childFixedTargetChars',
  'childFixedMinChars', 'childFixedMaxChars', 'childFixedOverlapChars',
] as const;
const strategyFields = ['parentStrategies', 'childStrategies'] as const;

function normalizeMode(value: unknown, strict: boolean): ChunkingMode {
  if (value === undefined) return DEFAULT_RECOMMENDED_CHUNKING_CONFIG.mode;
  if (value === 'recommended' || value === 'custom') return value;
  return strict ? invalid('mode', '必须是 recommended 或 custom') : DEFAULT_RECOMMENDED_CHUNKING_CONFIG.mode;
}

function normalizeStrategies<T extends ChunkStrategyCode>(value: unknown, fallback: T[], strict: boolean, label: string): T[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) return strict ? invalid(`${label}Strategies`, '必须是策略数组') : [...fallback];
  const result: T[] = [];
  for (const code of value) {
    if (!isKnownStrategy(code)) {
      if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', `${label}策略包含未知 code：${String(code)}`);
      continue;
    }
    if (label === 'Parent' && code === 'SEMANTIC' || label === 'Parent' && code === 'LLM') {
      if (strict) throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', `Parent 不支持 ${code} 策略。`);
      continue;
    }
    if (!result.includes(code as T)) result.push(code as T);
  }
  return result;
}

function normalizeFlags(value: unknown, strict: boolean): Array<'i' | 'm'> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return strict ? invalid('regexFlags', '必须是数组') : [];
  const result: Array<'i' | 'm'> = [];
  for (const flag of value) {
    if (flag !== 'i' && flag !== 'm') {
      if (strict) return invalid('regexFlags', '只支持 i、m');
      continue;
    }
    if (!result.includes(flag)) result.push(flag);
  }
  return result;
}

function numberValue(value: unknown, fallback: number, min: number, max: number, strict: boolean, field: string, integer = true): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return strict ? invalid(field, '必须是有限数字') : fallback;
  if (integer && !Number.isInteger(value)) return strict ? invalid(field, '必须是整数') : Math.round(Math.min(max, Math.max(min, value)));
  if (value < min || value > max) return strict ? invalid(field, `必须介于 ${min} 和 ${max} 之间`) : Math.min(max, Math.max(min, value));
  return value;
}

function stringValue(value: unknown, fallback: string, strict: boolean, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return strict ? invalid(field, '必须是文本') : fallback;
  return value;
}

function booleanValue(value: unknown, fallback: boolean, strict: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') return strict ? invalid(field, '必须是布尔值') : fallback;
  return value;
}

function invalid(field: string, message: string): never {
  throw new ChunkingConfigError('CHUNK_CONFIG_INVALID', `切块配置 ${field} 无效：${message}`);
}

function isKnownStrategy(value: unknown): value is ChunkStrategyCode {
  return value === 'STRUCTURE' || value === 'RECURSIVE' || value === 'SEMANTIC' || value === 'LLM' || value === 'PAGE' || value === 'REGEX' || value === 'FIXED';
}

function isMigration(value: unknown): value is NonNullable<LibraryChunkingConfig['migration']> {
  return isRecord(value) && value.source === 'pipelineStructure-v1' && typeof value.migratedAt === 'string' && Boolean(value.migratedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneConfig(config: LibraryChunkingConfig): LibraryChunkingConfig {
  return JSON.parse(JSON.stringify(config)) as LibraryChunkingConfig;
}

function withoutMigration(config: LibraryChunkingConfig): Omit<LibraryChunkingConfig, 'migration'> {
  const { migration: _migration, ...rest } = config;
  return rest;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
