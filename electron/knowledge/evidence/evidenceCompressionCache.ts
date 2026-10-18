/**
 * In-memory derived-data cache for evidence compression artifacts.
 * 证据压缩产物的内存派生数据缓存。
 */
import {
  createEvidenceCompressionCacheKey,
  type EvidenceCompressionArtifact,
  type EvidenceCompressionCacheEntry,
  type EvidenceCompressionCacheStateVector,
} from './evidenceCompressionTypes.ts';

/**
 * An in-memory derived-data cache. The state vector deliberately includes the
 * session and turn, so a cache hit can never cross those isolation boundaries.
 * 内存派生数据缓存。状态向量故意包含 session 和 turn，确保缓存命中不会跨越隔离边界。
 */
export class EvidenceCompressionCache {
  private readonly entries = new Map<string, EvidenceCompressionCacheEntry>();

  /**
   * Retrieve a cached compression artifact by its state vector.
   * 根据状态向量获取缓存的压缩产物。
   *
   * @param stateVector - The cache lookup key / 缓存查找键
   * @returns A deep copy of the cached artifact, or undefined if absent / 缓存产物的深拷贝，未命中时返回 undefined
   */
  get(stateVector: EvidenceCompressionCacheStateVector): EvidenceCompressionArtifact | undefined {
    const key = createEvidenceCompressionCacheKey(stateVector);
    const entry = this.entries.get(key);
    return entry ? copyArtifact(entry.artifact) : undefined;
  }

  /**
   * Store a compression artifact in the cache, keyed by the given state vector.
   * 将压缩产物存入缓存，以给定状态向量为键。
   *
   * @param stateVector - The cache key / 缓存键
   * @param artifact - The artifact to cache / 要缓存的产物
   * @returns The computed cache key / 计算得到的缓存键
   */
  set(stateVector: EvidenceCompressionCacheStateVector, artifact: EvidenceCompressionArtifact): string {
    assertArtifactMatchesState(stateVector, artifact);
    const key = createEvidenceCompressionCacheKey(stateVector);
    this.entries.set(key, { key, stateVector: copyStateVector(stateVector), artifact: copyArtifact(artifact) });
    return key;
  }

  /**
   * Remove a cached entry by its state vector.
   * 根据状态向量移除缓存条目。
   *
   * @param stateVector - The cache key to remove / 要移除的缓存键
   * @returns true if an entry was deleted / 成功删除时返回 true
   */
  delete(stateVector: EvidenceCompressionCacheStateVector): boolean {
    return this.entries.delete(createEvidenceCompressionCacheKey(stateVector));
  }

  /**
   * Remove all cached entries.
   * 清除所有缓存条目。
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Number of entries currently in the cache.
   * 当前缓存中的条目数量。
   */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Assert that an artifact's identity fields match the given state vector.
 * 断言产物的身份字段与给定状态向量一致。
 *
 * @param stateVector - Expected state / 期望状态
 * @param artifact - Artifact to validate / 待校验产物
 */
function assertArtifactMatchesState(stateVector: EvidenceCompressionCacheStateVector, artifact: EvidenceCompressionArtifact): void {
  const expectedIds = new Set(stateVector.sourceEvidenceIds);
  const actualIds = new Set(artifact.sourceEvidenceIds);
  if (artifact.snapshotId !== stateVector.snapshotId) throw new Error('压缩缓存 Artifact 的 snapshotId 不匹配。');
  if (artifact.contentHash !== stateVector.contentHash) throw new Error('压缩缓存 Artifact 的 contentHash 不匹配。');
  if (artifact.modelProfileId !== stateVector.modelProfileId) throw new Error('压缩缓存 Artifact 的 modelProfileId 不匹配。');
  if (artifact.compressionPolicyVersion !== stateVector.compressionPolicyVersion) throw new Error('压缩缓存 Artifact 的策略版本不匹配。');
  if (expectedIds.size !== actualIds.size || [...expectedIds].some((evidenceId) => !actualIds.has(evidenceId))) {
    throw new Error('压缩缓存 Artifact 的 sourceEvidenceIds 不匹配。');
  }
}

/**
 * Deep-copy a state vector to prevent external mutation of cached keys.
 * 深拷贝状态向量，防止外部修改缓存键。
 */
function copyStateVector(stateVector: EvidenceCompressionCacheStateVector): EvidenceCompressionCacheStateVector {
  return {
    ...stateVector,
    sourceEvidenceIds: [...stateVector.sourceEvidenceIds],
    sourceTextHashes: { ...stateVector.sourceTextHashes },
  };
}

/**
 * Deep-copy an artifact including its nested segments and conflict arrays.
 * 深拷贝产物，包括嵌套的段落数组和冲突数组。
 */
function copyArtifact(artifact: EvidenceCompressionArtifact): EvidenceCompressionArtifact {
  return {
    ...artifact,
    sourceEvidenceIds: [...artifact.sourceEvidenceIds],
    compressedSegments: artifact.compressedSegments.map((segment) => ({
      ...segment,
      sourceEvidenceIds: [...segment.sourceEvidenceIds],
      preservedTopics: [...segment.preservedTopics],
    })),
    preservedConflicts: artifact.preservedConflicts.map((conflict) => ({
      ...conflict,
      supportsEvidenceIds: [...conflict.supportsEvidenceIds],
      contradictsEvidenceIds: [...conflict.contradictsEvidenceIds],
    })),
  };
}
