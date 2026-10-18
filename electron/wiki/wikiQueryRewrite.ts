/**
 * Wiki question rewrite and scope-intent recognition gate.
 * Wiki 问题改写与范围识别闸门。
 *
 * Decides whether a free-form question needs one model call for coreference resolution / context completion,
 * builds the JSON-schema-constrained rewrite prompt, and normalizes the model output while guarding against
 * divergent rewrites and hallucinated section titles.
 * 判断自由问答是否需要一次模型调用做指代消解/上下文补全，构造带 JSON Schema 约束的改写提示词，
 * 并在归一化模型输出的同时防止改写发散与幻觉章节标题。
 */
import { generateAiJson } from '../knowledge/ai/aiProvider.ts';
import type { AiProviderConfig } from '../knowledge/ai/aiTypes.ts';
import type { AssistantConversationMessage } from '../knowledge/assistant/assistantTurnTypes.ts';
import type { WikiActionKind } from './wikiQuickActions.ts';
import {
  hasExplicitWikiDocumentScope,
  hasExplicitWikiNodeLock,
  resolveWikiScopeDecision,
  type WikiScopeMode,
} from './wikiScopePolicy.ts';

/**
 * Max output tokens allowed for the rewrite model call.
 * 改写模型调用的最大输出 token 数。
 */
export const WIKI_QUERY_REWRITE_MAX_OUTPUT_TOKENS = 1024;
/**
 * Timeout for the rewrite model call in milliseconds.
 * 改写模型调用超时时间（毫秒）。
 */
export const WIKI_QUERY_REWRITE_TIMEOUT_MS = 15_000;

const REWRITE_MAX_CHARS = 300;
const SUB_QUESTION_MAX_COUNT = 3;
const SUB_QUESTION_MAX_CHARS = 200;
const EXPLICIT_SECTION_MAX_COUNT = 8;
const EXPLICIT_SECTION_MAX_CHARS = 60;
const HISTORY_MESSAGE_COUNT = 6;
const HISTORY_MESSAGE_MAX_CHARS = 500;
const SHORT_FOLLOWUP_CHARS = 12;

// Anaphora markers indicating historical coreference that needs rewrite resolution.
// 表示需要改写消解的历史指代标记。
const ANAPHORA_MARKERS = [
  '它们', '他们', '她们', '它', '他', '她', '其', '该',
  '上述', '上面', '以上', '刚才', '之前', '前面', '上一轮',
  '这个', '那个', '这点', '那点', '这些', '那些',
];
// Sentence starters typical of follow-up turns.
// 典型追问句开头词。
const FOLLOWUP_STARTERS = ['那么', '然后', '接着', '继续', '再', '还有', '另外', '如果', '要是', '那'];
// Trailing particles marking elliptical follow-up questions (e.g. "还有呢？").
// 标记省略式追问的尾部语气词（如「还有呢？」）。
const ELLIPSIS_ENDINGS = ['呢？', '呢?', '呢'];
// Literal Chinese ordinal section references, e.g. 第三章 / 第12节.
// 字面中文序数章节引用，如 第三章 / 第12节。
const SECTION_REFERENCE_PATTERN = /第[零〇一二三四五六七八九十百千万两\d]+(?:章|节|部分)/gu;

/**
 * Reason code for the rewrite gate decision.
 * 改写闸门决策的原因码。
 */
export type WikiQueryRewriteGateReason =
  | 'quick-action' // Quick action already has stable intent / 快捷动作已有稳定意图
  | 'explicit-node-lock' // User explicitly locked a node / 用户显式锁定节点
  | 'explicit-section-reference' // User named document/chapter scope / 用户点名全文或章节
  | 'no-history' // No conversation to resolve against / 无历史可消解
  | 'follow-up' // Follow-up signals matched / 命中追问信号
  | 'self-contained'; // Question is self-contained / 问题自足

/**
 * Rewrite gate decision: whether to rewrite and which signals drove it.
 * 改写闸门决策：是否改写及驱动信号。
 */
export interface WikiQueryRewriteGateDecision {
  rewriting: boolean;
  /** Gate reason code. / 闸门原因码。 */
  reason: WikiQueryRewriteGateReason;
  /** Matched follow-up / anaphora signals (empty when none). / 命中的追问/指代信号（无则为空）。 */
  matchedSignals: string[];
}

/**
 * History message shape accepted by the rewrite prompt (role + content).
 * 改写提示词接受的历史消息形态（role + content）。
 */
export interface WikiRewriteHistoryMessage {
  role: AssistantConversationMessage['role'];
  /** Content already truncated to the history budget. / 已截断到历史预算内的内容。 */
  content: string;
}

/**
 * Validated rewrite result returned by rewriteWikiQuestion.
 * rewriteWikiQuestion 返回的校验后改写结果。
 */
export interface WikiQueryRewriteResult {
  /** Self-contained rewritten question (falls back to the original under the anti-divergence guard). / 可独立检索的改写问题（防发散守卫触发时回退为原问题）。 */
  rewrite: string;
  /** True only when the model explicitly split a multi-part question. / 仅当模型明确拆分多问题时为 true。 */
  shouldSplit: boolean;
  /** Sub-questions when split; otherwise the single rewrite. / 拆分时的子问题；否则为单条改写。 */
  subQuestions: string[];
  /** Scope mode after authoritative scope resolution. / 权威作用域决策后的范围模式。 */
  scopeIntent: WikiScopeMode;
  /** Chapter titles explicitly named in the question (literal matches only). / 问题中显式点名的章节标题（仅字面命中）。 */
  explicitSectionTitles: string[];
  /** Raw model JSON output for diagnosis, never used as answer evidence. / 诊断用原始模型 JSON 输出，不作为回答证据。 */
  rawOutput?: string;
  /** Model id used for the rewrite. / 改写所用模型 id。 */
  model: string;
  /** Wall-clock duration of the rewrite call in milliseconds. / 改写调用耗时（毫秒）。 */
  elapsedMs: number;
  /** Name of the safety guard that rewrote the fallback, e.g. 'anti-divergence'. / 触发回退的安全守卫名，如 'anti-divergence'。 */
  guardTriggered?: string;
}

/**
 * Error thrown by the rewrite pipeline with a stable machine-readable code and optional raw output for diagnosis.
 * 改写流水线抛出的错误，带稳定的机器可读 code 与可选原始输出以便诊断。
 */
export class WikiQueryRewriteError extends Error {
  /** Stable error code. / 稳定错误码。 */
  readonly code: string;
  /** Raw model output captured when the failure occurred. / 失败时捕获的原始模型输出。 */
  readonly rawOutput?: string;

  /**
   * Create a WikiQueryRewriteError.
   * 创建 WikiQueryRewriteError。
   *
   * @param code - Stable error code / 稳定错误码
   * @param message - Human-readable error message / 面向用户的错误信息
   * @param rawOutput - Optional raw model output for diagnosis / 可选的诊断用原始模型输出
   */
  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = 'WikiQueryRewriteError';
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

/**
 * Decide whether the rewrite model call is needed: quick actions already have stable intent and skip the extra
 * call; free-form questions are rewritten only when context must be resolved or the user explicitly names the
 * whole document/chapters. "这里" stays anchored to the current node and is not treated as historical anaphora.
 * 快捷动作已有稳定意图，不额外花一次模型调用；自由问答只在需要消解上下文，
 * 或用户显式点名全文/章节时改写。"这里"保留为当前节点锚点，不视作历史指代。
 *
 * @param input.userText - Current user text / 当前用户文本
 * @param input.conversation - Recent conversation turns / 最近对话轮次
 * @param input.actionKind - Quick action kind of this turn / 本轮快捷动作类型
 * @returns Gate decision with reason and matched signals / 带原因与命中信号的闸门决策
 */
export function shouldRewriteWikiQuestion(input: {
  userText: string;
  conversation: AssistantConversationMessage[];
  actionKind: WikiActionKind;
}): WikiQueryRewriteGateDecision {
  if (input.actionKind !== 'free') {
    return { rewriting: false, reason: 'quick-action', matchedSignals: [] };
  }

  const text = input.userText.trim();
  if (hasExplicitWikiNodeLock(text)) {
    return { rewriting: false, reason: 'explicit-node-lock', matchedSignals: [] };
  }
  const explicitSections = extractExplicitWikiSectionReferences(text);
  if (hasExplicitWikiDocumentScope(text) || explicitSections.length > 0) {
    return {
      rewriting: true,
      reason: 'explicit-section-reference',
      matchedSignals: explicitSections.map((title) => `section:${title}`),
    };
  }
  if (input.conversation.length === 0) {
    return { rewriting: false, reason: 'no-history', matchedSignals: [] };
  }

  const matchedSignals: string[] = [];
  for (const marker of ANAPHORA_MARKERS) if (text.includes(marker)) matchedSignals.push(`anaphora:${marker}`);
  for (const starter of FOLLOWUP_STARTERS) if (text.startsWith(starter)) matchedSignals.push(`followup:${starter}`);
  for (const ending of ELLIPSIS_ENDINGS) if (text.endsWith(ending)) matchedSignals.push(`ellipsis:${ending}`);
  // "这里/本节/..." anchor to the current node and must not trigger history-based rewrite.
  // 「这里/本节/…」锚定当前节点，不触基于历史的改写。
  const anchoredToCurrentNode = /这里|本节|本章|当前章节|当前节点/u.test(text);
  if (text.length < SHORT_FOLLOWUP_CHARS && !anchoredToCurrentNode) matchedSignals.push('short-followup');
  if (matchedSignals.length > 0) {
    return { rewriting: true, reason: 'follow-up', matchedSignals };
  }
  return { rewriting: false, reason: 'self-contained', matchedSignals: [] };
}

/**
 * Take the last few conversation turns and truncate each content to the history budget for the rewrite prompt.
 * 截取最近几轮对话并把每条内容截断到历史预算内，供改写提示词使用。
 *
 * @param conversation - Full conversation turns / 完整对话轮次
 * @returns Trimmed history messages / 截断后的历史消息
 */
export function selectWikiRewriteHistory(
  conversation: AssistantConversationMessage[],
): WikiRewriteHistoryMessage[] {
  return conversation.slice(-HISTORY_MESSAGE_COUNT).map((message) => ({
    role: message.role,
    content: message.content.slice(0, HISTORY_MESSAGE_MAX_CHARS),
  }));
}

const WIKI_QUERY_REWRITE_PROMPT = `你是 Trellora Wiki 的问题改写与范围识别器。
请结合最近对话和当前问题，只返回以下 JSON：
{
  "rewrite": "可独立检索的问题",
  "should_split": false,
  "sub_questions": ["子问题"],
  "scope_intent": "node-first",
  "explicit_section_titles": []
}

规则：
1. 只做指代消解、上下文补全和轻量口语规范化，不得扩写用户意图。
2. 保留专有名词、编号、时间、角色、环境以及“只看本节/结合全文”等范围限制。
3. 只有原问题明确包含多个独立问题时才允许拆分，最多 3 个；否则 should_split=false。
4. scope_intent 只能是 node-locked、node-first、document-first。只看当前章节为 node-locked；明确全文、其他章节或点名章节为 document-first；其余为 node-first。
5. explicit_section_titles 只列出当前问题原文明确点名的章节标题或“第 X 章/节”，不得猜测目录。
6. 不回答问题，不生成章节概览、建议问题或检索计划。

<history>
{{history}}
</history>
<question>
{{question}}
</question>`;

const WIKI_QUERY_REWRITE_JSON_SCHEMA = {
  name: 'wiki_query_rewrite',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      rewrite: { type: 'string' },
      should_split: { type: 'boolean' },
      sub_questions: { type: 'array', items: { type: 'string' } },
      scope_intent: { type: 'string', enum: ['node-locked', 'node-first', 'document-first'] },
      explicit_section_titles: { type: 'array', items: { type: 'string' } },
    },
    required: ['rewrite', 'should_split', 'sub_questions', 'scope_intent', 'explicit_section_titles'],
    additionalProperties: false,
  },
} as const;

/**
 * Build the rewrite prompt by injecting truncated history and the current question.
 * 通过注入截断后的历史和当前问题来构建改写提示词。
 *
 * @param input.question - Current user question / 当前用户问题
 * @param input.history - Trimmed conversation history / 截断后的对话历史
 * @returns Assembled rewrite prompt string / 拼装后的改写提示词
 */
export function buildWikiQueryRewritePrompt(input: {
  question: string;
  history: WikiRewriteHistoryMessage[];
}): string {
  const history = input.history
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${escapeXmlText(message.content)}`)
    .join('\n');
  return WIKI_QUERY_REWRITE_PROMPT
    .replace('{{history}}', history || '（无）')
    .replace('{{question}}', escapeXmlText(input.question));
}

/**
 * Execute the full query-rewrite pipeline: gate decision, model call, output normalization, and scope resolution.
 * 执行完整的查询改写流水线：闸门决策、模型调用、输出归一化和范围解析。
 *
 * @param input.question - Raw user question / 原始用户问题
 * @param input.history - Conversation history for coreference resolution / 用于指代消解的对话历史
 * @param input.actionKind - Quick action kind / 快捷动作类型
 * @param input.model - Model identifier / 模型标识
 * @param input.providerConfig - Optional AI provider config / 可选的 AI 提供方配置
 * @param input.contextWindowTokens - Optional context window size / 可选的上下文窗口大小
 * @param input.signal - Abort signal / 中止信号
 * @returns Validated rewrite result / 校验后的改写结果
 */
export async function rewriteWikiQuestion(input: {
  question: string;
  history: WikiRewriteHistoryMessage[];
  actionKind: WikiActionKind;
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  signal: AbortSignal;
}): Promise<WikiQueryRewriteResult> {
  const startedAt = Date.now();
  let rawOutput: string | undefined;
  let value: unknown;
  try {
    value = await generateAiJson({
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      prompt: buildWikiQueryRewritePrompt({ question: input.question, history: input.history }),
      maxOutputTokens: WIKI_QUERY_REWRITE_MAX_OUTPUT_TOKENS,
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      timeoutMs: WIKI_QUERY_REWRITE_TIMEOUT_MS,
      signal: input.signal,
      callKind: 'query-rewrite',
      jsonSchema: WIKI_QUERY_REWRITE_JSON_SCHEMA,
      onRawResponse: (text) => { rawOutput = text; },
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new WikiQueryRewriteError(
      'rewrite-call-failed',
      error instanceof Error ? error.message : String(error),
      rawOutput,
    );
  }

  if (!value || typeof value !== 'object') {
    throw new WikiQueryRewriteError('invalid-rewrite', 'Wiki 问题改写结果不是对象。', rawOutput);
  }
  const record = value as Record<string, unknown>;
  const rewriteRaw = typeof record.rewrite === 'string' ? record.rewrite.trim() : '';
  if (!rewriteRaw || rewriteRaw.length > REWRITE_MAX_CHARS) {
    throw new WikiQueryRewriteError('invalid-rewrite', 'Wiki 问题改写结果为空或过长。', rawOutput);
  }

  const originalQuestion = input.question.trim();
  let rewrite = rewriteRaw;
  let guardTriggered: string | undefined;
  if (rewrite.length > originalQuestion.length * 2 + 40) {
    rewrite = originalQuestion;
    guardTriggered = 'anti-divergence';
  }

  const normalizedSubQuestions = normalizeStringList(
    record.sub_questions,
    SUB_QUESTION_MAX_COUNT,
    SUB_QUESTION_MAX_CHARS,
  );
  if (normalizedSubQuestions === undefined) {
    throw new WikiQueryRewriteError('invalid-sub-questions', 'Wiki 子问题格式无效。', rawOutput);
  }
  const shouldSplit = record.should_split === true && normalizedSubQuestions.length >= 2;
  const subQuestions = shouldSplit ? normalizedSubQuestions : [rewrite];

  const suggestedScope = normalizeSuggestedScope(record.scope_intent);
  const scopeDecision = resolveWikiScopeDecision({
    actionKind: input.actionKind,
    userText: originalQuestion,
    suggestedMode: suggestedScope,
  });
  const explicitSectionTitles = normalizeExplicitSectionTitles(
    record.explicit_section_titles,
    originalQuestion,
  );

  return {
    rewrite,
    shouldSplit,
    subQuestions,
    scopeIntent: scopeDecision.mode,
    explicitSectionTitles,
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    model: input.model,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(guardTriggered ? { guardTriggered } : {}),
  };
}

/**
 * Extract explicit Chinese ordinal section references (e.g. 第三章, 第12节) from a question.
 * 从问题中提取显式的中文序数章节引用（如 第三章、第12节）。
 *
 * @param question - User question text / 用户问题文本
 * @returns Deduplicated section reference strings / 去重后的章节引用字符串
 */
export function extractExplicitWikiSectionReferences(question: string): string[] {
  return [...new Set(question.match(SECTION_REFERENCE_PATTERN) ?? [])];
}

function normalizeSuggestedScope(value: unknown): WikiScopeMode | undefined {
  return value === 'node-locked' || value === 'node-first' || value === 'document-first'
    ? value
    : undefined;
}

function normalizeStringList(value: unknown, maxCount: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value.slice(0, maxCount)) {
    if (typeof item !== 'string') return undefined;
    const normalized = item.trim().slice(0, maxChars);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeExplicitSectionTitles(value: unknown, originalQuestion: string): string[] {
  const fromModel = normalizeStringList(value, EXPLICIT_SECTION_MAX_COUNT, EXPLICIT_SECTION_MAX_CHARS) ?? [];
  const literalModelTitles = fromModel.filter((title) => originalQuestion.includes(title));
  return [...new Set([
    ...extractExplicitWikiSectionReferences(originalQuestion),
    ...literalModelTitles,
  ])].slice(0, EXPLICIT_SECTION_MAX_COUNT);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}
