/**
 * Applies pre-computed Stage-4 compression artifacts to current-note evidence materials.
 * 将已计算的 Stage-4 压缩产物应用到当前笔记证据材料上。
 */
import type { EvidenceCompressionArtifact } from '../evidence/evidenceCompressionTypes.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import type { ContextMaterial } from '../context/contextRuntimeTypes.ts';

/** Result of applying evidence compression to current-note materials. 将证据压缩应用到当前笔记材料后的结果。 */
export interface CurrentNoteEvidenceCompressionResult {
  materials: ContextMaterial[];
  changedMaterialIds: string[];
}

/**
 * Projects already-validated Stage 4 artifacts into cold evidence materials.
 * It never calls a model and never mutates SearchPlan or Evidence Ledger state.
 * 将已验证的 Stage-4 产物投影为冷证据材料。
 * 不调用模型，不修改 SearchPlan 或 Evidence Ledger 状态。
 *
 * @param materials - Current context materials to evaluate / 要评估的当前上下文材料
 * @param artifacts - Validated compression artifacts from Stage 4 / 来自 Stage-4 的已验证压缩产物
 * @returns Object containing possibly-updated materials and list of changed material IDs / 包含可能更新的材料列表和已变更材料 ID 列表的对象
 */
export function applyCurrentNoteEvidenceCompression(
  materials: readonly ContextMaterial[],
  artifacts: readonly EvidenceCompressionArtifact[],
): CurrentNoteEvidenceCompressionResult {
  if (artifacts.length === 0) return { materials: [...materials], changedMaterialIds: [] };
  const artifactByEvidenceId = new Map<string, EvidenceCompressionArtifact>();
  for (const artifact of artifacts) {
    for (const evidenceId of artifact.sourceEvidenceIds) artifactByEvidenceId.set(evidenceId, artifact);
  }
  const changedMaterialIds: string[] = [];
  const output = materials.map((material): ContextMaterial => {
    if (material.protected || material.zone !== 'dynamic-evidence') return material;
    const evidenceIds = material.provenance?.evidenceIds ?? [];
    if (evidenceIds.length === 0) return material;
    const selected = [...new Set(evidenceIds.map((evidenceId) => artifactByEvidenceId.get(evidenceId)).filter((artifact): artifact is EvidenceCompressionArtifact => Boolean(artifact)))];
    if (selected.length === 0) return material;
    const representedEvidenceIds = new Set(selected.flatMap((artifact) => artifact.sourceEvidenceIds));
    const staleArtifact = selected.some((artifact) => (
      material.provenance?.snapshotId && artifact.snapshotId !== material.provenance.snapshotId
      || material.provenance?.contentHash && artifact.contentHash !== material.provenance.contentHash
    ));
    if (staleArtifact || evidenceIds.some((evidenceId) => !representedEvidenceIds.has(evidenceId))) return material;
    const content = selected.map(renderArtifact).join('\n\n');
    if (!content.trim() || estimateTokenCount(content) >= estimateTokenCount(material.content)) return material;
    changedMaterialIds.push(material.id);
    return {
      ...material,
      content,
      source: {
        ...material.source,
        version: `${material.source.version}:evidence-compression:${selected.map((artifact) => artifact.artifactId).sort().join(',')}`,
      },
    } as ContextMaterial;
  });
  return { materials: output, changedMaterialIds };
}

function renderArtifact(artifact: EvidenceCompressionArtifact): string {
  const sourceIds = [...new Set(artifact.sourceEvidenceIds)].sort();
  const body = artifact.compressedSegments.map((segment) => {
    const segmentSources = [...new Set(segment.sourceEvidenceIds)].sort().join(',');
    return `[${segment.segmentId}; sources=${segmentSources}] ${segment.text.trim()}`;
  }).join('\n');
  return `[既有证据压缩 Artifact ${artifact.artifactId}; evidenceIds=${sourceIds.join(',')}]\n${body}`;
}
