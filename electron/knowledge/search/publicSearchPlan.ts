/**
 * Public projection of an internal SearchPlan for UI / assistant display,
 * with local-path redaction, label truncation and head/tail query-term sampling.
 * 将内部 SearchPlan 投影为面向界面/助手的公开视图，包含本地路径脱敏、
 * 标签截断以及查询词的头尾抽样。
 */
import type { CurrentNotePublicQueryTerm, CurrentNotePublicSearchPlan } from '../assistant/assistantTurnTypes.ts';
import { SEARCH_QUERY_TERM_PROJECTION_LIMIT, type SearchPlan } from './searchPlanTypes.ts';

/** Cap on publicly projected final query terms. / 公开投影中最终查询词的数量上限。 */
const MAX_PUBLIC_FINAL_QUERY_TERMS = SEARCH_QUERY_TERM_PROJECTION_LIMIT;

/**
 * Projects an internal plan into the sanitized public plan shape.
 * 将内部计划投影为脱敏后的公开计划结构。
 *
 * @param plan - The internal search plan. / 内部搜索计划。
 * @param evidenceIds - Evidence ids currently available for counting coverage. / 当前可计数的证据 id 集合。
 * @returns The public plan view with redacted text and bounded query terms. / 脱敏文本与限量查询词组成的公开计划视图。
 */
export function projectPublicSearchPlan(plan: SearchPlan, evidenceIds: ReadonlySet<string>): CurrentNotePublicSearchPlan {
  const activeGoal = plan.activeGoalId ? plan.goals.find((goal) => goal.goalId === plan.activeGoalId) : undefined;
  return {
    version: plan.version,
    originalQuestion: sanitizePlanText(plan.originalQuestion, 240),
    status: plan.status,
    ...(activeGoal ? { activeGoalLabel: publicGoalLabel(activeGoal.question) } : {}),
    goals: plan.goals.map((goal) => {
      // Union of all evidence ids bound via evidence and conflict bindings. / 汇总证据绑定与冲突绑定引用的全部证据 id。
      const boundEvidenceIds = new Set([
        ...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds),
        ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]),
      ]);
      return {
        label: publicGoalLabel(goal.question || goal.requirements[0]?.label || '当前核实目标'),
        status: goal.status,
        // Count only evidence that still exists in the current ledger. / 只统计仍在当前证据台账中的证据。
        evidenceCount: [...boundEvidenceIds].filter((evidenceId) => evidenceIds.has(evidenceId)).length,
        evidenceKind: goal.evidenceKind,
        requirements: goal.requirements.map((requirement) => ({
          label: sanitizePlanText(requirement.label, 120),
          minEvidence: requirement.minEvidence,
        })),
        queryTermCount: goal.queryTerms.length,
        queryTerms: projectHeadAndTail(goal.queryTerms, SEARCH_QUERY_TERM_PROJECTION_LIMIT).map((queryTerm) => projectQueryTerm(queryTerm)),
      };
    }),
  };
}

/**
 * Sanitizes, deduplicates and bounds a list of free-text query terms.
 * 对自由文本查询词进行脱敏、去重并限制数量。
 *
 * @param terms - Raw query terms. / 原始查询词列表。
 * @returns Sanitized unique terms capped at the public projection limit. / 脱敏后的唯一词项，数量不超过公开投影上限。
 */
export function sanitizeQueryTerms(terms: readonly string[]): string[] {
  return [...new Set(terms
    .map((term) => sanitizePlanText(term, 64))
    .filter(Boolean))].slice(0, MAX_PUBLIC_FINAL_QUERY_TERMS);
}

/** Projects one query term into the public shape. / 将单个查询词投影为公开结构。 */
function projectQueryTerm(queryTerm: { term: string; source: CurrentNotePublicQueryTerm['source'] }): CurrentNotePublicQueryTerm {
  return { term: sanitizePlanText(queryTerm.term, 64), source: queryTerm.source };
}

/** Keeps the head and tail of a list when it exceeds the limit. / 列表超限时保留头部与尾部元素。 */
function projectHeadAndTail<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  const headCount = Math.ceil(limit / 2);
  return [...values.slice(0, headCount), ...values.slice(-(limit - headCount))];
}

/** Builds a short ellipsized goal label. / 生成带省略号的简短目标标签。 */
function publicGoalLabel(value: string): string {
  const label = sanitizePlanText(value, 120);
  return label.length > 72 ? `${label.slice(0, 71)}…` : label;
}

/** Redacts absolute local paths and collapses whitespace before truncating. / 截断前脱敏本地绝对路径并压缩空白。 */
function sanitizePlanText(value: string, maxLength: number): string {
  return value
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, '[本地路径已省略]')
    .replace(/\\\\[^\s]+/gu, '[本地路径已省略]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}