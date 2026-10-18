/**
 * OpenAI Chat Completions transport for remote text generation and streaming.
 * OpenAI Chat Completions 远程文本生成与流式传输适配层。
 */
import { createParser } from 'eventsource-parser';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';
import type { AiProviderConfig } from './aiTypes.ts';
import {
  assertRemoteGenerationRequest,
  createGenerationRequestSignal,
  normalizeGenerationEndpoint,
  readNonNegativeTokenCount,
  resolveGenerationTemperature,
  type AiGenerationTransportInput,
  type AiStreamingTransportInput,
  type AiStructuredOutputRequest,
  type AiStructuredOutputTransport,
  type AiTransportImage,
} from './aiGenerationTransport.ts';
import { createAiProviderHttpError, createAiProviderMessageError } from './aiProviderError.ts';
import { resolveAiModelDescriptor, resolveMaxOutputTokensOptions, resolveThinkingOptions } from './aiModelCapabilities.ts';
import { StructuredOutputContractError } from '../plan/structuredOutputContract.ts';

/**
 * Alias of the shared structured-output transport contract for OpenAI.
 * OpenAI 结构化输出传输契约的别名。
 */
export type OpenAiStructuredOutputTransport = AiStructuredOutputTransport;
/**
 * Alias of the shared structured-output request shape for OpenAI.
 * OpenAI 结构化输出请求结构的别名。
 */
export type OpenAiStructuredOutputRequest = AiStructuredOutputRequest;
/**
 * Input accepted by OpenAI non-streaming completion calls.
 * OpenAI 非流式补全调用的输入结构别名。
 */
export type OpenAiCompletionInput = AiGenerationTransportInput;

/**
 * Send a non-streaming chat completion request to an OpenAI-compatible endpoint.
 * 向 OpenAI 兼容端点发送非流式补全请求。
 *
 * @param config - Provider endpoint, API key and model settings / 供应商端点、密钥与模型配置
 * @param input - Prompt, images and structured-output options / 提示词、图片与结构化输出选项
 * @returns Generated text and optional token usage / 生成文本与可选 token 用量
 */
export async function generateOpenAiCompletion(
  config: AiProviderConfig,
  input: OpenAiCompletionInput,
): Promise<{ text: string; usage?: AssistantTokenUsage }> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const useNativeJsonSchema = input.structuredOutput?.transport === 'native-json-schema';
  const useStructuredTool = input.structuredOutput?.transport === 'tool-call';
  const useJsonObject = Boolean(input.format && (!input.structuredOutput || input.structuredOutput.transport === 'json-object'));
  // When JSON mode is active but the prompt never mentions JSON, append an explicit JSON-only instruction.
  // JSON 模式生效但提示词未提及 JSON 时，追加"仅输出 JSON"的显式约束。
  const prompt = useJsonObject && !/json/iu.test(input.prompt)
    ? `${input.prompt}\n只输出一个有效 JSON 对象。`
    : input.prompt;
  const systemPrompt = input.systemPrompt?.trim();
  const structuredTool = useStructuredTool && input.structuredOutput
    ? {
      type: 'function' as const,
      function: {
        name: input.structuredOutput.schema.name,
        description: '提交本轮唯一的最终结构化结果。参数必须严格匹配 JSON Schema。',
        parameters: input.structuredOutput.schema.schema,
        ...(input.structuredOutput.strictToolSchema ? { strict: true } : {}),
      },
    }
    : undefined;
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: resolveOpenAiCompletionUserContent(prompt, input.images) }],
      // OpenAI reasoning models reject custom temperature; omit it for them.
      // OpenAI 推理模型不接受自定义 temperature，需省略。
      ...(descriptor.provider === 'openai' && descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(useNativeJsonSchema && input.structuredOutput
        ? { response_format: { type: 'json_schema', json_schema: input.structuredOutput.schema } }
        : useJsonObject ? { response_format: { type: 'json_object' } } : {}),
      ...(structuredTool && input.structuredOutput ? {
        tools: [structuredTool],
        tool_choice: { type: 'function', function: { name: input.structuredOutput.schema.name } },
      } : {}),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  const payload = await response.json() as {
    choices?: Array<{ finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown } }>;
    usage?: Record<string, unknown> | null;
  };
  input.onFinishReason?.(payload.choices?.[0]?.finish_reason);
  const message = payload.choices?.[0]?.message;
  const text = useStructuredTool && input.structuredOutput
    ? readStructuredToolArguments(message?.tool_calls, input.structuredOutput.schema.name)
    : readMessageContent(message?.content);
  return { text, usage: normalizeTokenUsage(payload.usage) };
}

/**
 * Send a streaming chat completion request and forward deltas as they arrive.
 * 发送流式补全请求，并在增量到达时实时转发。
 *
 * @param config - Provider endpoint, API key and model settings / 供应商端点、密钥与模型配置
 * @param input - Prompt, images and streaming callbacks / 提示词、图片与流式回调
 * @returns Token usage if the provider reported it, otherwise undefined / 供应商上报时返回 token 用量，否则为 undefined
 */
export async function streamOpenAiCompletion(
  config: AiProviderConfig,
  input: AiStreamingTransportInput,
): Promise<AssistantTokenUsage | undefined> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const systemPrompt = input.systemPrompt?.trim();
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: resolveOpenAiCompletionUserContent(input.prompt, input.images) }],
      ...(descriptor.provider === 'openai' && descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      stream: true,
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(descriptor.supportsStreamUsage ? { stream_options: { include_usage: true } } : {}),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  if (!response.body) throw new Error('远程服务未返回流式内容。');

  // SSE parse/provider errors are captured and rethrown after the stream drains so the reader is always released.
  // SSE 解析/供应商错误先记录，待流读完后再抛出，确保 reader 一定被释放。
  let parseError: Error | null = null;
  let usage: AssistantTokenUsage | undefined;
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      let payload: { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; message?: { content?: unknown } }>; usage?: Record<string, unknown> | null; error?: { message?: unknown } };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        parseError = new Error('远程服务返回了无法识别的流式数据。');
        return;
      }
      if (typeof payload.error?.message === 'string' && payload.error.message.trim()) {
        parseError = createAiProviderMessageError(payload.error.message.trim());
        return;
      }
      usage = normalizeTokenUsage(payload.usage) ?? usage;
      const choice = payload.choices?.[0];
      const reasoning = choice?.delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) input.onThinkingDelta?.(reasoning);
      const content = choice?.delta?.content ?? choice?.message?.content;
      if (typeof content === 'string' && content) input.onDelta(content);
    },
    onError: () => {
      parseError = new Error('远程服务返回了格式错误的流式数据。');
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      parser.feed(decoder.decode(value, { stream: !done }));
      if (parseError) throw parseError;
      if (done) break;
    }
    parser.feed(decoder.decode());
    parser.reset({ consume: true });
    if (parseError) throw parseError;
  } finally {
    reader.releaseLock();
  }
  return usage;
}

/**
 * Build Chat Completions multimodal content: keep a plain string when no images
 * (request body stays byte-identical to existing text turns), otherwise assemble
 * a `[{text}, {image_url}]` array where image_url consumes renderer-generated data URLs.
 * Chat Completions 多模态 content：无图时保持纯字符串（请求体与既有文本轮次逐字节一致），
 * 有图时组装为 `[{text}, {image_url}]` 数组，image_url 直接消费渲染进程生成的 data URL。
 */
function resolveOpenAiCompletionUserContent(prompt: string, images: AiTransportImage[] | undefined): string | Array<Record<string, unknown>> {
  if (!images?.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
  ];
}

/**
 * Extract and validate the single structured tool call returned by the model.
 * 提取并校验模型返回的唯一结构化工具调用。
 */
function readStructuredToolArguments(value: unknown, expectedName: string): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new StructuredOutputContractError('missing-tool-call', `模型未调用结构化输出工具 ${expectedName}。`);
  }
  if (value.length !== 1) {
    throw new StructuredOutputContractError('multiple-tool-calls', `模型返回了 ${value.length} 个工具调用；结构化输出只能提交一次。`);
  }
  const call = value[0];
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw new StructuredOutputContractError('unexpected-tool-call', '模型返回的结构化工具调用无效。');
  }
  const fn = (call as Record<string, unknown>).function;
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
    throw new StructuredOutputContractError('unexpected-tool-call', '模型返回的工具调用缺少 function。');
  }
  const functionCall = fn as Record<string, unknown>;
  if (functionCall.name !== expectedName) {
    throw new StructuredOutputContractError('unexpected-tool-call', `模型调用了非预期工具；需要 ${expectedName}。`);
  }
  if (typeof functionCall.arguments === 'string' && functionCall.arguments.trim()) return functionCall.arguments.trim();
  if (functionCall.arguments && typeof functionCall.arguments === 'object') return JSON.stringify(functionCall.arguments);
  throw new StructuredOutputContractError('invalid-tool-arguments', '结构化输出工具参数不是有效 JSON 文本。');
}

/**
 * Read message content that may be a plain string or an array of text parts.
 * 读取可能为纯字符串或文本分段数组的消息内容。
 */
function readMessageContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? [text] : [];
  }).join('').trim();
}

/**
 * Normalize heterogeneous provider usage fields into AssistantTokenUsage.
 * 将各供应商不一致的用量字段归一化为 AssistantTokenUsage。
 */
function normalizeTokenUsage(value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  if (!value) return undefined;
  // Providers disagree on naming (prompt/completion vs input/output); cached tokens may nest under prompt_tokens_details.
  // 各供应商字段命名不一（prompt/completion 或 input/output）；缓存 token 可能嵌套在 prompt_tokens_details 下。
  const inputTokens = readNonNegativeTokenCount(value.prompt_tokens ?? value.input_tokens);
  const outputTokens = readNonNegativeTokenCount(value.completion_tokens ?? value.output_tokens);
  const totalTokens = readNonNegativeTokenCount(value.total_tokens);
  const promptDetails = value.prompt_tokens_details;
  const cachedInputTokens = readNonNegativeTokenCount(value.cached_input_tokens ?? value.cached_tokens
    ?? (promptDetails && typeof promptDetails === 'object' && !Array.isArray(promptDetails)
      ? (promptDetails as Record<string, unknown>).cached_tokens
      : undefined));
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}
