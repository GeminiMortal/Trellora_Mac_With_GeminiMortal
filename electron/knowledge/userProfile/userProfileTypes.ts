/**
 * Shared type contracts for the user profile knowledge domain.
 * 用户画像知识域的共享类型合同。
 *
 * Defines categories, item lifecycles, extraction jobs, evidence,
 * revisions, import/export shapes and diagnostics used across the
 * Electron main-process user profile services.
 * 定义 Electron 主进程用户画像服务共用的类别、条目生命周期、抽取任务、
 * 证据、修订、导入导出结构与诊断信息。
 */

/** Whitelist of user profile categories. / 用户画像类别白名单。 */
export const USER_PROFILE_CATEGORIES = [
  'identity',
  'professional',
  'expertise',
  'technical-environment',
  'goals',
  'communication',
  'collaboration',
  'decision',
  'constraints',
  'interests',
] as const;

/** Union of allowed user profile categories. / 允许的用户画像类别联合类型。 */
export type UserProfileCategory = (typeof USER_PROFILE_CATEGORIES)[number];
/** Whether a field holds one value or many. / 字段是单值还是多值。 */
export type UserProfileCardinality = 'single' | 'multiple';
/** Temporal validity: current, historical, or unspecified. / 时效性：当前、历史或未指定。 */
export type UserProfileTemporalStatus = 'current' | 'historical' | 'unspecified';
/** How an assertion was produced. / 断言的产生方式。 */
export type UserProfileAssertionKind = 'manual' | 'explicit' | 'inferred';
/** Lifecycle status of a profile item. / 画像条目的生命周期状态。 */
export type UserProfileItemStatus = 'active' | 'suggested' | 'rejected' | 'superseded';
/** Expected stability of a value over time. / 取值随时间的预期稳定程度。 */
export type UserProfileStability = 'stable' | 'long-term' | 'contextual';
/** Scope when clearing the profile. / 清空画像的范围。 */
export type UserProfileClearScope = 'all' | 'ai-only';
/** Data source scope for extraction. / 抽取的数据来源范围。 */
export type UserProfileExtractionScope = 'chat' | 'knowledge-base';
/** Lifecycle status of an extraction job. / 抽取任务的生命周期状态。 */
export type UserProfileExtractionJobStatus = 'pending' | 'running' | 'completed' | 'empty' | 'failed' | 'blocked' | 'unknown';
/** Whether observation was explicitly stated or inferred. / 观察结果是明说还是推断。 */
export type UserProfileObservationAssertion = 'explicit' | 'inferred';
/** Stability hint for a single observation. / 单条观察结果的稳定性提示。 */
export type UserProfileObservationStability = 'stable' | 'long-term' | 'turn-only';
/** Recorded revision action on a profile item. / 画像条目上记录的修订动作。 */
export type UserProfileRevisionAction = 'create' | 'update' | 'lock' | 'unlock' | 'supersede' | 'restore';
/** Who performed a revision. / 修订的执行者。 */
export type UserProfileRevisionActor = 'user' | 'system' | 'extractor';

export interface UserProfileSettings {
  profileId: string;
  autoExtractEnabled: boolean;
  useInQaContext: boolean;
  allowChat: boolean;
  allowKnowledgeBase: boolean;
  extractionModelProfileId?: string;
  profileTokenBudget: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfileItem {
  itemId: string;
  profileId: string;
  category: UserProfileCategory;
  itemKey: string;
  fieldLabel: string;
  valueText: string;
  cardinality: UserProfileCardinality;
  temporalStatus: UserProfileTemporalStatus;
  assertionKind: UserProfileAssertionKind;
  status: UserProfileItemStatus;
  confidence: number;
  stability: UserProfileStability;
  userLocked: boolean;
  sourceCount: number;
  validFrom?: string;
  validTo?: string;
  expiresAt?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfileOverviewCounts {
  total: number;
  active: number;
  suggested: number;
  locked: number;
  evidence: number;
  conflicts: number;
  reviewDue: number;
}

export interface UserProfileOverview {
  settings: UserProfileSettings;
  items: UserProfileItem[];
  counts: UserProfileOverviewCounts;
  conflicts: UserProfileConflictGroup[];
  reviewDueItems: UserProfileReviewItem[];
  extraction: UserProfileExtractionOverview;
  maintenance?: UserProfileMaintenanceDiagnostics;
}

/** Main-process snapshot intentionally excludes evidence and background jobs. */
export interface UserProfileContextSnapshot {
  settings: UserProfileSettings;
  items: UserProfileItem[];
}

export interface UserProfileSettingsPatch {
  autoExtractEnabled?: boolean;
  useInQaContext?: boolean;
  allowChat?: boolean;
  allowKnowledgeBase?: boolean;
  profileTokenBudget?: number;
}

export interface UserProfileExtractionJob {
  jobId: string;
  sourceTurnId: string;
  sessionId: string;
  profileId: string;
  scope: UserProfileExtractionScope;
  status: UserProfileExtractionJobStatus;
  attemptCount: number;
  failedAttemptCount: number;
  manualRetryNo: number;
  modelProfileId?: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  observationCount: number;
  appliedCount: number;
  filteredSensitiveCount: number;
  filteredInvalidCount: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface UserProfileExtractionStats {
  totalJobs: number;
  pendingJobs: number;
  runningJobs: number;
  completedJobs: number;
  emptyJobs: number;
  failedJobs: number;
  blockedJobs: number;
  unknownJobs: number;
  totalCalls: number;
  failedCalls: number;
  manualRetries: number;
  observations: number;
  applied: number;
  filteredSensitive: number;
  filteredInvalid: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UserProfileExtractionOverview {
  stats: UserProfileExtractionStats;
  recentJobs: UserProfileExtractionJob[];
}

export interface UserProfileObservation {
  category: UserProfileCategory;
  key: string;
  value: string;
  assertion: UserProfileObservationAssertion;
  stability: UserProfileObservationStability;
  confidence: number;
  evidenceQuote: string;
}

export interface UserProfileExtractionScheduleInput {
  sourceTurnId: string;
  sessionId: string;
  scope: UserProfileExtractionScope;
  modelProfileId: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
}

export interface UserProfileExtractionSource {
  job: UserProfileExtractionJob;
  userText: string;
  previousAssistantQuestion?: string;
  existingItems: Array<Pick<UserProfileItem, 'category' | 'itemKey' | 'fieldLabel' | 'valueText' | 'status' | 'userLocked'>>;
}

export interface UserProfileExtractionResult {
  observationCount: number;
  observations: UserProfileObservation[];
  invalidCount: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UserProfileMergeResult {
  appliedCount: number;
  sensitiveFilteredCount: number;
  invalidFilteredCount: number;
  acceptedCategories: UserProfileCategory[];
}

export interface UserProfileRetryInput {
  jobId: string;
}

export interface UserProfileItemInput {
  itemId?: string;
  category: UserProfileCategory;
  fieldLabel: string;
  valueText: string;
  cardinality: UserProfileCardinality;
  temporalStatus: UserProfileTemporalStatus;
  userLocked: boolean;
  expectedRevision?: number;
}

export interface UserProfileEvidence {
  evidenceId: string;
  itemId: string;
  sourceTurnId?: string;
  sourceSessionId?: string;
  sourceScope: 'chat' | 'knowledge-base' | 'manual';
  excerpt: string;
  assertionKind: UserProfileAssertionKind;
  confidence: number;
  occurredAt: string;
  createdAt: string;
}

export interface UserProfileEvidencePage {
  items: UserProfileEvidence[];
  nextCursor?: number;
}

export interface UserProfileClearResult {
  deletedItems: number;
}

export interface UserProfileLockInput {
  itemId: string;
  locked: boolean;
  expectedRevision: number;
}

export interface UserProfileDeleteInput {
  itemId: string;
  expectedRevision: number;
}

export interface UserProfileEvidenceQuery {
  itemId: string;
  cursor?: number;
  pageSize?: number;
}

export interface UserProfileConflictGroup {
  groupId: string;
  category: UserProfileCategory;
  itemKey: string;
  fieldLabel: string;
  items: UserProfileItem[];
  updatedAt: string;
}

export interface UserProfileConflictResolutionInput {
  itemId: string;
  expectedRevision: number;
  decision: 'keep' | 'reject';
}

export interface UserProfileReviewItem {
  item: UserProfileItem;
  dueAt: string;
  daysOverdue: number;
}

export interface UserProfileReviewInput {
  itemId: string;
  expectedRevision: number;
  decision: 'keep' | 'archive';
}

export interface UserProfileRevisionSnapshot {
  category: UserProfileCategory;
  itemKey: string;
  fieldLabel: string;
  valueText: string;
  cardinality: UserProfileCardinality;
  temporalStatus: UserProfileTemporalStatus;
  assertionKind: UserProfileAssertionKind;
  status: UserProfileItemStatus;
  confidence: number;
  stability: UserProfileStability;
  userLocked: boolean;
  sourceCount: number;
  validFrom?: string;
  validTo?: string;
  expiresAt?: string;
}

export interface UserProfileRevision {
  revisionId: string;
  itemId: string;
  revision: number;
  action: UserProfileRevisionAction;
  actor: UserProfileRevisionActor;
  before?: UserProfileRevisionSnapshot;
  after?: UserProfileRevisionSnapshot;
  createdAt: string;
}

export interface UserProfileRevisionQuery {
  itemId: string;
  cursor?: number;
  pageSize?: number;
}

export interface UserProfileRevisionPage {
  items: UserProfileRevision[];
  nextCursor?: number;
}

export interface UserProfileRollbackInput {
  itemId: string;
  targetRevision: number;
  expectedRevision: number;
}

export interface UserProfileQueueDiagnostics {
  state: 'idle' | 'running' | 'stopped';
  queuedJobs: number;
  activeJobs: number;
  activeJobId?: string;
  lastSettledAt?: string;
  lastErrorCode?: string;
}

export interface UserProfileContextUsageDiagnostics {
  sampleCount: number;
  averageCandidateTokens: number;
  averageFinalTokens: number;
  peakCandidateTokens: number;
  truncatedSamples: number;
  recommendedTokenBudget?: number;
  recommendationReason: string;
}

export interface UserProfileCategoryUsage {
  category: UserProfileCategory;
  activeItems: number;
  suggestedItems: number;
  evidenceCount: number;
}

export interface UserProfileMaintenanceDiagnostics {
  queue: UserProfileQueueDiagnostics;
  contextUsage: UserProfileContextUsageDiagnostics;
  categories: UserProfileCategoryUsage[];
  categoryPolicy: 'fixed-whitelist';
}

export interface UserProfileUpdateReceipt {
  requestId: string;
  updatedItemCount: number;
  completedAt: string;
}

export interface UserProfileExportItem {
  category: UserProfileCategory;
  fieldLabel: string;
  valueText: string;
  cardinality: UserProfileCardinality;
  temporalStatus: UserProfileTemporalStatus;
  status: 'active';
  userLocked: boolean;
}

export interface UserProfileExportDocument {
  format: 'menghan-notes.user-profile';
  version: 1;
  exportedAt: string;
  items: UserProfileExportItem[];
}

export interface UserProfileExportResult {
  canceled: boolean;
  exportedItems: number;
}

export interface UserProfileImportSummary {
  importedItems: number;
  skippedItems: number;
  rejectedItems: number;
  conflictItems: number;
}

export interface UserProfileImportResult extends UserProfileImportSummary {
  canceled: boolean;
}
