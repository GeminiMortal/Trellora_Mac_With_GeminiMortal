/**
 * Prompt budget calculation for selection edit requests, ensuring token limits fit the model context window.
 * 选区编辑请求的提示词预算计算，确保 token 限制适配模型上下文窗口。
 */
import { resolveAiModelDescriptor } from '../ai/aiModelCapabilities.ts';
import type { AiProviderConfig } from '../ai/aiTypes.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import type { SelectionEditAction } from './selectionEditTypes.ts';

/** Default maximum output tokens when model descriptor is unavailable. / 模型描述符不可用时的默认最大输出 token 数。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
/** Absolute minimum output tokens to ensure a usable response. / 确保可用响应的最低输出 token 数。 */
const MIN_OUTPUT_TOKENS = 256;
/** Extra token margin reserved for request framing overhead. / 为请求框架开销预留的额外 token 余量。 */
const REQUEST_MARGIN_TOKENS = 64;
/** Upper bound on suggestion output characters to prevent runaway generation. / 建议输出字符数上限，防止生成失控。 */
const MAX_SUGGESTION_CHARACTERS = 40_000;

/** Breakdown of token budget for a single selection edit request. / 单次选区编辑请求的 token 预算分解。 */
export interface SelectionEditPromptBudget {
  contextWindowTokens: number;
  promptTokens: number;
  maxOutputTokens: number;
  totalTokens: number;
}

/**
 * Calculate the token budget for a selection edit prompt.
 * This is deliberately evaluated on the fully assembled prompt immediately
 * before a provider request. Static text-length limits cannot account for
 * nearby context, verified evidence, or the selected model's real window.
 *
 * 计算选区编辑提示词的 token 预算。特意在 provider 请求前、
 * 提示词完全组装后才评估，因为静态文本长度限制无法考虑
 * 附近上下文、已核验证据或所选模型的实际窗口。
 *
 * @param input - Provider config, model, action, selected text, assembled prompt, and optional target character count.
 *   / 提供商配置、模型、操作、选中文本、已组装提示词及可选目标字符数。
 * @returns Token budget breakdown including context window, prompt, output, and total tokens.
 *   / Token 预算分解，包括上下文窗口、提示词、输出和总 token 数。
 */
export function resolveSelectionEditPromptBudget(input: {
  config: AiProviderConfig;
  model: string;
  action: SelectionEditAction;
  selectedText: string;
  prompt: string;
  targetCharacters?: number;
}): SelectionEditPromptBudget {
  const descriptor = resolveAiModelDescriptor(input.config, input.model);
  const outputCharacters = input.targetCharacters ?? Math.max(
    input.selectedText.length * (input.action === 'expand' || input.action === 'explain' ? 2 : 1),
    320,
  );
  const expectedOutputTokens = estimateTokenCount('扩'.repeat(Math.min(MAX_SUGGESTION_CHARACTERS, outputCharacters))) + 128;
  const maxOutputTokens = Math.min(
    descriptor.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, expectedOutputTokens)),
  );
  const promptTokens = estimateTokenCount(input.prompt);
  return {
    contextWindowTokens: descriptor.contextWindowTokens,
    promptTokens,
    maxOutputTokens,
    totalTokens: promptTokens + maxOutputTokens + REQUEST_MARGIN_TOKENS,
  };
}

/**
 * Resolve the prompt budget and throw if it exceeds the model's context window.
 * 解析提示词预算，若超出模型上下文窗口则抛出错误。
 *
 * @param input - Same parameters as resolveSelectionEditPromptBudget.
 *   / 与 resolveSelectionEditPromptBudget 相同的参数。
 * @returns The validated token budget.
 *   / 已验证的 token 预算。
 * @throws {Error} If total tokens exceed the model's context window capacity.
 *   / 若总 token 数超出模型上下文窗口容量。
 */
export function assertSelectionEditPromptFitsContext(input: Parameters<typeof resolveSelectionEditPromptBudget>[0]): SelectionEditPromptBudget {
  const budget = resolveSelectionEditPromptBudget(input);
  if (budget.totalTokens > budget.contextWindowTokens) {
    throw new Error(
      `AI 编辑请求预计需要 ${budget.totalTokens.toLocaleString('zh-CN')} token（提示词约 ${budget.promptTokens.toLocaleString('zh-CN')}，预留输出 ${budget.maxOutputTokens.toLocaleString('zh-CN')}），超过当前模型 ${budget.contextWindowTokens.toLocaleString('zh-CN')} token 的上下文窗口。请缩小选区、减少上下文范围，或切换上下文窗口更大的模型。`,
    );
  }
  return budget;
}
