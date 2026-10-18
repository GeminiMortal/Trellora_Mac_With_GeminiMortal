/**
 * Type and constant vocabulary for the current-note search plan domain:
 * goal/plan statuses, evidence kinds, query-term sources, budgets and patch shapes.
 * 当前笔记搜索计划域的类型与常词表：目标/计划状态、证据类型、查询词来源、预算与补丁结构。
 */
import type { CurrentNoteSearchScopePlannerInput } from '../currentNote/currentNoteSearchScope.ts';

/** Allowed statuses for a single search goal. / 单个搜索目标的允许状态。 */
export const searchGoalStatuses = [
  'pending',
  'searching',
  'partial',
  'covered',
  'conflicted',
  'not-found',
] as const;

/** Lifecycle status of a single search goal. / 单个搜索目标的生命周期状态。 */
export type SearchGoalStatus = typeof searchGoalStatuses[number];

/** Allowed plan statuses in one canonical order. / 计划状态的合法取值（固定顺序）。 */
export const searchPlanStatuses = [
  'active',
  'completed',
  'partial',
  'not-found',
  'failed',
  'cancelled',
  'stale',
  'interrupted',
] as const;

/** Lifecycle status of the whole search plan. / 整个搜索计划的生命周期状态。 */
export type SearchPlanStatus = typeof searchPlanStatuses[number];

/** Evidence shapes a goal may request. / 目标可要求的证据形态。 */
export const searchEvidenceKinds = ['fact', 'definition', 'comparison', 'cause', 'timeline'] as const;
/** Kind of evidence a goal needs. / 目标所需证据的类型。 */
export type SearchEvidenceKind = typeof searchEvidenceKinds[number];

/** Allowed provenance sources of a query term. / 查询词允许的来源出处。 */
export const searchQueryTermSources = [
  'planner',
  'note-map',
  'search-observation',
  'model-synonym',
  'user-confirmed',
] as const;

/** Provenance of a query term. / 查询词的来源出处。 */
export type SearchQueryTermSource = typeof searchQueryTermSources[number];
/** Provenance of a late-added query variant; 'planner' is reserved for initial terms. / 后补查询变体的来源；'planner' 仅限初始查询词使用。 */
export type SearchQueryVariantSource = Exclude<SearchQueryTermSource, 'planner'>;

/** Completeness labels a final answer may claim. / 最终回答可声明的完整度标签。 */
export const searchPlanCompleteness = ['complete', 'partial', 'not-found'] as const;
/** Completeness of a final answer. / 最终回答的完整度。 */
export type SearchPlanCompleteness = typeof searchPlanCompleteness[number];

/**
 * Technical execution/projection bounds; SearchPlan itself has no cumulative QueryTerm count limit.
 * 技术执行/投影上限；SearchPlan 本身不限制 QueryTerm 的累计数量。
 */
export const SEARCH_QUERY_TERM_BATCH_SIZE = 8;      /** Query terms per goal from the Planner. / Planner 单目标查询词上限。 */
export const SEARCH_QUERY_TERM_PROJECTION_LIMIT = 16; /** Query terms exposed in the public plan view. / 公开计划视图展示的查询词上限。 */
export const SEARCH_QUERY_VARIANTS_PER_PATCH = 4;     /** Variants a single patch may append per goal. / 单补丁单目标追加变体上限。 */

/** Default structural budget of one plan; v1 constants, not user-configurable. / 单个计划的默认结构预算；第一版常量，不对外开放配置。 */
export const DEFAULT_SEARCH_PLAN_BUDGET = {
  maxGoals: 4,
  maxRequirementsPerGoal: 4,
  maxEvidencePerRequirementBinding: 4,
  maxEvidencePerConflictSide: 4,
  maxPlanRevisions: 2,
  maxGoalUpdates: 8,
} as const;

/**
 * One verifiable evidence requirement inside a goal.
 * 目标内一条可核验的证据要求。
 */
export interface SearchEvidenceRequirement {
  requirementId: string; /** Stable unique id. / 稳定唯一 id。 */
  label: string;         /** Human-readable statement to be proven. / 待证明的可读陈述。 */
  subject?: string;      /** Optional subject the requirement is about. / 该要求涉及的主体（可选）。 */
  minEvidence: number;   /** Distinct evidence count needed. / 覆盖该要求所需的去重证据数。 */
}

/**
 * Binds collected evidence ids to one requirement.
 * 将已收集的证据 id 绑定到某个要求。
 */
export interface SearchEvidenceBinding {
  requirementId: string;
  evidenceIds: string[];
}

/**
 * Binds supporting and contradicting evidence for a conflicted requirement.
 * 为存在冲突的要求绑定支持与反对两侧的证据。
 */
export interface SearchConflictBinding {
  requirementId: string;
  supportsEvidenceIds: string[];
  contradictsEvidenceIds: string[];
}

/**
 * One search query term with its provenance.
 * 单个搜索查询词及其来源。
 */
export interface SearchQueryTerm {
  term: string;
  source: SearchQueryTermSource;
}

/**
 * A search goal: a question plus the evidence needed to answer it.
 * 一个搜索目标：待回答的问题及支撑其回答所需的证据。
 */
export interface SearchGoal {
  goalId: string;        /** Stable unique id. / 稳定唯一 id。 */
  question: string;      /** The question this goal answers. / 该目标要回答的问题。 */
  evidenceKind: SearchEvidenceKind;
  requirements: SearchEvidenceRequirement[];
  queryTerms: SearchQueryTerm[]; /** Retrieval anchors for search execution. / 供检索执行使用的检索锚点。 */
  status: SearchGoalStatus;
  evidenceBindings: SearchEvidenceBinding[];
  conflictBindings: SearchConflictBinding[];
  missingEvidence?: string;      /** Description of evidence still missing. / 尚缺证据的说明。 */
}

/**
 * The controller-owned search plan document.
 * 由控制器持有的搜索计划文档。
 */
export interface SearchPlan {
  planId: string;           /** Stable unique id. / 稳定唯一 id。 */
  version: number;          /** Monotonic revision, incremented on every accepted change. / 单调递增版本号。 */
  originalQuestion: string; /** The user's original question; never rewritten. / 用户原始问题；不被改写。 */
  goals: SearchGoal[];
  activeGoalId: string | null; /** Goal currently being executed; null when none. / 当前执行目标；可为 null。 */
  status: SearchPlanStatus;
  revisionCount: number;    /** Count of replanning revisions. / 重规划修订次数。 */
  goalUpdateCount: number;  /** Count of goal updates applied. / 已应用的目标更新次数。 */
  createdAt: string;
  updatedAt: string;
}

/**
 * The only model-facing shape accepted when a plan is first created.
 * 计划首次创建时唯一接受的面向模型结构。
 */
export interface SearchPlannerGoalInput {
  goalId?: string;         /** Optional id; assigned locally when absent. / 可选 id；缺失时由本地分配。 */
  question: string;
  evidenceKind: SearchEvidenceKind;
  requirements: SearchEvidenceRequirement[];
  queryTerms: string[];    /** Plain-string retrieval anchors. / 纯字符串形式的检索锚点。 */
}

/**
 * Raw Planner JSON output with an optional scope and required goals.
 * Planner 原始 JSON 输出，含可选 scope 与必需的 goals。
 */
export interface SearchPlannerOutput {
  scope?: CurrentNoteSearchScopePlannerInput; /** Planner-proposed search scope. / Planner 提出的检索范围。 */
  goals: SearchPlannerGoalInput[];
}

/**
 * Local draft shape accepted by createSearchPlan.
 * createSearchPlan 接受的本地草稿结构。
 */
export interface SearchPlanDraft {
  originalQuestion: string;
  goals: Array<{
    goalId?: string;
    question: string;
    evidenceKind: SearchEvidenceKind;
    requirements: SearchEvidenceRequirement[];
    queryTerms: Array<string | SearchQueryTerm>;
  }>;
}

/**
 * A query term appended to a goal after plan creation.
 * 计划创建后向目标追加的查询词。
 */
export interface QueryVariant {
  term: string;
  source: SearchQueryVariantSource;
}

/**
 * Per-goal update carried by a patch.
 * 补丁中针对单个目标的更新。
 */
export interface SearchPlanPatchGoalUpdate {
  goalId: string;
  status?: SearchGoalStatus;
  queryVariants?: QueryVariant[];
  evidenceBindings?: SearchEvidenceBinding[];
  conflictBindings?: SearchConflictBinding[];
  missingEvidence?: string | null; /** Set/clear the missing-evidence note (null clears). / 设置或清除缺证说明（null 清除）。 */
}

/**
 * Optimistic-concurrency patch proposed against one plan version.
 * 针对某个计划版本提出的乐观并发补丁。
 */
export interface SearchPlanPatch {
  baseVersion: number;           /** Version the patch was computed against. / 补丁计算时所基于的版本。 */
  activeGoalId?: string | null;  /** Requested active goal; null clears it. / 请求设置的活动目标；null 表示清除。 */
  goalOrder?: string[];          /** Full permutation of existing goal ids. / 现有 goalId 的完整排列。 */
  goalUpdates: SearchPlanPatchGoalUpdate[];
}

/**
 * An answer may carry its final coverage patch; it is not a separate tool.
 * 回答动作可携带最终覆盖补丁；它不是独立工具。
 */
export interface SearchPlanAnswerAction {
  type: 'answer';
  answer: string;
  citations?: string[];          /** Evidence ids cited by the answer. / 回答引用的证据 id。 */
  completeness: SearchPlanCompleteness;
  planPatch?: SearchPlanPatch;   /** Optional final coverage patch applied atomically. / 可选的最终覆盖补丁，与回答原子应用。 */
}

/** Evidence id collection accepted by validation (set or array). / 校验接受的证据 id 集合（集合或数组）。 */
export type SearchPlanEvidenceIds = ReadonlySet<string> | readonly string[];

/**
 * Options controlling plan/patch validation strictness.
 * 控制计划/补丁校验严格程度的选项。
 */
export interface SearchPlanValidationOptions {
  evidenceIds?: SearchPlanEvidenceIds; /** Current Evidence Ledger. / 当前证据台账。 */
  /** Controller-provided lexical scope for non-model query variants. / 控制器为非模型查询变体提供的词法作用域。 */
  queryVariantScope?: SearchQueryVariantScope;
  /** Internal allowance for an answer atomically terminating the active turn. / 允许回答原子性结束当前轮次时清空活动目标。 */
  allowActiveGoalClear?: boolean;
  /** Stage 6: one valid source per requirement, not legacy count. / 第六阶段：每要求只需一个有效来源。 */
  relaxRequirementMinEvidence?: boolean;
  /** Stage 6: conflicted goal may be complete when both sides cited. / 第六阶段：冲突目标双侧引用后可视为完成。 */
  allowConflictedComplete?: boolean;
}

/**
 * Allowed term inventories per non-model query-variant source.
 * 各非模型查询变体来源允许的词项清单。
 */
export interface SearchQueryVariantScope {
  noteMapTerms?: readonly string[];          /** Terms provable by the note map. / 可由笔记图谱证明的词项。 */
  searchObservationTerms?: readonly string[]; /** Terms provable by search observations. / 可由搜索观察证明的词项。 */
  userConfirmedTerms?: readonly string[];    /** Terms explicitly confirmed by the user. / 用户显式确认过的词项。 */
}

/**
 * Options for applying patches; adds timestamp and answer-finalizing context.
 * 应用补丁的选项，额外提供时间戳与回答收尾上下文。
 */
export interface SearchPlanPatchOptions extends SearchPlanValidationOptions {
  now?: string;              /** Timestamp used for updatedAt. / 用于 updatedAt 的时间戳。 */
  /** The answer path may clear activeGoalId while terminating the plan. / 回答路径在终止计划时可清空 activeGoalId。 */
  isAnswerFinalizing?: boolean;
}


