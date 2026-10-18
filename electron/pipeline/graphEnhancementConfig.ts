/**
 * Graph enhancement configuration: entity/relation extraction, Leiden community detection,
 * summary budget, global search level, and alias arbitration settings.
 * 图谱增强配置：实体/关系抽取、Leiden 社区检测、摘要预算、全局检索层级与别名仲裁设置。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertExistingDirectory } from '../files/pathGuards.ts';
import { atomicWriteJson } from './pathLayout.ts';
import { DEFAULT_LIBRARY_LEIDEN_CONFIG, normalizeLibraryLeidenConfig } from './libraryGraphStore.ts';
import type { LibraryGraphEnhancementConfig } from './types.ts';

/** Config schema version. / 配置 Schema 版本号。 */
export const GRAPH_ENHANCEMENT_CONFIG_SCHEMA_VERSION = 1;
/** Persisted config file name under `.menghan-meta/config/`. / `.menghan-meta/config/` 下的持久化配置文件名。 */
export const GRAPH_ENHANCEMENT_CONFIG_FILE_NAME = 'graph-enhancement.json';

/** Default summary prompt version; bump invalidates summaries and projection (§5 invalidation chain). / 社区摘要提示词版本默认值；变化只失效摘要及其投影（方案 §5 失效链）。 */
export const DEFAULT_SUMMARY_PROMPT_VERSION = 'graph-summary-v1';
/** Summary context budget: default 8000, minimum 4000 to support small local models (§3.3/§8). / 摘要上下文预算：默认 8000，下限 4000 适配本地小模型（方案 §3.3/§8）。 */
export const DEFAULT_SUMMARY_BUDGET_TOKENS = 8_000;
/** Lower bound for summary budget tokens. / 摘要预算下限。 */
export const SUMMARY_BUDGET_MIN_TOKENS = 4_000;
/** Upper bound for summary budget tokens. / 摘要预算上限。 */
export const SUMMARY_BUDGET_MAX_TOKENS = 32_000;
/** Default global search depth level (§4.2: C1–C3 conclusion, default 1, configurable 0–3). / 全局检索默认层级（方案 §4.2：论文 C1–C3 结论，默认 level=1，可配 0–3）。 */
export const DEFAULT_GLOBAL_SEARCH_LEVEL = 1;
/** Maximum allowed global search level. / 全局检索层级上限。 */
export const GLOBAL_SEARCH_MAX_LEVEL = 3;

/** Graph enhancement defaults: feature off; entity extraction incurs model costs, must be explicitly enabled. / 图谱增强默认关闭：实体抽取会产生模型调用成本，必须显式开启。 */
export const DEFAULT_GRAPH_ENHANCEMENT_CONFIG: LibraryGraphEnhancementConfig = {
  schemaVersion: GRAPH_ENHANCEMENT_CONFIG_SCHEMA_VERSION,
  enabled: false,
  maxChars: 6000,
  maxEntitiesPerChunk: 20,
  maxRelationsPerChunk: 30,
  promptVersion: 'graph-entities-v3',
  llmTimeoutMs: 60_000,
  llmMaxOutputTokens: 4_000,
  leidenConfig: { ...DEFAULT_LIBRARY_LEIDEN_CONFIG },
  summaryPromptVersion: DEFAULT_SUMMARY_PROMPT_VERSION,
  summaryBudgetTokens: DEFAULT_SUMMARY_BUDGET_TOKENS,
  globalSearchLevel: DEFAULT_GLOBAL_SEARCH_LEVEL,
  aliasArbitrationEnabled: false,
};

/**
 * Error thrown when graph enhancement configuration is invalid or cannot be written.
 * 图谱增强配置无效或写入失败时抛出的错误。
 */
export class GraphEnhancementConfigError extends Error {
  readonly code: 'GRAPH_CONFIG_INVALID' | 'GRAPH_CONFIG_WRITE_FAILED';

  constructor(code: GraphEnhancementConfigError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GraphEnhancementConfigError';
    this.code = code;
  }
}

/**
 * Compute the absolute path to the graph-enhancement config file for a library.
 * 计算资料库的图谱增强配置文件绝对路径。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @returns Absolute path to `graph-enhancement.json` / `graph-enhancement.json` 的绝对路径
 */
export function graphEnhancementConfigPath(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta', 'config', GRAPH_ENHANCEMENT_CONFIG_FILE_NAME);
}

/**
 * Read the graph-enhancement config from disk, falling back to defaults when no file exists.
 * 从磁盘读取图谱增强配置，文件不存在时回退到默认值。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @returns Parsed and normalized configuration / 解析并归一化后的配置
 */
export function readLibraryGraphEnhancementConfig(libraryPath: string): LibraryGraphEnhancementConfig {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  const configPath = graphEnhancementConfigPath(normalizedLibraryPath);
  if (fs.existsSync(configPath)) {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    } catch (error) {
      throw new GraphEnhancementConfigError('GRAPH_CONFIG_INVALID', `图谱增强配置文件无法读取：${error instanceof Error ? error.message : String(error)}`, error);
    }
    return normalizeGraphEnhancementConfig(value);
  }
  return { ...DEFAULT_GRAPH_ENHANCEMENT_CONFIG };
}

/**
 * Normalize, validate, and atomically persist a graph-enhancement config value.
 * 归一化、校验并原子写入图谱增强配置。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @param value - Raw JSON value to normalize and persist / 要归一化并持久化的原始 JSON 值
 * @returns The normalized configuration actually persisted / 实际写入的归一化配置
 */
export function saveLibraryGraphEnhancementConfig(libraryPath: string, value: unknown): LibraryGraphEnhancementConfig {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  const config = normalizeGraphEnhancementConfig(value);
  const configPath = graphEnhancementConfigPath(normalizedLibraryPath);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    atomicWriteJson(configPath, config);
  } catch (error) {
    throw new GraphEnhancementConfigError('GRAPH_CONFIG_WRITE_FAILED', `图谱增强配置写入失败：${error instanceof Error ? error.message : String(error)}`, error);
  }
  return config;
}

/**
 * Coerce an unknown JSON value into a valid LibraryGraphEnhancementConfig,
 * bounding every integer field and migrating legacy prompt versions.
 * 将未知 JSON 值强制转换为合法的 LibraryGraphEnhancementConfig，
 * 限制每个整数字段范围并迁移旧版提示词版本。
 *
 * @param value - Raw JSON value; must be a non-array object / 原始 JSON 值；必须是非数组对象
 * @returns Normalized configuration / 归一化后的配置
 */
export function normalizeGraphEnhancementConfig(value: unknown): LibraryGraphEnhancementConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphEnhancementConfigError('GRAPH_CONFIG_INVALID', '图谱增强配置必须是 JSON 对象。');
  }
  const candidate = value as Record<string, unknown>;
  return {
    schemaVersion: GRAPH_ENHANCEMENT_CONFIG_SCHEMA_VERSION,
    enabled: candidate.enabled === true,
    maxChars: boundedInteger(candidate.maxChars, DEFAULT_GRAPH_ENHANCEMENT_CONFIG.maxChars, 200, 20_000),
    maxEntitiesPerChunk: boundedInteger(candidate.maxEntitiesPerChunk, DEFAULT_GRAPH_ENHANCEMENT_CONFIG.maxEntitiesPerChunk, 1, 100),
    maxRelationsPerChunk: boundedInteger(candidate.maxRelationsPerChunk, DEFAULT_GRAPH_ENHANCEMENT_CONFIG.maxRelationsPerChunk, 1, 200),
    promptVersion: normalizedPromptVersion(candidate.promptVersion),
    llmTimeoutMs: boundedInteger(candidate.llmTimeoutMs, DEFAULT_GRAPH_ENHANCEMENT_CONFIG.llmTimeoutMs, 5_000, 600_000),
    llmMaxOutputTokens: boundedInteger(candidate.llmMaxOutputTokens, DEFAULT_GRAPH_ENHANCEMENT_CONFIG.llmMaxOutputTokens, 256, 65_536),
    leidenConfig: normalizeLibraryLeidenConfig(candidate.leidenConfig),
    summaryPromptVersion: normalizedSummaryPromptVersion(candidate.summaryPromptVersion),
    summaryBudgetTokens: boundedInteger(candidate.summaryBudgetTokens, DEFAULT_SUMMARY_BUDGET_TOKENS, SUMMARY_BUDGET_MIN_TOKENS, SUMMARY_BUDGET_MAX_TOKENS),
    globalSearchLevel: boundedInteger(candidate.globalSearchLevel, DEFAULT_GLOBAL_SEARCH_LEVEL, 0, GLOBAL_SEARCH_MAX_LEVEL),
    aliasArbitrationEnabled: candidate.aliasArbitrationEnabled === true,
  };
}

/**
 * Build a cache key covering the extraction-relevant subset of graph enhancement config.
 * leidenConfig and alias arbitration are excluded because they do not affect LLM extraction.
 * 基于图谱增强配置中与抽取相关的子集生成缓存键。
 * leidenConfig 与别名仲裁不影响 LLM 抽取，故排除在外。
 */
export function graphEnhancementConfigHash(config: LibraryGraphEnhancementConfig): string {
  // leidenConfig only affects graph assembly (via graphKey), not entity extraction cache key,
  // so community parameter changes do not trigger a re-run of LLM extraction.
  // leidenConfig 只影响库级图装配（走 graphKey），不纳入实体抽取缓存键，避免社区参数变化重跑 LLM 抽取。
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: config.schemaVersion,
    enabled: config.enabled,
    maxChars: config.maxChars,
    maxEntitiesPerChunk: config.maxEntitiesPerChunk,
    maxRelationsPerChunk: config.maxRelationsPerChunk,
    promptVersion: config.promptVersion,
  })).digest('hex');
}

function normalizedPromptVersion(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_GRAPH_ENHANCEMENT_CONFIG.promptVersion;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !/^[\w.-]+$/u.test(trimmed)) return DEFAULT_GRAPH_ENHANCEMENT_CONFIG.promptVersion;
  // Prompt versions v1 (no evidence contract) and v2 (no strength scale) are migrated to v3.
  // 提示词由 callKind 集中管理：v1 无证据契约，v2 无强度标尺；存量配置统一迁移到 v3。
  if (trimmed === 'graph-entities-v1' || trimmed === 'graph-entities-v2') return 'graph-entities-v3';
  return trimmed;
}

function normalizedSummaryPromptVersion(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SUMMARY_PROMPT_VERSION;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !/^[\w.-]+$/u.test(trimmed)) return DEFAULT_SUMMARY_PROMPT_VERSION;
  return trimmed;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
