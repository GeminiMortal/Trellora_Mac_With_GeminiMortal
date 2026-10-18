/**
 * Context helpers for adaptive expansion mode resolution, thinking mode, and full-note snapshot admission.
 * 自适应扩写模式判定、思维模式和全文笔记快照准入的上下文辅助工具。
 */
import { createHash } from 'node:crypto';
import { countFullNoteCharacters, EXPANSION_FULL_NOTE_CHARACTERS } from '../../../shared/selectionExpansionPolicy.ts';
import type { CurrentNoteSnapshot } from '../currentNote/currentNoteSnapshot.ts';
import type { SelectionContextReceipt, SelectionEvidenceItem } from './selectionEditTypes.ts';
import { resolveAiModelDescriptor } from '../ai/aiModelCapabilities.ts';
import type { AiProviderConfig } from '../ai/aiTypes.ts';

/** Expansion context mode: 'legacy' uses fixed heuristics, 'adaptive' uses model-aware logic. / 扩写上下文模式：'legacy' 使用固定启发式，'adaptive' 使用模型感知逻辑。 */
export type SelectionExpansionMode = 'legacy' | 'adaptive';

/**
 * Resolve the expansion context mode from environment variable.
 * Expansion owns this switch and threshold; QA and other edits keep their policy.
 *
 * 从环境变量解析扩写上下文模式。扩写拥有此开关和阈值；QA 和其他编辑保持各自策略。
 *
 * @param value - Environment variable value; defaults to process.env.MENGHAN_SELECTION_EXPANSION_CONTEXT_MODE.
 *   / 环境变量值；默认为 process.env.MENGHAN_SELECTION_EXPANSION_CONTEXT_MODE。
 * @returns The resolved expansion mode.
 *   / 解析后的扩写模式。
 */
export function resolveSelectionExpansionMode(value = process.env.MENGHAN_SELECTION_EXPANSION_CONTEXT_MODE): SelectionExpansionMode {
  return value === 'legacy' ? 'legacy' : 'adaptive';
}

/**
 * Check whether an evidence item represents the full-note expansion admission.
 * 检查证据项是否代表全文笔记扩写准入。
 *
 * @param item - The evidence item to check. / 要检查的证据项。
 * @returns True if the item is a full-note expansion evidence. / 若为全文笔记扩写证据则返回 true。
 */
export function isExpansionFullNoteEvidence(item: SelectionEvidenceItem): boolean {
  return item.sourceKind === 'current-note' && item.evidenceId.startsWith('expansion-full-note-');
}

/**
 * Resolve the thinking mode for expansion to prevent optional provider thinking from consuming the measured body output reserve.
 * 解析扩写的思维模式，防止可选的提供商思维链占用已测量的正文输出预留。
 *
 * @param config - AI provider configuration. / AI 提供商配置。
 * @param model - Model identifier. / 模型标识符。
 * @returns 'simple' for supported dialects, otherwise undefined. / 支持的方言返回 'simple'，否则返回 undefined。
 */
export function resolveExpansionThinkingMode(config: AiProviderConfig, model: string): 'simple' | undefined {
  const dialect = resolveAiModelDescriptor(config, model).thinkingDialect;
  return dialect === 'deepseek' || dialect === 'qwen' ? 'simple' : undefined;
}

/**
 * Collect expansion context from the immutable main-process note snapshot without tool caps.
 * Full-note admission reads the immutable main-process snapshot without tool caps.
 *
 * 从不可变的主进程笔记快照中收集扩写上下文，不带工具上限。
 * 全文准入读取不可变的主进程快照，不带工具上限。
 *
 * @param snapshot - Current note snapshot from main process. / 来自主进程的当前笔记快照。
 * @param goalIds - Goal IDs to associate with the evidence. / 要关联到证据的目标 ID 列表。
 * @returns Evidence items and context receipt for the expansion. / 扩写的证据项和上下文回执。
 */
export function collectExpansionSnapshotContext(snapshot: CurrentNoteSnapshot, goalIds: string[]): {
  evidence: SelectionEvidenceItem[]; receipt: SelectionContextReceipt;
} {
  const characters = countFullNoteCharacters(snapshot.markdown);
  const included = characters <= EXPANSION_FULL_NOTE_CHARACTERS;
  const locator = `当前笔记 / L1-L${snapshot.lineCount}`;
  return {
    evidence: included ? [{
      evidenceId: `expansion-full-note-${snapshot.contentHash.slice(0, 24)}`, sourceKind: 'current-note', title: snapshot.title,
      locator, content: snapshot.markdown, sourceContentHash: snapshot.contentHash,
      textHash: createHash('sha256').update(snapshot.markdown).digest('hex'), goalIds, readVerified: true,
    }] : [],
    receipt: {
      contextMode: included ? 'full-note' : 'related-original', fullNoteCharacters: characters,
      includedCharacters: included ? characters : 0, fullNoteIncluded: included,
      planned: [{ sourceKind: 'current-note', reason: included ? '按扩写阈值纳入当前笔记全文。' : '通过 ReAct 定位并深读当前笔记相关原文。' }],
      used: included ? [{ sourceKind: 'current-note', title: snapshot.title, locator, characterCount: characters }] : [],
      skipped: [], candidates: [], conflicts: [], personalization: { requested: false, applied: false, itemCount: 0 },
      fullNoteMode: 'not-requested',
    },
  };
}
