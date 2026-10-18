/**
 * Renderer-side draft session types for the selection-expansion evidence workspace.
 * 选区扩展证据工作区的渲染端草稿会话类型。
 */
import type { SelectionExpansionCapabilities, SelectionExpansionEvidence, SelectionExpansionPlan, SelectionExpansionResult, SelectionExpansionSettings } from '../../electron';
import type { SelectionSnapshot, SelectionWritebackCapability } from './selectionActions.ts';

/**
 * Renderer-only session. It is deliberately separate from persisted default settings.
 * 仅渲染端的会话；刻意与持久化的默认设置分离。
 */
export interface SelectionExpansionDraftSession {
  id: string;
  snapshot: SelectionSnapshot;
  writeback: SelectionWritebackCapability;
  settings: SelectionExpansionSettings;
  capabilities: SelectionExpansionCapabilities;
  status: 'configuring' | 'planning' | 'researching' | 'synthesizing' | 'completed' | 'partial' | 'not-found' | 'cancelled' | 'stale' | 'error';
  message?: string;
  requestId?: string;
  taskSessionId?: string;
  sequence: number;
  plan?: SelectionExpansionPlan;
  evidence: SelectionExpansionEvidence[];
  result?: SelectionExpansionResult;
  error?: string;
}

/**
 * Explicit user confirmation to write a reviewed suggestion back through the live editor.
 * 用户显式确认后，将已审阅的建议写回实时编辑器。
 */
export interface SelectionExpansionApplyRequest {
  id: string;
  snapshot: SelectionSnapshot;
  text: string;
}
