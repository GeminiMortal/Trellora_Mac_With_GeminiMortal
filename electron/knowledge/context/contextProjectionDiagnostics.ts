/**
 * Builds a complete diagnostic report for a context projection, including per-zone
 * token breakdowns, window configuration, omission details, and invariant violations.
 * 为上下文投影构建完整诊断报告，包含按 zone 的 token 分解、窗口配置、遗漏详情和不变量违规。
 */
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import type {
  AssistantContextRuntimeMode,
  ContextEnvelope,
  ContextProjection,
  ContextProjectionDiagnostics,
  ContextProjectionZoneDiagnostics,
  ContextZone,
} from './contextRuntimeTypes.ts';

/**
 * Assembles a ContextProjectionDiagnostics record from the envelope, an optional
 * projection, runtime mode, and send path. Computes per-zone and aggregate token stats.
 * 从信封、可选投影、运行时模式和发送路径组装 ContextProjectionDiagnostics 记录。计算按 zone 和汇总的 token 统计。
 *
 * @param input - Envelope, projection, mode, sendPath, and optional overrides / 信封、投影、模式、sendPath 和可选覆盖
 * @returns Complete projection diagnostics record / 完整的投影诊断记录
 */
export function createContextProjectionDiagnostics(input: {
  envelope: ContextEnvelope;
  projection?: ContextProjection;
  mode: Exclude<AssistantContextRuntimeMode, 'off'>;
  sendPath: ContextProjectionDiagnostics['sendPath'];
  invariantViolations?: readonly string[];
  recordedAt?: string;
}): ContextProjectionDiagnostics {
  const { envelope, projection } = input;
  const materialById = new Map(envelope.materials.map((material) => [material.id, material]));
  const includedById = new Map((projection?.included ?? []).map((material) => [material.id, material]));
  const omissionById = new Map((projection?.omitted ?? []).map((omission) => [omission.materialId, omission]));
  const zones = new Map<ContextZone, ContextProjectionZoneDiagnostics>();

  for (const material of envelope.materials) {
    const row = zones.get(material.zone) ?? createZoneRow(material.zone);
    const candidateTokens = material.diagnosticCandidateTokens ?? estimateTokenCount(material.content);
    row.candidateTokens += candidateTokens;
    row.candidateMaterials += 1;
    addUnique(row.channels, material.channel);
    addUnique(row.trusts, material.trust);
    if (material.protected) row.protectedMaterials += 1;
    if (material.compressStrategy !== 'none') addUnique(row.compressionActions, material.compressStrategy);
    const included = includedById.get(material.id);
    if (included) {
      row.finalTokens += included.estimatedTokens;
      row.includedMaterials += 1;
    }
    const omission = omissionById.get(material.id);
    if (omission) {
      row.omittedMaterials += 1;
      addUnique(row.compressionActions, `omit:${omission.reason}`);
    }
    zones.set(material.zone, row);
  }

  const profile = envelope.windowProfile;
  const availablePromptTokens = Math.max(0, profile.effectiveContextTokens - profile.reservedOutputTokens - profile.safetyTokens);
  const candidateTokens = envelope.materials.reduce(
    (total, material) => total + (material.diagnosticCandidateTokens ?? estimateTokenCount(material.content)),
    0,
  );
  const stablePrefixEligible = envelope.materials.some((material) => material.cache.prefixEligible
    && includedById.has(material.id));
  const sendPath = input.sendPath;

  return {
    schemaVersion: 1,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...(envelope.scope.turnId ? { turnId: envelope.scope.turnId } : {}),
    route: envelope.route,
    callKind: envelope.callKind,
    mode: input.mode,
    sendPath,
    providerId: profile.providerId,
    modelId: profile.modelId,
    pressureLevel: projection?.pressureLevel ?? 0,
    window: {
      ...(profile.runtimeProfileId ? { runtimeProfileId: profile.runtimeProfileId } : {}),
      ...(profile.physicalContextTokens ? { physicalTokens: profile.physicalContextTokens } : {}),
      physicalSource: profile.physicalSource,
      ...(profile.productCapMode ? { productCapMode: profile.productCapMode } : {}),
      productCeilingTokens: profile.productCeilingTokens,
      ...(profile.userCapTokens ? { userCapTokens: profile.userCapTokens } : {}),
      effectiveTokens: profile.effectiveContextTokens,
      autoCompactAtTokens: profile.autoCompactAtTokens,
      outputReserveTokens: profile.reservedOutputTokens,
      safetyTokens: profile.safetyTokens,
      availablePromptTokens,
    },
    tokens: {
      candidate: candidateTokens,
      final: projection?.stats.serializedTokens ?? 0,
      outputReserve: profile.reservedOutputTokens,
      safety: profile.safetyTokens,
    },
    zones: [...zones.values()],
    omissions: (projection?.omitted ?? []).map((omission) => ({
      materialId: omission.materialId,
      zone: materialById.get(omission.materialId)?.zone ?? 'agent-state',
      reason: omission.reason,
      estimatedTokens: omission.estimatedTokens,
    })),
    stablePrefix: {
      ...(projection?.stablePrefixFingerprint ? { fingerprint: projection.stablePrefixFingerprint } : {}),
      cacheEligible: stablePrefixEligible,
      providerCacheHitClaimed: false,
    },
    invariantViolations: (input.invariantViolations ?? []).map(redactDiagnosticMessage),
  };
}

// Creates a zeroed-out zone diagnostics row for accumulating per-zone stats.
// 创建一个归零的 zone 诊断行，用于累计按 zone 的统计。
function createZoneRow(zone: ContextZone): ContextProjectionZoneDiagnostics {
  return {
    zone,
    candidateTokens: 0,
    finalTokens: 0,
    candidateMaterials: 0,
    includedMaterials: 0,
    omittedMaterials: 0,
    channels: [],
    trusts: [],
    protectedMaterials: 0,
    compressionActions: [],
  };
}

// Appends a value only if it is not already present, maintaining a set-like list.
// 仅在值不存在时追加，维护类似集合的列表。
function addUnique<T extends string>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

// Sanitizes diagnostic messages by stripping control characters and capping at 400 chars.
// 净化诊断消息：去除控制字符并将长度限制在 400 字符以内。
function redactDiagnosticMessage(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 400);
}
