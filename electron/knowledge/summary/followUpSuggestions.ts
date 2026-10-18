/**
 * Follow-up suggestion generator: produces 0-3 suggested questions after a main answer.
 * 建议追问生成器：主回答完成后生成 0~3 条建议问题。
 *
 * Triggered after the main answer completes; uses a lightweight JSON call.
 * The model self-judges whether suggestions are needed (chitchat/thanks returns empty).
 * Failures/timeouts are silently swallowed by the caller.
 * 主回答 complete 后发起独立轻量 JSON 调用。失败/超时由调用方静默吞掉。
 */

import { generateAiJson } from '../ai/aiProvider.ts';
import type { AiProviderConfig } from '../ai/aiTypes.ts';
import type { AssistantConversationMessage } from '../assistant/assistantTurnTypes.ts';
import { isStructuredOutputContractError } from '../plan/structuredOutputContract.ts';

/**
 * 开放式问答建议追问：主回答 complete 后发起一次独立轻量 JSON 小调用，
 * 生成 0~3 条可一键发送的后续问题。是否「有需要」由模型自判
 * （寒暄/致谢/一次性问题返回空数组）；失败/超时由调用方静默吞掉。
 */

/** Maximum output tokens for follow-up suggestion generation / 建议追问生成的最大输出 token 数。 */
export const FOLLOW_UP_MAX_OUTPUT_TOKENS = 256;
/** Timeout in milliseconds for follow-up suggestion API call / 建议追问 API 调用的超时毫秒数。 */
export const FOLLOW_UP_TIMEOUT_MS = 8_000;
const FOLLOW_UP_MAX_COUNT = 3;
const FOLLOW_UP_MAX_CHARS = 60;
const ANSWER_HEAD_CHARS = 600;
const HISTORY_TURN_COUNT = 2;
const HISTORY_ANSWER_HEAD_CHARS = 200;

/**
 * A single history turn (user question + answer head) for follow-up context.
 * 用于追问上下文的单轮历史（用户问题 + 回答头部）。
 */
export interface FollowUpHistoryTurn {
  userText: string;
  answerHead: string;
}

const FOLLOW_UP_SYSTEM_PROMPT = `你是Trellora「AI 问答」的追问建议助手。
请根据用户问题与助手回答，判断用户是否可能继续深入该话题。
若可能，生成 2~3 条可一键发送的后续问题；仅当本轮是寒暄、致谢或无实质信息量的闲聊时返回空数组。
注意：是非、确认类问题（如"需要…吗""是不是…"）只要回答涉及可延伸的方向，同样生成后续问题，不得一律返回空数组。

问题规则：
1. 自包含：不得使用"它/这个/那个"等指代或省略，问题必须能独立被理解和回答。
2. 每条不超过 40 字，口语自然、直接可发送。
3. 不得重复或简单改写用户原问题。
4. 不得引入回答中未提及的新主题，只沿回答已涉及的方向深入或延伸。
5. 只返回合法 JSON，不要输出额外解释。

最近会话上下文：
<history>

本轮用户问题：
<question>

本轮助手回答（头部截断）：
<answer>`;

const FOLLOW_UP_JSON_SCHEMA = {
  name: 'follow_up_suggestions',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      suggestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['suggestions'],
    additionalProperties: false,
  },
} as const;

/**
 * Extract the most recent 2 history turns from the conversation for follow-up prompt context.
 * 从渲染进程上送的有限会话上下文中配对出最近 2 轮历史，供 prompt 使用。
 *
 * @param conversation - Conversation messages from renderer / 渲染进程上送的会话消息
 * @returns Up to 2 paired history turns / 最多 2 轮配对历史
 */
export function selectFollowUpHistory(conversation: AssistantConversationMessage[]): FollowUpHistoryTurn[] {
  const turns: FollowUpHistoryTurn[] = [];
  for (let index = 0; index < conversation.length - 1; index += 1) {
    const user = conversation[index];
    const assistant = conversation[index + 1];
    if (user.role === 'user' && assistant.role === 'assistant') {
      turns.push({ userText: user.content, answerHead: assistant.content });
      index += 1;
    }
  }
  return turns.slice(-HISTORY_TURN_COUNT).map((turn) => ({
    userText: turn.userText,
    answerHead: turn.answerHead.slice(0, HISTORY_ANSWER_HEAD_CHARS),
  }));
}

/**
 * Build the system prompt for follow-up suggestion generation, injecting
 * conversation history, current question, and truncated answer head.
 * 构建建议追问的系统 prompt，注入会话历史、当前问题和截断的回答头部。
 *
 * @param input.question - Current user question / 当前用户问题
 * @param input.answerHead - Truncated assistant answer / 截断的助手回答
 * @param input.history - Recent conversation turns / 最近会话轮次
 * @returns Assembled prompt string / 组装好的 prompt 字符串
 */
export function buildFollowUpSuggestionsPrompt(input: { question: string; answerHead: string; history: FollowUpHistoryTurn[] }): string {
  const historyText = input.history.length
    ? input.history.map((turn) => `用户：${turn.userText}\n助手：${turn.answerHead}`).join('\n\n')
    : '（无）';
  return FOLLOW_UP_SYSTEM_PROMPT
    .replace('<history>', historyText)
    .replace('<question>', input.question)
    .replace('<answer>', input.answerHead);
}

/** 宽松提取：接受 {suggestions:[...]} / {questions:[...]} / 顶层数组，跳过非字符串项，永不抛错。 */
function extractSuggestions(value: unknown, question: string): string[] {
  let items: unknown[] | undefined;
  if (Array.isArray(value)) items = value;
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate = Array.isArray(record.suggestions) ? record.suggestions : Array.isArray(record.questions) ? record.questions : undefined;
    if (candidate) items = candidate;
  }
  if (!items) return [];
  const normalizedQuestion = question.trim();
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed === normalizedQuestion || result.includes(trimmed)) continue;
    result.push(trimmed.slice(0, FOLLOW_UP_MAX_CHARS));
    if (result.length >= FOLLOW_UP_MAX_COUNT) break;
  }
  return result;
}

/** Schema 校验失败时的回退解析：优先对象切片，其次整体文本。 */
function parseLenientJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidates: string[] = [];
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 尝试下一个候选。
    }
  }
  throw new FollowUpSuggestionsError('invalid-suggestions', '建议追问原始输出不是合法 JSON。');
}

/**
 * Error type for follow-up suggestion generation failures.
 * 建议追问生成失败的错误类型。
 */
export class FollowUpSuggestionsError extends Error {
  readonly code: string;
  readonly rawOutput?: string;

  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = 'FollowUpSuggestionsError';
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

/**
 * Generate up to 3 follow-up suggestions after a complete answer. Returns validated
 * and truncated suggestions; abort signals are re-thrown, other failures throw
 * FollowUpSuggestionsError for the caller to handle silently.
 * 建议追问生成服务：校验截断后返回 ≤3 条问题；
 * 取消（AbortSignal）原样上抛，其余失败抛 FollowUpSuggestionsError 由调用方静默处理。
 *
 * @param input.question - User's original question / 用户原始问题
 * @param input.answer - Full assistant answer / 完整助手回答
 * @param input.history - Conversation history turns / 会话历史轮次
 * @param input.model - Model identifier / 模型标识
 * @param input.providerConfig - Optional AI provider config / 可选的 AI 提供商配置
 * @param input.contextWindowTokens - Optional context window size / 可选的上下文窗口大小
 * @param input.signal - Abort signal / 中止信号
 * @param input.onRawOutput - Optional callback for raw model output / 可选的原始模型输出回调
 * @returns Array of 0–3 suggestion strings / 0–3 条建议字符串数组
 */
export async function generateFollowUpSuggestions(input: {
  question: string;
  answer: string;
  history: FollowUpHistoryTurn[];
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  signal: AbortSignal;
  /** 成功路径回传模型原始输出，供调用方落痕诊断。 */
  onRawOutput?: (raw: string) => void;
}): Promise<string[]> {
  let rawOutput: string | undefined;
  let value: unknown;
  try {
    value = await generateAiJson({
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      prompt: buildFollowUpSuggestionsPrompt({
        question: input.question,
        answerHead: input.answer.slice(0, ANSWER_HEAD_CHARS),
        history: input.history,
      }),
      maxOutputTokens: FOLLOW_UP_MAX_OUTPUT_TOKENS,
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      timeoutMs: FOLLOW_UP_TIMEOUT_MS,
      signal: input.signal,
      callKind: 'follow-up-suggest',
      jsonSchema: FOLLOW_UP_JSON_SCHEMA,
      onRawResponse: (text) => { rawOutput = text; },
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    // Schema 校验失败属最佳努力场景：回退宽松解析原始输出，其余失败照常上抛。
    if (isStructuredOutputContractError(error) && error.reason === 'schema-validation' && rawOutput !== undefined) {
      value = parseLenientJson(rawOutput);
    } else {
      throw new FollowUpSuggestionsError('follow-up-call-failed', error instanceof Error ? error.message : String(error), rawOutput);
    }
  }
  if (rawOutput !== undefined) input.onRawOutput?.(rawOutput);
  return extractSuggestions(value, input.question);
}
