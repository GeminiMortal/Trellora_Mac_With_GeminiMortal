/**
 * Per-library LLM binding configuration for pipeline stages (stored under .menghan-meta/config).
 * 资料库级流水线语言模型绑定配置（存放于 .menghan-meta/config 下）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_PROVIDER_CATALOG, OLLAMA_SOURCE_ID, readModelHub, resolveGenerationConfig, resolveProviderCredentials } from '../knowledge/ai/modelHub.ts';
import type { AiProviderConfig } from '../knowledge/ai/aiTypes.ts';
import { assertExistingDirectory } from '../files/pathGuards.ts';
import { atomicWriteJson } from './pathLayout.ts';

/**
 * Schema version of the per-library pipeline LLM binding file.
 * 资料库级流水线 LLM 绑定文件的 schema 版本。
 */
export const LIBRARY_PIPELINE_LLM_SCHEMA_VERSION = 1;

/**
 * File name of the per-library pipeline LLM binding config.
 * 资料库级流水线 LLM 绑定配置的文件名。
 */
export const LIBRARY_PIPELINE_LLM_CONFIG_FILE_NAME = 'pipeline-llm.json';

/**
 * Library-level language-model binding: empty source/model means "follow the global generation slot".
 * 资料库级语言模型绑定：source/model 为空表示跟随全局生成槽位。
 *
 * Once bound, it drives LLM calls for ambiguity resolution, smart chunking and graph enhancement (GraphRAG) in this library.
 * 绑定后用于该资料库歧义消解、智能切块与图谱增强（GraphRAG）的 LLM 调用。
 */
export interface LibraryPipelineLlmBinding {
  /** Schema version of the binding record. / 绑定记录的 schema 版本。 */
  schemaVersion: 1;
  /** Provider source id; empty string means unbound. / 模型来源 id；空字符串表示未绑定。 */
  source: string;
  /** Model name; empty string means unbound. / 模型名称；空字符串表示未绑定。 */
  model: string;
}

/**
 * Default binding with empty source/model, i.e. follow the global generation slot.
 * source/model 均为空的默认绑定，即跟随全局生成槽位。
 */
export const DEFAULT_LIBRARY_PIPELINE_LLM_BINDING: LibraryPipelineLlmBinding = {
  schemaVersion: LIBRARY_PIPELINE_LLM_SCHEMA_VERSION,
  source: '',
  model: '',
};

/**
 * Error thrown when the library pipeline LLM binding cannot be read, validated or written.
 * 读取、校验或写入资料库流水线 LLM 绑定失败时抛出的错误。
 */
export class LibraryPipelineLlmConfigError extends Error {
  /** Stable machine-readable error code. / 稳定的机器可读错误码。 */
  readonly code: 'PIPELINE_LLM_CONFIG_INVALID' | 'PIPELINE_LLM_CONFIG_WRITE_FAILED';

  /**
   * Creates a config error with a stable code.
   * 创建带稳定错误码的配置错误。
   *
   * @param code - Machine-readable error code / 机器可读错误码
   * @param message - Human-readable error message / 面向用户的错误信息
   * @param cause - Optional underlying error / 可选的底层错误
   */
  constructor(code: LibraryPipelineLlmConfigError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LibraryPipelineLlmConfigError';
    this.code = code;
  }
}

/**
 * Resolves the absolute path of a library's pipeline LLM binding file.
 * 解析资料库流水线 LLM 绑定文件的绝对路径。
 *
 * @param libraryPath - Library root directory / 资料库根目录
 * @returns Absolute config file path / 配置文件绝对路径
 */
export function libraryPipelineLlmConfigPath(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta', 'config', LIBRARY_PIPELINE_LLM_CONFIG_FILE_NAME);
}

/**
 * Reads the library's pipeline LLM binding, returning the default when no file exists.
 * 读取资料库流水线 LLM 绑定；文件不存在时返回默认绑定。
 *
 * @param libraryPath - Library root directory / 资料库根目录
 * @returns The normalized binding / 归一化后的绑定
 */
export function readLibraryPipelineLlmBinding(libraryPath: string): LibraryPipelineLlmBinding {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  const configPath = libraryPipelineLlmConfigPath(normalizedLibraryPath);
  if (!fs.existsSync(configPath)) return { ...DEFAULT_LIBRARY_PIPELINE_LLM_BINDING };
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new LibraryPipelineLlmConfigError('PIPELINE_LLM_CONFIG_INVALID', `资料库语言模型绑定无法读取：${error instanceof Error ? error.message : String(error)}`, error);
  }
  return normalizeLibraryPipelineLlmBinding(value);
}

/**
 * Merges a patch into the library's pipeline LLM binding and persists it atomically.
 * 将补丁合并进资料库流水线 LLM 绑定并原子化写入磁盘。
 *
 * @param libraryPath - Library root directory / 资料库根目录
 * @param patch - Partial binding fields to merge over the current value / 覆盖合并到当前值的绑定字段补丁
 * @returns The normalized binding after saving / 保存后的归一化绑定
 */
export function saveLibraryPipelineLlmBinding(libraryPath: string, patch: unknown): LibraryPipelineLlmBinding {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  const candidate = (patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>;
  const binding = normalizeLibraryPipelineLlmBinding({ ...readLibraryPipelineLlmBinding(normalizedLibraryPath), ...candidate });
  const configPath = libraryPipelineLlmConfigPath(normalizedLibraryPath);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    atomicWriteJson(configPath, binding);
  } catch (error) {
    throw new LibraryPipelineLlmConfigError('PIPELINE_LLM_CONFIG_WRITE_FAILED', `资料库语言模型绑定写入失败：${error instanceof Error ? error.message : String(error)}`, error);
  }
  return binding;
}

function normalizeLibraryPipelineLlmBinding(value: unknown): LibraryPipelineLlmBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LibraryPipelineLlmConfigError('PIPELINE_LLM_CONFIG_INVALID', '资料库语言模型绑定必须是 JSON 对象。');
  }
  const candidate = value as Record<string, unknown>;
  return {
    schemaVersion: LIBRARY_PIPELINE_LLM_SCHEMA_VERSION,
    source: typeof candidate.source === 'string' ? candidate.source.trim() : '',
    model: typeof candidate.model === 'string' ? candidate.model.trim().slice(0, 120) : '',
  };
}

interface HubReadStore {
  get: (key: string) => unknown;
}

/** Library binding → runtime AiProviderConfig; falls back to the global generation slot when unbound so the pipeline always resolves a config. / 资料库绑定 → 运行时 AiProviderConfig；未绑定时回退全局生成槽位，保证流水线总有解析结果。 */
export function resolveLibraryPipelineLlmConfig(store: HubReadStore, libraryPath: string): AiProviderConfig {
  const binding = readLibraryPipelineLlmBinding(libraryPath);
  const model = binding.model.trim();
  // Unbound (empty source or model) → follow the global generation slot.
  // 未绑定（source 或 model 为空）→ 跟随全局生成槽位。
  if (!model || !binding.source) return resolveGenerationConfig(store);
  if (binding.source === OLLAMA_SOURCE_ID) {
    const hub = readModelHub(store);
    return { kind: 'ollama', endpoint: hub.ollamaEndpoint.trim() || undefined, model };
  }
  const hub = readModelHub(store);
  const credentials = resolveProviderCredentials(store, binding.source);
  const provider = hub.providers.find((entry) => entry.id === binding.source);
  const catalog = MODEL_PROVIDER_CATALOG.find((entry) => entry.id === binding.source);
  // Unknown provider id (neither hub entry nor catalog) → fall back to the global slot.
  // 未知的 provider id（hub 与目录表均无匹配）→ 回退全局生成槽位。
  if (!provider && !catalog) return resolveGenerationConfig(store);
  return {
    kind: 'openai-compatible',
    provider: binding.source,
    api: provider?.api ?? catalog?.api ?? 'openai-completions',
    endpoint: credentials.endpoint || catalog?.endpoint || provider?.endpoint || '',
    apiKey: credentials.apiKey,
    model,
    availableModels: (provider?.models ?? []).map((name) => ({ name })),
    remoteContentConsent: hub.remoteConsent,
  };
}
