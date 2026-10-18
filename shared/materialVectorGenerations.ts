/**
 * Shared types describing material vector generations produced by the embedding pipeline.
 * 描述嵌入流水线产生的资料向量代次的共享类型。
 */

import type { MaterialEmbeddingProfile } from '../electron/pipeline/materialEmbeddingTypes';

/**
 * Lifecycle state of a material vector generation.
 * 资料向量代次的生命周期状态。
 */
export type MaterialVectorGenerationState = 'BUILDING' | 'INTERRUPTED' | 'CANCELLED' | 'FAILED' | 'READY' | 'ACTIVE' | 'RETIRED';

/**
 * One vector generation pass over a material library, tracked for progress and lifecycle.
 * 对资料库执行的一轮向量代次，用于跟踪进度与生命周期。
 */
export interface MaterialVectorGeneration {
  /** Unique generation id. / 唯一代次 id。 */
  id: string;
  /** Current lifecycle state. / 当前生命周期状态。 */
  state: MaterialVectorGenerationState;
  /** Embedding profile used for this generation. / 本代次使用的嵌入配置档。 */
  profile: MaterialEmbeddingProfile;
  /** Number of items completed so far. / 已完成条目数。 */
  completed: number;
  /** Total number of items to process. / 需处理的条目总数。 */
  total: number;
  /** Number of evaluation queries processed. / 已处理的评测查询数。 */
  evaluatedQueries: number;
  /** ISO timestamp of creation. / 创建时的 ISO 时间戳。 */
  createdAt: string;
  /** Error message when the generation failed. / 代次失败时的错误信息。 */
  error?: string;
}
