/**
 * Canonical QA history utilities: message validation, history projection, and conversation merging.
 * Provides deterministic helpers that turn stored turns into canonical history messages and enforce agent tool-call invariants.
 * 规范问答历史工具：消息校验、历史投影与会话合并。
 * 提供确定性辅助函数，将已存轮次投影为规范历史消息，并强制 agent 工具调用不变量。
 */
import type { AssistantAttachment, AssistantConversationMessage } from '../assistant/assistantTurnTypes.ts';
import { MEMORY_CONSTANTS } from '../memory/memoryConstants.ts';
import type {
  QaAgentMessage,
  QaAgentMessageInput,
  QaCanonicalHistoryMessage,
  QaRecentCompleteTurn,
  QaTurnAttachmentDescriptor,
} from './qaMemoryTypes.ts';

/**
 * Placeholder text substituted for stale retrieval tool results in projected history.
 * 历史投影中为过期检索工具结果替换的占位文本。
 */
export const QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE =
  '[Previous retrieval result omitted — knowledge base may have changed. Please perform a fresh search.]';

// Tool names whose historical results are redacted when retrieval history is not retained.
// 不保留检索历史时，其历史结果会被脱敏的工具名称。
const RETRIEVAL_TOOL_NAMES = new Set([
  'knowledge_search',
  'grep_chunks',
  'list_knowledge_chunks',
  'get_document_info',
  'graph_local_search',
  'graph_global_search',
  'web_search',
  'web_fetch',
  'get_note_map',
  'search_note',
  'read_note_range',
  'read_note_section',
  'expand_evidence',
  'search_conversations',
]);

/**
 * Mirrors WeKnora's non-greedy complete-block removal and trims the answer.
 * 对齐 WeKnora 的非贪婪完整 think 块移除，并去除首尾空白。
 *
 * @param value - Raw text possibly containing think blocks / 可能含 think 块的原始文本
 * @returns Text with complete think blocks removed and trimmed / 移除完整 think 块并去空白后的文本
 */
export function stripInlineThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/giu, '').trim();
}

/**
 * Computes how many history messages to overfetch for a given history-turn count.
 * 计算指定历史轮数需要超取的历史消息条数。
 *
 * @param historyTurns - Desired number of recent history turns / 期望的近期历史轮数
 * @returns Overfetched message count (multiplier result floored by a minimum) / 超取消息条数（乘数结果与最小值取大）
 */
export function calculateQaHistoryMessageOverfetch(historyTurns: number): number {
  if (!Number.isSafeInteger(historyTurns) || historyTurns < 0) {
    throw new Error('最近历史轮数必须是非负整数。');
  }
  return Math.max(
    historyTurns * MEMORY_CONSTANTS.conversationHistory.overfetchMultiplier,
    MEMORY_CONSTANTS.conversationHistory.overfetchMinimumMessages,
  );
}

/**
 * Maps assistant attachments to compact descriptors for historical rendering.
 * 将助手附件映射为紧凑描述符，供历史渲染使用。
 *
 * @param attachments - Raw assistant attachments, or undefined / 原始助手附件，可为 undefined
 * @returns Descriptors including mimeType only for image/document kinds / 仅图片/文档类型包含 mimeType 的描述符
 */
export function describeAssistantAttachments(
  attachments: readonly AssistantAttachment[] | undefined,
): QaTurnAttachmentDescriptor[] {
  return (attachments ?? []).map((attachment) => ({
    attachmentId: attachment.attachmentId,
    kind: attachment.kind,
    name: attachment.name,
    ...(attachment.kind === 'image' || attachment.kind === 'document'
      ? { mimeType: attachment.mimeType }
      : {}),
    sizeBytes: attachment.sizeBytes,
  }));
}

/**
 * Renders a historical user message by appending image/attachment listings to the user text.
 * 渲染历史用户消息：在用户文本后附加图片/附件清单。
 *
 * @param userText - Original user text / 用户原始文本
 * @param attachments - Descriptors of attachments on that turn / 该轮的附件描述符
 * @returns Combined user content for history projection / 用于历史投影的合并用户内容
 */
export function renderQaHistoricalUserContent(
  userText: string,
  attachments: readonly QaTurnAttachmentDescriptor[],
): string {
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  const files = attachments.filter((attachment) => attachment.kind !== 'image');
  const sections = [userText];
  if (images.length > 0) {
    sections.push([
      '[用户上传图片]',
      ...images.map((attachment) => `- ${attachment.name}（${attachment.mimeType ?? 'image'}，${attachment.sizeBytes} bytes）`),
    ].join('\n'));
  }
  if (files.length > 0) {
    sections.push([
      '[用户上传附件]',
      ...files.map((attachment) => `- ${attachment.name}（${attachment.mimeType ?? attachment.kind}，${attachment.sizeBytes} bytes）`),
    ].join('\n'));
  }
  return sections.filter((section) => section.trim()).join('\n\n');
}

/**
 * Validate the cross-table invariant before a transaction writes messages.
 * Every call must have exactly one later tool result in call order, and no
 * tool message may reference a call from another turn.
 *
 * 验证事务写入消息前的跨表不变量。
 * 每个调用必须恰好有一个后续工具结果按调用顺序排列，
 * 且工具消息不得引用另一轮次的调用。
 *
 * @param messages - Agent message inputs to validate / 待验证的 Agent 消息输入
 * @throws Error if invariant is violated / 不变量被违反时抛出错误
 */
export function validateQaAgentMessageInputs(messages: readonly QaAgentMessageInput[]): void {
  const pendingCalls: Array<{ id: string; name: string }> = [];
  const seenCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pendingCalls.length > 0) throw new Error('Agent tool call 缺少对应结果。');
      for (const call of message.toolCalls ?? []) {
        const callId = call.callId.trim();
        const toolName = call.toolName.trim();
        if (!callId || !toolName || seenCallIds.has(callId)) throw new Error('Agent tool call 标识或名称无效。');
        assertJsonObject(call.arguments, 'Agent tool call 参数');
        seenCallIds.add(callId);
        pendingCalls.push({ id: callId, name: toolName });
      }
      if ((message.toolCallId ?? '').trim()) throw new Error('assistant step 不得携带 toolCallId。');
      continue;
    }

    const expected = pendingCalls.shift();
    const toolCallId = message.toolCallId?.trim() ?? '';
    if (!expected || !toolCallId || toolCallId !== expected.id) {
      throw new Error('Agent tool result 未按 call_seq 匹配当前 turn 的 tool call。');
    }
    if (message.toolName?.trim() && message.toolName.trim() !== expected.name) {
      throw new Error('Agent tool result 的工具名称与 tool call 不一致。');
    }
    if (!(message.content ?? '').trim() && message.artifactRef === undefined) {
      throw new Error('Agent tool result 必须包含正文或 artifact 引用。');
    }
    if (message.toolCalls?.length) throw new Error('tool step 不得再声明 tool call。');
    if (message.reasoningContent?.trim()) throw new Error('tool step 不得携带 reasoning_content。');
    if (message.artifactRef !== undefined) assertJsonObject(message.artifactRef, 'Agent artifact 引用');
  }
  if (pendingCalls.length > 0) throw new Error('Agent tool call 缺少对应结果。');
}

/**
 * Checks whether stored agent messages are self-consistent: contiguous messageSeq values and valid call/result pairing.
 * 校验已存 agent 消息是否自洽：messageSeq 连续且调用/结果配对合法。
 *
 * @param messages - Stored agent messages / 已存 agent 消息
 * @returns True when the sequence passes validation / 序列通过校验时返回 true
 */
export function validateQaStoredAgentMessages(messages: readonly QaAgentMessage[]): boolean {
  if (!messages.every((message, index) => message.messageSeq === index)) return false;
  try {
    validateQaAgentMessageInputs(messages.map((message) => ({
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.artifactRef ? { artifactRef: message.artifactRef } : {}),
      toolCalls: message.toolCalls.map((call) => ({
        callId: call.callId,
        toolName: call.toolName,
        arguments: call.arguments,
      })),
    })));
    return true;
  } catch {
    return false;
  }
}

/**
 * Projects recent complete turns into canonical history messages: replays assistant tool calls,
 * filters final_answer calls, optionally redacts retrieval results, and attaches final reasoning.
 * 将近期完整轮次投影为规范历史消息：重放助手工具调用、过滤 final_answer 调用、
 * 按需脱敏检索结果，并附上最终推理内容。
 *
 * @param turns - Recent complete turns with agent messages / 含 agent 消息的近期完整轮次
 * @param options - Whether to retain retrieval tool history (defaults to project constant) / 是否保留检索工具历史（默认取项目常量）
 * @returns Canonical history messages for prompt assembly / 用于 prompt 装配的规范历史消息
 */
export function projectQaRecentTurnsToHistoryMessages(
  turns: readonly QaRecentCompleteTurn[],
  options: { retainRetrievalHistory?: boolean } = {},
): QaCanonicalHistoryMessage[] {
  const retainRetrievalHistory = options.retainRetrievalHistory
    ?? MEMORY_CONSTANTS.conversationHistory.retainRetrievalHistoryByDefault;
  const result: QaCanonicalHistoryMessage[] = [];
  for (const turn of turns) {
    result.push({
      role: 'user',
      content: renderQaHistoricalUserContent(turn.userText, turn.metadata.attachments),
    });
    let finalReasoningContent = '';
    // Call ids of final_answer tool calls that are dropped from the replay.
    // 从重放中剔除的 final_answer 工具调用 id。
    const ignoredFinalAnswerCallIds = new Set<string>();
    for (const message of turn.agentMessages) {
      if (message.role === 'assistant') {
        // A reasoning-only assistant step becomes the turn's final reasoning content.
        // 纯推理的 assistant 步骤转为该轮的最终推理内容。
        if (message.toolCalls.length === 0 && !message.content.trim() && message.reasoningContent.trim()) {
          finalReasoningContent = message.reasoningContent;
          continue;
        }
        // Keep only replayable tool calls; record final_answer calls so their results are skipped.
        // 只保留可重放的工具调用；记录 final_answer 调用以便跳过其结果。
        const replayableToolCalls = message.toolCalls.filter((call) => {
          if (call.toolName !== 'final_answer') return true;
          ignoredFinalAnswerCallIds.add(call.callId);
          return false;
        });
        if (message.toolCalls.length > 0 && replayableToolCalls.length === 0) continue;
        result.push({
          role: 'assistant',
          content: message.content,
          ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
          ...(replayableToolCalls.length > 0 ? {
            toolCalls: replayableToolCalls.map((call) => ({
              id: call.callId,
              name: call.toolName,
              arguments: call.arguments,
            })),
          } : {}),
        });
        continue;
      }
      if (message.toolCallId && ignoredFinalAnswerCallIds.has(message.toolCallId)) continue;
      if (message.toolName === 'final_answer') continue;
      // Redact retrieval tool results when retrieval history retention is disabled.
      // 未启用检索历史保留时，对检索工具结果进行脱敏替换。
      const content = !retainRetrievalHistory && message.toolName && RETRIEVAL_TOOL_NAMES.has(message.toolName)
        ? QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE
        : message.content;
      result.push({
        role: 'tool',
        content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.artifactRef ? { artifactRef: message.artifactRef } : {}),
      });
    }
    result.push({
      role: 'assistant',
      content: turn.assistantText,
      ...(finalReasoningContent ? { reasoningContent: finalReasoningContent } : {}),
    });
  }
  return result;
}

/**
 * Direct routes consume the same selected turns, projected to Q/A messages.
 * 直接路由使用相同选中轮次，投影为问答消息。
 *
 * @param turns - Recent complete turns / 最近完整轮次
 * @returns Conversation messages / 对话消息数组
 */
export function projectQaRecentTurnsToConversation(
  turns: readonly QaRecentCompleteTurn[],
): AssistantConversationMessage[] {
  return turns.flatMap((turn) => [
    {
      role: 'user' as const,
      content: renderQaHistoricalUserContent(turn.userText, turn.metadata.attachments),
    },
    { role: 'assistant' as const, content: turn.assistantText },
  ]);
}

/**
 * Select only complete user/assistant pairs and keep the newest N pairs.
 * 仅选择完整的用户/助手配对，保留最新的 N 对。
 *
 * @param messages - Conversation messages / 对话消息
 * @param historyTurns - Number of recent pairs to keep / 保留的最近配对数
 * @returns Selected conversation messages / 选中的对话消息
 */
export function selectQaRecentCompleteConversation(
  messages: readonly AssistantConversationMessage[],
  historyTurns = MEMORY_CONSTANTS.conversationHistory.recentCompleteTurns,
): AssistantConversationMessage[] {
  if (!Number.isSafeInteger(historyTurns) || historyTurns < 0) throw new Error('最近历史轮数无效。');
  if (historyTurns === 0) return [];
  const pairs: Array<[AssistantConversationMessage, AssistantConversationMessage]> = [];
  let pendingUser: AssistantConversationMessage | undefined;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;
    if (message.role === 'user') {
      pendingUser = { role: 'user', content };
      continue;
    }
    if (!pendingUser) continue;
    pairs.push([pendingUser, { role: 'assistant', content }]);
    pendingUser = undefined;
  }
  return pairs.slice(-historyTurns).flatMap(([user, assistant]) => [user, assistant]);
}

/**
 * Merge legacy fallback and canonical histories, preferring the later copy on conflict.
 * 合并旧版回退和规范历史，冲突时优先保留后者的副本。
 *
 * @param histories - Arrays of conversation histories to merge / 待合并的对话历史数组
 * @param historyTurns - Max pairs to keep / 保留的最大配对数
 * @returns Merged conversation messages / 合并后的对话消息
 */
export function mergeQaRecentCompleteConversations(
  histories: readonly (readonly AssistantConversationMessage[])[],
  historyTurns = MEMORY_CONSTANTS.conversationHistory.recentCompleteTurns,
): AssistantConversationMessage[] {
  const orderedPairs: Array<[AssistantConversationMessage, AssistantConversationMessage]> = [];
  for (const history of histories) {
    const selected = selectQaRecentCompleteConversation(history, Number.MAX_SAFE_INTEGER);
    for (let index = 0; index < selected.length; index += 2) {
      const user = selected[index];
      const assistant = selected[index + 1];
      if (!user || !assistant) continue;
      // Deduplicate by exact pair signature; the later occurrence replaces the earlier one.
      // 按配对签名去重：后出现的副本替换先出现的副本。
      const signature = `${user.content}\0${assistant.content}`;
      const duplicateIndex = orderedPairs.findIndex(([oldUser, oldAssistant]) => (
        `${oldUser.content}\0${oldAssistant.content}` === signature
      ));
      if (duplicateIndex >= 0) orderedPairs.splice(duplicateIndex, 1);
      orderedPairs.push([user, assistant]);
    }
  }
  return orderedPairs.slice(-historyTurns).flatMap(([user, assistant]) => [user, assistant]);
}

/**
 * Create validated agent message inputs from raw conversation messages.
 * 从原始对话消息创建经过验证的 Agent 消息输入。
 *
 * @param messages - Raw conversation messages / 原始对话消息
 * @returns Validated agent message inputs / 经过验证的 Agent 消息输入
 */
export function createQaAgentMessageInputs(
  messages: readonly Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    toolName?: string;
  }>,
): QaAgentMessageInput[] {
  const result = messages.flatMap((message): QaAgentMessageInput[] => {
    if (message.role !== 'assistant' && message.role !== 'tool') return [];
    if (message.role === 'tool') {
      return [{
        role: 'tool',
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
      }];
    }
    return [{
      role: 'assistant',
      content: message.content,
      ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
      toolCalls: (message.toolCalls ?? []).map((call) => ({
        callId: call.id,
        toolName: call.name,
        arguments: call.arguments,
      })),
    }];
  });
  validateQaAgentMessageInputs(result);
  return result;
}

/**
 * Asserts that a value is a plain JSON-serializable object.
 * 断言某个值是可 JSON 序列化的普通对象。
 */
function assertJsonObject(value: Record<string, unknown>, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
  JSON.stringify(value);
}
