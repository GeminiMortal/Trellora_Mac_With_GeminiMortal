/**
 * Type definitions for the context memory adapter system including request,
 * result, diagnostics, and adapter interfaces.
 * 本模块定义上下文记忆适配器系统所需的类型，包括请求、结果、诊断和适配器接口。
 */
import type { ContextMaterial, ContextRoute } from './contextRuntimeTypes.ts';
import type { ResolvedSkillDefinitions } from '../skill/skillDefinitionResolver.ts';

/**
 * Project-level context input including stable policy, validated instructions,
 * and resolved Skill definitions.
 * 项目级别的上下文输入，包含稳定策略、已验证指令和已解析的 Skill 定义。
 */
export interface ContextProjectInput {
  /** Stable product policy already validated by the application. */
  stablePolicy: string;
  /** Optional validated project/Skill constraints without leading separators. */
  validatedInstructions?: string;
  /** Discovery descriptions are separate from selected, protected Skill bodies. */
  skills?: ResolvedSkillDefinitions;
  version: string;
}

/**
 * Request envelope for loading context memory materials. Specifies the route,
 * workspace scope, session, current question, token budgets, and optional project context.
 * 加载上下文记忆材料的请求信封。包含路由、工作区范围、会话、当前问题、token 预算和可选项目上下文。
 */
export interface ContextMemoryRequest {
  route: ContextRoute;
  workspaceId: string;
  libraryId?: string;
  noteId?: string;
  sessionId: string;
  currentQuestion: string;
  snapshotId?: string;
  contentHash?: string;
  budgets: {
    summaryTokens: number;
    hotTokens: number;
    recallTokens: number;
  };
  projectContext?: ContextProjectInput;
}

/**
 * Aggregated diagnostics for a memory load operation including counts of loaded
 * turns, summaries, recalled turns, and stale items.
 * 记忆加载操作的汇总诊断，包括已加载轮次、摘要、召回轮次和过期项数量。
 */
export interface ContextMemoryDiagnostics {
  source: string;
  loadedTurns: number;
  loadedSummaries: number;
  recalledTurns: number;
  staleItems: number;
}

/**
 * Result of a context memory load: merged materials, a version hash, and diagnostics.
 * 上下文记忆加载的结果：合并后的材料、版本哈希和诊断信息。
 */
export interface ContextMemoryResult {
  materials: ContextMaterial[];
  version: string;
  diagnostics: ContextMemoryDiagnostics;
}

/**
 * Contract for a single memory source that can determine whether it supports a
 * given request and produce memory materials from it.
 * 单个记忆源的契约：判断是否支持给定请求，并从中生成记忆材料。
 */
export interface ContextMemoryAdapter {
  readonly id: string;
  supports(request: ContextMemoryRequest): boolean;
  load(request: ContextMemoryRequest): Promise<ContextMemoryResult>;
}

/**
 * Adds cross-route context without competing for the single route adapter.
 * Supplemental failures must be isolated by the registry.
 * 添加跨路由上下文，不与单路由 Adapter 竞争。
 * 补充 Adapter 的失败必须由注册器隔离。
 */
export interface SupplementalContextAdapter extends ContextMemoryAdapter {
  readonly role: 'supplemental';
}
