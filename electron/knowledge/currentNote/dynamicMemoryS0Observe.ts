/**
 * S0 (Stage 0) observation diagnostics for dynamic memory provider calls.
 * Captures token partition budgets, payload fingerprints, conversation coverage,
 * and route wiring without mutating the provider request.
 *
 * 动态记忆 provider 调用的 S0（阶段 0）观察诊断。捕获 token 分区预算、
 * 载荷指纹、对话覆盖和路由连接信息，不修改 provider 请求。
 */
import { createHash } from 'node:crypto';
import type { AiTransportImage } from '../ai/aiGenerationTransport.ts';
import type { QaResidualMemoryObservationInput } from '../qa/qaMemoryTypes.ts';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import type {
  AssistantModelRuntimeProfile,
  ContextEnvelope,
  ConversationCoverageMapDiagnostics,
  DynamicMemoryS0CallKind,
  DynamicMemoryS0Diagnostics,
  DynamicMemoryS0Route,
  ToolObservationS0Diagnostics,
} from '../context/contextRuntimeTypes.ts';

interface ObservableProviderMessage {
  role: string;
  content: string;
  images?: readonly AiTransportImage[];
  toolCalls?: readonly unknown[];
  toolCallId?: string;
  toolName?: string;
}

/**
 * Input for observing a provider-bound logical call in S0 diagnostics.
 * 用于在 S0 诊断中观察 provider 绑定的逻辑调用的输入。
 */
export interface DynamicMemoryS0CallObservationInput {
  route: DynamicMemoryS0Route;
  callKind: DynamicMemoryS0CallKind;
  messages: readonly ObservableProviderMessage[];
  tools?: readonly unknown[];
  structuredOutputSchema?: unknown;
  images?: readonly AiTransportImage[];
  providerFields?: Record<string, unknown>;
  windowProfile?: AssistantModelRuntimeProfile;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  safetyTokens?: number;
  rNextTokens?: number;
  envelope?: ContextEnvelope;
  memoryTexts?: readonly string[];
  agentStateTexts?: readonly string[];
  evidenceTexts?: readonly string[];
  skillTexts?: readonly string[];
  coverage?: QaResidualMemoryObservationInput;
  usage?: AssistantTokenUsage;
  responseCompleted?: boolean;
  diagnosticArtifactWrites?: number;
}

/**
 * S0 observes a provider-bound logical request without editing it. Raw prompt,
 * tool and image content is reduced to counts and hashes before diagnostics
 * leave the main process.
 *
 * S0 观察 provider 绑定的逻辑请求但不修改它。原始提示词、工具和图像内容在诊断
 * 离开主进程前被简化为计数和哈希。
 *
 * @param input - Observation input with messages, tools, and budget info / 包含消息、工具和预算信息的观察输入
 * @returns S0 diagnostics snapshot / S0 诊断快照
 */
export function observeDynamicMemoryS0Call(input: DynamicMemoryS0CallObservationInput): DynamicMemoryS0Diagnostics {
  const tools = [...(input.tools ?? [])];
  const images = collectImages(input.messages, input.images);
  const normalizedMessages = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.images?.length ? { images: message.images.map(normalizeImageForPayload) } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
  }));
  const logicalPayload = {
    messages: normalizedMessages,
    ...(tools.length ? { tools } : {}),
    ...(input.structuredOutputSchema ? { structuredOutputSchema: input.structuredOutputSchema } : {}),
    ...(input.images?.length ? { images: input.images.map(normalizeImageForPayload) } : {}),
    ...(input.providerFields ?? {}),
  };
  const serializedPayload = JSON.stringify(logicalPayload);
  const messageOnlyText = JSON.stringify({ messages: normalizedMessages, ...(input.providerFields ?? {}) });
  const toolSchemaText = tools.length ? JSON.stringify(tools) : '';
  const providerPayloadTokens = estimateTokenCount(serializedPayload);
  const toolSchemaTokens = estimateTokenCount(toolSchemaText);
  const skillTexts = input.skillTexts ?? collectEnvelopeTexts(input.envelope, (material) => {
    const kind = material.admission?.kind;
    return kind === 'skill-description' || kind === 'skill-body';
  });
  const skillTokens = estimateTexts(skillTexts);
  const memoryTokens = estimateTexts(input.memoryTexts ?? collectEnvelopeTexts(input.envelope, (material) => (
    material.zone === 'user-profile'
      || material.zone === 'conversation-summary'
      || material.zone === 'conversation-hot'
      || material.zone === 'conversation-recall'
  )));
  const agentStateTokens = estimateTexts(input.agentStateTexts ?? collectEnvelopeTexts(input.envelope, (material) => (
    material.zone === 'agent-state' || material.zone === 'tool-observation'
  )));
  const evidenceTokens = estimateTexts(input.evidenceTexts ?? collectEnvelopeTexts(input.envelope, (material) => (
    material.zone === 'dynamic-evidence' || material.zone === 'note-capsule'
  )));
  // Token partition taxonomy: T=tools+skills, A=agent state, E=evidence, M=memory, F=fixed/uncategorized framing.
  // Token 分区分类：T=工具+技能，A=代理状态，E=证据，M=记忆，F=固定/未分类框架。
  const T = toolSchemaTokens + skillTokens;
  const A = agentStateTokens;
  const E = evidenceTokens;
  const M = memoryTokens;
  const knownPartitionTokens = T + A + E + M;
  // F captures framing tokens not attributable to any known partition.
  // F 捕获不属于任何已知分区的框架 token。
  const F = Math.max(0, providerPayloadTokens - knownPartitionTokens);
  const partitionOverflowTokens = Math.max(0, knownPartitionTokens - providerPayloadTokens);
  const total = F + T + A + E + M;
  // Budget decomposition: W=window, O=output reserve, G=safety guard, P=available prompt.
  // 预算分解：W=窗口，O=输出预留，G=安全守卫，P=可用提示词。
  const W = normalizePositiveInteger(input.windowProfile?.effectiveContextTokens ?? input.contextWindowTokens, 64_000);
  const O = normalizeNonNegativeInteger(
    input.outputReserveTokens ?? input.windowProfile?.reservedOutputTokens,
    Math.min(8_192, Math.max(1_024, Math.floor(W * 0.125))),
  );
  const G = normalizeNonNegativeInteger(
    input.safetyTokens ?? input.windowProfile?.safetyTokens,
    Math.max(2_048, Math.floor(W * 0.03125)),
  );
  const P = Math.max(0, W - O - G);
  const RNext = normalizeNonNegativeInteger(input.rNextTokens, 0);
  const diagnostics: DynamicMemoryS0Diagnostics = {
    schemaVersion: 1,
    observationOnly: true,
    route: input.route,
    callKind: input.callKind,
    recordedAt: new Date().toISOString(),
    budget: { W, O, G, P, RNext },
    partitions: {
      F,
      T,
      A,
      E,
      M,
      total,
      totalWithRNext: total + RNext,
      remainingPromptTokens: Math.max(0, P - total),
      partitionOverflowTokens,
    },
    providerPayload: {
      chars: serializedPayload.length,
      bytes: Buffer.byteLength(serializedPayload, 'utf8'),
      estimatedTokens: providerPayloadTokens,
      sha256: sha256(serializedPayload),
      messageCount: normalizedMessages.length,
      toolSchemaCount: tools.length,
      toolSchemaChars: toolSchemaText.length,
      toolSchemaBytes: Buffer.byteLength(toolSchemaText, 'utf8'),
      toolSchemaTokens,
      skillCount: skillTexts.filter((value) => value.trim()).length,
      skillTokens,
      attachmentCount: images.length,
      attachmentBytes: images.reduce((totalBytes, image) => totalBytes + Buffer.byteLength(image.dataUrl, 'utf8'), 0),
      mediaTokenEstimateUnavailable: images.length > 0,
      messageOnlyEstimatedTokens: estimateTokenCount(messageOnlyText),
      payloadDeltaFromMessageOnlyTokens: Math.max(0, providerPayloadTokens - estimateTokenCount(messageOnlyText)),
      uncountedToolSchemaTokens: toolSchemaTokens,
      responseCompleted: input.responseCompleted ?? false,
    },
    coverage: createConversationCoverageMap(input.coverage),
    wiring: createRouteWiring(input.route),
    sideEffects: {
      providerRequestMutations: 0,
      semanticMemoryMutations: 0,
      diagnosticArtifactWrites: normalizeNonNegativeInteger(input.diagnosticArtifactWrites, 0),
      traceWritesAllowed: true,
    },
  };
  applyDynamicMemoryS0ProviderUsage(diagnostics, input.usage, input.responseCompleted ?? false);
  return diagnostics;
}

/**
 * Enriches S0 diagnostics with actual provider usage data to compute estimation error.
 * 使用实际 provider 使用数据充实 S0 诊断，以计算估算误差。
 *
 * @param diagnostics - S0 diagnostics to enrich / 需要充实的 S0 诊断
 * @param usage - Actual provider token usage / 实际 provider token 使用量
 * @param responseCompleted - Whether the response completed successfully / 响应是否成功完成
 */
export function applyDynamicMemoryS0ProviderUsage(
  diagnostics: DynamicMemoryS0Diagnostics,
  usage: AssistantTokenUsage | undefined,
  responseCompleted: boolean,
): void {
  diagnostics.providerPayload.responseCompleted = responseCompleted;
  const providerInputTokens = usage?.inputTokens;
  if (providerInputTokens === undefined) return;
  const error = diagnostics.providerPayload.estimatedTokens - providerInputTokens;
  diagnostics.providerPayload.providerInputTokens = providerInputTokens;
  diagnostics.providerPayload.estimateSignedErrorTokens = error;
  diagnostics.providerPayload.estimateAbsoluteErrorTokens = Math.abs(error);
  if (providerInputTokens > 0) diagnostics.providerPayload.estimateRelativeError = Math.abs(error) / providerInputTokens;
}

/**
 * Builds a conversation coverage map diagnosing which eligible turns are covered
 * by summary ranges or hot turns, and flags coverage gaps and overlaps.
 *
 * 构建对话覆盖图，诊断哪些符合条件的轮次被摘要范围或热轮次覆盖，
 * 并标记覆盖缺口和重叠。
 *
 * @param input - Optional residual memory observation data / 可选的残差记忆观察数据
 * @returns Coverage map diagnostics with risk flags / 包含风险标记的覆盖图诊断
 */
export function createConversationCoverageMap(
  input?: QaResidualMemoryObservationInput,
): ConversationCoverageMapDiagnostics {
  const eligibleTurnSeqs = [...new Set((input?.memorableTurns ?? [])
    .map((turn) => turn.turnSeq)
    .filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
  const summaryRanges = normalizeSummaryRanges(input?.legacy.summaryTurnRanges ?? []);
  const hotTurnSeqs = [...new Set((input?.legacy.hotTurnSeqs ?? [])
    .filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
  // Count how many times each eligible turn is covered by summary ranges or hot turns.
  // 统计每个符合条件的轮次被摘要范围或热轮次覆盖的次数。
  const coverageCounts = new Map<number, number>();
  for (const range of summaryRanges) {
    for (let turnSeq = range.turnFrom; turnSeq <= range.turnTo; turnSeq += 1) {
      coverageCounts.set(turnSeq, (coverageCounts.get(turnSeq) ?? 0) + 1);
    }
  }
  for (const turnSeq of hotTurnSeqs) coverageCounts.set(turnSeq, (coverageCounts.get(turnSeq) ?? 0) + 1);
  const uncoveredTurnSeqs = eligibleTurnSeqs.filter((turnSeq) => !coverageCounts.has(turnSeq));
  const multiplyCoveredTurnSeqs = eligibleTurnSeqs.filter((turnSeq) => (coverageCounts.get(turnSeq) ?? 0) > 1);
  const risks: string[] = [];
  if (uncoveredTurnSeqs.length > 0) risks.push('eligible-turn-coverage-gap');
  if (multiplyCoveredTurnSeqs.length > 0) risks.push('eligible-turn-double-coverage');
  if ((input?.legacy.summaryMaterialCount ?? 0) > summaryRanges.length) risks.push('summary-range-provenance-incomplete');
  risks.push('fixed-six-turn-hot-window');
  risks.push('assistant-answer-head-projection');
  risks.push('assistant-storage-60000-char-limit');
  risks.push('old-turn-recall-disabled');
  return {
    schemaVersion: 1,
    eligibleTurnCount: eligibleTurnSeqs.length,
    ...(eligibleTurnSeqs[0] !== undefined ? { eligibleTurnSeqFrom: eligibleTurnSeqs[0] } : {}),
    ...(eligibleTurnSeqs.at(-1) !== undefined ? { eligibleTurnSeqTo: eligibleTurnSeqs.at(-1) } : {}),
    summaryRanges,
    hotTurnSeqs,
    uncoveredTurnSeqs,
    multiplyCoveredTurnSeqs,
    complete: uncoveredTurnSeqs.length === 0 && multiplyCoveredTurnSeqs.length === 0,
    currentProjection: {
      fixedHotTurnLimit: 6,
      queryRewriteAnswerHeadChars: 200,
      reactHistoryAnswerHeadChars: 1_500,
      storedAssistantTextLimitChars: 60_000,
      recallTokens: 0,
    },
    risks,
  };
}

/**
 * Observes a tool observation by comparing raw vs. provider-visible content,
 * detecting truncation, artifact references, and size reductions.
 *
 * 通过比较原始内容与 provider 可见内容来观察工具观察结果，
 * 检测截断、工件引用和大小缩减。
 *
 * @param raw - Full raw tool observation text / 完整的原始工具观察文本
 * @param providerVisible - Text actually visible to the provider / 实际对 provider 可见的文本
 * @returns Tool observation S0 diagnostics / 工具观察 S0 诊断
 */
export function observeToolObservationS0(raw: string, providerVisible: string): ToolObservationS0Diagnostics {
  const artifactId = /artifactId=(context-artifact-[a-f0-9]{64})/u.exec(providerVisible)?.[1];
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const providerBytes = Buffer.byteLength(providerVisible, 'utf8');
  return {
    schemaVersion: 1,
    raw: digestText(raw),
    providerVisible: digestText(providerVisible),
    truncated: raw !== providerVisible,
    artifactized: Boolean(artifactId),
    ...(artifactId ? { artifactId } : {}),
    releasedChars: Math.max(0, raw.length - providerVisible.length),
    releasedBytes: Math.max(0, rawBytes - providerBytes),
  };
}

// Build the wiring diagnostics for a given route, describing which subsystems are connected,
// source-only, or unwired for each pipeline stage.
// 为给定路由构建连接诊断，描述每个流水线阶段中哪些子系统已连接、仅源或未连接。
function createRouteWiring(route: DynamicMemoryS0Route): DynamicMemoryS0Diagnostics['wiring'] {
  const shared = {
    prepare: 'QaMemoryOrchestrator.prepareTurn',
    finalize: 'QaMemoryOrchestrator.finalizeTurn',
    pressureController: {
      relieveNonConversation: 'wired' as const,
      projectAtLevel: 'source-only' as const,
      projectToFit: 'source-only' as const,
    },
    summaryRollups: 'stored-unwired' as const,
    oldTurnLexicalRecall: 'source-only' as const,
    databases: {
      qa: 'qa-memory.db' as const,
      currentNote: 'assistant-memory.db' as const,
      legacyWorkspace: 'conversation-memory.db' as const,
    },
    currentNoteExcluded: true as const,
  };
  if (route === 'knowledge-base-react') {
    return {
      ...shared,
      contextEnvelope: { status: 'unwired', entry: 'buildKnowledgeMemoryEnvelope + runReActLoop messages' },
      residualEnforcer: { status: 'unwired', entry: 'QaResidualMemoryEnforcer' },
      provider: 'runReActLoop -> ReActChatTransport.chat',
    };
  }
  return {
    ...shared,
    contextEnvelope: { status: 'wired', entry: 'createQaContextRuntimeAssembly' },
    residualEnforcer: {
      status: 'conditional',
      entry: route === 'chat-direct'
        ? 'QaMemoryOrchestrator.enforceChatContext'
        : 'QaMemoryOrchestrator.enforceKnowledgeBaseContext',
    },
    provider: 'streamKnowledgeAnswer -> streamAiText',
  };
}

function collectEnvelopeTexts(
  envelope: ContextEnvelope | undefined,
  predicate: (material: ContextEnvelope['materials'][number]) => boolean,
): string[] {
  return envelope?.materials.filter(predicate).map((material) => material.content) ?? [];
}

function collectImages(
  messages: readonly ObservableProviderMessage[],
  images: readonly AiTransportImage[] | undefined,
): AiTransportImage[] {
  return [
    ...(images ?? []),
    ...messages.flatMap((message) => [...(message.images ?? [])]),
  ];
}

function normalizeImageForPayload(image: AiTransportImage) {
  return { name: image.name, mimeType: image.mimeType, dataUrl: image.dataUrl };
}

function normalizeSummaryRanges(
  ranges: readonly { turnFrom: number; turnTo: number }[],
): Array<{ turnFrom: number; turnTo: number }> {
  return ranges
    .filter((range) => Number.isSafeInteger(range.turnFrom)
      && Number.isSafeInteger(range.turnTo)
      && range.turnFrom > 0
      && range.turnTo >= range.turnFrom)
    .map((range) => ({ turnFrom: range.turnFrom, turnTo: range.turnTo }))
    .sort((left, right) => left.turnFrom - right.turnFrom || left.turnTo - right.turnTo);
}

function estimateTexts(values: readonly string[]): number {
  return values.reduce((total, value) => total + estimateTokenCount(value), 0);
}

function digestText(value: string) {
  return {
    chars: value.length,
    bytes: Buffer.byteLength(value, 'utf8'),
    estimatedTokens: estimateTokenCount(value),
    sha256: sha256(value),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}
