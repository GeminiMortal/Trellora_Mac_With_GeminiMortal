/**
 * Structured action driver for the ReAct-style assistant controller.
 * ReAct 风格助手控制器的结构化动作驱动器。
 *
 * Translates raw model JSON output into typed agent actions (tool calls or
 * answers), validates against the allowlisted tool schema, and normalizes
 * plan patches from the structured output contract.
 */
import type { SearchPlanPatch, SearchPlanPatchGoalUpdate } from '../search/searchPlanTypes.ts';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';
import type { ModelCallKind } from '../ai/modelCallBudget.ts';

/**
 * Allowlisted tool names for the current-note agent.
 * 当前笔记代理允许的工具名称列表。
 */
export const currentNoteToolNames = [
  'get_note_map',
  'search_note',
  'read_note_range',
  'read_note_section',
  'expand_evidence',
  'search_conversations',
] as const;

/**
 * Union type of allowlisted current-note tool names.
 * 允许的当前笔记工具名称的联合类型。
 */
export type CurrentNoteToolName = typeof currentNoteToolNames[number];

/**
 * Error codes for structured action parsing failures.
 * 结构化动作解析失败的错误代码。
 */
export type StructuredActionErrorCode = 'invalid-json' | 'invalid-action-schema' | 'invalid-plan-patch' | 'provider-timeout' | 'context-overflow';

/**
 * Error thrown when model output fails structured action validation.
 * 当模型输出未通过结构化动作验证时抛出的错误。
 */
export class StructuredActionError extends Error {
  readonly code: StructuredActionErrorCode;
  /** Safe, path-qualified contract details; never contains prompts or evidence text. */
  readonly details: readonly string[];

  constructor(
    code: StructuredActionErrorCode,
    message = '模型动作未通过结构化输出约束。',
    options?: { cause?: unknown; details?: readonly string[] },
  ) {
    super(message, options);
    this.name = 'StructuredActionError';
    this.code = code;
    this.details = Object.freeze([...(options?.details ?? [])]);
  }
}

/**
 * OpenAI-compatible strict structured output schema wrapper.
 * OpenAI 兼容的严格结构化输出 Schema 包装。
 */
export interface StructuredOutputSchema {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
}

/**
 * Discriminated union of agent actions: tool call or final answer.
 * 代理动作的可区分联合：工具调用或最终回答。
 */
export type CurrentNoteAgentAction =
  | {
    type: 'tool';
    /** Required by the plan-aware controller; optional for legacy off mode. */
    goalId?: string;
    tool: CurrentNoteToolName;
    arguments: Record<string, unknown>;
    publicRationale: string;
    planPatch?: SearchPlanPatch;
  }
  | {
    type: 'answer';
    answer: string;
    citations: string[];
    completeness: 'complete' | 'partial' | 'not-found';
    planPatch?: SearchPlanPatch;
  };

/**
 * Interface for generating structured decide/synthesize actions from prompts.
 * 从提示词生成结构化 decide/synthesize 动作的接口。
 */
export interface StructuredActionDriver {
  decide(input: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; onUsage?: (usage: AssistantTokenUsage) => void }): Promise<CurrentNoteAgentAction>;
  synthesize(input: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; onUsage?: (usage: AssistantTokenUsage) => void }): Promise<Extract<CurrentNoteAgentAction, { type: 'answer' }>>;
}

/**
 * Tool actions still use the executable allowlist, but non-executable model
 * output is returned verbatim as the final answer. The ReAct controller does
 * not request or enforce a provider-side answer schema.
 *
 * 工具动作仍使用可执行允许列表，但不可执行的模型输出将作为最终回答原样返回。
 * ReAct 控制器不要求也不强制提供者端的回答 Schema。
 *
 * @param input - Object with generateJson function / 包含 generateJson 函数的对象
 * @returns Structured action driver / 结构化动作驱动器
 */
export function createStructuredActionDriver(input: {
  generateJson: (request: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void; onRawResponse?: (text: string) => void }) => Promise<unknown>;
}): StructuredActionDriver {
  return {
    async decide(request) {
      return generateModelAuthoritativeAction(input.generateJson, request, 'decide');
    },
    async synthesize(request) {
      const action = await generateModelAuthoritativeAction(input.generateJson, request, 'synthesize');
      return action.type === 'answer' ? action : modelOutputAsAnswer(action);
    },
  };
}

async function generateModelAuthoritativeAction(
  generateJson: (request: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; callKind?: ModelCallKind; onUsage?: (usage: AssistantTokenUsage) => void; onRawResponse?: (text: string) => void }) => Promise<unknown>,
  request: { prompt: string; signal: AbortSignal; maxOutputTokens?: number; jsonSchema?: StructuredOutputSchema; onUsage?: (usage: AssistantTokenUsage) => void },
  callKind: Extract<ModelCallKind, 'decide' | 'synthesize'>,
): Promise<CurrentNoteAgentAction> {
  let rawResponse = '';
  const { jsonSchema: _ignoredSchema, ...generationRequest } = request;
  let value: unknown;
  try {
    value = await generateJson({
      ...generationRequest,
      callKind,
      onRawResponse: (text) => { rawResponse = text; },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (request.signal.aborted) throw error;
      throw new StructuredActionError('provider-timeout', '模型服务请求超时。', { cause: error });
    }
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new StructuredActionError('provider-timeout', '模型服务请求超时。', { cause: error });
    }
    if (rawResponse.trim()) return modelOutputAsAnswer(rawResponse);
    throw error;
  }
  try {
    return parseCurrentNoteAgentAction(value);
  } catch {
    return modelOutputAsAnswer(value ?? rawResponse);
  }
}

/**
 * A non-executable model payload is the model's final answer. This deliberately
 * avoids a second controller-owned format gate while keeping tool execution on
 * the existing allowlisted action contract.
 */
function modelOutputAsAnswer(value: unknown): Extract<CurrentNoteAgentAction, { type: 'answer' }> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const output = value as Record<string, unknown>;
    if (typeof output.answer === 'string') {
      return {
        type: 'answer',
        answer: output.answer,
        citations: readOptionalCitations(output.citations),
        completeness: readOptionalCompleteness(output.completeness),
        ...tryReadPlanPatch(output.planPatch),
      };
    }
  }
  return {
    type: 'answer',
    answer: typeof value === 'string' ? value : stringifyModelOutput(value),
    citations: [],
    completeness: 'complete',
  };
}

function readOptionalCitations(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function readOptionalCompleteness(value: unknown): 'complete' | 'partial' | 'not-found' {
  return value === 'partial' || value === 'not-found' ? value : 'complete';
}

function tryReadPlanPatch(value: unknown): { planPatch?: SearchPlanPatch } {
  if (value === undefined || value === null) return {};
  try {
    return { planPatch: readPlanPatch(value) };
  } catch {
    return {};
  }
}

function stringifyModelOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Parses raw model output into a typed agent action.
 * 将原始模型输出解析为类型化的代理动作。
 *
 * @param value - Raw model output / 原始模型输出
 * @returns Parsed agent action / 解析后的代理动作
 * @throws Error if the output is not a valid action / 如果输出不是有效动作则抛出错误
 */
export function parseCurrentNoteAgentAction(value: unknown): CurrentNoteAgentAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型动作必须是 JSON 对象。');
  const action = value as Record<string, unknown>;
  if (action.type === 'tool') return parseToolAction(action);
  if (action.type === 'answer') return parseAnswerAction(action);
  throw new Error('模型动作类型无效。');
}

function parseToolAction(action: Record<string, unknown>): Extract<CurrentNoteAgentAction, { type: 'tool' }> {
  if (typeof action.tool !== 'string' || !currentNoteToolNames.includes(action.tool as CurrentNoteToolName)) {
    throw new Error('模型请求了不允许的工具。');
  }
  if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) throw new Error('工具参数必须是对象。');
  if (typeof action.publicRationale !== 'string') throw new Error('工具动作缺少公开说明。');
  const goalId = action.goalId === undefined || action.goalId === null ? undefined : readActionId(action.goalId, 'goalId');
  const planPatch = action.planPatch === undefined || action.planPatch === null ? undefined : readPlanPatch(action.planPatch);
  const publicRationale = action.publicRationale.replace(/\s+/gu, ' ').trim();
  if (!publicRationale || Array.from(publicRationale).length > 80) throw new Error('工具公开说明必须为 1 到 80 个字符。');
  return {
    type: 'tool',
    ...(goalId ? { goalId } : {}),
    tool: action.tool as CurrentNoteToolName,
    arguments: sanitizeToolArguments(action.tool as CurrentNoteToolName, action.arguments as Record<string, unknown>),
    publicRationale,
    ...(planPatch ? { planPatch } : {}),
  };
}

/** Keeps the executable schema strict while discarding provider-added metadata. */
function sanitizeToolArguments(tool: CurrentNoteToolName, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case 'get_note_map':
      return pickDefined(args, ['detail']);
    case 'search_note':
      return pickDefined(args, ['terms', 'limit', 'cursor']);
    case 'read_note_range':
      return pickDefined(args, ['lineFrom', 'lineTo']);
    case 'read_note_section':
      return pickDefined(args, ['headingId', 'cursor']);
    case 'expand_evidence':
      return pickDefined(args, ['evidenceId', 'beforeLines', 'afterLines']);
    case 'search_conversations':
      return pickDefined(args, ['query', 'limit']);
  }
}

function pickDefined(args: Record<string, unknown>, allowedKeys: string[]): Record<string, unknown> {
  return Object.fromEntries(allowedKeys.flatMap((key) => args[key] === undefined || args[key] === null ? [] : [[key, args[key]]]));
}

function parseAnswerAction(action: Record<string, unknown>): Extract<CurrentNoteAgentAction, { type: 'answer' }> {
  if (typeof action.answer !== 'string') throw new Error('回答动作缺少 answer。');
  const answer = action.answer.trim();
  if (!answer || answer.length > 12_000) throw new Error('回答长度无效。');
  if (!Array.isArray(action.citations) || action.citations.length > 24 || !action.citations.every((entry) => typeof entry === 'string')) {
    throw new Error('回答引用格式无效。');
  }
  if (action.completeness !== 'complete' && action.completeness !== 'partial' && action.completeness !== 'not-found') {
    throw new Error('回答完整性标记无效。');
  }
  const planPatch = action.planPatch === undefined || action.planPatch === null ? undefined : readPlanPatch(action.planPatch);
  return {
    type: 'answer',
    answer,
    citations: [...new Set(action.citations.map((entry) => entry.trim()).filter(Boolean))],
    completeness: action.completeness,
    ...(planPatch ? { planPatch } : {}),
  };
}

function readActionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u.test(value)) throw new Error(`${label} 格式无效。`);
  return value;
}

function readPlanPatch(value: unknown): SearchPlanPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('planPatch 必须是对象。');
  const patch = value as Record<string, unknown>;
  if (!Array.isArray(patch.goalUpdates)) return value as SearchPlanPatch;
  return {
    ...(patch as unknown as SearchPlanPatch),
    // Structured Outputs requires every declared field to be present. Restore
    // nullable placeholders to the optional in-process patch contract before
    // semantic validation, and discard goal updates that contain no mutation.
    goalUpdates: patch.goalUpdates.flatMap(normalizeStructuredGoalUpdate),
  };
}

function normalizeStructuredGoalUpdate(value: unknown): SearchPlanPatchGoalUpdate[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('planPatch.goalUpdates 必须包含对象。');
  const raw = value as Record<string, unknown>;
  if (raw.clearMissingEvidence !== undefined && typeof raw.clearMissingEvidence !== 'boolean') {
    throw new Error('planPatch goalUpdate.clearMissingEvidence 必须是布尔值。');
  }
  if (raw.clearMissingEvidence === true && raw.missingEvidence !== undefined && raw.missingEvidence !== null) {
    throw new Error('planPatch goalUpdate 不能同时设置和清除 missingEvidence。');
  }

  const normalized: Record<string, unknown> = { goalId: raw.goalId };
  if (raw.status !== undefined && raw.status !== null) normalized.status = raw.status;
  if (raw.queryVariants !== undefined && raw.queryVariants !== null
    && (!Array.isArray(raw.queryVariants) || raw.queryVariants.length > 0)) {
    normalized.queryVariants = raw.queryVariants;
  }
  if (raw.evidenceBindings !== undefined && raw.evidenceBindings !== null) normalized.evidenceBindings = raw.evidenceBindings;
  if (raw.conflictBindings !== undefined && raw.conflictBindings !== null) normalized.conflictBindings = raw.conflictBindings;
  if (raw.clearMissingEvidence === true) normalized.missingEvidence = null;
  else if (raw.missingEvidence !== undefined && raw.missingEvidence !== null) normalized.missingEvidence = raw.missingEvidence;

  return Object.keys(normalized).length === 1 ? [] : [normalized as unknown as SearchPlanPatchGoalUpdate];
}
