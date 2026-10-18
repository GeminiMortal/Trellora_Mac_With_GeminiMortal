/**
 * Helpers for settling assistant turn message lifecycles in the renderer.
 * 渲染进程助手回合消息生命周期的辅助函数。
 */

/**
 * Shape of a message whose turn lifecycle the renderer owns.
 * 由渲染进程持有生命周期的回合消息结构。
 */
export interface AssistantTurnLifecycleMessage {
  id: string;
  state: 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled';
  statusMessage?: string;
}

/**
 * Settles a renderer-owned turn before its asynchronous cancel event returns.
 * 在异步取消事件返回前，将渲染进程持有的回合标记为已取消。
 *
 * @param messages - Current message list / 当前消息列表
 * @param requestId - Id of the turn to settle / 要结束的回合 id
 * @returns A new list with the matching turn cancelled / 将匹配回合置为已取消后的新列表
 */
export function markAssistantTurnCancelled<T extends AssistantTurnLifecycleMessage>(
  messages: readonly T[],
  requestId: string,
): T[] {
  return messages.map((message) => message.id === requestId
    && (message.state === 'pending' || message.state === 'streaming')
    ? { ...message, state: 'cancelled', statusMessage: undefined }
    : message) as T[];
}
