/**
 * Deterministic quality gate for selection-edit candidates. Applies length,
 * evidence-coverage, and web-verification boundaries after generation, and
 * produces a machine-readable quality receipt without granting write authority.
 * 选区编辑候选结果的确定性质量门。在生成后执行长度、证据覆盖与
 * 网页核验边界检查，并产出机器可读的质量回执，但不授予写回权限。
 */

import type {
  SelectionEditAction,
  SelectionEditQualityIssue,
  SelectionEditQualityIssueCode,
  SelectionEditQualityReceipt,
  SelectionEditValidation,
  SelectionEvidenceItem,
} from './selectionEditTypes.ts';

import { createSelectionLengthReceipt } from '../../../shared/selectionExpansionPolicy.ts';

// Human-readable Chinese labels for each machine-readable issue code.
// 每个机器可读问题码对应的中文可读标签。
/** Maps quality issue codes to human-readable Chinese labels. / 将质量问题代码映射为人类可读的中文标签。 */
const issueLabels: Record<SelectionEditQualityIssueCode, string> = {
  EXPAND_NOT_LONGER: '扩写未达到目标长度',
  TARGET_LENGTH_MISSED: '扩写未达到目标长度',
  MARKDOWN_FORMAT_LOST: '扩写未保留原文 Markdown 格式',
  PROTECTED_ANCHOR_LOST: '原文关键信息未完整保留',
  UNSUPPORTED_ADDITION: '新增内容缺少原文依据',
  EVIDENCE_GOAL_UNCOVERED: '证据覆盖不足',
  WEB_PAGE_UNVERIFIED: '网页来源尚未全文核验',
  TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT: '目标长度超出当前模型输出能力',
};

// Priority order used when presenting a single primary issue to users.
// 向用户展示单个主要问题时使用的优先级顺序。
/** Priority order for sorting quality issues (highest priority first). / 质量问题的优先级排序（最高优先级在前）。 */
const issuePriority: SelectionEditQualityIssueCode[] = [
  'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT',
  'EXPAND_NOT_LONGER',
  'TARGET_LENGTH_MISSED',
  'MARKDOWN_FORMAT_LOST',
  'PROTECTED_ANCHOR_LOST',
  'UNSUPPORTED_ADDITION',
  'WEB_PAGE_UNVERIFIED',
  'EVIDENCE_GOAL_UNCOVERED',
];

/**
 * Input for the quality gate: action, original and candidate text, required
 * goal IDs, evidence list, validation state, and optional model output flag.
 * 质量门输入：动作、原文与候选文本、必需目标 ID 列表、证据列表、
 * 校验状态以及可选的模型输出超限标志。
 */
/**
 * Input for the deterministic quality gate check.
 * 确定性质量门检查的输入。
 */
export interface SelectionEditQualityGateInput {
  /** The edit action being evaluated. / 正在评估的编辑动作。 */
  action: SelectionEditAction;
  /** Original selected text. / 原始选中文本。 */
  selectedText: string;
  /** Generated candidate text. / 生成的候选文本。 */
  candidateText: string;
  /** Target character count for expansion. / 扩写的目标字符数。 */
  targetCharacters?: number;
  /** Evidence goal IDs that must be covered. / 必须被覆盖的证据目标 ID。 */
  requiredGoalIds: readonly string[];
  /** Available evidence items. / 可用的证据项。 */
  evidence: readonly SelectionEvidenceItem[];
  /** Current validation state (mutated in place). / 当前校验状态（原地修改）。 */
  validation: SelectionEditValidation;
  /** Whether the target exceeds the model's output capacity. / 目标是否超出模型输出能力。 */
  targetExceedsModelOutput?: boolean;
}

/**
 * Output of the quality gate: updated validation state and quality receipt.
 * 质量门输出：更新后的校验状态与质量回执。
 */
/**
 * Result of the quality gate: mutated validation and a quality receipt.
 * 质量门的结果：已修改的校验和质量回执。
 */
export interface SelectionEditQualityGateResult {
  /** Updated validation with any new issues added. / 已更新的校验，包含新增的问题。 */
  validation: SelectionEditValidation;
  /** Machine-readable quality receipt for the candidate. / 候选结果的机器可读质量回执。 */
  receipt: SelectionEditQualityReceipt;
}

/**
 * Applies the final, deterministic result policy after a generator or ReAct
 * loop has produced a candidate. This function never grants write authority;
 * callers must still require `validation.passed` before exposing writeback.
 * 在生成器或 ReAct 循环产出候选结果后，应用最终的确定性结果策略。
 * 此函数从不授予写回权限；调用方仍须检查 `validation.passed`
 * 才能开放写回。
 *
 * @param input - Quality gate input / 质量门输入
 * @returns Updated validation and quality receipt / 更新后的校验状态与质量回执
 */
export function applySelectionEditQualityGate(input: SelectionEditQualityGateInput): SelectionEditQualityGateResult {
  const validation = input.validation;
  applyExpansionLengthBoundary(validation, input);
  const evidenceCoverage = applyEvidenceCoverageBoundary(validation, input.requiredGoalIds, input.evidence);
  applyWebVerificationBoundary(validation, input.evidence);
  if (input.targetExceedsModelOutput) {
    addIssue(validation, {
      code: 'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT',
      message: issueLabels.TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT,
      retryable: false,
    });
  }
  return {
    validation,
    receipt: {
      generation: !input.candidateText.trim() ? 'empty' : validation.passed ? 'complete' : 'partial',
      evidenceCoverage,
      validation: validation.passed ? 'passed' : 'failed',
      issues: sortIssues(validation.issues ?? []),
      ...(input.action === 'expand' ? { lengthReceipt: createSelectionLengthReceipt(input.selectedText, input.candidateText, input.targetCharacters) } : {}),
    },
  };
}

/**
 * Returns the human-readable Chinese label for a quality issue code.
 * 返回质量问题代码的人类可读中文标签。
 *
 * @param issue - Issue with a code property / 带有 code 属性的问题
 * @returns Chinese label string / 中文标签字符串
 */
export function selectionEditQualityIssueLabel(issue: Pick<SelectionEditQualityIssue, 'code'>): string {
  return issueLabels[issue.code];
}

/**
 * Picks one human-facing reason without collapsing machine-readable issues.
 * 选出一个面向用户的原因，同时不丢失机器可读的问题列表。
 *
 * @param receipt - Quality receipt with issues / 含问题列表的质量回执
 * @returns Highest-priority issue, or undefined when none exist / 最高优先级问题；无问题时返回 undefined
 */
export function primarySelectionEditQualityIssue(
  receipt: Pick<SelectionEditQualityReceipt, 'issues'> | undefined,
): SelectionEditQualityIssue | undefined {
  if (!receipt?.issues.length) return undefined;
  return [...receipt.issues].sort((left, right) => issuePriority.indexOf(left.code) - issuePriority.indexOf(right.code))[0];
}

// Expand boundary: candidate must reach the minimum target length. If it is
// not even longer than the original, the issue is EXPAND_NOT_LONGER; otherwise
// it is TARGET_LENGTH_MISSED.
// 扩写边界：候选文本必须达到最小目标长度。若未比原文更长，问题码为
// EXPAND_NOT_LONGER；否则为 TARGET_LENGTH_MISSED。
function applyExpansionLengthBoundary(validation: SelectionEditValidation, input: SelectionEditQualityGateInput): void {
  if (input.action !== 'expand') return;
  const { originalCharacters: originalLength, actualCharacters: candidateLength, minimumCharacters: targetLength } = createSelectionLengthReceipt(input.selectedText, input.candidateText, input.targetCharacters);
  if (candidateLength >= targetLength) return;
  const code: SelectionEditQualityIssueCode = candidateLength <= originalLength
    ? 'EXPAND_NOT_LONGER'
    : 'TARGET_LENGTH_MISSED';
  addIssue(validation, { code, message: issueLabels[code], retryable: !input.targetExceedsModelOutput });
}

// Evidence coverage boundary: every required goal ID must map to at least one
// evidence item. Returns the coverage level for the receipt.
// 证据覆盖边界：每个必需目标 ID 必须至少映射到一条证据。返回回执所需的覆盖级别。
function applyEvidenceCoverageBoundary(
  validation: SelectionEditValidation,
  requiredGoalIds: readonly string[],
  evidence: readonly SelectionEvidenceItem[],
): SelectionEditQualityReceipt['evidenceCoverage'] {
  const required = [...new Set(requiredGoalIds.filter(Boolean))];
  if (required.length === 0) return 'not-required';
  const covered = new Set(evidence.flatMap((item) => item.goalIds));
  const missing = required.filter((goalId) => !covered.has(goalId));
  if (missing.length === 0) return 'complete';
  addIssue(validation, {
    code: 'EVIDENCE_GOAL_UNCOVERED',
    message: issueLabels.EVIDENCE_GOAL_UNCOVERED,
    retryable: true,
  });
  return covered.size === 0 ? 'none' : 'partial';
}

/**
 * Defense in depth: a search snippet is not webpage evidence. Flags web-sourced
 * evidence items that have not completed full-page verification.
 * 深度防御：搜索摘要不等于网页证据。标记尚未完成全文核验的网页来源证据。
 *
 * @param validation - Validation state to mutate / 待变更的校验状态
 * @param evidence - Evidence items to inspect / 待检查的证据列表
 */
export function applyWebVerificationBoundary(validation: SelectionEditValidation, evidence: readonly SelectionEvidenceItem[]): void {
  if (!evidence.some((item) => item.sourceKind === 'web' && item.pageVerified !== true)) return;
  addIssue(validation, {
    code: 'WEB_PAGE_UNVERIFIED',
    message: issueLabels.WEB_PAGE_UNVERIFIED,
    retryable: true,
  });
}

// Appends a unique issue and flips `passed` to false. Duplicate codes are ignored.
// 追加唯一问题并将 `passed` 置为 false。重复的问题码会被忽略。
function addIssue(validation: SelectionEditValidation, issue: SelectionEditQualityIssue): void {
  const existingIssues = validation.issues ?? [];
  if (existingIssues.some((entry) => entry.code === issue.code)) return;
  validation.issues = [...existingIssues, issue];
  validation.passed = false;
}

// Sorts issues by the global priority order defined in `issuePriority`.
// 按 `issuePriority` 中定义的全局优先级对问题排序。
function sortIssues(issues: readonly SelectionEditQualityIssue[]): SelectionEditQualityIssue[] {
  return [...issues].sort((left, right) => issuePriority.indexOf(left.code) - issuePriority.indexOf(right.code));
}
