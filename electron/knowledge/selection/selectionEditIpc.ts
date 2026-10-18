/**
 * Renderer-facing IPC transport layer for selection editing (SE-7).
 * Validates run requests and resolves runtime mode without exposing model
 * or source-snapshot details to the renderer.
 * 面向渲染进程的选区编辑 IPC 传输层（SE-7）。
 * 校验运行请求并解析运行时模式，不向渲染进程暴露模型或来源快照细节。
 */

import { selectionEditActions, selectionEditContextScopes, type SelectionEditAction, type SelectionEditContextScope } from './selectionEditTypes.ts';
import type { SelectionTransformContext, SelectionTransformResult } from './selectionTransformTypes.ts';
import { assertSelectionEditWordLimit } from '../../../shared/selectionEditLimits.ts';
import type { SelectionLocatorCapture } from '../../../shared/selectionLocatorTypes.ts';
import { validateSelectionLocatorCapture } from './selectionEditLocator.ts';

export { MAX_SELECTION_EDIT_WORDS, countSelectionEditWords } from '../../../shared/selectionEditLimits.ts';

// Maximum lengths for user-supplied IPC fields to bound memory and model input.
// 用户提供的 IPC 字段的最大长度限制，用于约束内存和模型输入规模。
const maxContextCharacters = 400;
const maxLanguageCharacters = 60;
const maxInstructionCharacters = 500;
const maxRequestIdCharacters = 128;

/**
 * Renderer-facing SE-7 transport. It deliberately exposes an editing intent,
 * not a source snapshot or model choice: Electron owns both boundaries.
 * 面向渲染进程的 SE-7 传输结构。它有意只暴露编辑意图，
 * 不暴露来源快照或模型选择：两者均由 Electron 主进程掌控。
 */
export interface SelectionEditRunRequest {
  requestId: string;
  action: SelectionEditAction;
  selectedText: string;
  context?: SelectionTransformContext;
  targetLanguage?: string;
  customInstruction?: string;
  currentPath?: string;
  contextScope: SelectionEditContextScope;
  selectionLocator?: SelectionLocatorCapture;
  expectedContentHash?: string;
}

/**
 * The lightweight launcher needs only an apply-safe result projection.
 * 轻量启动器只需要一个可安全应用的结果投影。
 */
export type SelectionEditRunResult = SelectionTransformResult;

/**
 * Runtime modes for the selection edit pipeline: unified (new pipeline) or
 * legacy (existing transform path).
 * 选区编辑流水线的运行时模式：unified（新流水线）或 legacy（既有转换路径）。
 */
export const selectionEditRuntimeModes = ['unified', 'legacy'] as const;

/**
 * Union of supported runtime modes.
 * 受支持的运行时模式联合类型。
 */
export type SelectionEditRuntimeMode = typeof selectionEditRuntimeModes[number];

/**
 * Resolves the runtime mode from an environment variable or raw string,
 * falling back to `unified` when the value is unrecognized.
 * 从环境变量或原始字符串解析运行时模式；无法识别时回退到 `unified`。
 *
 * @param rawMode - Raw mode string, defaults to MENGHAN_SELECTION_EDIT_MODE env var / 原始模式字符串，默认取 MENGHAN_SELECTION_EDIT_MODE 环境变量
 * @returns Valid runtime mode / 合法的运行时模式
 */
export function resolveSelectionEditRuntimeMode(
  rawMode = process.env.MENGHAN_SELECTION_EDIT_MODE,
): SelectionEditRuntimeMode {
  return selectionEditRuntimeModes.includes(rawMode as SelectionEditRuntimeMode)
    ? rawMode as SelectionEditRuntimeMode
    : 'unified';
}

/**
 * Validates and normalizes an untrusted renderer request. Rejects unknown
 * fields, enforces length limits, and cross-checks action-specific constraints
 * (translate requires target language, custom requires instruction, etc.).
 * 校验并规范化不可信的渲染进程请求。拒绝未知字段、强制长度限制，
 * 并交叉检查动作相关约束（翻译需指定目标语言、自定义需填写要求等）。
 *
 * @param value - Unknown payload from IPC / 来自 IPC 的未知载荷
 * @returns Validated selection edit run request / 校验通过的选区编辑运行请求
 * @throws Error when validation fails / 校验失败时抛出错误
 */
export function validateSelectionEditRunRequest(value: unknown): SelectionEditRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('统一 AI 编辑请求格式无效。');
  const input = value as Record<string, unknown>;
  // Whitelist: reject any key not part of the SE-7 transport contract.
  // 白名单机制：拒绝不属于 SE-7 传输合同的任何字段。
  const allowedKeys = new Set([
    'requestId',
    'action',
    'selectedText',
    'context',
    'targetLanguage',
    'customInstruction',
    'currentPath',
    'contextScope',
    'selectionLocator',
    'expectedContentHash',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`统一 AI 编辑请求包含不支持的字段：${key}。`);
  }

  const requestId = readString(input.requestId, '请求标识', maxRequestIdCharacters);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(requestId)) throw new Error('请求标识格式无效。');
  if (typeof input.action !== 'string' || !selectionEditActions.includes(input.action as SelectionEditAction)) {
    throw new Error('不支持的 AI 编辑动作。');
  }
  const action = input.action as SelectionEditAction;
  const selectedText = readString(input.selectedText, '选中文字');
  if (!selectedText.trim()) throw new Error('请先选择要编辑的文字。');
  assertSelectionEditWordLimit(selectedText);
  const context = readContext(input.context);
  const targetLanguage = input.targetLanguage === undefined ? undefined : readString(input.targetLanguage, '目标语言', maxLanguageCharacters);
  const customInstruction = input.customInstruction === undefined
    ? undefined
    : readString(input.customInstruction, '自定义要求', maxInstructionCharacters);
  const currentPath = input.currentPath === undefined ? undefined : readString(input.currentPath, '当前笔记路径', 4_096);
  const contextScope = input.contextScope === undefined ? 'auto' : readContextScope(input.contextScope);
  const selectionLocator = validateSelectionLocatorCapture(input.selectionLocator);
  const expectedContentHash = input.expectedContentHash === undefined ? undefined : readString(input.expectedContentHash, '内容哈希', 64);
  if (expectedContentHash !== undefined && !/^[a-f0-9]{64}$/u.test(expectedContentHash)) throw new Error('内容哈希格式无效。');

  // Cross-check action-specific requirements: translate must declare a target
  // language, custom must declare an instruction, and neither field is allowed
  // on other actions.
  // 交叉检查动作相关要求：翻译必须声明目标语言，自定义必须声明要求，
  // 其他动作均不允许携带这两个字段。
  if (action === 'translate' && !targetLanguage?.trim()) throw new Error('翻译需要指定目标语言。');
  if (action === 'custom' && !customInstruction?.trim()) throw new Error('自定义编辑需要填写要求。');
  if (action !== 'translate' && targetLanguage) throw new Error('只有翻译操作可以指定目标语言。');
  if (action !== 'custom' && customInstruction) throw new Error('只有自定义操作可以填写编辑要求。');

  return {
    requestId,
    action,
    selectedText,
    ...(context ? { context } : {}),
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(customInstruction ? { customInstruction } : {}),
    ...(currentPath ? { currentPath } : {}),
    contextScope,
    ...(selectionLocator ? { selectionLocator } : {}),
    ...(expectedContentHash ? { expectedContentHash } : {}),
  };
}

// Reads and bounds the optional before/after context pair.
// 读取并限制可选的前文/后文上下文对。
function readContext(value: unknown): SelectionTransformContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上下文格式无效。');
  const record = value as Record<string, unknown>;
  const before = readString(record.before ?? '', '前文', maxContextCharacters);
  const after = readString(record.after ?? '', '后文', maxContextCharacters);
  if (before.length + after.length > maxContextCharacters) throw new Error('相邻上下文不能超过 400 字。');
  return before || after ? { before, after } : undefined;
}

// Validates that the context scope is one of the allowed enum values.
// 校验上下文范围是否属于允许的枚举值。
function readContextScope(value: unknown): SelectionEditContextScope {
  if (typeof value === 'string' && selectionEditContextScopes.includes(value as SelectionEditContextScope)) {
    return value as SelectionEditContextScope;
  }
  throw new Error('上下文范围无效。');
}

// Reads a string field and enforces an optional maximum length.
// 读取字符串字段并强制可选的最大长度限制。
function readString(value: unknown, label: string, maxLength?: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  if (maxLength !== undefined && value.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return value;
}
