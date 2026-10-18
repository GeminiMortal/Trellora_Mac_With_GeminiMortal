/**
 * Knowledge-base question rewrite: rewrite gate (rule-only exclusion) and LLM rewrite
 * service (anaphora resolution, context completion, explicit multi-question splitting).
 * Rewrite only affects the retrieval query; the original user text is preserved in the prompt.
 * 知识库问答问题改写：改写门（纯规则排除）与 LLM 改写服务（指代消解/上下文补全/显式多问拆分）。
 * 改写只影响检索 query，不替换回答 prompt 中的用户原文。
 */
import { generateAiJson } from '../ai/aiProvider.ts';
import type { AiProviderConfig } from '../ai/aiTypes.ts';
import type { QaRecentTurn } from '../qa/qaMemoryTypes.ts';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';

/** Anaphora / anaphoric markers: substring match, v1 without tokenization. / 指代/回指信号：substring 匹配，v1 不做分词。 */
const ANAPHORA_MARKERS = [
  '它们', '他们', '她们', '它', '他', '她', '其', '该',
  '上述', '上面', '以上', '刚才', '之前', '前面', '上一轮',
  '这个', '那个', '这部', '这篇', '这份',
];

/** Follow-up starter signals: startsWith match. / 承接式开头信号：startsWith 匹配。 */
const FOLLOWUP_STARTERS = ['那么', '然后', '接着', '继续', '再', '还有', '另外', '如果', '要是', '那'];

/** Ellipsis-ending signals: endsWith match. / 省略式追问信号：endsWith 匹配。 */
const ELLIPSIS_ENDINGS = ['呢？', '呢?', '呢'];

/** Max output tokens for the query rewrite LLM call. / 查询改写 LLM 调用的最大输出 token 数。 */
export const QUERY_REWRITE_MAX_OUTPUT_TOKENS = 1024;
/** Timeout in milliseconds for the query rewrite LLM call. / 查询改写 LLM 调用的超时毫秒数。 */
export const QUERY_REWRITE_TIMEOUT_MS = 15_000;
const REWRITE_MAX_CHARS = 300;
const SUB_QUESTION_MAX_COUNT = 3;
const SUB_QUESTION_MAX_CHARS = 200;
const SHORT_FOLLOWUP_CHARS = 12;
const SELF_CONTAINED_MAX_CHARS = 120;
const HISTORY_TURN_COUNT = 3;
const HISTORY_ANSWER_HEAD_CHARS = 200;

/**
 * Decision output of the rewrite gate: whether rewriting is needed and why.
 * 改写门的决策输出：是否需要改写及原因。
 */
export interface QueryRewriteGateDecision {
  rewriting: boolean;
  /** Exclusion reason: no-history / self-contained. / 排除原因：no-history / self-contained。 */
  reason?: string;
  /** Matched admission signals, e.g. anaphora:它 / followup:那么 / ellipsis:呢 / short-followup. / 命中的放行信号。 */
  matchedSignals: string[];
}

/**
 * Rewrite gate (design §3): E1 no-history excludes immediately; admission signals trigger
 * rewrite; otherwise self-contained excludes. False-positive direction is "over-rewrite", the safe side.
 * 改写门（设计 §3）：E1 无历史直接排除 → 放行信号命中即改写 → 其余按自足排除。误判方向是「多改写」，安全方向。
 *
 * @param input - Object with userText and hasHistory flag. / 包含 userText 和 hasHistory 标志的对象。
 * @returns Gate decision with rewriting flag, reason and matched signals. / 包含 rewriting 标志、原因和命中信号的门控决策。
 */
export function shouldRewriteQuestion(input: { userText: string; hasHistory: boolean }): QueryRewriteGateDecision {
  const text = input.userText.trim();
  if (!input.hasHistory) return { rewriting: false, reason: 'no-history', matchedSignals: [] };
  const signals: string[] = [];
  for (const marker of ANAPHORA_MARKERS) if (text.includes(marker)) signals.push(`anaphora:${marker}`);
  for (const starter of FOLLOWUP_STARTERS) if (text.startsWith(starter)) signals.push(`followup:${starter}`);
  for (const ending of ELLIPSIS_ENDINGS) if (text.endsWith(ending)) signals.push(`ellipsis:${ending}`);
  if (text.length < SHORT_FOLLOWUP_CHARS) signals.push('short-followup');
  if (signals.length > 0) return { rewriting: true, matchedSignals: signals };
  if (text.length <= SELF_CONTAINED_MAX_CHARS) return { rewriting: false, reason: 'self-contained', matchedSignals: [] };
  return { rewriting: false, reason: 'self-contained', matchedSignals: [] };
}

/**
 * Selects the most recent completed turns for the rewrite prompt's <history> section;
 * answer heads are truncated to HISTORY_ANSWER_HEAD_CHARS.
 * 供改写 prompt 的 <history> 使用：最近若干已完成轮次，回答截头部。
 *
 * @param recentTurns - Recent QA turns. / 最近的问答轮次。
 * @returns Truncated turns suitable for the rewrite prompt. / 适合改写 prompt 的截断轮次。
 */
export function selectRewriteHistoryTurns(recentTurns: QaRecentTurn[]): QaRecentTurn[] {
  return recentTurns.slice(-HISTORY_TURN_COUNT).map((turn) => ({
    userText: turn.userText,
    answerHead: turn.answerHead.slice(0, HISTORY_ANSWER_HEAD_CHARS),
  }));
}

/**
 * Error thrown by the query rewrite service with a stable error code and optional raw output.
 * 查询改写服务抛出的错误，带稳定错误码和可选的原始输出。
 */
export class QueryRewriteError extends Error {
  readonly code: string;
  readonly rawOutput?: string;

  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = 'QueryRewriteError';
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

/**
 * Graph intent classification for GraphRAG routing.
 * GraphRAG 路由的图意图分类。
 */
export type KnowledgeGraphIntent = 'global' | 'local' | 'none';

/**
 * Result of a successful query rewrite operation.
 * 查询改写操作成功后的结果。
 */
export interface QueryRewriteResult {
  rewrite: string;
  shouldSplit: boolean;
  subQuestions: string[];
  /**
   * Graph intent gating (GraphRAG design §4.3): holistic/trend/cross-topic → global;
   * concrete entity/relation → local; otherwise none.
   * 图意图门控（GraphRAG 方案 §4.3）：整体性/趋势/跨主题 → global；具体实体/关系 → local；其余 none。
   */
  graphIntent: KnowledgeGraphIntent;
  rawOutput?: string;
  model: string;
  elapsedMs: number;
  /** Guard-triggered flag set by anti-divergence or other programmatic guardrails. / 防发散等程序化护栏触发标记。 */
  guardTriggered?: string;
}

/**
 * Observation event emitted when the query rewrite provider call completes or fails.
 * 查询改写 provider 调用完成或失败时发出的观察事件。
 */
export interface QueryRewriteProviderCallObservationEvent {
  request: {
    model: string;
    prompt: string;
    maxOutputTokens: number;
    contextWindowTokens?: number;
    structuredOutputSchema: typeof QUERY_REWRITE_JSON_SCHEMA;
  };
  usage?: AssistantTokenUsage;
  responseCompleted: boolean;
}

const QUERY_REWRITE_SYSTEM_PROMPT = `你是企业文档问答系统的问题改写助手。
请结合历史上下文和当前问题，输出一个 JSON：
{
  "rewrite": "改写后的独立问题",
  "should_split": true,
  "sub_questions": ["子问题1", "子问题2"],
  "graph_intent": "none"
}

改写规则：
1. 只做指代消解、上下文补全、口语转书面化，不要发散扩写。
2. 专有名词、时间范围、环境、角色、终端类型等限制条件必须保留。
3. 不得添加原文没有的条件、维度、假设，不得引入"方面/维度/角度"等枚举词。
4. 如果当前问题已经完整，就尽量少改。
5. 不要根据你自己的理解去提前规划章节、结构或检索模式。

拆分规则：
1. 默认 should_split=false，sub_questions 只保留 1 条，且必须与 rewrite 表达同一件事。
2. 只有当前问题原文里显式存在多个独立问题时，才允许 should_split=true。
3. 可拆分的典型情况只有：多个问号、分号、换行列举、编号列举、明确"分别"提问。
4. 抽象对比、笼统追问、承接式追问一律不要拆分；只做改写。
5. 不确定时必须不拆分。
6. 只返回合法 JSON，不要输出额外解释。

图意图判定（graph_intent，只能取 global / local / none）：
1. 整库概览、主题脉络、跨文档趋势与共性总结等整体性问题 → global。
2. 围绕具体实体（人/组织/项目/概念）的关系、关联脉络类问题 → local。
3. 其余（普通内容检索、字面量查找、闲聊等）→ none。
4. 不确定时给 none。

历史上下文：
<history>

当前问题：
<question>`;

const QUERY_REWRITE_JSON_SCHEMA = {
  name: 'query_rewrite',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      rewrite: { type: 'string' },
      should_split: { type: 'boolean' },
      sub_questions: { type: 'array', items: { type: 'string' } },
      graph_intent: { type: 'string' },
    },
    required: ['rewrite', 'should_split', 'sub_questions', 'graph_intent'],
    additionalProperties: false,
  },
} as const;

/**
 * Builds the full prompt for the query rewrite LLM call from question and history.
 * 根据问题和历史构建查询改写 LLM 调用的完整 prompt。
 *
 * @param input - Object containing question, history turns and optional asker background. / 包含问题、历史轮次和可选提问者背景的对象。
 * @returns Assembled prompt string. / 拼装后的 prompt 字符串。
 */
export function buildQueryRewritePrompt(input: { question: string; history: QaRecentTurn[]; askerBackground?: string }): string {
  const historyText = input.history
    .map((turn) => `用户：${turn.userText}\n助手：${turn.answerHead}`)
    .join('\n\n');
  const prompt = QUERY_REWRITE_SYSTEM_PROMPT
    .replace('<history>', historyText)
    .replace('<question>', input.question);
  const background = input.askerBackground?.trim();
  return background ? `${background}\n\n${prompt}` : prompt;
}

function normalizeSubQuestions(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value.slice(0, SUB_QUESTION_MAX_COUNT)) {
    if (typeof item !== 'string') return undefined;
    const trimmed = item.trim();
    if (trimmed) result.push(trimmed.slice(0, SUB_QUESTION_MAX_CHARS));
  }
  return result;
}

/**
 * LLM rewrite service (design §4): calls the model to produce a rewritten question,
 * optional sub-questions and a graph intent. Throws QueryRewriteError on failure;
 * AbortSignal cancellation propagates unchanged.
 * LLM 改写服务（设计 §4）：调用模型生成改写问题、可选子问题与图意图。
 * 失败抛 QueryRewriteError；AbortSignal 取消原样上抛。
 *
 * @param input - Rewrite request with question, history, model config and signal. / 包含问题、历史、模型配置和 signal 的改写请求。
 * @returns Rewrite result with rewrite text, split decision and graph intent. / 包含改写文本、拆分决策和图意图的改写结果。
 */
export async function rewriteKnowledgeQuestion(input: {
  question: string;
  history: QaRecentTurn[];
  /** Only helps anaphora resolution and query rewrite; never a retrieval filter. / 仅帮助指代消解与查询改写，不得作为检索过滤条件。 */
  askerBackground?: string;
  model: string;
  providerConfig?: AiProviderConfig;
  contextWindowTokens?: number;
  signal: AbortSignal;
  /** Main-process-only S0 hook; it must not mutate the observed request. */
  onProviderCallObserved?: (event: QueryRewriteProviderCallObservationEvent) => void;
}): Promise<QueryRewriteResult> {
  const startedAt = Date.now();
  let rawOutput: string | undefined;
  let value: unknown;
  let usage: AssistantTokenUsage | undefined;
  const observationRequest: QueryRewriteProviderCallObservationEvent['request'] = {
    model: input.model,
    prompt: buildQueryRewritePrompt({
      question: input.question,
      history: input.history,
      ...(input.askerBackground ? { askerBackground: input.askerBackground } : {}),
    }),
    maxOutputTokens: QUERY_REWRITE_MAX_OUTPUT_TOKENS,
    ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
    structuredOutputSchema: QUERY_REWRITE_JSON_SCHEMA,
  };
  try {
    value = await generateAiJson({
      model: input.model,
      ...(input.providerConfig ? { providerConfig: input.providerConfig } : {}),
      prompt: observationRequest.prompt,
      maxOutputTokens: QUERY_REWRITE_MAX_OUTPUT_TOKENS,
      ...(input.contextWindowTokens ? { contextWindowTokens: input.contextWindowTokens } : {}),
      timeoutMs: QUERY_REWRITE_TIMEOUT_MS,
      signal: input.signal,
      callKind: 'query-rewrite',
      jsonSchema: QUERY_REWRITE_JSON_SCHEMA,
      onUsage: (incoming) => { usage = incoming; },
      onRawResponse: (text) => { rawOutput = text; },
    });
    notifyProviderObservation(input.onProviderCallObserved, {
      request: observationRequest,
      usage,
      responseCompleted: true,
    });
  } catch (error) {
    notifyProviderObservation(input.onProviderCallObserved, {
      request: observationRequest,
      usage,
      responseCompleted: false,
    });
    if (input.signal.aborted) throw error;
    throw new QueryRewriteError('rewrite-call-failed', error instanceof Error ? error.message : String(error), rawOutput);
  }
  const record = value as Record<string, unknown>;
  const rewriteRaw = typeof record.rewrite === 'string' ? record.rewrite.trim() : '';
  if (!rewriteRaw) throw new QueryRewriteError('invalid-rewrite', '改写结果为空。', rawOutput);
  if (rewriteRaw.length > REWRITE_MAX_CHARS) throw new QueryRewriteError('invalid-rewrite', `改写结果超过 ${REWRITE_MAX_CHARS} 字符。`, rawOutput);

  // Anti-divergence guardrail (design §4.3 rule 2): fall back to the original text on overlong rewrites, no throw. / 防发散护栏（设计 §4.3 规则 2）：超长改写回退原文，不抛错。
  let rewrite = rewriteRaw;
  let guardTriggered: string | undefined;
  if (rewrite.length > input.question.trim().length * 2 + 40) {
    rewrite = input.question.trim();
    guardTriggered = 'anti-divergence';
  }

  let subQuestions = normalizeSubQuestions(record.sub_questions);
  if (subQuestions === undefined) throw new QueryRewriteError('invalid-sub-questions', '子问题格式无效。', rawOutput);
  subQuestions = [...new Set(subQuestions)];
  const shouldSplit = record.should_split === true && subQuestions.length >= 2;
  if (!shouldSplit) subQuestions = [rewrite];

  return {
    rewrite,
    shouldSplit,
    subQuestions,
    graphIntent: normalizeGraphIntent(record.graph_intent),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    model: input.model,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(guardTriggered ? { guardTriggered } : {}),
  };
}

function notifyProviderObservation(
  callback: ((event: QueryRewriteProviderCallObservationEvent) => void) | undefined,
  event: QueryRewriteProviderCallObservationEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // S0 diagnostics are isolated from query rewrite behavior.
  }
}

/**
 * Whitelist normalization of the graph intent: invalid/missing values fall back to
 * 'none' (the safe direction: never route to the graph).
 * 图意图白名单归一化：非法/缺失值一律落 none（安全方向：不做图路由）。
 *
 * @param value - Raw graph intent value from the model. / 模型返回的原始图意图值。
 * @returns Normalized graph intent: 'global', 'local' or 'none'. / 归一化后的图意图：'global'、'local' 或 'none'。
 */
export function normalizeGraphIntent(value: unknown): KnowledgeGraphIntent {
  if (value === 'global' || value === 'local') return value;
  return 'none';
}