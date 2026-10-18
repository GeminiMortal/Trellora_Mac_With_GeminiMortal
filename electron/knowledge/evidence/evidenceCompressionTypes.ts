/**
 * Type definitions and constants for the evidence compression pipeline.
 * 证据压缩流水线的类型定义与常量。
 */
import { createHash } from 'node:crypto';

/** Stage 4 policy version identifier. 第四阶段策略版本标识符。 */
export const EVIDENCE_COMPRESSION_POLICY_VERSION = 'stage4-v1';
/** Target compression reduction ratio (35%). 目标压缩缩减比率（35%）。 */
export const EVIDENCE_COMPRESSION_TARGET_REDUCTION_RATIO = 0.35;
/** Minimum acceptable reduction ratio (30%). 最低可接受缩减比率（30%）。 */
export const EVIDENCE_COMPRESSION_MIN_REDUCTION_RATIO = 0.30;
/** Maximum acceptable reduction ratio (40%). 最高可接受缩减比率（40%）。 */
export const EVIDENCE_COMPRESSION_MAX_REDUCTION_RATIO = 0.40;

/**
 * A single source evidence record fed into the compression pipeline.
 * 输入压缩流水线的单条源证据记录。
 */
export interface EvidenceCompressionSourceEvidence {
  evidenceId: string;
  snapshotId: string;
  contentHash: string;
  textHash: string;
  text: string;
  headingPath: string[];
  lineFrom?: number;
  lineTo?: number;
  goalIds: string[];
  firstSeenSeq: number;
  bestScore?: number;
  protected?: boolean;
  /** Original evidence IDs represented by a derived compression unit. 由派生压缩单元代表的原始证据 ID。 */
  representedEvidenceIds?: string[];
}

/**
 * A conflict binding linking supporting and contradicting evidence on a topic.
 * 将支持和反对证据链接到某个主题的冲突绑定。
 */
export interface EvidenceCompressionConflictBinding {
  topic: string;
  supportsEvidenceIds: string[];
  contradictsEvidenceIds: string[];
}

/**
 * A compression batch describing source evidence to compress and its target ratio.
 * 描述待压缩源证据及其目标比率的压缩批次。
 */
export interface EvidenceCompressionBatch {
  batchId: string;
  snapshotId: string;
  contentHash: string;
  sourceEvidenceIds: string[];
  /** Internal source-unit IDs; absent for first-round raw evidence batches. 内部源单元 ID；首轮原始证据批次中不存在。 */
  sourceUnitIds?: string[];
  sourceTokenCount: number;
  primaryGoalId: string;
  headingPath: string[];
  targetReductionRatio: number;
  estimatedCompressedTokens: number;
  estimatedNetSavingsTokens: number;
  artifactFramingTokens: number;
}

/**
 * A compressed text segment produced by the AI, tracing back to source evidence.
 * AI 生成的压缩文本段落，可追溯到源证据。
 */
export interface EvidenceCompressionSegment {
  segmentId: string;
  sourceEvidenceIds: string[];
  text: string;
  preservedTopics: string[];
}

/**
 * A conflict preserved through compression, with supporting and contradicting evidence IDs.
 * 压缩过程中保留的冲突，含支持和反对的证据 ID。
 */
export interface EvidenceCompressionPreservedConflict {
  topic: string;
  supportsEvidenceIds: string[];
  contradictsEvidenceIds: string[];
}

/**
 * The immutable output artifact of a successful compression run.
 * 压缩成功运行后的不可变输出产物。
 */
export interface EvidenceCompressionArtifact {
  artifactId: string;
  batchId: string;
  snapshotId: string;
  contentHash: string;
  sourceEvidenceIds: string[];
  sourceTokenCount: number;
  compressedTokenCount: number;
  reductionRatio: number;
  compressedSegments: EvidenceCompressionSegment[];
  preservedConflicts: EvidenceCompressionPreservedConflict[];
  modelProfileId: string;
  compressionPolicyVersion: string;
  createdAt: string;
}

/**
 * State vector that uniquely identifies a compression cache entry.
 * 唯一标识压缩缓存条目的状态向量。
 */
export interface EvidenceCompressionCacheStateVector {
  libraryId: string;
  noteId: string;
  sessionId: string;
  turnId: string;
  planId: string;
  planVersion: number;
  questionHash: string;
  snapshotId: string;
  contentHash: string;
  sourceEvidenceIds: string[];
  sourceTextHashes: Record<string, string>;
  compressionPolicyVersion: string;
  targetReductionRatio: number;
  modelProfileId: string;
  tokenizerFingerprint: string;
}

/**
 * A single entry in the compression cache, pairing a state vector with its artifact.
 * 压缩缓存中的单个条目，将状态向量与其产物配对。
 */
export interface EvidenceCompressionCacheEntry {
  key: string;
  stateVector: EvidenceCompressionCacheStateVector;
  artifact: EvidenceCompressionArtifact;
}

/**
 * Default strict JSON Schema for AI compression output validation.
 * 用于 AI 压缩输出校验的默认严格 JSON Schema。
 */
export const DEFAULT_EVIDENCE_COMPRESSION_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['batchId', 'sourceEvidenceIds', 'compressedSegments', 'preservedConflicts'],
  properties: {
    batchId: { type: 'string' },
    sourceEvidenceIds: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    },
    compressedSegments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['segmentId', 'sourceEvidenceIds', 'text', 'preservedTopics'],
        properties: {
          segmentId: { type: 'string' },
          sourceEvidenceIds: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
          text: { type: 'string', minLength: 1 },
          preservedTopics: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    preservedConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'supportsEvidenceIds', 'contradictsEvidenceIds'],
        properties: {
          topic: { type: 'string' },
          supportsEvidenceIds: {
            type: 'array',
            items: { type: 'string' },
          },
          contradictsEvidenceIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
});

/**
 * Compute a deterministic cache key from a canonicalized state vector.
 * 从规范化状态向量计算确定性缓存键。
 *
 * @param state - The state vector to canonicalize and hash / 待规范化和哈希的状态向量
 * @returns A prefixed SHA-256 cache key / 带前缀的 SHA-256 缓存键
 */
export function createEvidenceCompressionCacheKey(state: EvidenceCompressionCacheStateVector): string {
  const canonical = {
    libraryId: state.libraryId,
    noteId: state.noteId,
    sessionId: state.sessionId,
    turnId: state.turnId,
    planId: state.planId,
    planVersion: state.planVersion,
    questionHash: state.questionHash,
    snapshotId: state.snapshotId,
    contentHash: state.contentHash,
    sourceEvidenceIds: [...new Set(state.sourceEvidenceIds)].sort(),
    sourceTextHashes: Object.fromEntries(Object.entries(state.sourceTextHashes).sort(([first], [second]) => first.localeCompare(second))),
    compressionPolicyVersion: state.compressionPolicyVersion,
    targetReductionRatio: state.targetReductionRatio,
    modelProfileId: state.modelProfileId,
    tokenizerFingerprint: state.tokenizerFingerprint,
  };
  return `evidence-compression-cache-${createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')}`;
}
