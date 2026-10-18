/**
 * Renderer-side launcher state for selection-edit actions over the unified IPC.
 * 基于统一 IPC 的选区编辑启动器渲染端状态。
 */
import type { SelectionEditAction, SelectionEditContextScope } from '../../../electron/knowledge/selection/selectionEditTypes.ts';
import type { SelectionSnapshot } from './selectionActions.ts';

/**
 * Renderer-only launcher state. Since SE-7 the regular launcher uses the
 * unified `selection-edit:*` IPC; the expansion workspace remains a dedicated
 * evidence UI over the same coordinator.
 * 仅渲染端的启动器状态。自 SE-7 起常规启动器使用统一的 `selection-edit:*` IPC；
 * 扩展工作区仍是基于同一协调器的专用证据 UI。
 */
export interface SelectionEditLauncherSession {
  snapshot: SelectionSnapshot;
  action: SelectionEditAction;
  contextScope: SelectionEditContextScope;
  targetLanguage: string;
  instruction: string;
}

/**
 * Create a launcher session with default polish settings for a new selection snapshot.
 * 为新的选区快照创建带有默认润色设置的启动器会话。
 *
 * @param snapshot - Selection snapshot to edit / 待编辑的选区快照
 * @returns A fresh launcher session in its default state / 处于默认状态的新启动器会话
 */
export function createSelectionEditLauncherSession(snapshot: SelectionSnapshot): SelectionEditLauncherSession {
  return {
    snapshot,
    action: 'polish',
    contextScope: 'auto',
    targetLanguage: '中文',
    instruction: '',
  };
}
