/**
 * Wiki retrieval cycle wrapper and fallback query builder for scoped search tools.
 * Wiki 检索周期包装器与降级查询构造器，为检索工具叠加 Wiki 专属范围门控。
 */

import { escapeXmlAttribute, escapeXmlText } from '../knowledge/tools/knowledgeToolContext.ts';
import type { ReActTool, ReActToolExecution } from '../knowledge/reactAgent/toolRegistry.ts';
import type { WikiSearchRange } from './wikiScopePolicy.ts';
import type { WikiToolContext } from './wikiToolContext.ts';

/**
 * Input for generating a set of fallback search queries.
 * 生成降级搜索查询集的输入。
 */
export interface WikiFallbackQueryInput {
  /** The raw user question / 原始用户问题 */
  originalQuestion: string;
  /** The rewritten/resolved question / 改写/解析后的问题 */
  resolvedQuestion: string;
  /** Sub-questions from question decomposition / 问题分解后的子问题 */
  subQuestions?: readonly string[];
  /** Explicit section titles mentioned in the question / 问题中明确提及的章节标题 */
  explicitSectionTitles?: readonly string[];
}

/**
 * Wrap a search tool with Wiki-specific cycle gating and scope policy. If the arguments themselves
 * are invalid the original tool still returns its own error, so an "invalid params" result is not
 * counted as a real retrieval cycle.
 * 为检索类工具叠加 Wiki 专属周期与范围门控。参数本身不合法时仍交给原工具返回
 * 既有错误，避免把"参数错误"错误计为一次真实检索周期。
 *
 * @param tool - The search tool to wrap / 待包装的检索工具
 * @param range - Search range: subtree or document / 检索范围：子树或文档
 * @returns A wrapped tool with cycle gating / 叠加了周期门控的包装工具
 */
export function createWikiScopedSearchTool(
  tool: ReActTool<WikiToolContext>,
  range: WikiSearchRange,
): ReActTool<WikiToolContext> {
  return {
    ...tool,
    execute: async (args, ctx) => {
      if (!hasExecutableWikiSearchArgs(tool.name, args)) return tool.execute(args, ctx);

      const decision = ctx.scopePolicy.beginSearch({ toolName: tool.name, range, args });
      if (!decision.allowed) {
        ctx.onScopeTrace?.({
          action: 'wiki-retrieval-cycle',
          status: 'rejected',
          output: {
            tool: tool.name,
            range,
            blockReason: decision.blockReason,
            cycles: ctx.scopeState.retrievalCycleCount,
            maxCycles: ctx.scopeState.maxRetrievalCycles,
          },
          error: decision.message,
        });
        return {
          ok: false,
          observation: `<tool_error code="${escapeXmlAttribute(decision.blockReason ?? 'scope-policy')}">${escapeXmlText(decision.message)}</tool_error>`,
          message: decision.message,
          referenceCount: 0,
        };
      }

      ctx.onStage?.(`正在执行第 ${decision.cycle}/${ctx.scopeState.maxRetrievalCycles} 个检索周期（${range === 'document' ? '本文其他章节' : '当前章节'}）…`);
      ctx.onScopeTrace?.({
        action: 'wiki-retrieval-cycle',
        status: 'started',
        output: {
          tool: tool.name,
          range,
          cycle: decision.cycle,
          maxCycles: ctx.scopeState.maxRetrievalCycles,
          scopeEscalated: decision.scopeEscalated === true,
        },
      });
      if (decision.scopeEscalated) {
        ctx.onScopeTrace?.({
          action: 'wiki-scope-escalation',
          status: 'completed',
          output: {
            from: 'subtree',
            to: 'document',
            reason: ctx.scopeState.escalationReason,
            cycle: decision.cycle,
          },
        });
      }

      try {
        const execution = await tool.execute(args, ctx);
        const newEvidenceCount = execution.referenceCount ?? 0;
        ctx.scopePolicy.completeSearch({ range, ok: execution.ok, newEvidenceCount });
        ctx.onScopeTrace?.({
          action: 'wiki-retrieval-cycle',
          status: 'completed',
          output: {
            tool: tool.name,
            range,
            cycle: decision.cycle,
            ok: execution.ok,
            newEvidenceCount,
            totalCycles: ctx.scopeState.retrievalCycleCount,
          },
        });
        return appendCycleObservation(execution, range, decision.cycle ?? ctx.scopeState.retrievalCycleCount, ctx.scopeState.maxRetrievalCycles);
      } catch (error) {
        ctx.scopePolicy.completeSearch({ range, ok: false, newEvidenceCount: 0 });
        ctx.onScopeTrace?.({
          action: 'wiki-retrieval-cycle',
          status: 'rejected',
          output: { tool: tool.name, range, cycle: decision.cycle },
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

/**
 * Build a bounded query queue from rewritten question artifacts for the fallback search path.
 * Deduplicates and caps at 5; does not pad to reach the limit.
 * 降级链路使用问题改写的真实产物生成有限查询队列。去重后最多 5 条；不足 5 条
 * 就按实际条数结束，不机械填满。
 *
 * @param input - Original/resolved question, sub-questions and section titles / 原始/改写后的问题、子问题与章节标题
 * @returns Deduplicated queries (≤ 5) / 去重后的查询（最多 5 条）
 */
export function buildWikiFallbackQueries(input: WikiFallbackQueryInput): string[] {
  const candidates = [
    ...(input.explicitSectionTitles ?? []).map((title) => `${title}：${input.resolvedQuestion}`),
    ...(input.subQuestions ?? []),
    input.resolvedQuestion,
    input.originalQuestion,
  ];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const candidate of candidates) {
    const query = candidate.trim();
    if (!query) continue;
    const key = query.toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query.slice(0, 120));
    if (queries.length >= 5) break;
  }
  return queries;
}

/** Check whether the tool args are valid enough to count as a real search (policy: invalid params are not a cycle). / 检查工具参数是否合法到应计入真实检索周期（策略：参数错误不算周期）。 */
function hasExecutableWikiSearchArgs(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'wiki_grep_node') return typeof args.pattern === 'string' && args.pattern.trim().length > 0;
  if (toolName === 'wiki_node_search' || toolName === 'wiki_search_document') {
    return Array.isArray(args.queries) && args.queries.some((item) => typeof item === 'string' && item.trim().length > 0);
  }
  return true;
}

/** Append a `<retrieval_cycle>` metadata tag to the observation for model visibility / 在观察结果中追加 `<retrieval_cycle>` 元数据标签，供模型感知周期进度 */
function appendCycleObservation(
  execution: ReActToolExecution,
  range: WikiSearchRange,
  cycle: number,
  maxCycles: number,
): ReActToolExecution {
  return {
    ...execution,
    observation: `${execution.observation}\n<retrieval_cycle current="${cycle}" max="${maxCycles}" range="${range}" new_evidence="${execution.referenceCount ?? 0}" />`,
    message: `第 ${cycle}/${maxCycles} 个检索周期：${execution.message}`,
  };
}
