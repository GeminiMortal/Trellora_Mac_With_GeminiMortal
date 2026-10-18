/** Application color theme / 应用颜色主题 */
export type AppTheme = 'system' | 'light' | 'dark';
/** UI element spacing density / 界面元素间距密度 */
export type InterfaceDensity = 'comfortable' | 'compact';
/** Startup view behavior / 启动视图行为 */
export type StartupBehavior = 'library' | 'last-note';
/** Preferred editor mode / 首选编辑器模式 */
export type PreferredEditorMode = 'wysiwyg' | 'preview' | 'source';
/** Default note preview rendering mode / 笔记默认预览渲染模式 */
export type PreviewPreference = 'rendered' | 'source';
/** External link open behavior / 外部链接打开行为 */
export type ExternalLinkOpenMode = 'in-app' | 'system-default';
import { normalizeAssistantEvidenceModeConfig, normalizeAssistantKnowledgeAgentMode, type AdaptiveContextMode, type AssistantEvidenceProjectionMode, type AssistantKnowledgeAgentMode, type AssistantPlanMode, type EvidenceCompressionMode } from './knowledge/assistant/assistantMode.ts';
import type { AssistantContextRuntimeMode } from './knowledge/context/contextRuntimeTypes.ts';
import type { MemoryProjectionMode, MemoryProjectionRouteMode } from './knowledge/memory/memoryCutover.ts';
import { ASSISTANT_RELEASE_DEFAULTS } from '../shared/assistantReleaseDefaults.ts';
import { NOTE_BACKUP_RETENTION } from '../shared/noteBackup.ts';
import { normalizeAppLanguage, type AppLanguage } from '../shared/appLanguage.ts';
import { normalizeLightColorScheme, type LightColorScheme } from '../shared/lightColorSchemes.ts';

/** Re-exported assistant mode types from knowledge subsystem / 从知识子系统重导出的助手模式类型 */
export type { AdaptiveContextMode, AssistantEvidenceProjectionMode, AssistantKnowledgeAgentMode, AssistantPlanMode, EvidenceCompressionMode } from './knowledge/assistant/assistantMode.ts';
/** Re-exported context runtime mode type / 重导出的上下文运行时模式类型 */
export type { AssistantContextRuntimeMode } from './knowledge/context/contextRuntimeTypes.ts';
/** Context runtime mode with 'inherit' fallback / 含 'inherit' 回退的上下文运行时模式 */
export type AssistantContextRuntimeRouteMode = AssistantContextRuntimeMode | 'inherit';
/** Re-exported memory projection mode types / 重导出的记忆投影模式类型 */
export type { MemoryProjectionMode, MemoryProjectionRouteMode } from './knowledge/memory/memoryCutover.ts';

import { defaultEditorPreferences, normalizeEditorPreferences, type EditorPreferences } from '../shared/editorPreferences.ts';

/** Full application preferences schema persisted by Electron main process. / 由 Electron 主进程持久化的完整应用偏好设置模式。 */
export interface AppPreferences extends EditorPreferences {
  schemaVersion: 1;
  theme: AppTheme;
  lightColorScheme: LightColorScheme;
  density: InterfaceDensity;
  language: AppLanguage;
  startupBehavior: StartupBehavior;
  externalLinkOpenMode: ExternalLinkOpenMode;
  backupRetention: number;
  defaultEditorMode: PreferredEditorMode;
  autosaveDelayMs: number;
  previewPreference: PreviewPreference;
  assistantPlanMode: AssistantPlanMode;
  adaptiveContextMode: AdaptiveContextMode;
  /** 知识库 ReAct Agent 入口开关（P3 默认开启）；传输层不可用或引擎异常时自动回退旧流水线。 */
  assistantKnowledgeAgentMode: AssistantKnowledgeAgentMode;
  assistantEvidenceProjectionMode: AssistantEvidenceProjectionMode;
  evidenceCompressionMode: EvidenceCompressionMode;
  assistantContextRuntimeMode: AssistantContextRuntimeMode;
  assistantContextRuntimeChatMode: AssistantContextRuntimeRouteMode;
  assistantContextRuntimeKnowledgeBaseMode: AssistantContextRuntimeRouteMode;
  assistantContextRuntimeCurrentNoteDirectMode: AssistantContextRuntimeRouteMode;
  assistantContextRuntimeCurrentNoteReactMode: AssistantContextRuntimeRouteMode;
  assistantMemoryProjectionMode: MemoryProjectionMode;
  assistantMemoryProjectionChatMode: MemoryProjectionRouteMode;
  assistantMemoryProjectionKnowledgeBaseMode: MemoryProjectionRouteMode;
  assistantMemoryProjectionCurrentNoteDirectMode: MemoryProjectionRouteMode;
  assistantMemoryProjectionCurrentNoteReactMode: MemoryProjectionRouteMode;
  leftSidebarWidth: number;
  rightPanelWidth: number;
  lastOpenedNote?: string;
}

/** Partial patch for updating application preferences / 用于更新应用偏好的部分补丁 */
export type AppPreferencesPatch = Partial<Omit<AppPreferences, 'schemaVersion'>>;

interface PreferenceStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Factory default values for all application preferences / 所有应用偏好的出厂默认值 */
export const defaultAppPreferences: AppPreferences = {
  schemaVersion: 1,
  ...defaultEditorPreferences,
  theme: 'system',
  lightColorScheme: 'green',
  density: 'comfortable',
  language: 'zh-CN',
  startupBehavior: 'library',
  externalLinkOpenMode: 'in-app',
  backupRetention: NOTE_BACKUP_RETENTION,
  defaultEditorMode: 'wysiwyg',
  autosaveDelayMs: 1_000,
  previewPreference: 'rendered',
  ...ASSISTANT_RELEASE_DEFAULTS,
  assistantKnowledgeAgentMode: 'on',
  assistantEvidenceProjectionMode: 'minimal',
  evidenceCompressionMode: 'observe',
  leftSidebarWidth: 240,
  rightPanelWidth: 280,
};

/** 读取时幂等归一旧工程配置，避免隐藏入口后继续使用历史切流值。 */
export function getAppPreferences(store: PreferenceStore | null | undefined): AppPreferences {
  const stored = store?.get('appPreferences');
  const preferences = normalizeAppPreferences(stored);
  if (store && stored && typeof stored === 'object' && !Array.isArray(stored)
    && Object.entries(ASSISTANT_RELEASE_DEFAULTS).some(([key, value]) => (stored as Record<string, unknown>)[key] !== value)) {
    store.set('appPreferences', preferences);
  }
  return preferences;
}

/** 保存个人偏好；工程模式由发行默认管理，不接受设置 IPC 的覆盖。 */
export function saveAppPreferences(store: PreferenceStore, patch: AppPreferencesPatch): AppPreferences {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('应用偏好格式无效。');
  const current = getAppPreferences(store);
  const next = normalizeAppPreferences({ ...current, ...patch });
  store.set('appPreferences', next);
  return next;
}

/** 规范化个人设置，并让新安装、旧配置和保存请求共用同一组工程默认。 */
export function normalizeAppPreferences(value: unknown): AppPreferences {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const lastOpenedNote = typeof candidate.lastOpenedNote === 'string' && candidate.lastOpenedNote.trim()
    ? candidate.lastOpenedNote.trim()
    : undefined;
  return {
    schemaVersion: 1,
    ...normalizeEditorPreferences(candidate),
    theme: isOneOf(candidate.theme, ['system', 'light', 'dark']) ? candidate.theme : defaultAppPreferences.theme,
    lightColorScheme: normalizeLightColorScheme(candidate.lightColorScheme),
    density: isOneOf(candidate.density, ['comfortable', 'compact']) ? candidate.density : defaultAppPreferences.density,
    language: normalizeAppLanguage(candidate.language),
    startupBehavior: isOneOf(candidate.startupBehavior, ['library', 'last-note']) ? candidate.startupBehavior : defaultAppPreferences.startupBehavior,
    externalLinkOpenMode: isOneOf(candidate.externalLinkOpenMode, ['in-app', 'system-default']) ? candidate.externalLinkOpenMode : defaultAppPreferences.externalLinkOpenMode,
    backupRetention: NOTE_BACKUP_RETENTION,
    defaultEditorMode: isOneOf(candidate.defaultEditorMode, ['wysiwyg', 'preview', 'source']) ? candidate.defaultEditorMode : defaultAppPreferences.defaultEditorMode,
    autosaveDelayMs: clampInteger(candidate.autosaveDelayMs, 250, 10_000, defaultAppPreferences.autosaveDelayMs),
    previewPreference: isOneOf(candidate.previewPreference, ['rendered', 'source']) ? candidate.previewPreference : defaultAppPreferences.previewPreference,
    ...ASSISTANT_RELEASE_DEFAULTS,
    assistantKnowledgeAgentMode: normalizeAssistantKnowledgeAgentMode(candidate.assistantKnowledgeAgentMode),
    ...normalizeAssistantEvidenceModeConfig({
      assistantEvidenceProjectionMode: candidate.assistantEvidenceProjectionMode as AssistantEvidenceProjectionMode,
      evidenceCompressionMode: candidate.evidenceCompressionMode as EvidenceCompressionMode,
    }),
    leftSidebarWidth: clampInteger(candidate.leftSidebarWidth, 200, 520, defaultAppPreferences.leftSidebarWidth),
    rightPanelWidth: clampInteger(candidate.rightPanelWidth, 260, Number.MAX_SAFE_INTEGER, defaultAppPreferences.rightPanelWidth),
    ...(lastOpenedNote ? { lastOpenedNote } : {}),
  };
}

function isOneOf<const T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T);
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}
