/**
 * Selection expansion settings management: reading, writing, normalizing,
 * validating, and resolving capability-based feature flags.
 * 选区扩写设置管理：读取、写入、规范化、校验和基于能力的功能标志解析。
 */
import {
  SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS,
  SELECTION_EXPANSION_MAX_TARGET_CHARACTERS,
  SELECTION_EXPANSION_MIN_TARGET_CHARACTERS,
  selectionExpansionAudiences,
  selectionExpansionCapabilityModes,
  selectionExpansionCitationModes,
  selectionExpansionLengthRatios,
  selectionExpansionReasoningDepths,
  selectionExpansionStyles,
  type SelectionExpansionCapabilities,
  type SelectionExpansionCapabilityMode,
  type SelectionExpansionSettings,
  type SelectionExpansionSettingsPatch,
  type SelectionExpansionSourceSettings,
  type SelectionExpansionTargetLength,
} from './selectionExpansionTypes.ts';

/**
 * Minimal key-value store interface for persisting expansion settings.
 * 用于持久化扩写设置的最小键值存储接口。
 */
interface SettingsStore {
  /** Reads a value by key. / 按键读取值。 */
  get(key: string): unknown;
  /** Writes a value by key. / 按键写入值。 */
  set(key: string, value: unknown): void;
}

/** Storage key for expansion settings in the settings store. / 设置存储中扩写设置的存储键。 */
const settingsStoreKey = 'selectionExpansionSettings';
/** Current schema version for migration and compatibility checks. / 当前架构版本，用于迁移和兼容性检查。 */
export const selectionExpansionSettingsSchemaVersion = 2;

/** Default expansion settings used as the baseline for normalization. / 用作规范化基线的默认扩写设置。 */
export const defaultSelectionExpansionSettings: SelectionExpansionSettings = {
  schemaVersion: selectionExpansionSettingsSchemaVersion,
  targetLength: { mode: 'ratio', ratio: 1.8 },
  style: 'preserve',
  audience: 'preserve',
  reasoningDepth: 'standard',
  sources: {
    currentNote: true,
    noteLibrary: false,
    materialsLibrary: false,
    web: 'off',
    personalization: false,
  },
  citationMode: 'source-cards',
  customInstruction: '',
};

/**
 * Reads expansion settings from the store, normalizes them, and persists
 * the normalized shape if it differs from the raw value (idempotent migration).
 * 从存储中读取扩写设置，规范化它们，如果与原始值不同则持久化规范化结果（幂等迁移）。
 *
 * @param store - Settings store instance / 设置存储实例
 * @returns Normalized expansion settings / 规范化的扩写设置
 */
export function readSelectionExpansionSettings(store: SettingsStore): SelectionExpansionSettings {
  const rawValue = store.get(settingsStoreKey);
  const settings = normalizeSelectionExpansionSettings(rawValue);
  // SE-7: old defaults may predate source switches and schemaVersion. Persist
  // the normalized v2 shape once, so later reads are deterministic and
  // migration is idempotent rather than merely a tolerant display fallback.
  if (rawValue !== undefined && JSON.stringify(rawValue) !== JSON.stringify(settings)) {
    store.set(settingsStoreKey, settings);
  }
  return settings;
}

/**
 * Applies a settings patch, validates against capabilities, and persists the result.
 * 应用设置补丁、校验是否符合能力限制，并持久化结果。
 *
 * @param store - Settings store instance / 设置存储实例
 * @param patch - Partial settings update to apply / 待应用的部分设置更新
 * @param capabilities - Current expansion capability profile / 当前扩写能力配置
 * @returns The saved expansion settings / 已保存的扩写设置
 */
export function saveSelectionExpansionSettings(
  store: SettingsStore,
  patch: unknown,
  capabilities: SelectionExpansionCapabilities,
): SelectionExpansionSettings {
  const current = readSelectionExpansionSettings(store);
  const next = applySelectionExpansionSettingsPatch(current, patch);
  assertSelectionExpansionSettingsSupported(next, capabilities);
  store.set(settingsStoreKey, next);
  return next;
}

/**
 * Tolerant read of legacy values; external save requests always go through strict patch validation.
 * 容错读取旧值；外部保存请求始终走严格 patch 校验。
 */
export function normalizeSelectionExpansionSettings(value: unknown): SelectionExpansionSettings {
  try {
    return applySelectionExpansionSettingsPatch(defaultSelectionExpansionSettings, value ?? {});
  } catch {
    return { ...defaultSelectionExpansionSettings, sources: { ...defaultSelectionExpansionSettings.sources } };
  }
}

/**
 * Resolves the current expansion capability profile based on the environment mode.
 * Supported modes: 'off', 'current-note', 'local-sources', 'full'.
 * 根据环境模式解析当前扩写能力配置。
 * 支持的模式：'off'、'current-note'、'local-sources'、'full'。
 *
 * @param rawMode - Optional mode override from env var / 可选的环境变量模式覆盖
 * @returns Resolved capabilities including source flags and limits / 解析后的能力配置，包括来源标志和限制
 */
export function resolveSelectionExpansionCapabilities(
  rawMode = process.env.MENGHAN_SELECTION_EXPANSION_MODE,
): SelectionExpansionCapabilities {
  const mode: SelectionExpansionCapabilityMode = selectionExpansionCapabilityModes.includes(rawMode as SelectionExpansionCapabilityMode)
    ? rawMode as SelectionExpansionCapabilityMode
    : 'current-note';
  const enabled = mode !== 'off';
  const localSourcesEnabled = mode === 'local-sources' || mode === 'full';
  const se6SourcesEnabled = mode === 'full';
  return {
    mode,
    enabled,
    sources: {
      currentNote: enabled,
      // SE-5：只有显式 local-sources/full 灰度才公开已接入的本地扩展来源。
      noteLibrary: enabled && localSourcesEnabled,
      materialsLibrary: enabled && localSourcesEnabled,
      // SE-6：网页与个性化只能在 full 灰度中逐项显式打开。
      web: enabled && se6SourcesEnabled,
      personalization: enabled && se6SourcesEnabled,
    },
    limits: {
      maxSelectedCharacters: 20_000,
      minTargetCharacters: SELECTION_EXPANSION_MIN_TARGET_CHARACTERS,
      maxTargetCharacters: SELECTION_EXPANSION_MAX_TARGET_CHARACTERS,
      maxCustomInstructionCharacters: SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS,
    },
  };
}

/**
 * Asserts that the given settings are allowed by the current capabilities.
 * Throws a descriptive Chinese error if any source is not enabled.
 * 断言给定设置是否被当前能力允许。如果任何来源未启用，则抛出描述性中文错误。
 *
 * @param settings - Settings to validate / 待校验的设置
 * @param capabilities - Current capability profile / 当前能力配置
 */
export function assertSelectionExpansionSettingsSupported(
  settings: SelectionExpansionSettings,
  capabilities: SelectionExpansionCapabilities,
): void {
  if (!capabilities.enabled) throw new Error('选区扩写优化尚未启用。');
  if (settings.sources.currentNote && !capabilities.sources.currentNote) throw new Error('当前笔记证据来源尚未启用。');
  if (settings.sources.noteLibrary && !capabilities.sources.noteLibrary) throw new Error('同库 Markdown 证据来源尚未启用。');
  if (settings.sources.materialsLibrary && !capabilities.sources.materialsLibrary) throw new Error('资料库证据来源尚未启用。');
  if (settings.sources.web !== 'off' && !capabilities.sources.web) throw new Error('联网证据来源尚未启用。');
  if (settings.sources.personalization && !capabilities.sources.personalization) throw new Error('个性化用词来源尚未启用。');
  if (!settings.sources.currentNote && !settings.sources.noteLibrary && !settings.sources.materialsLibrary) {
    throw new Error('至少需要启用一个本地证据来源。');
  }
}

/**
 * Used by the main process to validate a task draft; does not write default settings.
 * 主进程用于验证一次任务草稿；不会写入默认设置。
 *
 * @param value - Raw settings value to validate / 待校验的原始设置值
 * @param capabilities - Current capability profile / 当前能力配置
 * @returns Validated expansion settings / 已校验的扩写设置
 */
export function validateSelectionExpansionSettings(
  value: unknown,
  capabilities: SelectionExpansionCapabilities,
): SelectionExpansionSettings {
  const settings = applySelectionExpansionSettingsPatch(defaultSelectionExpansionSettings, value);
  assertSelectionExpansionSettingsSupported(settings, capabilities);
  return settings;
}

/**
 * Applies a partial patch to the current settings with full validation.
 * Rejects unknown keys and invalid enum values.
 * 将部分补丁应用到当前设置并进行完整校验。拒绝未知键和无效枚举值。
 */
function applySelectionExpansionSettingsPatch(
  current: SelectionExpansionSettings,
  value: unknown,
): SelectionExpansionSettings {
  if (!isRecord(value)) throw new Error('扩写设置格式无效。');
  const allowedKeys = new Set([
    'schemaVersion',
    'targetLength',
    'style',
    'audience',
    'reasoningDepth',
    'modelProfileId',
    'sources',
    'citationMode',
    'customInstruction',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`扩写设置包含不支持的字段：${key}。`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== selectionExpansionSettingsSchemaVersion) {
    throw new Error('扩写设置版本不兼容。');
  }
  const patch = value as SelectionExpansionSettingsPatch;
  const modelProfileId = patch.modelProfileId === undefined
    ? current.modelProfileId
    : patch.modelProfileId === null
      ? undefined
      : readBoundedString(patch.modelProfileId, '模型档案标识', 160);
  return {
    schemaVersion: selectionExpansionSettingsSchemaVersion,
    targetLength: patch.targetLength === undefined ? current.targetLength : parseTargetLength(patch.targetLength),
    style: patch.style === undefined ? current.style : readEnum(patch.style, selectionExpansionStyles, '写作风格'),
    audience: patch.audience === undefined ? current.audience : readEnum(patch.audience, selectionExpansionAudiences, '目标读者'),
    reasoningDepth: patch.reasoningDepth === undefined ? current.reasoningDepth : readEnum(patch.reasoningDepth, selectionExpansionReasoningDepths, '思考强度'),
    ...(modelProfileId ? { modelProfileId } : {}),
    sources: patch.sources === undefined ? { ...current.sources } : parseSources(current.sources, patch.sources),
    citationMode: patch.citationMode === undefined ? current.citationMode : readEnum(patch.citationMode, selectionExpansionCitationModes, '引用展示'),
    customInstruction: patch.customInstruction === undefined
      ? current.customInstruction
      : readBoundedString(patch.customInstruction, '自定义要求', SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS),
  };
}

/**
 * Parses and validates a target length value (ratio or character count).
 * 解析并校验目标长度值（比例或字符数）。
 */
function parseTargetLength(value: unknown): SelectionExpansionTargetLength {
  if (!isRecord(value)) throw new Error('目标长度格式无效。');
  if (value.mode === 'ratio') {
    if (!selectionExpansionLengthRatios.includes(value.ratio as typeof selectionExpansionLengthRatios[number])) {
      throw new Error('目标长度比例无效。');
    }
    return { mode: 'ratio', ratio: value.ratio as typeof selectionExpansionLengthRatios[number] };
  }
  if (value.mode === 'characters') {
    if (typeof value.characters !== 'number' || !Number.isInteger(value.characters)
      || value.characters < SELECTION_EXPANSION_MIN_TARGET_CHARACTERS
      || value.characters > SELECTION_EXPANSION_MAX_TARGET_CHARACTERS) {
      throw new Error(`自定义目标字符数必须在 ${SELECTION_EXPANSION_MIN_TARGET_CHARACTERS} 到 ${SELECTION_EXPANSION_MAX_TARGET_CHARACTERS} 之间。`);
    }
    return { mode: 'characters', characters: value.characters };
  }
  throw new Error('目标长度模式无效。');
}

/**
 * Parses and validates source settings, merging with current values for unset fields.
 * 解析并校验来源设置，对未设置的字段与当前值合并。
 */
function parseSources(current: SelectionExpansionSourceSettings, value: unknown): SelectionExpansionSourceSettings {
  if (!isRecord(value)) throw new Error('证据范围格式无效。');
  const allowedKeys = new Set(['currentNote', 'noteLibrary', 'materialsLibrary', 'web', 'personalization']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`证据范围包含不支持的字段：${key}。`);
  }
  const readBoolean = (key: keyof Pick<SelectionExpansionSourceSettings, 'currentNote' | 'noteLibrary' | 'materialsLibrary' | 'personalization'>) => {
    const next = value[key];
    if (next === undefined) return current[key];
    if (typeof next !== 'boolean') throw new Error(`证据范围“${key}”必须为布尔值。`);
    return next;
  };
  const web = value.web === undefined ? current.web : readEnum(value.web, ['off', 'inherit', 'on'] as const, '联网范围');
  const personalization = value.personalization === undefined ? current.personalization : readBoolean('personalization');
  return {
    currentNote: readBoolean('currentNote'),
    noteLibrary: readBoolean('noteLibrary'),
    materialsLibrary: readBoolean('materialsLibrary'),
    web,
    personalization,
  };
}

/**
 * Validates that a value is a string matching one of the allowed enum values.
 * 校验值是否为匹配允许枚举值之一的字符串。
 */
function readEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label}无效。`);
  return value as T[number];
}

/**
 * Validates that a value is a trimmed string within the specified length bound.
 * 校验值是否为修剪后不超过指定长度的字符串。
 */
function readBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return normalized;
}

/**
 * Checks whether a value is a non-null, non-array object.
 * 检查值是否为非空、非数组的对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
