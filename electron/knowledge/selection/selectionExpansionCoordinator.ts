/**
 * Coordinates the selection expansion workflow: validates the expansion request,
 * delegates to the unified selection-edit coordinator, maps plan and evidence
 * types, and assembles the final expansion result.
 * 协调选区扩写工作流：校验扩写请求、委托统一选区编辑协调器、映射计划与证据类型、
 * 并组装最终扩写结果。
 */
import {
  createCoordinatorPlanId,
  createCurrentNoteSelectionEditRequest,
  runSelectionEditCoordinator,
} from './selectionEditCoordinator.ts';
import type { CurrentNoteSnapshot } from '../currentNote/currentNoteSnapshot.ts';
import type { SelectionEditExtendedSourceRuntime } from './sources/extendedSources.ts';
import type { SelectionEditContextPlan, SelectionEvidenceItem } from './selectionEditTypes.ts';
import type {
  SelectionExpansionEvidence,
  SelectionExpansionEventPayload,
  SelectionExpansionPlan,
  SelectionExpansionRequest,
  SelectionExpansionResult,
} from './selectionExpansionTypes.ts';
import { validateSelectionExpansionSettings } from './selectionExpansionSettings.ts';
import type { SelectionExpansionCapabilities } from './selectionExpansionTypes.ts';
import { resolveExpansionTarget } from '../../../shared/selectionExpansionPolicy.ts';
import { validateSelectionLocatorCapture } from './selectionEditLocator.ts';

/**
 * Input parameters for the selection expansion coordinator.
 * 选区扩写协调器的输入参数。
 */
export interface SelectionExpansionCoordinatorInput {
  /** Unique identifier for this expansion request. / 此扩写请求的唯一标识。 */
  requestId: string;
  /** Session identifier tying this request to a user session. / 关联用户会话的会话标识。 */
  sessionId: string;
  /** The validated expansion request payload. / 已校验的扩写请求载荷。 */
  request: SelectionExpansionRequest;
  /** Current note snapshot used as primary source. / 用作主要来源的当前笔记快照。 */
  snapshot: CurrentNoteSnapshot;
  /** Abort signal to cancel the expansion. / 用于取消扩写的中止信号。 */
  signal: AbortSignal;
  /** Returns whether the snapshot is still the latest version. / 返回快照是否仍为最新版本。 */
  isSnapshotCurrent: () => boolean;
  /** Emits expansion lifecycle events to the caller. / 向调用方发出扩写生命周期事件。 */
  emit: (event: SelectionExpansionEventPayload) => void;
  /** Optional runtime for extended source adapters (note library, materials, web). / 可选的扩展来源适配器运行时（笔记库、资料库、网页）。 */
  extendedSources?: SelectionEditExtendedSourceRuntime;
}

/**
 * Validates and normalizes a raw expansion request against capabilities.
 * 校验并规范化原始扩写请求，检查是否符合能力限制。
 *
 * @param value - Raw untrusted input to validate / 待校验的原始不可信输入
 * @param capabilities - Current expansion capability profile / 当前扩写能力配置
 * @returns A typed and validated expansion request / 类型化且已校验的扩写请求
 */
export function validateSelectionExpansionRequest(value: unknown, capabilities: SelectionExpansionCapabilities): SelectionExpansionRequest {
  if (!isRecord(value)) throw new Error('选区扩写请求格式无效。');
  const selectionSnapshotId = readBoundedString(value.selectionSnapshotId, '选区快照标识', 200);
  const sourceSnapshotId = readBoundedString(value.sourceSnapshotId, '来源快照标识', 200);
  const currentPath = readBoundedString(value.currentPath, '当前笔记路径', 4_096);
  const selectedText = readBoundedString(value.selectedText, '选中文字', 20_000);
  if (!selectedText.trim()) throw new Error('请先选择要扩写的文字。');
  const expectedContentHash = readBoundedString(value.expectedContentHash, '内容哈希', 64);
  if (!/^[a-f0-9]{64}$/iu.test(expectedContentHash)) throw new Error('内容哈希格式无效。');
  return {
    selectionSnapshotId,
    sourceSnapshotId,
    currentPath,
    selectedText,
    selectionLocator: validateSelectionLocatorCapture(value.selectionLocator),
    expectedContentHash: expectedContentHash.toLowerCase(),
    settings: validateSelectionExpansionSettings(value.settings, capabilities),
  };
}

/**
 * Current-note-only first slice of the expansion workflow. The model plans
 * evidence goals, while candidate discovery and source reads stay deterministic
 * in the main process. Later phases add other source adapters without widening
 * this coordinator's write authority (it has none).
 * 扩写工作流的"仅当前笔记"首阶段切片。模型规划证据目标，而候选发现和来源读取
 * 保持在主进程中确定性执行。后续阶段可添加其他来源适配器，但不会扩大此协调器
 * 的写权限（它没有任何写权限）。
 *
 * @param input - Expansion coordinator input including request, snapshot, and signals / 扩写协调器输入，包含请求、快照和信号
 * @returns The final expansion result with text, plan, evidence, and validation / 包含文本、计划、证据和校验的最终扩写结果
 */
export async function runSelectionExpansionCoordinator(input: SelectionExpansionCoordinatorInput): Promise<SelectionExpansionResult> {
  const { request, snapshot, signal, emit } = input;
  let plan: SelectionExpansionPlan = {
    planId: createCoordinatorPlanId(),
    outline: ['依据当前笔记中已读取的原文补充必要说明。'],
    goals: [],
    fallback: true,
  };
  // Delegate to the unified coordinator with expansion-specific settings / 委托给统一协调器，使用扩写专用配置
  const unified = await runSelectionEditCoordinator({
    request: createCurrentNoteSelectionEditRequest({
      requestId: input.requestId,
      action: 'expand',
      sourceSnapshotId: request.sourceSnapshotId,
      snapshot,
      selectedText: request.selectedText,
      selectionLocator: request.selectionLocator,
      customInstruction: request.settings.customInstruction,
      outputPreference: 'insert-below',
      // Use 'extended' scope when any external source is enabled / 当任何外部来源启用时使用 'extended' 范围
      contextScope: request.settings.sources.noteLibrary || request.settings.sources.materialsLibrary || request.settings.sources.web ? 'extended' : 'current-note',
      allowedSources: {
        currentNote: request.settings.sources.currentNote,
        noteLibrary: request.settings.sources.noteLibrary,
        materialsLibrary: request.settings.sources.materialsLibrary,
        web: request.settings.sources.web !== 'off',
        personalization: request.settings.sources.personalization,
      },
    }),
    snapshot,
    extendedSources: input.extendedSources,
    signal,
    isSnapshotCurrent: input.isSnapshotCurrent,
    synthesis: {
      forceCurrentNoteResearch: true,
      targetCharacters: resolveExpansionTarget(request.selectedText,
        request.settings.targetLength.mode === 'characters' ? request.settings.targetLength.characters : undefined,
        request.settings.targetLength.mode === 'ratio' ? request.settings.targetLength.ratio : undefined),
      style: request.settings.style,
      audience: request.settings.audience,
      reasoningDepth: request.settings.reasoningDepth === 'standard' ? 'balanced' : request.settings.reasoningDepth,
      customInstruction: request.settings.customInstruction,
    },
    // Map internal coordinator stages to expansion-specific phases / 将内部协调器阶段映射为扩写专用阶段
    emit: (event) => {
      if (event.type === 'status') {
        const phase = event.stage === 'planning' ? 'planning'
          : event.stage === 'reading' ? 'researching'
            : event.stage === 'generating' ? 'synthesizing'
              : event.stage === 'cancelled' ? 'cancelled'
                : event.stage === 'failed' ? 'error'
                  : 'configuring';
        emit({ type: 'status', phase, message: event.message });
        return;
      }
      if (event.type === 'plan') {
        plan = toSelectionExpansionPlan(event.plan);
        emit({ type: 'plan', plan });
        return;
      }
      if (event.type === 'evidence') emit({ type: 'evidence', evidence: toSelectionExpansionEvidence(event.evidence) });
    },
  });
  // Map unified evidence back to expansion evidence type / 将统一证据映射回扩写证据类型
  const evidence = unified.evidence.map((item) => toSelectionExpansionEvidence(item));
  // Check whether all planned goals are covered by at least one evidence item / 检查所有计划目标是否至少被一条证据覆盖
  const coveredGoalIds = new Set(evidence.flatMap((item) => item.goalIds));
  const completeCoverage = plan.goals.length > 0 && plan.goals.every((goal) => coveredGoalIds.has(goal.goalId));
  const result: SelectionExpansionResult = {
    requestId: input.requestId,
    sessionId: input.sessionId,
    selectionSnapshotId: request.selectionSnapshotId,
    text: unified.text,
    // Determine completeness: no text → not-found; validation passed + full coverage → complete; otherwise partial / 确定完整性：无文本→未找到；校验通过且全覆盖→完整；否则为部分
    completeness: !unified.text ? 'not-found' : unified.validation.passed && completeCoverage ? 'complete' : 'partial',
    plan,
    evidence,
    receipt: unified.receipt,
    validation: unified.validation,
    qualityReceipt: unified.qualityReceipt,
    execution: unified.execution,
    provider: unified.provider,
    model: unified.model,
    generatedAt: unified.generatedAt,
  };
  emit({ type: 'complete', result });
  return result;
}

/**
 * Converts a generic selection-edit context plan into an expansion-specific plan.
 * 将通用选区编辑上下文计划转换为扩写专用计划。
 *
 * @param plan - Source context plan from the coordinator / 来自协调器的源上下文计划
 * @returns Expansion plan with localized goal descriptions / 带有本地化目标描述的扩写计划
 */
function toSelectionExpansionPlan(plan: SelectionEditContextPlan): SelectionExpansionPlan {
  return {
    planId: createCoordinatorPlanId(),
    outline: ['依据已深读的本地来源原文补充必要说明。'],
    goals: plan.goals.map((goal, index) => ({
      goalId: goal.goalId,
      question: index === 0 ? '本地来源中的定义、背景或限定条件' : index === 1 ? '本地来源中的相关支撑原文' : '本地来源中的范围或例外条件',
      queryTerms: [...goal.queryTerms],
      requirements: [{ requirementId: `${goal.goalId}-req-1`, label: '已深读的本地来源原文' }],
    })),
    fallback: false,
  };
}

/**
 * Converts a generic selection-edit evidence item into an expansion evidence record.
 * Validates that the locator is non-empty and the read was verified.
 * 将通用选区编辑证据项转换为扩写证据记录。校验定位器非空且读取已验证。
 *
 * @param evidence - Source evidence item from the coordinator / 来自协调器的源证据项
 * @returns Typed expansion evidence with validated locator / 带有已校验定位器的类型化扩写证据
 */
function toSelectionExpansionEvidence(evidence: SelectionEvidenceItem): SelectionExpansionEvidence {
  if (!evidence.locator.trim() || !evidence.readVerified) throw new Error('选区编辑证据回执无效。');
  return {
    evidenceId: evidence.evidenceId,
    sourceKind: evidence.sourceKind,
    title: evidence.title,
    locator: evidence.locator,
    content: evidence.content,
    ...(evidence.sourceContentHash ? { sourceContentHash: evidence.sourceContentHash } : {}),
    textHash: evidence.textHash,
    ...(evidence.headingPath?.length ? { headingPath: [...evidence.headingPath] } : {}),
    goalIds: [...evidence.goalIds],
    readVerified: evidence.readVerified,
    ...(evidence.pageVerified !== undefined ? { pageVerified: evidence.pageVerified } : {}),
  };
}

/**
 * Checks whether a value is a non-null, non-array object.
 * 检查值是否为非空、非数组的对象。
 *
 * @param value - Value to test / 待测试的值
 * @returns True if value is a plain object / 如果值是普通对象则返回 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates that a value is a string within the specified length bound.
 * 校验值是否为不超过指定长度的字符串。
 *
 * @param value - Value to validate / 待校验的值
 * @param label - Human-readable field name for error messages / 用于错误消息的可读字段名
 * @param maxLength - Maximum allowed character count / 允许的最大字符数
 * @returns The validated string / 已校验的字符串
 */
function readBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  if (value.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return value;
}
