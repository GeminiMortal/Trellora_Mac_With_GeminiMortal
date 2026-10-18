/**
 * Current-note Planner driver: builds the planner prompt, runs plan/repair model
 * calls, validates planner output and provides an emergency lexical fallback plan.
 * 当前笔记 Planner 驱动：构建 planner prompt、执行 plan/修复模型调用、
 * 校验 planner 输出，并提供应急词法兜底计划。
 */
/**
 * Current-note search plan driver: creates prompts for the structured Planner, validates
 * and repairs Planner output, and provides a fallback plan when the model cannot produce one.
 * 当前笔记搜索计划驱动器：为结构化 Planner 创建 prompt，校验与修复 Planner 输出，
 * 并在模型无法生成计划时提供兜底计划。
 */
import type { AssistantConversationMessage, CurrentNoteContextMode } from '../assistant/assistantTurnTypes.ts';
import { serializeNoteCapsule, type NoteCapsule } from '../currentNote/currentNoteCapsule.ts';
import { normalizeTechnicalTerm } from '../index/lexicalMatchPolicy.ts';
import { createSearchPlanFromPlanner, createSearchPlan } from './searchPlanValidation.ts';
import { DEFAULT_SEARCH_PLAN_BUDGET, SEARCH_QUERY_TERM_BATCH_SIZE, type SearchPlan } from './searchPlanTypes.ts';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';
import type { ModelCallKind } from '../ai/modelCallBudget.ts';
import { shouldUseCurrentNotePlanner as modeAllowsCurrentNotePlanner, type AssistantPlanMode } from '../assistant/assistantMode.ts';
import {
  createFallbackCurrentNoteSearchScope,
  resolveCurrentNoteSearchScope,
  type CurrentNoteSearchScope,
} from '../currentNote/currentNoteSearchScope.ts';
import { DEFAULT_PLAN_JSON_SCHEMA, toStructuredOutputSchema } from '../plan/planAwarePromptProjector.ts';
import { listToolCapabilities } from '../model/toolCapabilityCatalog.ts';

/** Re-exported plan modes for callers of this driver. / 为本驱动的调用方再导出计划模式。 */
export { assistantPlanModes } from '../assistant/assistantMode.ts';
/** Re-exported plan-mode type for callers of this driver. / 为本驱动的调用方再导出计划模式类型。 */
export type { AssistantPlanMode } from '../assistant/assistantMode.ts';

/** Input for one Planner request. / 单次 Planner 请求的输入。 */
/**
 * Input for the current-note Planner model call.
 * 当前笔记 Planner 模型调用的输入。
 */
export interface CurrentNotePlannerInput {
  capsule: NoteCapsule;           /** Stable structural capsule of the current note. / 当前笔记的稳定结构化 Capsule。 */
  question: string;
  conversation: AssistantConversationMessage[];
  signal: AbortSignal;
  /** Main-process emergency retry may supply a compacted projection. / 主进程应急重试可提供压缩后的投影 prompt。 */
  prompt?: string;
  maxOutputTokens?: number;
  onUsage?: (usage: AssistantTokenUsage) => void;
}

/** Driver contract: produce a plan, or repair a previously invalid one. / 驱动契约：生成计划，或修复此前不合法的输出。 */
/**
 * Driver interface for planning and repairing current-note search plans.
 * 当前笔记搜索计划的规划与修复驱动接口。
 */
export interface CurrentNotePlanDriver {
  plan(input: CurrentNotePlannerInput): Promise<CurrentNotePlanResult>;
  repair(input: CurrentNotePlannerRepairInput): Promise<CurrentNotePlanResult>;
}

/** Repair input carrying the rejected output and the fields allowed to change. / 修复输入，携带被拒输出与允许修改的字段。 */
/**
 * Extended planner input for field-level repair of invalid Planner output.
 * 用于 Planner 输出字段级修复的扩展输入。
 */
export interface CurrentNotePlannerRepairInput extends CurrentNotePlannerInput {
  invalidOutput: unknown;              /** The rejected planner output. / 被拒绝的 planner 输出。 */
  invalidFields: readonly string[];    /** Field paths the repair may rewrite. / 修复可改写的字段路径。 */
  validationMessage: string;           /** Validation failure message. / 校验失败信息。 */
}

/** Pre-rendered prompt sections for custom renderers. / 供自定义渲染器使用的预切分 prompt 片段。 */
/**
 * Sections that compose the current-note Planner prompt.
 * 组成当前笔记 Planner prompt 的各段落。
 */
export interface CurrentNotePlanPromptSections {
  policy: string;
  toolInstructions: readonly { name: string; description: string }[];
  capsuleText: string;
  conversation: readonly AssistantConversationMessage[];
  conversationText: string;
  question: string;
}

/** Result of a successful plan call. / 一次成功 plan 调用的结果。 */
/**
 * Result of a successful Planner call: validated plan, resolved scope and optional JSON output.
 * Planner 调用成功的结果：已校验的计划、已解析的作用域和可选的 JSON 输出。
 */
export interface CurrentNotePlanResult {
  plan: SearchPlan;
  scope: CurrentNoteSearchScope;
  /** Exact Planner JSON after schema validation and local-path redaction. / Schema 校验与本地路径脱敏后的 Planner 原始 JSON。 */
  plannerOutputJson?: string;
}

/**
 * Thrown when planner output fails local plan validation.
 * planner 输出未通过本地计划校验时抛出。
 */
/**
 * Error thrown when the Planner output fails local plan validation.
 * Planner 输出未通过本地计划校验时抛出的错误。
 */
export class CurrentNotePlanValidationError extends Error {
  readonly code = 'CURRENT_NOTE_PLAN_VALIDATION';
  readonly plannerOutput: unknown;       /** The rejected planner output. / 被拒绝的 planner 输出。 */
  readonly invalidFields: readonly string[]; /** Fields that failed validation. / 校验失败的字段。 */

  constructor(message = 'Planner 输出未通过本地计划校验。', options?: {
    cause?: unknown;
    plannerOutput?: unknown;
    invalidFields?: readonly string[];
  }) {
    super(message, options);
    this.name = 'CurrentNotePlanValidationError';
    this.plannerOutput = options?.plannerOutput;
    this.invalidFields = Object.freeze([...(options?.invalidFields ?? [])]);
  }
}

/**
 * Type guard for CurrentNotePlanValidationError, tolerant of cross-realm errors.
 * CurrentNotePlanValidationError 的类型守卫，容忍跨 realm 错误对象。
 */
/**
 * Type guard: checks whether an error is a CurrentNotePlanValidationError.
 * 类型守卫：检查错误是否为 CurrentNotePlanValidationError。
 *
 * @param error - The error to check. / 待检查的错误。
 * @returns True if the error is a CurrentNotePlanValidationError. / 是否为 CurrentNotePlanValidationError。
 */
export function isCurrentNotePlanValidationError(error: unknown): error is CurrentNotePlanValidationError {
  return error instanceof CurrentNotePlanValidationError
    || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'CURRENT_NOTE_PLAN_VALIDATION');
}

/** A fallback search plan with a non-enumerable scope attachment. / 带不可枚举 scope 附加属性的兜底搜索计划。 */
/** A fallback search plan that carries its own resolved scope. / 携带已解析作用域的兜底搜索计划。 */
export type CurrentNoteFallbackPlan = SearchPlan & { readonly scope: CurrentNoteSearchScope };

/** Frozen list of tool descriptions available to the current-note Planner. / 当前笔记 Planner 可用的冻结工具描述列表。 */
export const currentNotePlannerToolDescriptions = Object.freeze(
  listToolCapabilities('current-note')
    .filter((tool) => tool.phase === 'navigation')
    .map(({ name, description }) => ({ name, description })),
);

/** Patterns for mining emergency fallback query terms from a question. / 从问题中提取应急兜底查询词的正则。 */
const FALLBACK_IDENTIFIER_PATTERN = /[A-Za-z][A-Za-z0-9_./:-]*|\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?/gu;
const FALLBACK_CHINESE_PHRASE_PATTERN = /[\u3400-\u9fff]{2,}/gu;
const FALLBACK_ENGLISH_BOILERPLATE = new Set(['what', 'is', 'the', 'a', 'an', 'about', 'current', 'note', 'please', 'tell', 'me', 'explain']);
const FALLBACK_CHINESE_SCAFFOLD_PATTERN = /请你|请问|请|帮我|帮忙|麻烦|阅读(?:当前)?笔记|阅读笔记|阅读|基于|根据|结合|当前这篇笔记|当前笔记|这篇笔记|本篇笔记|告诉我|告诉|我想知道|能否|可以|解释一下|解释|说明一下|说明|分析一下|分析|是什么|是啥|啥是|什么意思|怎么回事|如何|为什么|有哪些|什么|一下|关于|笔记(?:中|里|内)?|当前/gu;

/**
 * Creates the plan/repair driver around an injected JSON generator.
 * 基于注入的 JSON 生成器创建 plan/修复驱动。
 */
/**
 * Factory that creates a CurrentNotePlanDriver backed by a JSON-generating model call.
 * 创建由 JSON 生成模型调用支撑的 CurrentNotePlanDriver 的工厂函数。
 *
 * @param input - Object with a generateJson function for model calls. / 包含 generateJson 模型调用函数的对象。
 * @returns A plan driver with plan() and repair() methods. / 带 plan() 和 repair() 方法的计划驱动器。
 */
export function createCurrentNotePlanDriver(input: {
  generateJson: (request: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: { name: string; strict: true; schema: Record<string, unknown> }; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void }) => Promise<unknown>;
}): CurrentNotePlanDriver {
  return {
    async plan(request) {
      const value = await input.generateJson({
        prompt: request.prompt ?? createCurrentNotePlanPrompt(request),
        signal: request.signal,
        callKind: 'plan',
        jsonSchema: toStructuredOutputSchema('current_note_plan', DEFAULT_PLAN_JSON_SCHEMA),
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.onUsage ? { onUsage: request.onUsage } : {}),
      });
      return createValidatedCurrentNotePlanResult(value, request);
    },
    async repair(request) {
      if (request.invalidFields.length === 0) {
        throw new CurrentNotePlanValidationError('Planner 输出没有可安全修复的字段。', {
          plannerOutput: request.invalidOutput,
        });
      }
      const value = await input.generateJson({
        prompt: request.prompt ?? createCurrentNotePlanRepairPrompt(request),
        signal: request.signal,
        callKind: 'plan',
        jsonSchema: {
          name: 'current_note_plan_field_repair',
          strict: true,
          schema: createPlannerFieldRepairSchema(request.invalidFields),
        },
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.onUsage ? { onUsage: request.onUsage } : {}),
      });
      try {
        const repaired = applyPlannerFieldRepairs(request.invalidOutput, value, request.invalidFields);
        return createValidatedCurrentNotePlanResult(repaired, request);
      } catch (error) {
        throw new CurrentNotePlanValidationError(
          error instanceof Error ? error.message : undefined,
          { cause: error, plannerOutput: request.invalidOutput },
        );
      }
    },
  };
}

function createValidatedCurrentNotePlanResult(
  value: unknown,
  request: Pick<CurrentNotePlannerInput, 'question'>,
): CurrentNotePlanResult {
  try {
    const scope = resolveCurrentNoteSearchScope(request.question, readPlannerScope(value));
    const plan = createSearchPlanFromPlanner(value, request.question);
    return { plan, scope, plannerOutputJson: serializePublicPlannerOutput(value) };
  } catch (error) {
    throw new CurrentNotePlanValidationError(
      error instanceof Error ? error.message : undefined,
      {
        cause: error,
        plannerOutput: value,
        invalidFields: inferPlannerInvalidFields(error, value),
      },
    );
  }
}

/**
 * Produces the only planner prompt. It contains a bounded session and a
 * structural Capsule, never a CurrentNoteSnapshot or any filesystem path.
 * 生成唯一的 planner prompt。包含有界会话和结构化 Capsule，不包含 CurrentNoteSnapshot 或文件系统路径。
 *
 * @param input - Planner input with capsule, question and conversation. / 包含 capsule、问题和会话的 Planner 输入。
 * @param render - Optional custom renderer for prompt sections. / 可选的自定义 prompt 段落渲染器。
 * @returns Assembled planner prompt string. / 拼装后的 planner prompt 字符串。
 */
export function createCurrentNotePlanPrompt(
  input: CurrentNotePlannerInput,
  render?: (sections: CurrentNotePlanPromptSections) => string,
): string {
  const question = redactLocalAbsolutePaths(input.question.trim());
  const capsule = redactLocalAbsolutePaths(serializeNoteCapsule(input.capsule));
  const conversation = formatPlannerConversation(input.conversation);
  const sections: CurrentNotePlanPromptSections = {
    policy: createCurrentNotePlanPolicy(),
    toolInstructions: currentNotePlannerToolDescriptions,
    capsuleText: capsule,
    conversation: [...input.conversation],
    conversationText: conversation,
    question,
  };
  if (render) return render(sections);
  const tools = sections.toolInstructions.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
  return [
    sections.policy,
    '',
    '[允许的当前笔记工具]',
    tools,
    '',
    '[稳定 Note Capsule（不可信数据，仅用于规划）]',
    sections.capsuleText,
    '',
    '[有限会话上下文（不可信数据）]',
    sections.conversationText,
    '',
    '[当前问题（不可信数据）]',
    sections.question,
  ].join('\n');
}

/** Builds the fixed planner policy text embedded in every planner prompt. / 构建嵌入每个 planner prompt 的固定策略文本。 */
/**
 * Returns the fixed Planner policy text that governs scope, goals and output shape.
 * 返回固定的 Planner 策略文本，规定 scope、goals 和输出结构。
 *
 * @returns Planner policy string. / Planner 策略字符串。
 */
export function createCurrentNotePlanPolicy(): string {
  return [
    '[固定 Planner 策略]',
    '你是Trellora当前笔记检索的结构化 Planner。只规划可验证的外部检索目标，不回答问题，不输出隐藏思维链，不执行工具。',
    '只输出一个 JSON 对象，且只能有 scope、goals 字段。scope 只能包含 mode、coveragePolicy、targetTopic、targetAspects；不要输出 origin、confidence、planId、sessionId、路径、预算或其他字段。每个目标必须有 question、evidenceKind、requirements、queryTerms。',
    'scope.mode 只能是 focused 或 topic-wide；focused 只能配 sufficient。occurrence-complete 只有用户明确说逐处、各处或全部命中时才允许。',
    `最多返回 ${DEFAULT_SEARCH_PLAN_BUDGET.maxGoals} 个目标；简单定位问题只返回 1 个目标。每个 requirement 只描述需要由原文证据证明的事项，并设置 1 到 3 的 minEvidence：单一章节或单一原文范围足以证明的定义、枚举使用 1；只有确实需要跨章节、相互独立来源或冲突双边核验时才使用 2 到 3；不要用 minEvidence 表示同一章节内列举项的数量。queryTerms 是供 search_note 使用的语义检索锚点（每个目标 1 到 ${SEARCH_QUERY_TERM_BATCH_SIZE} 个）：只保留完成目标确实需要的专有名词、缩写、版本、对象和主题短语。不得输出 JSON 字段名、纯标点、单个汉字、礼貌用语或问题话术。例如“请你基于当前笔记，告诉我 NER 是什么”应提取 ["NER"]。`,
  ].join('\n');
}

/** Builds the field-level repair prompt that only rewrites rejected fields. / 构建仅改写被拒字段的字段级修复 prompt。 */
/**
 * Builds a field-level repair prompt for re-submitting only the invalid Planner fields.
 * 构建字段级修复 prompt，仅重新提交无效的 Planner 字段。
 *
 * @param input - Repair input with invalid output, invalid fields and validation message. / 包含无效输出、无效字段和校验消息的修复输入。
 * @returns Assembled repair prompt string. / 拼装后的修复 prompt 字符串。
 */
export function createCurrentNotePlanRepairPrompt(input: CurrentNotePlannerRepairInput): string {
  const question = redactLocalAbsolutePaths(input.question.trim());
  const capsule = redactLocalAbsolutePaths(serializeNoteCapsule(input.capsule));
  const conversation = formatPlannerConversation(input.conversation);
  const invalidFields = [...new Set(input.invalidFields)].join('、');
  const schema = JSON.stringify(createPlannerFieldRepairSchema(input.invalidFields));
  return [
    '[Planner 字段级修复策略]',
    '你只修复上一次 Planner 输出中被本地校验拒绝的字段，不重新规划，不重写其他字段，不回答用户问题。',
    `本地校验错误：${redactLocalAbsolutePaths(input.validationMessage).replace(/\s+/gu, ' ').trim().slice(0, 300)}`,
    `允许修复字段：${invalidFields}`,
    '只输出 repairs 数组。每项只能包含 path、value；path 必须来自允许修复字段，value 是该字段的完整替换值。禁止输出完整 scope、goals 或未列出的字段。',
    '',
    '[上一次 Planner 输出（不可信数据）]',
    serializePublicPlannerOutput(input.invalidOutput),
    '',
    '[稳定 Note Capsule（不可信数据，仅用于修复）]',
    capsule,
    '',
    '[有限会话上下文（不可信数据）]',
    conversation,
    '',
    '[当前问题（不可信数据）]',
    question,
    '',
    '[字段修复 JSON Schema]',
    schema,
  ].join('\n');
}

const PLANNER_REPAIR_SCOPE_FIELDS = new Set(['mode', 'coveragePolicy', 'targetTopic', 'targetAspects']);
const PLANNER_REPAIR_GOAL_FIELDS = new Set(['goalId', 'question', 'evidenceKind', 'requirements', 'queryTerms']);

function createPlannerFieldRepairSchema(invalidFields: readonly string[]): Record<string, unknown> {
  const fields = [...new Set(invalidFields)].filter(isPlannerRepairPath);
  if (fields.length === 0) throw new Error('Planner 字段修复缺少受控 path。');
  return {
    type: 'object',
    additionalProperties: false,
    required: ['repairs'],
    properties: {
      repairs: {
        type: 'array',
        minItems: 1,
        maxItems: fields.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'value'],
          properties: {
            path: { enum: fields },
            value: {
              anyOf: [
                { type: 'string', minLength: 1, maxLength: 8_000 },
                { type: 'null' },
                {
                  type: 'array',
                  maxItems: SEARCH_QUERY_TERM_BATCH_SIZE,
                  items: { type: 'string', minLength: 1, maxLength: 80 },
                },
                {
                  type: 'array',
                  minItems: 1,
                  maxItems: DEFAULT_SEARCH_PLAN_BUDGET.maxRequirementsPerGoal,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['requirementId', 'label', 'subject', 'minEvidence'],
                    properties: {
                      requirementId: { type: 'string' },
                      label: { type: 'string' },
                      subject: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                      minEvidence: { type: 'integer', minimum: 1, maximum: 3 },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function applyPlannerFieldRepairs(
  invalidOutput: unknown,
  repairOutput: unknown,
  invalidFields: readonly string[],
): unknown {
  if (!isPlainObject(invalidOutput)) throw new Error('上一次 Planner 输出不是可修复对象。');
  if (!isPlainObject(repairOutput) || Object.keys(repairOutput).some((key) => key !== 'repairs')) {
    throw new Error('Planner 字段修复输出只能包含 repairs。');
  }
  if (!Array.isArray(repairOutput.repairs) || repairOutput.repairs.length === 0) {
    throw new Error('Planner 字段修复输出缺少 repairs。');
  }
  const allowed = new Set(invalidFields.filter(isPlannerRepairPath));
  const repaired = structuredClone(invalidOutput);
  const seen = new Set<string>();
  for (const item of repairOutput.repairs) {
    if (!isPlainObject(item) || Object.keys(item).some((key) => key !== 'path' && key !== 'value')) {
      throw new Error('Planner 字段修复项只能包含 path、value。');
    }
    const path = typeof item.path === 'string' ? item.path : '';
    if (!allowed.has(path) || seen.has(path)) throw new Error(`Planner 字段修复 path 不允许或重复：${path || '(empty)'}。`);
    seen.add(path);
    const scopeMatch = /^scope\.(mode|coveragePolicy|targetTopic|targetAspects)$/u.exec(path);
    if (scopeMatch) {
      if (!isPlainObject(repaired.scope)) throw new Error('Planner scope 不是可修复对象。');
      repaired.scope[scopeMatch[1]] = item.value;
      continue;
    }
    const goalMatch = /^goals\.(\d+)\.(goalId|question|evidenceKind|requirements|queryTerms)$/u.exec(path);
    if (!goalMatch || !Array.isArray(repaired.goals)) throw new Error(`Planner 字段修复 path 无效：${path}。`);
    const goalIndex = Number(goalMatch[1]);
    const goal = repaired.goals[goalIndex];
    if (!Number.isInteger(goalIndex) || !isPlainObject(goal)) throw new Error(`Planner 字段修复目标不存在：${path}。`);
    goal[goalMatch[2]] = item.value;
  }
  return repaired;
}

function inferPlannerInvalidFields(error: unknown, value: unknown): string[] {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'focused-coverage' || code === 'occurrence-not-explicit') return ['scope.coveragePolicy'];
  if (code === 'invalid-aspects' || code === 'aspect-count' || code === 'duplicate-aspect') return ['scope.targetAspects'];
  if (/Planner scope\.mode/u.test(message)) return ['scope.mode'];
  if (/Planner scope\.coveragePolicy/u.test(message)) return ['scope.coveragePolicy'];
  if (/Planner scope\.targetTopic/u.test(message)) return ['scope.targetTopic'];
  if (/Planner scope\.targetAspects/u.test(message)) return ['scope.targetAspects'];

  const plannerGoalNumber = Number(/Planner 目标 (\d+)/u.exec(message)?.[1]);
  const explicitGoalNumber = Number(/目标 (\d+) 的/u.exec(message)?.[1]);
  const goalIndex = Number.isInteger(plannerGoalNumber) && plannerGoalNumber > 0
    ? plannerGoalNumber - 1
    : Number.isInteger(explicitGoalNumber) && explicitGoalNumber > 0 ? explicitGoalNumber - 1 : undefined;
  if (goalIndex !== undefined) {
    if (/queryTerms|语义锚点|查询词/u.test(message)) return [`goals.${goalIndex}.queryTerms`];
    if (/goalId/u.test(message)) return [`goals.${goalIndex}.goalId`];
    if (/evidenceKind/u.test(message)) return [`goals.${goalIndex}.evidenceKind`];
    if (/question/u.test(message)) return [`goals.${goalIndex}.question`];
    if (/requirement/u.test(message)) return [`goals.${goalIndex}.requirements`];
  }

  if (code === 'duplicate-goal-id' && isPlainObject(value) && Array.isArray(value.goals)) {
    return value.goals.map((_goal, index) => `goals.${index}.goalId`);
  }
  if (code === 'duplicate-requirement-id' && isPlainObject(value) && Array.isArray(value.goals)) {
    return value.goals.map((_goal, index) => `goals.${index}.requirements`);
  }
  return [];
}

function isPlannerRepairPath(value: string): boolean {
  const scopeMatch = /^scope\.([A-Za-z]+)$/u.exec(value);
  if (scopeMatch) return PLANNER_REPAIR_SCOPE_FIELDS.has(scopeMatch[1]);
  const goalMatch = /^goals\.(\d+)\.([A-Za-z]+)$/u.exec(value);
  return Boolean(goalMatch
    && Number(goalMatch[1]) >= 0
    && Number(goalMatch[1]) < DEFAULT_SEARCH_PLAN_BUDGET.maxGoals
    && PLANNER_REPAIR_GOAL_FIELDS.has(goalMatch[2]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Creates a legal one-goal plan without another model call.
 * 无需再次模型调用，直接创建合法的单目标计划。
 */
export function createFallbackCurrentNotePlan(question: string): CurrentNoteFallbackPlan | undefined {
  const queryTerms = deriveCurrentNoteFallbackQueryTerms(question);
  if (queryTerms.length === 0) return undefined;
  const normalizedQuestion = question.trim();
  const plan = createSearchPlan({
    originalQuestion: normalizedQuestion,
    goals: [{
      question: normalizedQuestion,
      evidenceKind: 'fact',
      requirements: [{
        requirementId: 'requirement-local-fallback',
        label: normalizedQuestion,
        minEvidence: 1,
      }],
      queryTerms,
    }],
  });
  const scope = createFallbackCurrentNoteSearchScope(normalizedQuestion);
  Object.defineProperty(plan, 'scope', { value: scope, enumerable: false, writable: false, configurable: false });
  return plan as CurrentNoteFallbackPlan;
}

/**
 * Emergency-only lexical anchors when the Planner cannot return a valid plan.
 * This deliberately does not use the index tokenizer: index terms may contain
 * Chinese characters and n-grams, while a SearchPlan must remain readable and
 * semantically meaningful to the next model decision.
 * 仅在 Planner 无法返回合法计划时使用的应急词法锚点。刻意不使用索引分词器：索引词条可能
 * 包含中文字符与 n-gram，而 SearchPlan 必须对下一次模型决策保持可读且语义完整。
 */
export function deriveCurrentNoteFallbackQueryTerms(question: string, maxTerms = 6): string[] {
  const limit = Number.isInteger(maxTerms) ? Math.max(1, maxTerms) : 6;
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const normalized = normalizeTechnicalTerm(raw).replace(/\s+/gu, ' ').trim();
    if (!normalized || normalized.length > 80 || seen.has(normalized) || terms.length >= limit) return;
    seen.add(normalized);
    terms.push(normalized);
  };

  // Identifiers and versions are the most precise anchors, so keep them first. / 标识符与版本号是最精确的锚点，排在最前。
  for (const match of question.match(FALLBACK_IDENTIFIER_PATTERN) ?? []) {
    const normalized = normalizeTechnicalTerm(match);
    if (FALLBACK_ENGLISH_BOILERPLATE.has(normalized)) continue;
    add(match);
  }

  for (const match of question.match(FALLBACK_CHINESE_PHRASE_PATTERN) ?? []) {
    const topic = match
      .replace(FALLBACK_CHINESE_SCAFFOLD_PATTERN, '')
      .replace(/^(?:的|在|中|里|内)+|(?:的|在|中|里|内)+$/gu, '')
      .trim();
    if (Array.from(topic).length >= 2) add(topic);
  }
  return terms;
}

/** Convenience wrapper producing a full fallback plan result in one call. / 一步产出完整兜底计划结果的便捷封装。 */
export function createFallbackCurrentNotePlanResult(question: string): CurrentNotePlanResult | undefined {
  const plan = createFallbackCurrentNotePlan(question);
  return plan ? { plan, scope: plan.scope } : undefined;
}

function readPlannerScope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as { scope?: unknown }).scope;
}

/**
 * Decides whether the current-note Planner may run for this turn.
 * 判定当前轮次是否可以运行当前笔记 Planner。
 */
export function shouldUseCurrentNotePlanner(input: {
  planMode: AssistantPlanMode;
  interactionRoute: 'chat' | 'clarify' | 'react';
  contextMode?: CurrentNoteContextMode;
  hasExternalContext: boolean;
}): boolean {
  return modeAllowsCurrentNotePlanner(input.planMode)
    && input.interactionRoute === 'react'
    && input.contextMode === 'react-search'
    && !input.hasExternalContext;
}

function formatPlannerConversation(messages: AssistantConversationMessage[]): string {
  const selected = messages.slice(-6);
  const parts: string[] = [];
  let used = 0;
  for (const message of [...selected].reverse()) {
    const content = redactLocalAbsolutePaths(message.content.trim());
    if (!content) continue;
    const remaining = 4_000 - used;
    if (remaining <= 0) break;
    const bounded = content.slice(Math.max(0, content.length - remaining));
    parts.push(`${message.role === 'user' ? '用户' : '助手'}：${bounded}`);
    used += bounded.length;
  }
  return parts.reverse().join('\n') || '无';
}

function redactLocalAbsolutePaths(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s\r\n]+/gu, '[本地路径已省略]')
    .replace(/\/(?:Users|home|var|tmp)\/[^\s\r\n]+/gu, '[本地路径已省略]');
}

/** The renderer may inspect the model's structured plan, but never unredacted paths. / 渲染端可查看模型结构化计划，但绝不能看到未脱敏路径。 */
function serializePublicPlannerOutput(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? redactLocalAbsolutePaths(item) : item, 2);
  if (!serialized) throw new Error('Planner 输出无法序列化。');
  return serialized;
}
