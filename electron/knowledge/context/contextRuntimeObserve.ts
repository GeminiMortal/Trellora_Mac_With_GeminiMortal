/**
 * Observes assistant context runtime by building shadow projections and recording
 * hash-only diagnostics for prompt parity and invariant checks.
 * 通过构建影子投影来观测助手上下文运行时，只记录哈希、计数与不变量差异等诊断信息，
 * 用于提示词一致性与不变量检查。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ContextArtifactStore } from './contextArtifactStore.ts';
import { ContextPressureCircuitBreaker } from './contextPressureCircuitBreaker.ts';
import { ContextPressureController } from './contextPressureController.ts';
import { collectContextProjectionInvariantViolations } from './contextProjectionInvariants.ts';
import { createContextProjectionDiagnostics } from './contextProjectionDiagnostics.ts';
import { LazyContextLoader } from './lazyContextLoader.ts';
import type { QaResidualMemoryObservationInput } from '../qa/qaMemoryTypes.ts';
import { observeQaResidualMemory } from '../qa/qaResidualMemoryObserve.ts';
import { applyDynamicMemoryS0ProviderUsage } from '../currentNote/dynamicMemoryS0Observe.ts';
import {
  CONTEXT_REQUEST_ENVELOPE_VERSION,
  normalizeAssistantContextRuntimeMode,
  type AssistantContextRuntimeMode,
  type ContextChannel,
  type ContextEnvelope,
  type ContextAdmissionDiagnostics,
  type ContextPressureEpisodeDiagnostics,
  type ContextProjection,
  type QaResidualMemoryEnforcementDiagnostics,
  type ContextRuntimeObservationReport,
  type ContextRuntimeObservationResult,
  type ContextRuntimePromptDigest,
} from './contextRuntimeTypes.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import type { AssistantTokenUsage } from '../model/tokenEstimator.ts';

// In-memory ring buffer; records are copied in/out and trimmed to the cap.
// 内存环形缓冲；记录以拷贝方式读写，并裁剪到上限。
const maxRecordedObservations = 100;
const observationBuffer: ContextRuntimeObservationReport[] = [];
// Shared pressure circuit breaker used unless a caller injects its own.
// 除非调用方注入自有断路器，否则使用共享的压力断路器。
const sharedPressureCircuitBreaker = new ContextPressureCircuitBreaker();

/**
 * Inputs for recording one context runtime observation report.
 * 记录单次上下文运行时观测报告的输入。
 */
export interface ObserveContextRuntimeInput {
  /** Observation mode; 'off' skips the entire pass. 观测模式；'off' 时整体跳过。 */
  mode?: AssistantContextRuntimeMode;
  /** Envelope under observation. 被观测的 Envelope。 */
  envelope: ContextEnvelope;
  /** Which send path produced the request. 产生该请求的发送路径。 */
  sendPath?: ContextRuntimeObservationReport['sendPath'];
  /** Pre-existing role prompts used as the byte-parity baseline. 作为字节一致性基线的旧角色提示词。 */
  legacy: {
    combinedPrompt: string;
    systemPrompt?: string;
    userPrompt: string;
  };
  /** Optional QA residual-memory observation input. 可选的问答残留记忆观测输入。 */
  qaResidualMemory?: QaResidualMemoryObservationInput;
  /** Token estimation calibration multiplier. Token 估算校准倍数。 */
  calibrationMultiplier?: number;
  /** Active tool phases for admission decisions. 用于准入判断的活跃工具阶段。 */
  activeToolPhases?: readonly string[];
  /** Skill ids requested for inclusion. 请求纳入的 Skill 标识。 */
  selectedSkillIds?: readonly string[];
  /** Attachment ids requested for inclusion. 请求纳入的附件标识。 */
  requestedAttachmentIds?: readonly string[];
  /** Artifact store override for pressure relief. 用于压力释放的 Artifact 存储覆盖。 */
  artifactStore?: ContextArtifactStore;
  /** Circuit breaker override; defaults to the shared instance. 断路器覆盖；默认使用共享实例。 */
  pressureCircuitBreaker?: ContextPressureCircuitBreaker;
  /** Fingerprint of materials for pressure decisions. 用于压力决策的材料指纹。 */
  materialFingerprint?: string;
  /** Precomputed projection to avoid re-running the shared pass. 预先计算的投影，避免重复执行共享流程。 */
  preparedProjection?: ContextProjection;
  /** Precomputed admission diagnostics paired with preparedProjection. 与 preparedProjection 配套的预计算准入诊断。 */
  preparedAdmission?: ContextAdmissionDiagnostics;
  /** Precomputed pressure episode diagnostics. 预先计算的压力事件诊断。 */
  preparedPressureEpisode?: ContextPressureEpisodeDiagnostics;
  /** Enforcement diagnostics for residual memory. 残留记忆的强制执行诊断。 */
  qaResidualMemoryEnforcement?: QaResidualMemoryEnforcementDiagnostics;
  /** Extra model calls attributed to this turn. 记入本轮的额外模型调用数。 */
  modelCallsAdded?: number;
  /** Extra memory writes attributed to this turn. 记入本轮的额外记忆写入数。 */
  memoryWritesAdded?: number;
}

/**
 * Inputs for the shared admission plus pressure-relief projection pass.
 * 共享的准入与压力释放投影流程的输入。
 */
export interface ProjectContextRuntimeEnvelopeInput {
  /** Envelope to project. 待投影的 Envelope。 */
  envelope: ContextEnvelope;
  /** Token estimation calibration multiplier. Token 估算校准倍数。 */
  calibrationMultiplier?: number;
  /** Active tool phases for admission decisions. 用于准入判断的活跃工具阶段。 */
  activeToolPhases?: readonly string[];
  /** Skill ids requested for inclusion. 请求纳入的 Skill 标识。 */
  selectedSkillIds?: readonly string[];
  /** Attachment ids requested for inclusion. 请求纳入的附件标识。 */
  requestedAttachmentIds?: readonly string[];
  /** Artifact store for pressure-relief spill. 用于压力释放溢出的 Artifact 存储。 */
  artifactStore?: ContextArtifactStore;
  /** Circuit breaker override; defaults to the shared instance. 断路器覆盖；默认使用共享实例。 */
  pressureCircuitBreaker?: ContextPressureCircuitBreaker;
  /** Fingerprint of materials for pressure decisions. 用于压力决策的材料指纹。 */
  materialFingerprint?: string;
}

/**
 * Envelope plus diagnostics produced by projectContextRuntimeEnvelope.
 * projectContextRuntimeEnvelope 产生的 Envelope 与诊断信息。
 */
export interface ProjectContextRuntimeEnvelopeResult {
  /** Envelope after admission and pressure relief. 经准入与压力释放后的 Envelope。 */
  envelope: ContextEnvelope;
  /** Projection stats, included materials and omitted-material list. 投影统计、已纳入材料与被省略材料列表。 */
  projection: ContextProjection;
  /** Pass-A admission diagnostics. Pass-A 准入诊断。 */
  admission: ContextAdmissionDiagnostics;
  /** Pressure relief episode diagnostics. 压力释放事件诊断。 */
  pressureEpisode: ContextPressureEpisodeDiagnostics;
}

/**
 * Shared Pass-A admission plus P1/P2 projection. It never mutates conversation materials.
 * 共享的 Pass-A 准入与 P1/P2 投影。该流程从不修改会话材料本身。
 *
 * @param input - Envelope and projection options / Envelope 与投影选项
 * @returns Relieved envelope with projection and diagnostics / 压力释放后的 Envelope 以及投影与诊断信息
 */
export function projectContextRuntimeEnvelope(input: ProjectContextRuntimeEnvelopeInput): ProjectContextRuntimeEnvelopeResult {
  const admission = new LazyContextLoader().admit(input.envelope, {
    activePhases: input.activeToolPhases,
    selectedSkillIds: input.selectedSkillIds,
    requestedAttachmentIds: input.requestedAttachmentIds,
  });
  const artifactStore = input.artifactStore ?? createDefaultArtifactStore(admission.envelope);
  const relieved = new ContextPressureController({
    ...(artifactStore ? { artifactStore } : {}),
    // A material is re-readable only when marked rereadable or when it carries a content hash.
    // 仅当材料标记为可重读或带有内容哈希时，才视为可重新读取。
    canReadSource: (material) => Boolean(material.lifecycle?.rereadable || material.source.contentHash),
  }).relieveNonConversation({
    envelope: admission.envelope,
    calibrationMultiplier: input.calibrationMultiplier,
    circuitBreaker: input.pressureCircuitBreaker ?? sharedPressureCircuitBreaker,
    materialFingerprint: input.materialFingerprint,
  });
  return {
    envelope: relieved.envelope,
    projection: {
      ...relieved.projection,
      omitted: [...admission.omissions, ...relieved.projection.omitted],
      stats: {
        ...relieved.projection.stats,
        candidateMaterials: input.envelope.materials.length,
        omittedMaterials: admission.omissions.length + relieved.projection.omitted.length,
      },
    },
    admission: admission.diagnostics,
    pressureEpisode: relieved.diagnostics,
  };
}

/**
 * Builds a local shadow projection and records only hashes, counts and
 * invariant differences. It never calls a Provider or a memory repository.
 * 构建本地影子投影，只记录哈希、计数与不变量差异。该流程从不调用 Provider 或记忆仓库。
 *
 * @param input - Observation inputs including the envelope and legacy prompts / 观测输入，包含 Envelope 与旧提示词
 * @returns The recorded report plus projection, or undefined when observation is off / 记录的报告与投影；观测关闭时返回 undefined
 */
export function observeContextRuntime(input: ObserveContextRuntimeInput): ContextRuntimeObservationResult | undefined {
  const mode = normalizeAssistantContextRuntimeMode(input.mode);
  if (mode === 'off') return undefined;
  const legacy = createPromptDigest(
    input.legacy.systemPrompt ?? '',
    input.legacy.userPrompt,
    input.legacy.combinedPrompt,
  );
  let projection: ContextProjection | undefined;
  let pressureEnvelope = input.envelope;
  let invariantViolations: string[] = [];
  let admission: ReturnType<LazyContextLoader['admit']> | undefined;
  let pressureEpisode: ContextRuntimeObservationReport['diagnostics']['pressureEpisode'];
  // Callers may pass a precomputed projection to avoid running the shared pass twice.
  // 调用方可传入预计算投影，避免重复执行共享流程。
  try {
    if (input.preparedProjection) {
      projection = input.preparedProjection;
      admission = input.preparedAdmission ? { envelope: input.envelope, omissions: [], diagnostics: input.preparedAdmission } : undefined;
      pressureEpisode = input.preparedPressureEpisode;
    } else {
      const prepared = projectContextRuntimeEnvelope(input);
      pressureEnvelope = prepared.envelope;
      pressureEpisode = prepared.pressureEpisode;
      admission = { envelope: prepared.envelope, omissions: [], diagnostics: prepared.admission };
      projection = prepared.projection;
    }
    invariantViolations = collectContextProjectionInvariantViolations(input.envelope, projection);
  } catch (error) {
    // Projection failures degrade into invariant violations so observation never breaks the send path.
    // 投影失败会降级为不变量差异记录，保证观测不会阻断发送路径。
    invariantViolations = [error instanceof Error ? error.message : String(error)];
  }
  const projectionDigest = projection
    ? createPromptDigest(
      projection.systemPrompt,
      projection.userPrompt,
      combineRolePrompts(projection.systemPrompt, projection.userPrompt),
      projection.toolMessages?.length ? ['system', 'user', 'tool'] : undefined,
    )
    : undefined;
  const diagnostics = createContextProjectionDiagnostics({
    envelope: input.envelope,
    ...(projection ? { projection } : {}),
    mode,
    sendPath: input.sendPath ?? 'legacy-phase-1',
    invariantViolations,
  });
  if (admission) diagnostics.admission = admission.diagnostics;
  if (pressureEpisode) diagnostics.pressureEpisode = pressureEpisode;
  if (input.qaResidualMemory) {
    diagnostics.residualMemory = observeQaResidualMemory({
      envelope: pressureEnvelope,
      memory: input.qaResidualMemory,
      calibrationMultiplier: input.calibrationMultiplier,
    });
  }
  if (input.qaResidualMemoryEnforcement) diagnostics.residualMemoryEnforcement = input.qaResidualMemoryEnforcement;
  const report: ContextRuntimeObservationReport = {
    schemaVersion: 1,
    mode,
    route: input.envelope.route,
    callKind: input.envelope.callKind,
    requestEnvelopeVersion: projection?.requestEnvelopeVersion ?? CONTEXT_REQUEST_ENVELOPE_VERSION,
    legacy,
    ...(projectionDigest ? { projection: projectionDigest } : {}),
    differences: {
      systemPromptEqual: Boolean(projection && projection.systemPrompt === (input.legacy.systemPrompt ?? '')),
      userPromptEqual: Boolean(projection && projection.userPrompt === input.legacy.userPrompt),
      roleStructureEqual: Boolean(projectionDigest && equalRoles(legacy.roleStructure, projectionDigest.roleStructure)),
      ...(projection ? { serializedTokenDelta: projection.stats.serializedTokens - estimateTokenCount(input.legacy.combinedPrompt) } : {}),
    },
    invariantViolations,
    ...(projection ? { stablePrefixFingerprint: projection.stablePrefixFingerprint } : {}),
    candidateMaterials: input.envelope.materials.length,
    includedMaterials: projection?.included.length ?? 0,
    modelCallsAdded: input.modelCallsAdded ?? 0,
    memoryWritesAdded: input.memoryWritesAdded ?? 0,
    turnStateMutations: 0,
    sendPath: input.sendPath ?? 'legacy-phase-1',
    diagnostics,
  };
  recordContextRuntimeObservation(report);
  return { report, ...(projection ? { projection } : {}) };
}

/**
 * Adds Provider usage/error metrics to an existing report without changing the send path.
 * 向已有报告追加 Provider 用量与误差指标，不改变发送路径。
 *
 * @param input - Report, response status and Provider usage comparison inputs / 报告、响应状态与 Provider 用量对比输入
 * @returns void / 无返回值
 */
export function observeContextRuntimeProviderUsage(input: {
  report: ContextRuntimeObservationReport;
  responseCompleted: boolean;
  usage?: AssistantTokenUsage;
  localRawInputTokens: number;
  localCalibratedInputTokens: number;
  calibrationMultiplierUsed: number;
}): void {
  const providerInputTokens = input.usage?.inputTokens;
  const reported = providerInputTokens !== undefined;
  // Signed error: local estimate minus Provider-reported tokens; positive means over-estimate.
  // 有符号误差：本地估算减去 Provider 上报的 token 数；正值表示高估。
  const rawError = reported ? input.localRawInputTokens - providerInputTokens : undefined;
  const calibratedError = reported ? input.localCalibratedInputTokens - providerInputTokens : undefined;
  input.report.diagnostics.providerUsage = {
    responseCompleted: input.responseCompleted,
    reported,
    localRawInputTokens: input.localRawInputTokens,
    localCalibratedInputTokens: input.localCalibratedInputTokens,
    calibrationMultiplierUsed: input.calibrationMultiplierUsed,
    ...(providerInputTokens !== undefined ? { providerInputTokens } : {}),
    ...(input.usage?.outputTokens !== undefined ? { providerOutputTokens: input.usage.outputTokens } : {}),
    ...(input.usage?.totalTokens !== undefined ? { providerTotalTokens: input.usage.totalTokens } : {}),
    ...(input.usage?.cachedInputTokens !== undefined ? { providerCachedInputTokens: input.usage.cachedInputTokens } : {}),
    ...(rawError !== undefined ? {
      rawEstimateSignedErrorTokens: rawError,
      rawEstimateAbsoluteErrorTokens: Math.abs(rawError),
      ...(providerInputTokens && providerInputTokens > 0 ? { rawEstimateRelativeError: Math.abs(rawError) / providerInputTokens } : {}),
    } : {}),
    ...(calibratedError !== undefined ? {
      calibratedEstimateSignedErrorTokens: calibratedError,
      calibratedEstimateAbsoluteErrorTokens: Math.abs(calibratedError),
      ...(providerInputTokens && providerInputTokens > 0 ? { calibratedEstimateRelativeError: Math.abs(calibratedError) / providerInputTokens } : {}),
    } : {}),
  };
  if (input.report.diagnostics.dynamicMemoryS0) {
    applyDynamicMemoryS0ProviderUsage(
      input.report.diagnostics.dynamicMemoryS0,
      input.usage,
      input.responseCompleted,
    );
  }
  replaceRecordedObservation(input.report);
}

/**
 * Returns defensive copies of all recorded observation reports.
 * 返回所有已记录观测报告的防御性拷贝。
 *
 * @returns Copied observation reports, oldest first / 拷贝后的观测报告，按时间从旧到新
 */
export function getContextRuntimeObservations(): ContextRuntimeObservationReport[] {
  return observationBuffer.map(copyReport);
}

/**
 * Clears all recorded observation reports from the in-memory buffer.
 * 清空内存缓冲区中所有已记录的观测报告。
 *
 * @returns void / 无返回值
 */
export function clearContextRuntimeObservations(): void {
  observationBuffer.length = 0;
}

/**
 * Returns diagnostics from the latest recorded report, optionally filtered by turn id.
 * 返回最近一条已记录报告的诊断信息，可按轮次标识过滤。
 *
 * @param turnId - Optional turn id to match / 可选的轮次标识
 * @returns A copy of the latest matching diagnostics, or null when none match / 最近一条匹配诊断的拷贝；无匹配时返回 null
 */
export function getContextProjectionDiagnostics(turnId?: string) {
  const normalizedTurnId = turnId?.trim();
  const reports = normalizedTurnId
    ? observationBuffer.filter((report) => report.diagnostics.turnId === normalizedTurnId)
    : observationBuffer;
  return reports.at(-1)?.diagnostics ? copyDiagnostics(reports.at(-1)!.diagnostics) : null;
}

function recordContextRuntimeObservation(report: ContextRuntimeObservationReport): void {
  observationBuffer.push(copyReport(report));
  if (observationBuffer.length > maxRecordedObservations) observationBuffer.splice(0, observationBuffer.length - maxRecordedObservations);
}

function replaceRecordedObservation(report: ContextRuntimeObservationReport): void {
  // Reports are matched by recorded timestamp, route and turn id; unmatched ones fall through to append.
  // 报告按记录时间戳、路由与轮次标识匹配；匹配不到则追加为新记录。
  for (let index = observationBuffer.length - 1; index >= 0; index -= 1) {
    const current = observationBuffer[index];
    if (current.diagnostics.recordedAt === report.diagnostics.recordedAt
      && current.route === report.route
      && current.callKind === report.callKind
      && current.diagnostics.turnId === report.diagnostics.turnId) {
      observationBuffer[index] = copyReport(report);
      return;
    }
  }
  recordContextRuntimeObservation(report);
}

function createPromptDigest(
  systemPrompt: string,
  userPrompt: string,
  combinedPrompt: string,
  forcedRoles?: ContextChannel[],
): ContextRuntimePromptDigest {
  return {
    roleStructure: forcedRoles ?? [
      ...(systemPrompt ? ['system' as const] : []),
      ...(userPrompt ? ['user' as const] : []),
    ],
    system: createRoleDigest(systemPrompt),
    user: createRoleDigest(userPrompt),
    combined: createRoleDigest(combinedPrompt),
  };
}

// Only length, token estimate and digest are kept — prompt content never leaves the caller.
// 只保留长度、token 估算与摘要——提示词内容不会外泄。
function createRoleDigest(value: string) {
  return {
    chars: value.length,
    estimatedTokens: estimateTokenCount(value),
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
  };
}

function combineRolePrompts(systemPrompt: string, userPrompt: string): string {
  return [systemPrompt, userPrompt].filter(Boolean).join('\n\n');
}

function equalRoles(first: readonly ContextChannel[], second: readonly ContextChannel[]): boolean {
  return first.length === second.length && first.every((role, index) => role === second[index]);
}

function copyReport(report: ContextRuntimeObservationReport): ContextRuntimeObservationReport {
  return {
    ...report,
    legacy: {
      ...report.legacy,
      roleStructure: [...report.legacy.roleStructure],
      system: { ...report.legacy.system },
      user: { ...report.legacy.user },
      combined: { ...report.legacy.combined },
    },
    ...(report.projection ? {
      projection: {
        ...report.projection,
        roleStructure: [...report.projection.roleStructure],
        system: { ...report.projection.system },
        user: { ...report.projection.user },
        combined: { ...report.projection.combined },
      },
    } : {}),
    differences: { ...report.differences },
    invariantViolations: [...report.invariantViolations],
    diagnostics: copyDiagnostics(report.diagnostics),
  };
}

function copyDiagnostics(diagnostics: ContextRuntimeObservationReport['diagnostics']): ContextRuntimeObservationReport['diagnostics'] {
  return {
    ...diagnostics,
    window: { ...diagnostics.window },
    tokens: { ...diagnostics.tokens },
    zones: diagnostics.zones.map((zone) => ({
      ...zone,
      channels: [...zone.channels],
      trusts: [...zone.trusts],
      compressionActions: [...zone.compressionActions],
    })),
    omissions: diagnostics.omissions.map((omission) => ({ ...omission })),
    stablePrefix: { ...diagnostics.stablePrefix },
    ...(diagnostics.residualMemory ? {
      residualMemory: {
        ...diagnostics.residualMemory,
        legacy: {
          M1: { ...diagnostics.residualMemory.legacy.M1 },
          M2: { ...diagnostics.residualMemory.legacy.M2 },
        },
        budget: { ...diagnostics.residualMemory.budget },
        wouldOptimize: {
          ...diagnostics.residualMemory.wouldOptimize,
          actions: [...diagnostics.residualMemory.wouldOptimize.actions],
        },
        wouldInclude: { ...diagnostics.residualMemory.wouldInclude },
        wouldCompact: { ...diagnostics.residualMemory.wouldCompact },
      },
    } : {}),
    ...(diagnostics.residualMemoryEnforcement ? {
      residualMemoryEnforcement: {
        ...diagnostics.residualMemoryEnforcement,
        budget: { ...diagnostics.residualMemoryEnforcement.budget },
        conversation: { ...diagnostics.residualMemoryEnforcement.conversation },
        compaction: { ...diagnostics.residualMemoryEnforcement.compaction },
      },
    } : {}),
    ...(diagnostics.providerUsage ? { providerUsage: { ...diagnostics.providerUsage } } : {}),
    ...(diagnostics.dynamicMemoryS0 ? {
      dynamicMemoryS0: {
        ...diagnostics.dynamicMemoryS0,
        budget: { ...diagnostics.dynamicMemoryS0.budget },
        partitions: { ...diagnostics.dynamicMemoryS0.partitions },
        providerPayload: { ...diagnostics.dynamicMemoryS0.providerPayload },
        coverage: {
          ...diagnostics.dynamicMemoryS0.coverage,
          summaryRanges: diagnostics.dynamicMemoryS0.coverage.summaryRanges.map((range) => ({ ...range })),
          hotTurnSeqs: [...diagnostics.dynamicMemoryS0.coverage.hotTurnSeqs],
          uncoveredTurnSeqs: [...diagnostics.dynamicMemoryS0.coverage.uncoveredTurnSeqs],
          multiplyCoveredTurnSeqs: [...diagnostics.dynamicMemoryS0.coverage.multiplyCoveredTurnSeqs],
          currentProjection: { ...diagnostics.dynamicMemoryS0.coverage.currentProjection },
          risks: [...diagnostics.dynamicMemoryS0.coverage.risks],
        },
        wiring: {
          ...diagnostics.dynamicMemoryS0.wiring,
          contextEnvelope: { ...diagnostics.dynamicMemoryS0.wiring.contextEnvelope },
          residualEnforcer: { ...diagnostics.dynamicMemoryS0.wiring.residualEnforcer },
          pressureController: { ...diagnostics.dynamicMemoryS0.wiring.pressureController },
          databases: { ...diagnostics.dynamicMemoryS0.wiring.databases },
        },
        sideEffects: { ...diagnostics.dynamicMemoryS0.sideEffects },
      },
    } : {}),
    ...(diagnostics.admission ? {
      admission: {
        ...diagnostics.admission,
        activationReasons: [...diagnostics.admission.activationReasons],
      },
    } : {}),
    ...(diagnostics.pressureEpisode ? {
      pressureEpisode: {
        ...diagnostics.pressureEpisode,
        actions: diagnostics.pressureEpisode.actions.map((action) => ({
          ...action,
          materialIds: [...action.materialIds],
        })),
        skippedZeroGainActions: [...diagnostics.pressureEpisode.skippedZeroGainActions],
      },
    } : {}),
    invariantViolations: [...diagnostics.invariantViolations],
  };
}

// Default store only exists when workspaceId is an absolute existing directory path.
// 仅当 workspaceId 是已存在的绝对目录路径时才创建默认存储。
function createDefaultArtifactStore(envelope: ContextEnvelope): ContextArtifactStore | undefined {
  const workspacePath = envelope.scope.workspaceId;
  try {
    if (!path.isAbsolute(workspacePath) || !fs.statSync(workspacePath).isDirectory()) return undefined;
    return new ContextArtifactStore(workspacePath);
  } catch {
    return undefined;
  }
}
