/**
 * SE-0 shared contract for the future unified selection-edit workflow.
 *
 * This file intentionally has no IPC, model, filesystem, or editor mutation
 * behavior. SE-1 through SE-7 must migrate existing selection transform and
 * selection expansion code to this contract behind their respective gates.
 * 统一选区编辑工作流的 SE-0 共享合同。
 * 本文件有意不包含 IPC、模型、文件系统或编辑器变更行为。
 * SE-1 至 SE-7 必须在各自门控后将现有选区转换和扩写代码迁移至本合同。
 */

import type { SelectionLengthReceipt } from '../../../shared/selectionExpansionPolicy.ts';

/**
 * All supported selection-edit actions in priority order.
 * 按优先级排列的所有受支持的选区编辑动作。
 */
export const selectionEditActions = [
  'polish',
  'shorten',
  'expand',
  'proofread',
  'explain',
  'translate',
  'custom',
] as const;

/**
 * Union of supported selection-edit actions.
 * 受支持的选区编辑动作联合类型。
 */
export type SelectionEditAction = typeof selectionEditActions[number];

/**
 * Allowed context scope strategies for selection editing.
 * 选区编辑允许的上下文范围策略。
 */
export const selectionEditContextScopes = ['auto', 'nearby', 'current-note', 'extended'] as const;

/**
 * Union of supported context scopes.
 * 受支持的上下文范围联合类型。
 */
export type SelectionEditContextScope = typeof selectionEditContextScopes[number];

/**
 * Facts may only be synthesized from source kinds listed here after a bounded read.
 * 事实只能在有限读取后从这里列出的来源类型中合成。
 */
export const selectionEditFactSourceKinds = ['current-note', 'note-library', 'materials', 'web'] as const;

/**
 * Union of fact source kinds.
 * 事实来源类型的联合类型。
 */
export type SelectionEditFactSourceKind = typeof selectionEditFactSourceKinds[number];

/**
 * Preferences may influence wording and terminology but can never support a factual claim.
 * 偏好只能影响措辞和术语，绝不能支撑事实声明。
 */
export const selectionEditPreferenceSourceKinds = ['personalization'] as const;

/**
 * Union of preference source kinds.
 * 偏好来源类型的联合类型。
 */
export type SelectionEditPreferenceSourceKind = typeof selectionEditPreferenceSourceKinds[number];

/**
 * Flags indicating which data sources are authorized for a given edit request.
 * 标记给定编辑请求授权了哪些数据来源。
 */
export interface SelectionEditSourceAuthorization {
  currentNote: boolean;
  noteLibrary: boolean;
  materialsLibrary: boolean;
  web: boolean;
  personalization: boolean;
}

/**
 * Supported writeback modes for applying edit suggestions.
 * 应用编辑建议时支持的写回模式。
 */
export const selectionEditWritebackModes = ['replace', 'insert-below', 'copy-only'] as const;

/**
 * Union of writeback modes.
 * 写回模式联合类型。
 */
export type SelectionEditWritebackMode = typeof selectionEditWritebackModes[number];

/**
 * Kinds of writeback content the renderer can apply.
 * 渲染进程可应用的写回内容类型。
 */
export const selectionEditWritebackKinds = ['inline-text', 'block-markdown', 'copy-only'] as const;

/**
 * Union of writeback kinds.
 * 写回内容类型联合类型。
 */
export type SelectionEditWritebackKind = typeof selectionEditWritebackKinds[number];

/**
 * Main-process snapshot contract. The renderer's SE-2 structure receipt is
 * promoted here only after a saved-note locator supplies the library, hash,
 * line, and heading identity fields. `sliceJson` remains opaque to IPC.
 * 主进程快照合同。渲染进程的 SE-2 结构回执仅在已保存笔记定位器
 * 提供资料库、哈希、行号和标题标识字段后才提升到此处。
 * `sliceJson` 对 IPC 保持不透明。
 */
export interface SelectionSnapshotV2 {
  editorSessionId: string;
  libraryId: string;
  currentPath: string;
  docRevision: number;
  noteContentHash: string;
  from: number;
  to: number;
  selectedText: string;
  selectedTextHash: string;
  markdownFragment: string;
  sliceJson: unknown;
  canonicalSliceJson: string;
  selectionStructureSignature: string;
  documentStructureSignature: string;
  lineFrom: number;
  lineTo: number;
  headingPath: Array<{ id: string; text: string }>;
  blockKinds: string[];
  rect: { left: number; top: number; right: number; bottom: number };
}

/**
 * Internal selection-edit request produced after the renderer's SE-7 transport
 * is validated and promoted into the main-process contract.
 * 渲染进程 SE-7 传输校验后生成的内部选区编辑请求，提升为主进程合同。
 */
export interface SelectionEditRequest {
  requestId: string;
  action: SelectionEditAction;
  snapshot: SelectionSnapshotV2;
  sourceSnapshotId: string;
  contextScope: SelectionEditContextScope;
  allowedSources: SelectionEditSourceAuthorization;
  targetLanguage?: string;
  customInstruction?: string;
  outputPreference: SelectionEditWritebackMode;
  modelProfileId?: string;
}

/**
 * Available routing strategies for selection editing.
 * 选区编辑可用的路由策略。
 */
export const selectionEditRoutes = ['local-transform', 'current-note-research', 'extended-research'] as const;

/**
 * Union of selection edit routes.
 * 选区编辑路由联合类型。
 */
export type SelectionEditRoute = typeof selectionEditRoutes[number];

/**
 * A single context goal within a research plan for an edit request.
 * 编辑请求研究计划中的单个上下文目标。
 */
export interface SelectionEditContextGoal {
  goalId: string;
  kind: 'style' | 'terminology' | 'definition' | 'support' | 'conflict' | 'coverage';
  queryTerms: string[];
  required: boolean;
}

/**
 * Full context plan for an edit request: action, routing, goals, planned
 * sources, and resource budgets.
 * 编辑请求的完整上下文计划：动作、路由、目标、计划来源与资源预算。
 */
export interface SelectionEditContextPlan {
  action: SelectionEditAction;
  route: SelectionEditRoute;
  goals: SelectionEditContextGoal[];
  plannedSources: SelectionEditFactSourceKind[];
  budgets: {
    maxToolCalls: number;
    maxEvidenceCharacters: number;
    maxModelTokens: number;
  };
}

/**
 * A single evidence item read from a source during the research phase.
 * 研究阶段从来源读取的单条证据项。
 */
export interface SelectionEvidenceItem {
  evidenceId: string;
  sourceKind: SelectionEditFactSourceKind;
  title: string;
  locator: string;
  headingPath?: string[];
  content: string;
  sourceContentHash?: string;
  textHash: string;
  goalIds: string[];
  readVerified: boolean;
  pageVerified?: boolean;
}

/**
 * Receipt describing how context was gathered for an edit request: which
 * sources were planned, used, skipped, and what candidates were retrieved.
 * 描述编辑请求上下文收集方式的回执：计划使用了哪些来源、实际使用了哪些、
 * 跳过了哪些以及检索到了哪些候选。
 */
export interface SelectionContextReceipt {
  contextMode?: 'full-note' | 'related-original' | 'nearby' | 'legacy' | 'not-requested';
  fullNoteCharacters?: number;
  includedCharacters?: number;
  fullNoteIncluded?: boolean;
  planned: Array<{ sourceKind: SelectionEditFactSourceKind; reason: string }>;
  used: Array<{ sourceKind: SelectionEditFactSourceKind; title: string; locator: string; characterCount: number }>;
  skipped: Array<{ sourceKind: SelectionEditFactSourceKind; reason: string }>;
  /**
   * Retrieval hits are navigation hints only. They must be kept in the receipt
   * but must never be treated as `used` or model-visible evidence; only deep
   * reads produce SelectionEvidenceItem.
   * 检索命中只是导航线索。它们必须保留在回执中，且绝不能被当作
   * `used` 或模型可见证据；只有深读后才会产生 SelectionEvidenceItem。
   */
  candidates: Array<{
    candidateId: string;
    sourceKind: SelectionEditFactSourceKind;
    title: string;
    locator: string;
    queryTerms: string[];
    retrievalMethod: string;
    readState: 'candidate' | 'deep-read' | 'skipped';
    score?: number;
    /** Web search snippets are false; only a completed web_fetch can upgrade to true. / 网页搜索摘要为 false；只有完成 web_fetch 后才可升级为 true。 */
    pageVerified?: boolean;
    /** Candidate-time identity check; never rendered or sent to the model. / 候选阶段的身份校验；不渲染也不发送给模型。 */
    sourceContentHash?: string;
    reason?: string;
  }>;
  /**
   * Conservatively identified discrepancies between source expressions;
   * flagged for human review only, never used as factual evidence.
   * 保守识别出的来源表述差异；仅提示人工核对，不能作为事实依据。
   */
  conflicts: Array<{
    conflictId: string;
    evidenceIds: string[];
    summary: string;
    status: 'needs-review';
  }>;
  /**
   * Personalization data is strictly separated from factual sources: it only
   * provides writing-style and terminology preferences, never enters the
   * Evidence Ledger, citations, or factual checks.
   * 个性化资料与事实来源严格分开：仅提供写作风格和术语偏好，
   * 绝不进入 Evidence Ledger、引用或事实校验。
   */
  personalization: {
    requested: boolean;
    applied: boolean;
    itemCount: number;
    reason?: string;
  };
  fullNoteMode: 'not-requested' | 'strict-direct' | 'map-and-read';
}

/**
 * Validation result for a selection-edit candidate: pass/fail status,
 * warnings, protected anchor losses, unsupported claims, and machine-readable issues.
 * 选区编辑候选结果的校验结果：通过/失败状态、警告、受保护锚点丢失、
 * 无依据声明与机器可读问题列表。
 */
export interface SelectionEditValidation {
  passed: boolean;
  warnings: string[];
  protectedAnchorLosses: string[];
  unsupportedClaims: string[];
  /**
   * RA-0 freezes machine-readable quality reasons without changing the legacy
   * warning arrays consumed by the current renderer. RA-4 will project these
   * issues into SelectionEditQualityReceipt and dedicated UI states.
   * RA-0 冻结机器可读的质量原因，同时不改变当前渲染进程消费的遗留警告数组。
   * RA-4 将把这些问题投影到 SelectionEditQualityReceipt 和专用 UI 状态中。
   */
  issues: SelectionEditQualityIssue[];
}

/**
 * Machine-readable codes for quality issues that may arise during validation.
 * 校验过程中可能出现的机器可读质量问题码。
 */
export const selectionEditQualityIssueCodes = [
  'EXPAND_NOT_LONGER',
  'TARGET_LENGTH_MISSED',
  'MARKDOWN_FORMAT_LOST',
  'PROTECTED_ANCHOR_LOST',
  'UNSUPPORTED_ADDITION',
  'EVIDENCE_GOAL_UNCOVERED',
  'WEB_PAGE_UNVERIFIED',
  'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT',
] as const;

/**
 * Union of quality issue codes.
 * 质量问题码联合类型。
 */
export type SelectionEditQualityIssueCode = typeof selectionEditQualityIssueCodes[number];

/**
 * A single quality issue with code, message, and retryability.
 * 单个质量问题，包含问题码、消息与可重试性。
 */
export interface SelectionEditQualityIssue {
  code: SelectionEditQualityIssueCode;
  message: string;
  retryable: boolean;
}

/**
 * RA-0 type contract only; runtime/UI projection is implemented in RA-4.
 * 仅为 RA-0 类型合同；运行时/UI 投影在 RA-4 中实现。
 */
export interface SelectionEditQualityReceipt {
  lengthReceipt?: SelectionLengthReceipt;
  generation: 'complete' | 'partial' | 'empty';
  evidenceCoverage: 'complete' | 'partial' | 'none' | 'not-required';
  validation: 'passed' | 'failed';
  issues: SelectionEditQualityIssue[];
}

/**
 * Renderer-safe execution counters. They intentionally describe only work
 * actually used for this result: development-only shadow work is omitted.
 * 渲染进程安全的执行计数器。它们有意仅描述本次结果实际使用的工作量；
 * 仅用于开发的影子工作被省略。
 */
export interface SelectionEditExecutionReceipt {
  path: 'direct' | 'react';
  rounds: number;
  modelCalls: number;
  toolCalls: number;
  repairAttempts: number;
}

/**
 * Complete result of a selection-edit operation, including the generated text,
 * validation, quality receipt, execution counters, and provider metadata.
 * 选区编辑操作的完整结果，包含生成文本、校验、质量回执、执行计数器与提供者元数据。
 */
export interface SelectionEditResult {
  requestId: string;
  action: SelectionEditAction;
  text: string;
  markdown?: string;
  writebackKind: SelectionEditWritebackKind;
  suggestedApplyMode: SelectionEditWritebackMode;
  changes?: Array<{ kind: string; before: string; after: string; reason: string }>;
  receipt: SelectionContextReceipt;
  evidence: SelectionEvidenceItem[];
  validation: SelectionEditValidation;
  qualityReceipt: SelectionEditQualityReceipt;
  execution: SelectionEditExecutionReceipt;
  sourceSnapshotId: string;
  selectedTextHash: string;
  /** Provider metadata is returned by the coordinator so legacy IPC adapters do not invent it. / 提供者元数据由协调器返回，避免遗留 IPC 适配器自行捏造。 */
  provider: 'ollama' | 'openai-compatible';
  model: string;
  generatedAt: string;
}

/**
 * Lifecycle stages of a selection-edit operation.
 * 选区编辑操作的生命周期阶段。
 */
export const selectionEditStages = [
  'preparing',
  'planning',
  'reading',
  'validating',
  'generating',
  'ready',
  'cancelled',
  'failed',
  'stale',
] as const;
export type SelectionEditStage = typeof selectionEditStages[number];

export type SelectionEditEventPayload =
  | { type: 'started' }
  | { type: 'status'; stage: SelectionEditStage; message: string }
  | { type: 'plan'; plan: SelectionEditContextPlan }
  | { type: 'evidence'; evidence: SelectionEvidenceItem }
  | { type: 'complete'; result: SelectionEditResult }
  | { type: 'cancelled' }
  | { type: 'error'; code: string; message: string };

export type SelectionEditEvent = SelectionEditEventPayload & {
  requestId: string;
  sessionId: string;
  sequence: number;
};
