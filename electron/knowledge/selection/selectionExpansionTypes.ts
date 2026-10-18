/**
 * Type definitions for the selection expansion feature: settings, requests, plans, evidence, results, and events.
 * 选区扩写功能的类型定义：设置、请求、计划、证据、结果和事件。
 */
import type { SelectionLocatorCapture } from '../../../shared/selectionLocatorTypes.ts';
import type {
  SelectionContextReceipt,
  SelectionEditExecutionReceipt,
  SelectionEditFactSourceKind,
  SelectionEditQualityReceipt,
  SelectionEditValidation,
} from './selectionEditTypes.ts';

/** Available capability modes for the expansion feature. / 扩写功能的可用能力模式。 */
export const selectionExpansionCapabilityModes = ['off', 'current-note', 'local-sources', 'full'] as const;
/** Union type of expansion capability modes. / 扩写能力模式的联合类型。 */
export type SelectionExpansionCapabilityMode = typeof selectionExpansionCapabilityModes[number];

/** Preset length ratios for expansion target length. / 扩写目标长度的预设长度比率。 */
export const selectionExpansionLengthRatios = [1.3, 1.8, 2.5] as const;
/** Union type of expansion length ratios. / 扩写长度比率的联合类型。 */
export type SelectionExpansionLengthRatio = typeof selectionExpansionLengthRatios[number];
/** Target length specification: either a ratio multiplier or absolute character count. / 目标长度规格：比率乘数或绝对字符数。 */
export type SelectionExpansionTargetLength =
  | { mode: 'ratio'; ratio: SelectionExpansionLengthRatio }
  | { mode: 'characters'; characters: number };

/** Available writing styles for expansion. / 扩写的可用写作风格。 */
export const selectionExpansionStyles = ['preserve', 'professional', 'academic', 'plain', 'proposal'] as const;
/** Union type of expansion writing styles. / 扩写写作风格的联合类型。 */
export type SelectionExpansionStyle = typeof selectionExpansionStyles[number];

/** Available target audience presets for expansion. / 扩写的可用目标受众预设。 */
export const selectionExpansionAudiences = ['preserve', 'beginner', 'professional', 'manager'] as const;
/** Union type of expansion target audiences. / 扩写目标受众的联合类型。 */
export type SelectionExpansionAudience = typeof selectionExpansionAudiences[number];

/** Available reasoning depth levels for expansion. / 扩写的可用推理深度级别。 */
export const selectionExpansionReasoningDepths = ['fast', 'standard', 'deep'] as const;
/** Union type of expansion reasoning depths. / 扩写推理深度的联合类型。 */
export type SelectionExpansionReasoningDepth = typeof selectionExpansionReasoningDepths[number];

/** Available citation output modes for expansion. / 扩写的可用引用输出模式。 */
export const selectionExpansionCitationModes = ['source-cards', 'copy-with-sources'] as const;
/** Union type of expansion citation modes. / 扩写引用模式的联合类型。 */
export type SelectionExpansionCitationMode = typeof selectionExpansionCitationModes[number];

/** Configuration for which data sources are enabled for expansion research. / 扩写研究启用哪些数据源的配置。 */
export interface SelectionExpansionSourceSettings {
  currentNote: boolean;
  noteLibrary: boolean;
  materialsLibrary: boolean;
  web: 'off' | 'inherit' | 'on';
  /** Only affects wording/terminology; not a factual evidence source. / 只影响措辞/术语；不属于事实证据来源。 */
  personalization: boolean;
}

/**
 * Persisted defaults for new expansion tasks; per-task drafts are managed separately by the renderer.
 * 持久化的是新任务的默认值；一次任务中的草稿由 Renderer 单独管理，不能直接覆盖此对象。
 */
export interface SelectionExpansionSettings {
  schemaVersion: 2;
  targetLength: SelectionExpansionTargetLength;
  style: SelectionExpansionStyle;
  audience: SelectionExpansionAudience;
  reasoningDepth: SelectionExpansionReasoningDepth;
  modelProfileId?: string;
  sources: SelectionExpansionSourceSettings;
  citationMode: SelectionExpansionCitationMode;
  customInstruction: string;
}

/** Partial patch for updating expansion settings. / 用于更新扩写设置的部分补丁。 */
export interface SelectionExpansionSettingsPatch {
  targetLength?: SelectionExpansionTargetLength;
  style?: SelectionExpansionStyle;
  audience?: SelectionExpansionAudience;
  reasoningDepth?: SelectionExpansionReasoningDepth;
  modelProfileId?: string | null;
  sources?: Partial<SelectionExpansionSourceSettings>;
  citationMode?: SelectionExpansionCitationMode;
  customInstruction?: string;
}

/** Computed capabilities and limits for the expansion feature. / 扩写功能的计算能力和限制。 */
export interface SelectionExpansionCapabilities {
  mode: SelectionExpansionCapabilityMode;
  enabled: boolean;
  sources: {
    currentNote: boolean;
    noteLibrary: boolean;
    materialsLibrary: boolean;
    web: boolean;
    personalization: boolean;
  };
  limits: {
    maxSelectedCharacters: number;
    minTargetCharacters: number;
    maxTargetCharacters: number;
    maxCustomInstructionCharacters: number;
  };
}

/** Maximum selected text character count. / 选中文本最大字符数。 */
export const SELECTION_EXPANSION_MAX_SELECTED_CHARACTERS = 20_000;
/** Minimum target expansion character count. / 目标扩写最小字符数。 */
export const SELECTION_EXPANSION_MIN_TARGET_CHARACTERS = 100;
/** Maximum target expansion character count. / 目标扩写最大字符数。 */
export const SELECTION_EXPANSION_MAX_TARGET_CHARACTERS = 40_000;
/** Maximum custom instruction character count. / 自定义指令最大字符数。 */
export const SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS = 500;

/** Expansion task lifecycle phases. / 扩写任务生命周期阶段。 */
export type SelectionExpansionPhase = 'configuring' | 'planning' | 'researching' | 'synthesizing' | 'completed' | 'partial' | 'not-found' | 'cancelled' | 'stale' | 'error';

/** Preparation metadata for a single expansion source. / 单个扩写来源的准备元数据。 */
export interface SelectionExpansionSourcePreparation {
  currentPath: string;
  contentHash: string;
  sourceSnapshotId: string;
}

/** Input payload for an expansion request. / 扩写请求的输入载荷。 */
export interface SelectionExpansionRequest {
  selectionLocator?: SelectionLocatorCapture;
  selectionSnapshotId: string;
  sourceSnapshotId: string;
  currentPath: string;
  selectedText: string;
  expectedContentHash: string;
  settings: SelectionExpansionSettings;
}

/** A single expansion research goal with query terms and requirements. / 包含查询词和需求的单个扩写研究目标。 */
export interface SelectionExpansionGoal {
  goalId: string;
  question: string;
  queryTerms: string[];
  requirements: Array<{ requirementId: string; label: string }>;
}

/** Expansion plan outlining goals and fallback strategy. / 包含目标和回退策略的扩写计划。 */
export interface SelectionExpansionPlan {
  planId: string;
  outline: string[];
  goals: SelectionExpansionGoal[];
  fallback: boolean;
}

/** Evidence item gathered during expansion research. / 扩写研究期间收集的证据项。 */
export interface SelectionExpansionEvidence {
  evidenceId: string;
  sourceKind: SelectionEditFactSourceKind;
  title: string;
  locator: string;
  content: string;
  sourceContentHash?: string;
  textHash: string;
  headingPath?: string[];
  goalIds: string[];
  readVerified: boolean;
  pageVerified?: boolean;
}

/** Final result of an expansion task. / 扩写任务的最终结果。 */
export interface SelectionExpansionResult {
  requestId: string;
  sessionId: string;
  selectionSnapshotId: string;
  text: string;
  completeness: 'complete' | 'partial' | 'not-found';
  plan: SelectionExpansionPlan;
  evidence: SelectionExpansionEvidence[];
  /** Actual read receipt; candidate locations and deeply-read sources are strictly layered. / 实际读取回执；候选定位与已深读原文严格分层。 */
  receipt: SelectionContextReceipt;
  /** Unified coordinator validation controls whether this legacy result may be applied inline. / 统一协调器验证控制此旧版结果是否可内联应用。 */
  validation: SelectionEditValidation;
  /** RA-4 separates generated output quality from legacy completeness. / RA-4 将生成输出质量与旧版完整性分离。 */
  qualityReceipt: SelectionEditQualityReceipt;
  execution: SelectionEditExecutionReceipt;
  provider: 'ollama' | 'openai-compatible';
  model: string;
  generatedAt: string;
}

/**
 * Event payload union sent from main process to renderer (task identifiers and sequence number are added before dispatch).
 * 由主进程补齐任务标识和单调序列号后，才会发送给渲染进程。
 */
export type SelectionExpansionEventPayload =
  | { type: 'started' }
  | { type: 'status'; phase: SelectionExpansionPhase; message: string }
  | { type: 'plan'; plan: SelectionExpansionPlan }
  | { type: 'evidence'; evidence: SelectionExpansionEvidence }
  | { type: 'complete'; result: SelectionExpansionResult }
  | { type: 'cancelled' }
  | { type: 'stale'; message: string }
  | { type: 'error'; code: string; message: string };

/** Expansion event enriched with request/session IDs and sequence number. / 附带请求/会话 ID 和序列号的扩写事件。 */
export type SelectionExpansionEvent = SelectionExpansionEventPayload & {
  requestId: string;
  sessionId: string;
  sequence: number;
};
