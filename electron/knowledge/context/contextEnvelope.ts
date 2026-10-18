/**
 * Builds phase-1 context envelopes that wrap prompt materials for the assistant
 * runtime while preserving legacy send-path bytes.
 * 构建 phase-1 上下文 Envelope，将提示词材料包装为统一结构，同时保持旧发送路径的内容字节不变。
 */
import { resolveAssistantModelRuntimeProfile } from '../../../shared/effectiveContextWindow.ts';
import { assertContextEnvelopeInvariants } from './contextProjectionInvariants.ts';
import {
  CONTEXT_RUNTIME_SCHEMA_VERSION,
  type AssistantModelRuntimeProfile,
  type ContextEnvelope,
  type ContextEnvelopeScope,
  type ContextMaterial,
  type ContextRoute,
} from './contextRuntimeTypes.ts';
import type { PromptCallKind } from '../currentNote/currentNoteContextBudget.ts';

// Default invariant ids stamped on every envelope unless the caller supplies its own.
// 默认不变量标识；除非调用方自带，否则每个 Envelope 都会携带这些标识。
const phaseOneInvariants = [
  'trust-channel-v1',
  'protected-material-v1',
  'stable-prefix-v1',
  'legacy-send-path-v1',
] as const;

/**
 * Inputs used to assemble a fresh ContextEnvelope.
 * 用于组装全新 ContextEnvelope 的输入。
 */
export interface CreateContextEnvelopeInput {
  /** Assistant route this envelope serves. 本 Envelope 服务的助手路由。 */
  route: ContextRoute;
  /** Kind of prompt call that produces this envelope. 产生该 Envelope 的提示词调用类型。 */
  callKind: PromptCallKind;
  /** Identity scope for the envelope (workspace, library, note, session, turn). Envelope 的身份范围（工作区、资料库、笔记、会话、轮次）。 */
  scope: ContextEnvelopeScope;
  /** Resolved assistant-model runtime profile for window sizing. 已解析的助手模型运行时配置，用于窗口定容。 */
  windowProfile: AssistantModelRuntimeProfile;
  /** Ordered context materials to include in the projection. 按顺序纳入投影的上下文材料。 */
  materials: readonly ContextMaterial[];
  /** Invariant ids to stamp; defaults to phase-1 invariants. 要标记的不变量标识；默认使用 phase-1 不变量。 */
  invariants?: readonly string[];
  /** Optional external state vector snapshot. 可选的外部状态向量快照。 */
  stateVector?: ContextEnvelope['stateVector'];
}

/**
 * Inputs for wrapping pre-assembled role prompts as legacy opaque materials.
 * 将已组装的角色提示词包装为旧版不透明材料的输入。
 */
export interface CreateLegacyRoleContextEnvelopeInput {
  /** Assistant route this envelope serves. 本 Envelope 服务的助手路由。 */
  route: ContextRoute;
  /** Kind of prompt call that produces this envelope. 产生该 Envelope 的提示词调用类型。 */
  callKind: PromptCallKind;
  /** Optional system prompt included as a protected policy material. 可选的系统提示词，作为受保护策略材料纳入。 */
  systemPrompt?: string;
  /** User prompt included as the main request material. 用户提示词，作为主请求材料纳入。 */
  userPrompt: string;
  /** Partial identity scope; defaults to the legacy runtime workspace. 部分身份范围；默认使用旧运行时工作区标识。 */
  scope?: Partial<ContextEnvelopeScope>;
  /** Provider id used to resolve the window profile when omitted. 省略 windowProfile 时用于解析窗口配置的 Provider 标识。 */
  providerId?: string;
  /** Model id used to resolve the window profile when omitted. 省略 windowProfile 时用于解析窗口配置的模型标识。 */
  modelId?: string;
  /** Known context-window token limit for resolving the window profile. 已知的上下文窗口 token 上限，用于解析窗口配置。 */
  contextWindowTokens?: number;
  /** Pre-resolved assistant-model runtime profile; overrides providerId/modelId/contextWindowTokens. 预解析的助手模型运行时配置；覆盖 providerId/modelId/contextWindowTokens。 */
  windowProfile?: AssistantModelRuntimeProfile;
  /** Optional external state vector snapshot. 可选的外部状态向量快照。 */
  stateVector?: ContextEnvelope['stateVector'];
}

/**
 * Creates a detached ContextEnvelope with defensive copies of all materials and validates its invariants.
 * 创建独立的 ContextEnvelope，对材料进行防御性拷贝并校验不变量。
 *
 * @param input - Envelope fields to assemble / 要组装的 Envelope 字段
 * @returns A validated ContextEnvelope with copied materials / 校验通过且材料已拷贝的 ContextEnvelope
 */
export function createContextEnvelope(input: CreateContextEnvelopeInput): ContextEnvelope {
  const envelope: ContextEnvelope = {
    schemaVersion: CONTEXT_RUNTIME_SCHEMA_VERSION,
    route: input.route,
    callKind: input.callKind,
    scope: {
      workspaceId: input.scope.workspaceId,
      ...(input.scope.libraryId ? { libraryId: input.scope.libraryId } : {}),
      ...(input.scope.noteId ? { noteId: input.scope.noteId } : {}),
      ...(input.scope.sessionId ? { sessionId: input.scope.sessionId } : {}),
      ...(input.scope.turnId ? { turnId: input.scope.turnId } : {}),
    },
    windowProfile: {
      ...input.windowProfile,
      warnings: [...input.windowProfile.warnings],
    },
    materials: input.materials.map(copyContextMaterial),
    invariants: [...(input.invariants ?? phaseOneInvariants)],
    stateVector: { ...(input.stateVector ?? {}) },
  };
  assertContextEnvelopeInvariants(envelope);
  return envelope;
}

/**
 * Phase 1 wraps the already assembled role messages as opaque materials. This
 * preserves every byte on the active Provider path while the later memory
 * phases replace these legacy materials with finer-grained adapters.
 * Phase 1 将已组装的角色消息包装为不透明材料，这样在活跃 Provider 路径上
 * 保持每一个字节不变，待后续记忆阶段用更细粒度的适配器替换这些旧材料。
 *
 * @param input - Legacy role prompts and optional runtime metadata / 旧版角色提示词与可选运行时元数据
 * @returns A ContextEnvelope built from the legacy prompts / 基于旧提示词构建的 ContextEnvelope
 */
export function createLegacyRoleContextEnvelope(input: CreateLegacyRoleContextEnvelopeInput): ContextEnvelope {
  const materials: ContextMaterial[] = [];
  if (input.systemPrompt?.trim()) {
    materials.push({
      id: 'legacy-system-prompt',
      zone: 'stable-policy',
      channel: 'system',
      trust: 'trusted-policy',
      content: input.systemPrompt,
      priority: 100,
      protected: true,
      compressStrategy: 'none',
      source: { kind: 'legacy-role', id: `${input.route}:system`, version: 'legacy-role-v1' },
      stalePolicy: 'keep',
      overflowPolicy: 'fail',
      cache: { stability: 'stable', prefixEligible: true },
    });
  }
  materials.push({
    id: 'legacy-user-prompt',
    zone: 'current-request',
    channel: 'user',
    // Knowledge-base prompts carry untrusted evidence; other routes carry untrusted memory.
    // 知识库路由携带不可信证据；其他路由携带不可信记忆。
    trust: input.route === 'knowledge-base' ? 'untrusted-evidence' : 'untrusted-memory',
    content: input.userPrompt,
    priority: 100,
    protected: true,
    compressStrategy: 'none',
    source: { kind: 'legacy-role', id: `${input.route}:user`, version: 'legacy-role-v1' },
    stalePolicy: 'keep',
    overflowPolicy: 'fail',
    cache: { stability: 'turn', prefixEligible: false },
  });
  return createContextEnvelope({
    route: input.route,
    callKind: input.callKind,
    scope: {
      // Fallback workspace id keeps legacy callers without scope working.
      // 工作区标识回退值，保证未传 scope 的旧调用方仍可用。
      workspaceId: input.scope?.workspaceId?.trim() || 'legacy-assistant-runtime',
      ...(input.scope?.libraryId ? { libraryId: input.scope.libraryId } : {}),
      ...(input.scope?.noteId ? { noteId: input.scope.noteId } : {}),
      ...(input.scope?.sessionId ? { sessionId: input.scope.sessionId } : {}),
      ...(input.scope?.turnId ? { turnId: input.scope.turnId } : {}),
    },
    windowProfile: input.windowProfile ?? createPhaseOneObservationRuntimeProfile({
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindowTokens: input.contextWindowTokens,
    }),
    materials,
    stateVector: input.stateVector,
  });
}

/**
 * Resolves an AssistantModelRuntimeProfile from optional observed provider, model and context-window tokens.
 * 依据可选的 Provider、模型与上下文窗口 token 观测值解析 AssistantModelRuntimeProfile。
 *
 * @param input - Optional provider, model and context-window observations / 可选的 Provider、模型与上下文窗口观测值
 * @returns The resolved runtime profile with default placeholders when fields are missing / 解析得到的运行时配置；缺失字段使用占位默认值
 */
export function createPhaseOneObservationRuntimeProfile(input: {
  providerId?: string;
  modelId?: string;
  contextWindowTokens?: number;
}): AssistantModelRuntimeProfile {
  return resolveAssistantModelRuntimeProfile({
    providerId: input.providerId?.trim() || 'unknown-provider',
    modelId: input.modelId?.trim() || 'unknown-model',
    knownModelWindow: input.contextWindowTokens,
  });
}

// Deep-copies nested arrays and objects so envelope materials never share mutable state with callers.
// 深拷贝嵌套数组与对象，确保 Envelope 材料不与调用方共享可变状态。
function copyContextMaterial(material: ContextMaterial): ContextMaterial {
  return {
    ...material,
    source: { ...material.source },
    ...(material.tokenBudget ? { tokenBudget: { ...material.tokenBudget } } : {}),
    ...(material.provenance ? {
      provenance: {
        ...material.provenance,
        ...(material.provenance.turnSeqs ? { turnSeqs: [...material.provenance.turnSeqs] } : {}),
        ...(material.provenance.sourceIds ? { sourceIds: [...material.provenance.sourceIds] } : {}),
        ...(material.provenance.goalIds ? { goalIds: [...material.provenance.goalIds] } : {}),
        ...(material.provenance.requirementIds ? { requirementIds: [...material.provenance.requirementIds] } : {}),
        ...(material.provenance.evidenceIds ? { evidenceIds: [...material.provenance.evidenceIds] } : {}),
      },
    } : {}),
    cache: { ...material.cache },
  } as ContextMaterial;
}
