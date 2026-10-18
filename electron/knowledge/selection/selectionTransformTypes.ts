/**
 * Type definitions for inline selection text transform actions (polish, shorten, expand, etc.).
 * 选区内联文本变换操作的类型定义（润色、缩短、扩写、校对等）。
 */

import type {
  SelectionEditContextScope,
  SelectionEditExecutionReceipt,
  SelectionEditQualityReceipt,
  SelectionEditValidation,
  SelectionContextReceipt,
} from './selectionEditTypes.ts';

/** All supported inline selection transform action identifiers. / 所有支持的选区内联变换操作标识。 */
export const selectionTransformActions = [
  'polish',
  'shorten',
  'expand',
  'proofread',
  'explain',
  'translate',
  'custom',
] as const;

/** Union type of all selection transform actions. / 所有选区变换操作的联合类型。 */
export type SelectionTransformAction = typeof selectionTransformActions[number];

/** Surrounding text context for a selection transform request. / 选区变换请求的上下文文本。 */
export interface SelectionTransformContext {
  before: string;
  after: string;
}

/** Input payload for an inline selection transform operation. / 选区内联变换操作的输入载荷。 */
export interface SelectionTransformRequest {
  requestId: string;
  action: SelectionTransformAction;
  selectedText: string;
  context?: SelectionTransformContext;
  targetLanguage?: string;
  instruction?: string;
  model?: string;
  /** Optional SE-4 source locator; omitted requests retain the local-only legacy behavior. */
  currentPath?: string;
  contextScope?: SelectionEditContextScope;
}

/** Result payload returned after a successful selection transform. / 选区变换成功后返回的结果载荷。 */
export interface SelectionTransformResult {
  requestId: string;
  text: string;
  provider: 'ollama' | 'openai-compatible';
  model: string;
  writebackKind: 'inline-text' | 'block-markdown' | 'copy-only';
  suggestedApplyMode: 'replace' | 'insert-below' | 'copy-only';
  validation: SelectionEditValidation;
  qualityReceipt: SelectionEditQualityReceipt;
  execution: SelectionEditExecutionReceipt;
  contextReceipt?: SelectionContextReceipt;
}
