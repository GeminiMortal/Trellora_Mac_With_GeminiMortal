/**
 * Structured action driver for the whole-library agent: validates model actions
 * (tool calls or answers) and exposes JSON schemas for decide/synthesize calls.
 * 整库代理的结构化动作驱动：校验模型动作（工具调用或回答），并提供 decide/synthesize 的 JSON Schema。
 */
import type { SearchPlanPatch } from '../search/searchPlanTypes.ts';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';
import type { ModelCallKind } from '../ai/modelCallBudget.ts';
import {
  DEFAULT_DECIDE_JSON_SCHEMA,
  DEFAULT_SYNTHESIZE_JSON_SCHEMA,
  type StructuredOutputSchema,
} from '../plan/planAwarePromptProjector.ts';

/**
 * Allowed whole-library tool names.
 * 允许使用的整库工具名称列表。
 *
 * @readonly
 */
export const libraryToolNames = [
  'search_note_library',
  'get_library_note_map',
  'search_library_note_blocks',
  'read_library_note_range',
  'read_library_note_section',
  'expand_library_evidence',
  'read_library_adjacent_section',
] as const;

/**
 * Union of allowed whole-library tool names.
 * 允许的整库工具名称联合类型。
 */
export type LibraryToolName = typeof libraryToolNames[number];

/** Per-tool argument shapes used to build the decide schema. / 各工具的参数结构，用于构建 decide Schema。 */
const libraryToolArgumentsSchema = {
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['limit'], properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'detail'], properties: { noteId: { type: 'string' }, detail: { enum: ['outline', 'stats', 'terms'] } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'limit'], properties: { noteId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'lineFrom', 'lineTo'], properties: { noteId: { type: 'string' }, lineFrom: { type: 'integer' }, lineTo: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['noteId', 'headingId', 'cursor'], properties: { noteId: { type: 'string' }, headingId: { type: 'string' }, cursor: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
    { type: 'object', additionalProperties: false, required: ['evidenceId', 'beforeLines', 'afterLines'], properties: { evidenceId: { type: 'string' }, beforeLines: { type: 'integer' }, afterLines: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['evidenceId', 'direction'], properties: { evidenceId: { type: 'string' }, direction: { enum: ['previous', 'next'] } } },
  ],
} as const;

/**
 * Decide-phase JSON schema restricted to whole-library tools.
 * 限定整库工具的 decide 阶段 JSON Schema。
 *
 * @readonly
 */
export const LIBRARY_DECIDE_JSON_SCHEMA = JSON.stringify(createLibraryDecideSchema());

/**
 * Synthesize-phase JSON schema (shared default answer contract).
 * synthesize 阶段 JSON Schema（共享的默认回答契约）。
 */
export const LIBRARY_SYNTHESIZE_JSON_SCHEMA = DEFAULT_SYNTHESIZE_JSON_SCHEMA;

/**
 * A model action: either one tool call or a final answer with citations.
 * 模型动作：一次工具调用，或带引用的最终回答。
 */
export type LibraryAgentAction =
  | {
    type: 'tool';
    goalId: string; // Target goal id / 目标 goalId
    tool: LibraryToolName; // Tool to invoke / 要调用的工具
    arguments: Record<string, unknown>; // Tool arguments / 工具参数
    publicRationale: string; // Short user-visible rationale / 简短的公开说明
    planPatch?: SearchPlanPatch; // Optional plan patch / 可选的计划补丁
  }
  | {
    type: 'answer';
    answer: string; // Final answer text / 最终回答文本
    citations: string[]; // Evidence ids cited / 引用的证据标识
    completeness: 'complete' | 'partial' | 'not-found'; // Completeness marker / 完整性标记
    planPatch?: SearchPlanPatch; // Optional plan patch / 可选的计划补丁
  };

/**
 * Driver interface for decide and synthesize model calls.
 * decide 与 synthesize 模型调用的驱动接口。
 */
export interface LibraryStructuredActionDriver {
  decide(input: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void }): Promise<LibraryAgentAction>;
  synthesize(input: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void }): Promise<Extract<LibraryAgentAction, { type: 'answer' }>>;
}

/**
 * Creates a structured action driver backed by a JSON generation backend.
 * 基于 JSON 生成后端创建结构化动作驱动。
 *
 * @param input - JSON generation backend / JSON 生成后端
 * @returns The structured action driver / 结构化动作驱动
 */
export function createLibraryStructuredActionDriver(input: {
  generateJson: (request: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void }) => Promise<unknown>;
}): LibraryStructuredActionDriver {
  return {
    async decide(request) {
      return parseLibraryAgentAction(await input.generateJson({ ...request, callKind: 'decide' }));
    },
    async synthesize(request) {
      const action = parseLibraryAgentAction(await input.generateJson({ ...request, callKind: 'synthesize' }));
      if (action.type !== 'answer') throw new Error('最终合成必须返回 answer 动作。');
      return action;
    },
  };
}

/**
 * Parses and validates an unknown model value into a LibraryAgentAction.
 * 将未知模型输出解析并校验为 LibraryAgentAction。
 *
 * @param value - Raw model output / 模型原始输出
 * @returns A validated agent action / 校验通过的代理动作
 */
export function parseLibraryAgentAction(value: unknown): LibraryAgentAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型动作必须是 JSON 对象。');
  const action = value as Record<string, unknown>;
  if (action.type === 'tool') return parseToolAction(action);
  if (action.type === 'answer') return parseAnswerAction(action);
  throw new Error('模型动作类型无效。');
}

/** Validates a tool action and sanitizes its arguments. / 校验工具动作并净化其参数。 */
function parseToolAction(action: Record<string, unknown>): Extract<LibraryAgentAction, { type: 'tool' }> {
  if (typeof action.tool !== 'string' || !libraryToolNames.includes(action.tool as LibraryToolName)) throw new Error('模型请求了不允许的整库工具。');
  if (typeof action.goalId !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u.test(action.goalId)) throw new Error('整库工具动作必须包含合法 goalId。');
  if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) throw new Error('工具参数必须是对象。');
  if (typeof action.publicRationale !== 'string') throw new Error('工具动作缺少公开说明。');
  const publicRationale = action.publicRationale.replace(/\s+/gu, ' ').trim();
  if (!publicRationale || publicRationale.length > 80) throw new Error('工具公开说明必须为 1 到 80 个字符。');
  const planPatch = action.planPatch === undefined || action.planPatch === null ? undefined : readPlanPatch(action.planPatch);
  return {
    type: 'tool',
    goalId: action.goalId,
    tool: action.tool as LibraryToolName,
    arguments: sanitizeToolArguments(action.tool as LibraryToolName, action.arguments as Record<string, unknown>),
    publicRationale,
    ...(planPatch ? { planPatch } : {}),
  };
}

/** Keeps only the keys each tool is allowed to accept. / 仅保留每个工具允许接受的参数键。 */
function sanitizeToolArguments(tool: LibraryToolName, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case 'search_note_library':
      return pickDefined(args, ['limit']);
    case 'get_library_note_map':
      return pickDefined(args, ['noteId', 'detail']);
    case 'search_library_note_blocks':
      return pickDefined(args, ['noteId', 'limit']);
    case 'read_library_note_range':
      return pickDefined(args, ['noteId', 'lineFrom', 'lineTo']);
    case 'read_library_note_section':
      return pickDefined(args, ['noteId', 'headingId', 'cursor']);
    case 'expand_library_evidence':
      return pickDefined(args, ['evidenceId', 'beforeLines', 'afterLines']);
    case 'read_library_adjacent_section':
      return pickDefined(args, ['evidenceId', 'direction']);
  }
}

/** Validates an answer action and de-duplicates its citations. / 校验回答动作并去重其引用。 */
function parseAnswerAction(action: Record<string, unknown>): Extract<LibraryAgentAction, { type: 'answer' }> {
  if (typeof action.answer !== 'string') throw new Error('回答动作缺少 answer。');
  const answer = action.answer.trim();
  if (!answer || answer.length > 12_000) throw new Error('回答长度无效。');
  if (!Array.isArray(action.citations) || action.citations.length > 32 || !action.citations.every((entry) => typeof entry === 'string')) throw new Error('回答引用格式无效。');
  if (action.completeness !== 'complete' && action.completeness !== 'partial' && action.completeness !== 'not-found') throw new Error('回答完整性标记无效。');
  const planPatch = action.planPatch === undefined || action.planPatch === null ? undefined : readPlanPatch(action.planPatch);
  return {
    type: 'answer',
    answer,
    citations: [...new Set(action.citations.map((entry) => entry.trim()).filter(Boolean))],
    completeness: action.completeness,
    ...(planPatch ? { planPatch } : {}),
  };
}

/** Passes through a planPatch object after a basic shape check. / 基础形状校验后透传 planPatch 对象。 */
function readPlanPatch(value: unknown): SearchPlanPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('planPatch 必须是对象。');
  return value as SearchPlanPatch;
}

/** Copies defined, non-null allowed keys from the raw arguments. / 从原始参数中复制已定义且非空的允许键。 */
function pickDefined(args: Record<string, unknown>, allowedKeys: string[]): Record<string, unknown> {
  return Object.fromEntries(allowedKeys.flatMap((key) => args[key] === undefined || args[key] === null ? [] : [[key, args[key]]]));
}

/** Derives the decide schema from the shared default contract. / 从共享默认契约派生 decide Schema。 */
function createLibraryDecideSchema(): Record<string, unknown> {
  const schema = JSON.parse(DEFAULT_DECIDE_JSON_SCHEMA) as {
    properties?: Record<string, unknown>;
  };
  const toolSchema = schema.properties?.tool as { anyOf?: Array<{ enum?: string[] }> } | undefined;
  if (!toolSchema?.anyOf?.[0]?.enum || !schema.properties) throw new Error('整库动作 Schema 无法从基础契约构建。');
  schema.properties.tool = { anyOf: [{ enum: [...libraryToolNames] }, { type: 'null' }] };
  schema.properties.arguments = { anyOf: [libraryToolArgumentsSchema, { type: 'null' }] };
  return schema as Record<string, unknown>;
}