/**
 * Shared types describing user-facing capability states and probes.
 * 描述面向用户的能力状态与探测请求的共享类型。
 */

/**
 * Availability state of a user-facing capability.
 * 面向用户能力的可用性状态。
 */
export type CapabilityState = 'available' | 'unconfigured' | 'unverified' | 'unreachable' | 'processing' | 'failed';

/**
 * Identifier of a user-facing capability.
 * 面向用户能力的标识符。
 */
export type CapabilityId = 'editing' | 'keywordSearch' | 'generation' | 'materialFullText' | 'materialSemantic' | 'pdfParsing' | 'documentWorker';

/**
 * Status report for a single capability with a user-actionable message.
 * 单个能力的状态报告，附带可操作的用户提示。
 */
export interface UserCapability {
  /** Capability identifier. / 能力标识符。 */
  id: CapabilityId;
  /** Current availability state. / 当前可用性状态。 */
  state: CapabilityState;
  /** Stable machine-readable code. / 稳定的机器可读代码。 */
  code: string;
  /** Human-readable status message. / 可读的状态信息。 */
  message: string;
  /** Suggested user action. / 建议的用户操作。 */
  action: string;
  /** ISO timestamp of the last check. / 最近一次检查的 ISO 时间戳。 */
  checkedAt: string;
}

/**
 * Optional scope for capability queries.
 * 能力查询的可选范围。
 */
export interface CapabilityRequest {
  /** Library path whose capabilities to inspect. / 要检查能力的资料库路径。 */
  libraryPath?: string;
  /** Document id whose capabilities to inspect. / 要检查能力的文档 id。 */
  documentId?: string;
}

/**
 * Snapshot of capability states for an optional scope.
 * 针对可选范围的能力状态快照。
 */
export interface CapabilitySnapshot extends CapabilityRequest {
  /** Capability reports in the snapshot. / 快照中的能力报告列表。 */
  capabilities: UserCapability[];
}

/**
 * Request to actively probe one on-demand capability.
 * 主动探测某个按需能力的请求。
 */
export interface CapabilityProbeRequest extends CapabilityRequest {
  /** Client-generated id used to correlate the response. / 客户端生成的请求 id，用于关联响应。 */
  requestId: string;
  /** Capability to probe. / 要探测的能力。 */
  capability: 'generation' | 'documentWorker' | 'materialSemantic';
}
