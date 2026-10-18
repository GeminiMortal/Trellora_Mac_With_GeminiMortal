/**
 * Bounded, monotonic L0-L5 context pressure controller: reduces non-conversation materials to fit within model window limits.
 * 有界、单调 L0-L5 上下文压力控制器：通过减少非会话材料使其适应模型窗口限制。
 */
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import { renderContextEnvelope } from './contextRenderer.ts';
import { compactCurrentNoteContextMaterials } from '../currentNote/currentNoteIncrementalCompactor.ts';
import { applyCurrentNoteEvidenceCompression } from '../currentNote/currentNoteEvidenceCompressor.ts';
import type { EvidenceCompressionArtifact } from '../evidence/evidenceCompressionTypes.ts';
import type { ContextArtifactStore, ContextArtifactRecord } from './contextArtifactStore.ts';
import { ContextPressureCircuitBreaker } from './contextPressureCircuitBreaker.ts';
import type {
  ContextEnvelope,
  ContextMaterial,
  ContextOmission,
  ContextPressureEpisodeDiagnostics,
  ContextProjection,
  ContextProgressivePressureLevel,
} from './contextRuntimeTypes.ts';

/** Re-export of ContextArtifactStore for downstream consumers. 为下游消费者重导出 ContextArtifactStore。 */
export { ContextArtifactStore } from './contextArtifactStore.ts';

/**
 * Numeric pressure level (0-5) derived from the progressive pressure level enum.
 * 从渐进压力等级枚举导出的数字压力等级（0-5）。
 */
export type ContextPressureLevel = ContextProjection['pressureLevel'];

/**
 * Kind of pressure-relief action performed by the controller.
 * 控制器执行的压力缓解动作类型。
 */
export type ContextPressureActionKind =
  | 'dedupe'
  | 'old-tool-cleanup'
  | 'compact'
  | 'artifact-reference'
  | 'evidence-compression'
  | 'cold-reference'
  | 'trace-state'
  | 'hierarchical-summary'
  | 'bounded-drop';

/**
 * A single pressure-relief action: which materials were affected and the token delta.
 * 单次压力缓解动作：受影响的材料及 token 变化量。
 */
export interface ContextPressureAction {
  level: ContextPressureLevel;
  kind: ContextPressureActionKind;
  materialIds: string[];
  beforeTokens: number;
  afterTokens: number;
  reason: string;
  artifactId?: string;
}

/**
 * Output of a pressure projection: the adjusted envelope, rendered projection, and actions taken.
 * 压力投影的输出：调整后的信封、渲染的投影和已执行的动作。
 */
export interface ContextPressureProjection {
  envelope: ContextEnvelope;
  projection: ContextProjection;
  actions: ContextPressureAction[];
}

/**
 * A single projection attempt that includes whether it fits within the token budget.
 * 单次投影尝试，包含是否适应 token 预算的结果。
 */
export interface ContextPressureAttempt extends ContextPressureProjection {
  fits: boolean;
}

/**
 * Final result of projectToFit: a successful projection plus all attempts made.
 * projectToFit 的最终结果：成功的投影加上所有已尝试的次数。
 */
export interface ContextPressureResult extends ContextPressureProjection {
  attempts: ContextPressureAttempt[];
}

/**
 * Options for the ContextPressureController constructor.
 * ContextPressureController 构造函数的选项。
 */
export interface ContextPressureControllerOptions {
  artifactStore?: ContextArtifactStore;
  currentNoteEvidenceArtifacts?: readonly EvidenceCompressionArtifact[];
  canReadSource?: (material: ContextMaterial) => boolean;
  artifactThresholdTokens?: number;
  artifactPreviewChars?: number;
}

/**
 * Result of the relieveNonConversation path: adjusted projection plus episode diagnostics.
 * relieveNonConversation 路径的结果：调整后的投影加上事件诊断。
 */
export interface ContextNonConversationReliefResult extends ContextPressureProjection {
  diagnostics: ContextPressureEpisodeDiagnostics;
}
  
/**
 * Options for projectAtLevel: optional max prompt token cap.
 * projectAtLevel 的选项：可选的 Prompt token 上限。
 */
export interface ProjectContextPressureOptions {
  maxPromptTokens?: number;
}

/**
 * Options for projectToFit: required max prompt tokens, optional previous level and max attempts.
 * projectToFit 的选项：必需的 Prompt token 上限，可选的上一等级和最大尝试次数。
 */
export interface ProjectContextToFitOptions {
  maxPromptTokens: number;
  previousLevel?: ContextPressureLevel;
  maxProjectionAttempts?: number;
}

/**
 * Thrown when all projection attempts fail to fit within the model window.
 * 当所有投影尝试均无法适应模型窗口时抛出。
 */
export class ContextPressureExhaustedError extends Error {
  readonly code = 'CONTEXT_PRESSURE_EXHAUSTED';

  /**
   * Creates the error with all failed attempts for diagnostic inspection.
   * 创建错误并附带所有失败尝试以供诊断检查。
   *
   * @param attempts - All projection attempts that were tried / 所有已尝试的投影尝试
   */
  constructor(readonly attempts: readonly ContextPressureAttempt[]) {
    super('上下文在最大投影尝试次数后仍超过模型窗口，未发送模型请求。');
    this.name = 'ContextPressureExhaustedError';
  }
}

/**
 * Bounded, monotonic L0-L5 context pressure controller.
 * 有界、单调 L0-L5 上下文压力控制器。
 */
export class ContextPressureController {
  private readonly artifactThresholdTokens: number;
  private readonly artifactPreviewChars: number;

  /**
   * Creates a pressure controller with optional artifact-store and threshold settings.
   * 创建压力控制器，可选制品存储和阈值设置。
   *
   * @param options - Controller options / 控制器选项
   */
  constructor(private readonly options: ContextPressureControllerOptions = {}) {
    this.artifactThresholdTokens = normalizePositiveInteger(options.artifactThresholdTokens ?? 1_200, 'Artifact 转换阈值');
    this.artifactPreviewChars = normalizePositiveInteger(options.artifactPreviewChars ?? 480, 'Artifact 预览字符数');
  }

  /**
   * Residual-memory Phase 1 path: immediate large-output Artifact followed by
   * monotonic P1/P2 non-conversation relief. Conversation materials are never
   * removed or rewritten here.
   * 残差记忆 Phase-1 路径：先将大型输出立即制品化，再按单调 P1/P2 级别缓解非会话材料。会话材料在此路径中不会被移除或改写。
   *
   * @param input - Envelope, optional calibration multiplier, circuit breaker, and fingerprint / 信封、可选校准倍率、断路器和指纹
   * @returns Adjusted projection with actions and episode diagnostics / 包含动作和事件诊断的调整后投影
   */
  relieveNonConversation(input: {
    envelope: ContextEnvelope;
    calibrationMultiplier?: number;
    circuitBreaker?: ContextPressureCircuitBreaker;
    materialFingerprint?: string;
  }): ContextNonConversationReliefResult {
    const envelope = input.envelope;
    const calibrationMultiplier = Math.max(1, input.calibrationMultiplier ?? 1);
    const breaker = input.circuitBreaker ?? new ContextPressureCircuitBreaker();
    const episode = breaker.begin({ envelope, ...(input.materialFingerprint ? { fingerprint: input.materialFingerprint } : {}) });
    const omissions: ContextOmission[] = [];
    const actions: ContextPressureAction[] = [];
    const skippedZeroGainActions: string[] = [];
    let materials = envelope.materials.map(copyMaterial);
    const initialProjection = renderContextEnvelope(envelope);
    const initialUWindow = calculateUWindow(envelope, initialProjection, calibrationMultiplier);
    const initialLevel = resolveProgressivePressureLevel(initialUWindow);
    let ineffectiveGain = false;
    let tripped = false;
    let repeatedZeroGain = false;

    // Apply closure: executes a transform, tracks before/after tokens, and records zero-gain episodes for the circuit breaker.
    // Apply 闭包：执行变换、跟踪前/后 token 数，并向断路器记录零增益事件。
    const apply = (
      actionKey: string,
      level: ContextPressureLevel,
      transform: (before: readonly ContextMaterial[]) => { materials: ContextMaterial[]; actions: ContextPressureAction[]; omissions?: ContextOmission[] },
    ) => {
      if (episode.shouldSkip(actionKey)) {
        skippedZeroGainActions.push(actionKey);
        repeatedZeroGain = true;
        return;
      }
      const beforeProjection = renderContextEnvelope({ ...envelope, materials });
      const result = transform(materials);
      materials = result.materials;
      actions.push(...result.actions);
      omissions.push(...(result.omissions ?? []));
      const afterProjection = renderContextEnvelope({ ...envelope, materials });
      if (level === 0 && result.actions.length === 0
        && beforeProjection.stats.serializedTokens === afterProjection.stats.serializedTokens) return;
      const outcome = episode.record(actionKey, {
        beforeTokens: beforeProjection.stats.serializedTokens,
        afterTokens: afterProjection.stats.serializedTokens,
      });
      ineffectiveGain ||= outcome.ineffective;
      tripped ||= outcome.tripped;
      // Record a no-op action when the transform produced no changes (for diagnostics).
      // 当变换未产生任何变化时记录空操作动作（用于诊断）。
      if (result.actions.length === 0 && beforeProjection.stats.serializedTokens === afterProjection.stats.serializedTokens) {
        actions.push({
          level,
          kind: level === 1 ? 'old-tool-cleanup' : level === 2 ? 'cold-reference' : 'artifact-reference',
          materialIds: [],
          beforeTokens: beforeProjection.stats.serializedTokens,
          afterTokens: afterProjection.stats.serializedTokens,
          reason: `${actionKey} 没有可安全执行的候选。`,
        });
      }
    };

    apply('p0-immediate-tool-artifact', 0, (before) => {
      const nextActions: ContextPressureAction[] = [];
      return {
        materials: before.map((material) => this.materializeLargeToolObservation(envelope, material, nextActions, 0)),
        actions: nextActions,
      };
    });

    let currentProjection = renderContextEnvelope({ ...envelope, materials });
    let currentUWindow = calculateUWindow(envelope, currentProjection, calibrationMultiplier);
    if (!tripped && currentUWindow >= 0.80) {
      apply('p1-tool-cleanup', 1, (before) => applyP1Cleanup(before));
      currentProjection = renderContextEnvelope({ ...envelope, materials });
      currentUWindow = calculateUWindow(envelope, currentProjection, calibrationMultiplier);
    }
    if (!tripped && currentUWindow >= 0.90) {
      apply('p2-artifact-evidence-trace-reference', 2, (before) => this.applyP2Relief(envelope, before, calibrationMultiplier));
      currentProjection = renderContextEnvelope({ ...envelope, materials });
      currentUWindow = calculateUWindow(envelope, currentProjection, calibrationMultiplier);
    }

    assertProtectedMaterialsPreserved(envelope.materials, materials);
    assertConversationMaterialsPreserved(envelope.materials, materials);
    const finalLevel = resolveProgressivePressureLevel(currentUWindow);
    const projectedEnvelope: ContextEnvelope = { ...envelope, materials };
    const projection: ContextProjection = {
      ...currentProjection,
      pressureLevel: pressureLevelNumber(finalLevel),
      omitted: omissions,
      stats: {
        ...currentProjection.stats,
        candidateMaterials: envelope.materials.length,
        omittedMaterials: omissions.length,
      },
    };
    return {
      envelope: projectedEnvelope,
      projection,
      actions,
      diagnostics: {
        pressureEpisodeId: episode.pressureEpisodeId,
        materialFingerprint: episode.materialFingerprint,
        initialLevel,
        finalLevel,
        initialUWindow,
        finalUWindow: currentUWindow,
        minPressureGainTokens: episode.minPressureGainTokens,
        stoppedReason: repeatedZeroGain
          // The circuit breaker detected repeated zero-gain actions; stop escalating.
          // 断路器检测到重复零增益动作；停止升级。
          ? 'repeated-zero-gain'
          : tripped
            // An individual action reported ineffective gain; stop escalating.
            // 单个动作报告增益无效；停止升级。
            ? 'ineffective-gain'
            : initialUWindow < 0.80
              ? 'below-p1'
              : currentUWindow < 0.90
                ? 'below-p2'
                : finalLevel === 'P1'
                  ? 'p1-complete'
                  : 'p2-complete',
        ineffectiveGain,
        actions: actions.map((action) => ({
          level: progressiveLevelFromNumber(action.level),
          kind: action.kind,
          materialIds: [...action.materialIds],
          beforeTokens: action.beforeTokens,
          afterTokens: action.afterTokens,
          releasedTokens: Math.max(0, action.beforeTokens - action.afterTokens),
          reason: action.reason,
          ...(action.artifactId ? { artifactId: action.artifactId } : {}),
        })),
        skippedZeroGainActions,
      },
    };
  }

  /**
   * Projects the envelope at a specific pressure level, applying L1-L5 relief actions cumulatively.
   * 在指定压力等级下投影信封，按 L1-L5 累积执行缓解动作。
   *
   * @param envelope - Context envelope to project / 要投影的上下文信封
   * @param level - Pressure level (0-5) to apply / 要应用的压力等级（0-5）
   * @param options - Optional max prompt token cap / 可选的 Prompt token 上限
   * @returns Projection with adjusted materials and actions / 包含调整后材料和动作的投影
   */
  projectAtLevel(
    envelope: ContextEnvelope,
    level: ContextPressureLevel,
    options: ProjectContextPressureOptions = {},
  ): ContextPressureProjection {
    assertPressureLevel(level);
    let materials = envelope.materials.map(copyMaterial);
    const omissions: ContextOmission[] = [];
    const actions: ContextPressureAction[] = [];

    if (level >= 1) {
      const compacted = envelope.route === 'current-note'
        ? compactCurrentNoteContextMaterials(materials)
        : dedupeExactMaterials(materials);
      for (const materialId of compacted.omittedMaterialIds) {
        const original = materials.find((material) => material.id === materialId);
        if (original) omissions.push(toOmission(original, 'duplicate', 'L1 合并完全相同的非受保护材料。'));
      }
      for (const materialId of compacted.changedMaterialIds) {
        const before = materials.find((material) => material.id === materialId);
        const after = compacted.materials.find((material) => material.id === materialId);
        if (before && after) actions.push(toAction(1, 'compact', [materialId], before.content, after.content, '复用当前笔记确定性 L1 压缩策略。'));
      }
      if (compacted.omittedMaterialIds.length) {
        const beforeTokens = sumMaterialTokens(materials.filter((material) => compacted.omittedMaterialIds.includes(material.id)));
        actions.push({
          level: 1,
          kind: 'dedupe',
          materialIds: [...compacted.omittedMaterialIds],
          beforeTokens,
          afterTokens: 0,
          reason: '合并完全相同的非受保护材料，并保留首个来源身份。',
        });
      }
      materials = compacted.materials;
    }

    if (level >= 2) {
      materials = materials.map((material) => this.materializeLargeToolObservation(envelope, material, actions));
    }

    if (level >= 3) {
      if (envelope.route === 'current-note') {
        const compressed = applyCurrentNoteEvidenceCompression(
          materials,
          this.options.currentNoteEvidenceArtifacts ?? [],
        );
        for (const materialId of compressed.changedMaterialIds) {
          const before = materials.find((material) => material.id === materialId);
          const after = compressed.materials.find((material) => material.id === materialId);
          if (before && after) actions.push(toAction(3, 'evidence-compression', [materialId], before.content, after.content, '复用已经校验的当前笔记证据压缩 Artifact；不改写 SearchPlan 或 Evidence Ledger。'));
        }
        materials = compressed.materials;
      }
      materials = materials.map((material) => this.referenceReadableColdMaterial(material, actions));
    }

    if (level >= 4) {
      const hierarchical = applyHierarchicalSummaries(materials);
      for (const removed of hierarchical.removed) {
        omissions.push(toOmission(removed, 'budget', 'L4 已由可追溯分层摘要覆盖，原始轮次仍保留在问答数据库。'));
      }
      if (hierarchical.removed.length) {
        actions.push({
          level: 4,
          kind: 'hierarchical-summary',
          materialIds: hierarchical.removed.map((material) => material.id),
          beforeTokens: sumMaterialTokens(hierarchical.removed),
          afterTokens: 0,
          reason: '用同会话、含来源范围的高层摘要覆盖冷历史；数据库原始 Turn 不变。',
        });
      }
      materials = hierarchical.materials;
    }

    if (level >= 5 && Number.isFinite(options.maxPromptTokens)) {
      const dropped = dropBoundedOverflowMaterials(envelope, materials, Number(options.maxPromptTokens));
      for (const removed of dropped.removed) omissions.push(toOmission(removed, 'policy', 'L5 仅移除 overflowPolicy=drop 的非受保护低优先级材料。'));
      if (dropped.removed.length) {
        actions.push({
          level: 5,
          kind: 'bounded-drop',
          materialIds: dropped.removed.map((material) => material.id),
          beforeTokens: sumMaterialTokens(dropped.removed),
          afterTokens: 0,
          reason: '在核心策略、当前问题、输出契约、Plan 身份和受保护证据之外执行有界舍弃。',
        });
      }
      materials = dropped.materials;
    }

    assertProtectedMaterialsPreserved(envelope.materials, materials);
    const projectedEnvelope: ContextEnvelope = { ...envelope, materials };
    const rendered = renderContextEnvelope(projectedEnvelope);
    const projection: ContextProjection = {
      ...rendered,
      pressureLevel: level,
      omitted: omissions,
      stats: {
        ...rendered.stats,
        candidateMaterials: envelope.materials.length,
        omittedMaterials: omissions.length,
      },
    };
    return { envelope: projectedEnvelope, projection, actions };
  }

  /**
   * Attempts projections at escalating pressure levels until the result fits or attempts are exhausted.
   * 从指定起始等级逐步升级压力投影，直到结果适配或尝试次数耗尽。
   *
   * @param envelope - Context envelope to project / 要投影的上下文信封
   * @param options - Max prompt tokens, optional previous level and max attempts / 最大 Prompt token、可选的上一等级和最大尝试次数
   * @returns Successful projection with all attempts / 成功的投影及所有尝试记录
   * @throws {ContextPressureExhaustedError} When no attempt fits within the budget / 当没有尝试适应预算时
   */
  projectToFit(envelope: ContextEnvelope, options: ProjectContextToFitOptions): ContextPressureResult {
    const maxPromptTokens = normalizeNonNegativeInteger(options.maxPromptTokens, '最大 Prompt token');
    const previousLevel = options.previousLevel ?? 0;
    assertPressureLevel(previousLevel);
    const maxAttempts = normalizeAttemptCount(options.maxProjectionAttempts ?? 3);
    const attemptLevels = buildAttemptLevels(previousLevel, maxAttempts);
    const attempts: ContextPressureAttempt[] = [];
    for (const level of attemptLevels) {
      const result = this.projectAtLevel(envelope, level, { maxPromptTokens });
      const attempt: ContextPressureAttempt = {
        ...result,
        fits: result.projection.stats.serializedTokens <= maxPromptTokens,
      };
      attempts.push(attempt);
      if (attempt.fits) return { ...result, attempts };
    }
    throw new ContextPressureExhaustedError(attempts);
  }

  // Writes large tool observations to the artifact store, verifies integrity by reading back, and replaces inline content with a reference if smaller.
  // 将大型工具观察写入制品存储，通过回读验证完整性，并在引用更小时替换内联内容。
  private materializeLargeToolObservation(
    envelope: ContextEnvelope,
    material: ContextMaterial,
    actions: ContextPressureAction[],
    actionLevel: 0 | 2 = 2,
  ): ContextMaterial {
    if (material.protected
      || material.zone !== 'tool-observation'
      || material.channel !== 'tool'
      || estimateTokenCount(material.content) < this.artifactThresholdTokens
      || !this.options.artifactStore
      || !envelope.scope.sessionId
      || !envelope.scope.turnId) return material;
    let artifact: ContextArtifactRecord;
    try {
      artifact = this.options.artifactStore.write({
        sessionId: envelope.scope.sessionId,
        turnId: envelope.scope.turnId,
        materialId: material.id,
        sourceTool: material.toolName ?? material.source.kind,
        content: material.content,
      });
      this.options.artifactStore.read({
        sessionId: envelope.scope.sessionId,
        turnId: envelope.scope.turnId,
        artifactId: artifact.artifactId,
      });
    } catch {
      return material;
    }
    const content = renderArtifactReference(artifact, this.artifactPreviewChars);
    if (estimateTokenCount(content) >= estimateTokenCount(material.content)) return material;
    actions.push({
      ...toAction(actionLevel, 'artifact-reference', [material.id], material.content, content, '大型 Tool Observation 已脱离 Prompt，并通过完整性校验后的 Artifact ID 读取。'),
      artifactId: artifact.artifactId,
    });
    return {
      ...material,
      content,
      compressStrategy: 'reference',
      source: { ...material.source, version: `${material.source.version}:${artifact.sha256}` },
      provenance: {
        ...material.provenance,
        sourceIds: [...new Set([...(material.provenance?.sourceIds ?? []), artifact.artifactId])],
        contentHash: artifact.sha256,
      },
    } as ContextMaterial;
  }

  // Replaces cold dynamic-evidence/agent-state materials with a directory reference when the source is confirmed readable and the reference is smaller.
  // 当来源确认可读且引用更小时，将冷的动态证据/Agent 状态材料替换为目录引用。
  private referenceReadableColdMaterial(
    material: ContextMaterial,
    actions: ContextPressureAction[],
    actionLevel: 2 | 3 = 3,
  ): ContextMaterial {
    if (material.protected
      || material.compressStrategy !== 'reference'
      || material.zone !== 'dynamic-evidence' && material.zone !== 'agent-state'
      || !this.options.canReadSource?.(material)) return material;
    const ids = [material.source.id, ...(material.provenance?.sourceIds ?? []), ...(material.provenance?.evidenceIds ?? [])];
    const content = `[冷材料引用]\nsource=${material.source.kind}:${material.source.id}@${material.source.version}\nids=${[...new Set(ids)].sort().join(',')}`;
    if (estimateTokenCount(content) >= estimateTokenCount(material.content)) return material;
    actions.push(toAction(actionLevel, 'cold-reference', [material.id], material.content, content, '来源已确认可读，将冷证据或执行轨迹降为目录引用。'));
    return { ...material, content } as ContextMaterial;
  }

  private applyP2Relief(
    envelope: ContextEnvelope,
    inputMaterials: readonly ContextMaterial[],
    calibrationMultiplier: number,
  ): { materials: ContextMaterial[]; actions: ContextPressureAction[]; omissions: ContextOmission[] } {
    const actions: ContextPressureAction[] = [];
    const omissions: ContextOmission[] = [];
    let materials = inputMaterials.map((material) => this.materializeLargeToolObservation(envelope, material, actions));
    materials = materials.map((material) => this.referenceReadableColdMaterial(material, actions, 2));
    const trace = stateizeCompletedTrace(materials);
    materials = trace.materials;
    actions.push(...trace.actions);
    omissions.push(...trace.omissions);
    const targetPromptTokens = Math.max(0, Math.floor(envelope.windowProfile.effectiveContextTokens * 0.90)
      - envelope.windowProfile.reservedOutputTokens - envelope.windowProfile.safetyTokens);
    if (calculateUWindow(envelope, renderContextEnvelope({ ...envelope, materials }), calibrationMultiplier) >= 0.90) {
      const dropped = dropBoundedOverflowMaterials(envelope, materials, targetPromptTokens);
      for (const removed of dropped.removed) omissions.push(toOmission(removed, 'policy', 'P2 仅省略可重读、无活动依赖且允许 drop 的非会话材料。'));
      if (dropped.removed.length) {
        actions.push({
          level: 2,
          kind: 'bounded-drop',
          materialIds: dropped.removed.map((material) => material.id),
          beforeTokens: sumMaterialTokens(dropped.removed),
          afterTokens: 0,
          reason: 'P2 在受保护材料之外执行有界省略，权威来源保持不变。',
        });
      }
      materials = dropped.materials;
    }
    return { materials, actions, omissions };
  }
}

function applyP1Cleanup(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  actions: ContextPressureAction[];
  omissions: ContextOmission[];
} {
  const deduped = dedupeExactMaterials(materials);
  const omissions: ContextOmission[] = [];
  const actions: ContextPressureAction[] = [];
  const duplicateMaterials = materials.filter((material) => deduped.omittedMaterialIds.includes(material.id));
  for (const material of duplicateMaterials) omissions.push(toOmission(material, 'duplicate', 'P1 合并完全相同的非受保护材料。'));
  if (duplicateMaterials.length) {
    actions.push({
      level: 1,
      kind: 'dedupe',
      materialIds: duplicateMaterials.map((material) => material.id),
      beforeTokens: sumMaterialTokens(duplicateMaterials),
      afterTokens: 0,
      reason: 'P1 精确去重并合并 provenance。',
    });
  }
  const cleanup = cleanupOldToolObservations(deduped.materials);
  for (const material of cleanup.removed) omissions.push(toOmission(material, 'stale', 'P1 清理已过期、已被覆盖且可重读的旧 Tool Observation。'));
  if (cleanup.removed.length) {
    actions.push({
      level: 1,
      kind: 'old-tool-cleanup',
      materialIds: cleanup.removed.map((material) => material.id),
      beforeTokens: sumMaterialTokens(cleanup.removed),
      afterTokens: 0,
      reason: '保留最新成功结果、最新错误/纠正和活动依赖，仅省略可重读旧输出。',
    });
  }
  return { materials: cleanup.materials, actions, omissions };
}

// Groups tool observations by tool name, keeps the latest correction, error, and success result per group, and removes rereadable stale/superseded/completed entries.
// 按工具名对工具观察分组，每组保留最新的纠正、错误和成功结果，并移除可重读的过期/已取代/已完成条目。
function cleanupOldToolObservations(materials: readonly ContextMaterial[]): { materials: ContextMaterial[]; removed: ContextMaterial[] } {
  const groups = new Map<string, ContextMaterial[]>();
  for (const material of materials) {
    if (material.zone !== 'tool-observation' || material.protected || material.lifecycle?.activeDependency) continue;
    const key = material.toolName?.trim() || `${material.source.kind}:${material.source.id}`;
    const group = groups.get(key) ?? [];
    group.push(material);
    groups.set(key, group);
  }
  const removeIds = new Set<string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (right.lifecycle?.sequence ?? 0) - (left.lifecycle?.sequence ?? 0)
      || right.id.localeCompare(left.id));
    let latestSuccessKept = false;
    let latestCorrectionKept = false;
    let latestErrorKept = false;
    for (const material of ordered) {
      const status = material.lifecycle?.status;
      const rereadable = material.lifecycle?.rereadable === true;
      if (status === 'correction' && !latestCorrectionKept) { latestCorrectionKept = true; continue; }
      if (status === 'error' && !latestErrorKept) { latestErrorKept = true; continue; }
      if ((status === 'completed' || status === 'active' || status === undefined) && !latestSuccessKept) { latestSuccessKept = true; continue; }
      if (rereadable && (status === 'stale' || status === 'superseded' || status === 'completed')) removeIds.add(material.id);
    }
  }
  return {
    materials: materials.filter((material) => !removeIds.has(material.id)),
    removed: materials.filter((material) => removeIds.has(material.id)),
  };
}

// Collapses multiple completed, rereadable trace/agent-state materials into a single compact state reference, keeping the highest-sequence entry, only when it saves tokens.
// 将多个已完成、可重读的轨迹/Agent 状态材料折叠为单个紧凑状态引用，保留最高序号条目，仅当节省 token 时执行。
function stateizeCompletedTrace(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  actions: ContextPressureAction[];
  omissions: ContextOmission[];
} {
  const candidates = materials.filter((material) => !material.protected
    && !material.lifecycle?.activeDependency
    && material.lifecycle?.status === 'completed'
    && material.lifecycle.rereadable
    && (material.zone === 'agent-state' || /trace|progress|planner/iu.test(material.source.kind)));
  if (candidates.length < 2) return { materials: [...materials], actions: [], omissions: [] };
  const keep = [...candidates].sort((left, right) => (right.lifecycle?.sequence ?? 0) - (left.lifecycle?.sequence ?? 0))[0];
  const removed = candidates.filter((material) => material.id !== keep.id);
  const content = `[执行轨迹状态]\nlatest=${keep.source.kind}:${keep.source.id}@${keep.source.version}\ncompleted=${candidates.map((material) => material.id).sort().join(',')}`;
  const replacement = { ...keep, content, compressStrategy: 'reference' as const } as ContextMaterial;
  const output = materials.filter((material) => !candidates.includes(material)).concat(replacement);
  const beforeTokens = sumMaterialTokens(candidates);
  const afterTokens = estimateTokenCount(content);
  if (afterTokens >= beforeTokens) return { materials: [...materials], actions: [], omissions: [] };
  return {
    materials: output,
    actions: [{ level: 2, kind: 'trace-state', materialIds: candidates.map((material) => material.id), beforeTokens, afterTokens, reason: 'P2 将已完成轨迹折叠为可重读状态，活动 Goal、错误和纠正不参与折叠。' }],
    omissions: removed.map((material) => toOmission(material, 'policy', 'P2 已由确定性执行轨迹状态覆盖。')),
  };
}

// Deduplicates materials by zone+channel+content, skips protected and runtime-core entries, and merges provenance into the kept copy.
// 按 zone+channel+content 去重材料，跳过受保护和运行时核心条目，并将出处合并到保留副本。
function dedupeExactMaterials(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  omittedMaterialIds: string[];
  changedMaterialIds: string[];
} {
  const seen = new Map<string, ContextMaterial>();
  const omittedMaterialIds: string[] = [];
  const output: ContextMaterial[] = [];
  for (const material of materials) {
    if (material.protected || isRuntimeCore(material)) {
      output.push(material);
      continue;
    }
    const key = `${material.zone}\u0000${material.channel}\u0000${material.content}`;
    const existing = seen.get(key);
    if (existing) {
      omittedMaterialIds.push(material.id);
      existing.provenance = mergeMaterialProvenance(existing, material);
      continue;
    }
    seen.set(key, material);
    output.push(material);
  }
  return { materials: output, omittedMaterialIds, changedMaterialIds: [] };
}

function mergeMaterialProvenance(first: ContextMaterial, second: ContextMaterial): ContextMaterial['provenance'] {
  const firstProvenance = first.provenance ?? {};
  const secondProvenance = second.provenance ?? {};
  const sourceIds = mergeStrings(
    [first.source.id, ...(firstProvenance.sourceIds ?? [])],
    [second.source.id, ...(secondProvenance.sourceIds ?? [])],
  )!;
  const turnSeqs = mergeNumbers(firstProvenance.turnSeqs, secondProvenance.turnSeqs);
  const goalIds = mergeStrings(firstProvenance.goalIds, secondProvenance.goalIds);
  const requirementIds = mergeStrings(firstProvenance.requirementIds, secondProvenance.requirementIds);
  const evidenceIds = mergeStrings(firstProvenance.evidenceIds, secondProvenance.evidenceIds);
  return {
    ...firstProvenance,
    sourceIds,
    ...(turnSeqs ? { turnSeqs } : {}),
    ...(goalIds ? { goalIds } : {}),
    ...(requirementIds ? { requirementIds } : {}),
    ...(evidenceIds ? { evidenceIds } : {}),
  };
}

// Removes database-backed conversation-summary/hot materials whose turn sequences are fully covered by qa-summary-rollup entries in the same session.
// 移除数据库支持的会话摘要/热材料，其轮次序号在同一会话中被 qa-summary-rollup 条目完全覆盖。
function applyHierarchicalSummaries(materials: readonly ContextMaterial[]): {
  materials: ContextMaterial[];
  removed: ContextMaterial[];
} {
  const rollups = materials.filter((material) => material.zone === 'conversation-summary'
    && material.source.kind === 'qa-summary-rollup'
    && material.provenance?.sessionId
    && material.provenance.turnSeqs?.length);
  if (rollups.length === 0) return { materials: [...materials], removed: [] };
  const coveredBySession = new Map<string, Set<number>>();
  for (const rollup of rollups) {
    const covered = coveredBySession.get(rollup.provenance!.sessionId!) ?? new Set<number>();
    for (const turnSeq of rollup.provenance!.turnSeqs ?? []) covered.add(turnSeq);
    coveredBySession.set(rollup.provenance!.sessionId!, covered);
  }
  const removed: ContextMaterial[] = [];
  const output = materials.filter((material) => {
    if (material.protected || rollups.includes(material)) return true;
    if (material.zone !== 'conversation-summary' && material.zone !== 'conversation-hot') return true;
    const sessionId = material.provenance?.sessionId;
    const turnSeqs = material.provenance?.turnSeqs ?? [];
    const covered = sessionId ? coveredBySession.get(sessionId) : undefined;
    const databaseBacked = material.source.kind === 'qa-turn' || material.source.kind === 'qa-summary-batch';
    if (!databaseBacked || !covered || turnSeqs.length === 0 || turnSeqs.some((turnSeq) => !covered.has(turnSeq))) return true;
    removed.push(material);
    return false;
  });
  return { materials: output, removed };
}

// Drops non-protected overflowPolicy=drop materials in priority order (lowest priority first, largest content first) until the serialized output fits within maxPromptTokens.
// 按优先级顺序（最低优先级优先，最大内容优先）移除非保护的 overflowPolicy=drop 材料，直到序列化输出适应 maxPromptTokens。
function dropBoundedOverflowMaterials(
  originalEnvelope: ContextEnvelope,
  materials: readonly ContextMaterial[],
  maxPromptTokens: number,
): { materials: ContextMaterial[]; removed: ContextMaterial[] } {
  let output = [...materials];
  const removed: ContextMaterial[] = [];
  const candidates = materials
    .filter((material) => material.overflowPolicy === 'drop' && !isL5Protected(originalEnvelope, material))
    .sort((first, second) => first.priority - second.priority
      || estimateTokenCount(second.content) - estimateTokenCount(first.content)
      || first.id.localeCompare(second.id));
  for (const candidate of candidates) {
    if (renderContextEnvelope({ ...originalEnvelope, materials: output }).stats.serializedTokens <= maxPromptTokens) break;
    output = output.filter((material) => material.id !== candidate.id);
    removed.push(candidate);
  }
  return { materials: output, removed };
}

// Returns true when a material should be protected from L5 bounded-drop: protected flag, runtime core zone, plan/evidence provenance, or stateVector plan id match.
// 当材料应受 L5 有界舍弃保护时返回 true：受保护标志、运行时核心区域、计划/证据出处，或 stateVector plan id 匹配。
function isL5Protected(envelope: ContextEnvelope, material: ContextMaterial): boolean {
  if (material.protected || isRuntimeCore(material)) return true;
  if (material.provenance?.planId || material.provenance?.evidenceIds?.length) return true;
  if (/search-plan|evidence-ledger/iu.test(material.source.kind)) return true;
  return envelope.stateVector.planId !== undefined && material.source.id === envelope.stateVector.planId;
}

function isRuntimeCore(material: ContextMaterial): boolean {
  return material.zone === 'stable-policy'
    || material.zone === 'current-request'
    || material.zone === 'output-contract';
}

function assertProtectedMaterialsPreserved(original: readonly ContextMaterial[], projected: readonly ContextMaterial[]): void {
  const byId = new Map(projected.map((material) => [material.id, material]));
  for (const material of original) {
    if (!material.protected) continue;
    const current = byId.get(material.id);
    if (!current || current.content !== material.content) throw new Error(`压力控制改写或遗漏了受保护材料：${material.id}`);
  }
}

function assertConversationMaterialsPreserved(original: readonly ContextMaterial[], projected: readonly ContextMaterial[]): void {
  const conversationZones = new Set(['conversation-summary', 'conversation-hot', 'conversation-recall']);
  const projectedById = new Map(projected.map((material) => [material.id, material]));
  for (const material of original) {
    if (!conversationZones.has(material.zone)) continue;
    const current = projectedById.get(material.id);
    if (!current || current.content !== material.content) throw new Error(`P1/P2 不允许改写或遗漏会话材料：${material.id}`);
  }
}

// Calculates the window utilization ratio: (predicted prompt tokens + output reserve + safety) / effective context tokens. Returns 1 when effective tokens is zero (maximum pressure).
// 计算窗口利用率：（预测 Prompt token + 输出预留 + 安全余量）/ 有效上下文 token。有效 token 为零时返回 1（最大压力）。
function calculateUWindow(envelope: ContextEnvelope, projection: ContextProjection, calibrationMultiplier: number): number {
  const profile = envelope.windowProfile;
  if (profile.effectiveContextTokens <= 0) return 1;
  const predictedPromptTokens = Math.ceil(projection.stats.serializedTokens * calibrationMultiplier);
  return (predictedPromptTokens + profile.reservedOutputTokens + profile.safetyTokens) / profile.effectiveContextTokens;
}

function resolveProgressivePressureLevel(utilization: number): ContextProgressivePressureLevel {
  if (utilization >= 1) return 'P4';
  if (utilization >= 0.95) return 'P3';
  if (utilization >= 0.90) return 'P2';
  if (utilization >= 0.80) return 'P1';
  return 'P0';
}

function pressureLevelNumber(level: ContextProgressivePressureLevel): ContextPressureLevel {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 } as const)[level];
}

function progressiveLevelFromNumber(level: ContextPressureLevel): ContextProgressivePressureLevel {
  if (level >= 5) return 'P5';
  if (level >= 4) return 'P4';
  if (level === 3) return 'P3';
  if (level === 2) return 'P2';
  if (level === 1) return 'P1';
  return 'P0';
}

function renderArtifactReference(artifact: ContextArtifactRecord, previewChars: number): string {
  const headChars = Math.ceil(previewChars * 0.65);
  const tailChars = Math.floor(previewChars * 0.25);
  const preview = artifact.content.length <= previewChars
    ? artifact.content
    : `${artifact.content.slice(0, headChars)}\n…（完整内容请按 Artifact ID 读取）…\n${artifact.content.slice(-tailChars)}`;
  return `[Tool Observation Artifact]\nartifactId=${artifact.artifactId}\nsha256=${artifact.sha256}\nbytes=${artifact.byteLength}\nmime=${artifact.mimeType}\npreview:\n${preview}`;
}

// Builds 1-3 attempt levels ending at level 5: [start], [start, 5], or [start, middle, 5].
// 构建以等级 5 结尾的 1-3 个尝试等级：[start]、[start, 5] 或 [start, middle, 5]。
function buildAttemptLevels(start: ContextPressureLevel, maxAttempts: number): ContextPressureLevel[] {
  if (maxAttempts === 1 || start === 5) return [start];
  if (maxAttempts === 2) return [...new Set([start, 5])] as ContextPressureLevel[];
  const middle = Math.max(start, 3) as ContextPressureLevel;
  return [...new Set([start, middle, 5])].slice(0, maxAttempts) as ContextPressureLevel[];
}

function toAction(
  level: ContextPressureLevel,
  kind: ContextPressureActionKind,
  materialIds: string[],
  before: string,
  after: string,
  reason: string,
): ContextPressureAction {
  return {
    level,
    kind,
    materialIds,
    beforeTokens: estimateTokenCount(before),
    afterTokens: estimateTokenCount(after),
    reason,
  };
}

function toOmission(material: ContextMaterial, reason: ContextOmission['reason'], detail: string): ContextOmission {
  return { materialId: material.id, reason, estimatedTokens: estimateTokenCount(material.content), detail };
}

function sumMaterialTokens(materials: readonly ContextMaterial[]): number {
  return materials.reduce((total, material) => total + estimateTokenCount(material.content), 0);
}

function mergeStrings(first: readonly string[] | undefined, second: readonly string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(first ?? []), ...(second ?? [])])].sort();
  return merged.length ? merged : undefined;
}

function mergeNumbers(first: readonly number[] | undefined, second: readonly number[] | undefined): number[] | undefined {
  const merged = [...new Set([...(first ?? []), ...(second ?? [])])].sort((left, right) => left - right);
  return merged.length ? merged : undefined;
}

function copyMaterial(material: ContextMaterial): ContextMaterial {
  return {
    ...material,
    source: { ...material.source },
    ...(material.tokenBudget ? { tokenBudget: { ...material.tokenBudget } } : {}),
    ...(material.admission ? { admission: { ...material.admission } } : {}),
    ...(material.lifecycle ? { lifecycle: { ...material.lifecycle } } : {}),
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

function assertPressureLevel(value: number): asserts value is ContextPressureLevel {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5) throw new Error('上下文压力等级必须位于 L0-L5。');
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
  return value;
}

function normalizeNonNegativeInteger(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}必须是非负整数。`);
  return Number(value);
}

function normalizeAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) throw new Error('上下文投影尝试次数必须位于 1-3。');
  return value;
}
