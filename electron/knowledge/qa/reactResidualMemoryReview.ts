/**
 * Architecture review constants and boundary guards for ReAct residual memory.
 * Records which pure contracts the ReAct routes may share and enforces that
 * conversation materials never impersonate ReAct authority.
 * ReAct 残差记忆的架构评审常量与边界守卫。
 * 记录 ReAct 路由可共享的纯合同，并确保会话材料不得冒充 ReAct 权威身份。
 */
import type { ContextMaterial } from '../context/contextRuntimeTypes.ts';

/**
 * Route identifier for a ReAct surface that may consume residual conversation memory.
 * 可消费残差会话记忆的 ReAct 表面路由标识。
 */
export type ReactResidualMemoryRoute = 'current-note' | 'library';

/**
 * Per-route enforceability review: which residual contracts a route may reuse
 * and which prerequisites remain before enforcement can be enabled.
 * 按路由的可执行性评审：该路由可复用哪些残差合同，以及启用强制前仍缺哪些前置条件。
 */
export interface ReactResidualMemoryRouteReview {
  route: ReactResidualMemoryRoute;
  residualBudget: 'reuse';
  checkpointContract: 'defer';
  qaStorage: 'forbidden';
  blockers: readonly string[];
  requiredBeforeEnforce: readonly string[];
}

/**
 * Whole-file adaptation review schema: shared/forbidden boundaries and the
 * per-route review table that together decide route-level enforcement is deferred.
 * 整体适配评审结构：共享/禁止边界与按路由评审表，共同决定路由级强制仍被推迟。
 */
export interface ReactResidualMemoryAdaptationReview {
  schemaVersion: 'react-residual-memory-review-v1';
  decision: 'defer-route-enforce';
  sharedBoundary: {
    reusable: readonly ['residual-budget-math', 'checkpoint-semantic-contract'];
    authoritativeState: readonly ['search-plan', 'evidence-ledger', 'tool-trace'];
    forbidden: readonly ['qa-table-reuse', 'authoritative-state-in-conversation-memory'];
  };
  routes: Readonly<Record<ReactResidualMemoryRoute, ReactResidualMemoryRouteReview>>;
}

/**
 * Phase 5 is an executable architecture decision, not a rollout switch. Both
 * ReAct routes may share pure budget/checkpoint contracts only after they own a
 * complete route-local transcript and CAS checkpoint. QA persistence remains
 * private to chat/knowledge-base.
 * 阶段 5 是可执行的架构决策，而不是灰度开关。两个 ReAct 路由只有在各自拥有
 * 完整的路由内会话流与 CAS Checkpoint 之后，才可共享纯预算/Checkpoint 合同。
 * QA 持久化仍然专属于 chat/knowledge-base。
 */
export const REACT_RESIDUAL_MEMORY_ADAPTATION_REVIEW: ReactResidualMemoryAdaptationReview = Object.freeze({
  schemaVersion: 'react-residual-memory-review-v1',
  decision: 'defer-route-enforce',
  sharedBoundary: {
    reusable: ['residual-budget-math', 'checkpoint-semantic-contract'],
    authoritativeState: ['search-plan', 'evidence-ledger', 'tool-trace'],
    forbidden: ['qa-table-reuse', 'authoritative-state-in-conversation-memory'],
  },
  routes: {
    'current-note': {
      route: 'current-note',
      residualBudget: 'reuse',
      checkpointContract: 'defer',
      qaStorage: 'forbidden',
      blockers: [
        'assistant-memory-loads-only-three-terminal-turns',
        'assistant-rolling-summary-has-fixed-character-cap',
        'assistant-checkpoint-is-not-the-residual-checkpoint-contract',
      ],
      requiredBeforeEnforce: [
        'route-local-complete-transcript-after-covered-sequence',
        'route-owned-checkpoint-cas-and-source-hash',
        'residual-two-pass-envelope-assembly',
      ],
    },
    library: {
      route: 'library',
      residualBudget: 'reuse',
      checkpointContract: 'defer',
      qaStorage: 'forbidden',
      blockers: [
        'conversation-is-renderer-provided',
        'react-session-id-is-created-per-turn',
        'route-has-no-transcript-or-checkpoint-authority',
      ],
      requiredBeforeEnforce: [
        'stable-main-process-library-session',
        'route-local-complete-transcript-after-covered-sequence',
        'route-owned-checkpoint-cas-and-source-hash',
      ],
    },
  },
});

/**
 * Conversation materials cannot impersonate or carry ReAct authority.
 * Collects every boundary violation found in the supplied materials.
 * 会话材料不得冒充或携带 ReAct 权威身份。
 * 收集所提供材料中的全部边界违规项。
 *
 * @param route - ReAct route the materials belong to / 材料所属的 ReAct 路由
 * @param materials - Conversation materials to validate / 待校验的会话材料
 * @returns Violation messages; empty when clean / 违规消息列表；为空表示通过
 */
export function collectReactConversationMemoryBoundaryViolations(
  route: ReactResidualMemoryRoute,
  materials: readonly ContextMaterial[],
): string[] {
  const violations: string[] = [];
  for (const material of materials) {
    if (material.zone !== 'conversation-summary' && material.zone !== 'conversation-hot') {
      violations.push(`${route} 会话记忆包含非法 Zone：${material.id}/${material.zone}`);
    }
    if (material.channel !== 'user' || material.trust !== 'untrusted-memory') {
      violations.push(`${route} 会话记忆必须保持 User Channel / untrusted-memory：${material.id}`);
    }
    if (material.protected) violations.push(`${route} 会话记忆不得升级为受保护权威材料：${material.id}`);
    if (material.cache.prefixEligible) violations.push(`${route} 会话记忆不得进入稳定前缀：${material.id}`);
    if (material.source.kind.startsWith('qa-')) violations.push(`${route} 会话记忆不得复用 QA 存储身份：${material.id}`);
    if (material.provenance?.planId
      || material.provenance?.goalIds?.length
      || material.provenance?.requirementIds?.length
      || material.provenance?.evidenceIds?.length) {
      // Any SearchPlan/Evidence Ledger identity is disallowed on conversation memory. / 会话记忆携带任一 SearchPlan/Evidence Ledger 身份即违规。
      violations.push(`${route} 会话记忆不得携带 SearchPlan 或 Evidence Ledger 身份：${material.id}`);
    }
  }
  return violations;
}

/**
 * Throws when any conversation material violates the ReAct memory boundary.
 * 当任一会话材料违反 ReAct 记忆边界时抛出错误。
 *
 * @param route - ReAct route the materials belong to / 材料所属的 ReAct 路由
 * @param materials - Conversation materials to validate / 待校验的会话材料
 * @throws Error listing all violations when at least one is found / 至少存在一项违规时抛出并列出全部违规
 */
export function assertReactConversationMemoryBoundary(
  route: ReactResidualMemoryRoute,
  materials: readonly ContextMaterial[],
): void {
  const violations = collectReactConversationMemoryBoundaryViolations(route, materials);
  if (violations.length) throw new Error(violations.join(' '));
}
