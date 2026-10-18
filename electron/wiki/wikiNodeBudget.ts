/**
 * Budget constants and ReAct budget profiles for Wiki node-scoped agents.
 * Wiki 节点作用域 Agent 的预算常量与 ReAct 预算剖面。
 */

import type { ReActBudget } from '../knowledge/reactAgent/reactEngineTypes.ts';

/**
 * Wiki node-scope ReAct budget profile (plan §4.4).
 * Wiki 节点作用域预算剖面（方案 §4.4）。
 *
 * R2 allows at most 5 controlled retrieval cycles; the budget must fit one search per cycle
 * plus necessary deep reads, while the scope policy independently rejects a 6th search.
 * R2 最多允许 5 个受控检索周期；预算需容纳每周期一次检索以及必要的深读，
 * 同时由范围策略独立拒绝第 6 次检索。
 */
export const WIKI_NODE_REACT_BUDGET: ReActBudget = {
  /** Allows 5 "search → assess" cycles, reserving decision turns for deep reads and the final answer. / 允许 5 个“检索 → 评估”周期，并为深读与终答留出决策轮。 */
  maxIterations: 10,
  /** Includes the final answer plus limited fallback headroom. / 含终答与有限兜底余量。 */
  maxModelCalls: 12,
  /** Allows limited deep reads beyond the 5 searches; a 6th search is still rejected by the Wiki cycle gate. / 5 次检索之外允许有限深读；第 6 次检索仍由 Wiki 周期门控拒绝。 */
  maxToolCalls: 12,
  /** Aligned with the engine default. / 对齐引擎默认。 */
  maxEmptyRetries: 1,
  /** Tolerated repeated-content rounds before the engine stops early. / 引擎提前停止前允许的重复内容轮数。 */
  maxRepeatedContentRounds: 2,
  /** Node evidence granularity is smaller than whole-library retrieval. / 节点证据粒度小于全库。 */
  maxSingleObservationChars: 8_000,
  /** Aligned with the general knowledge-base dynamic trajectory budget. / 与通用知识库动态轨迹预算对齐。 */
  maxTotalObservationTokens: 20_000,
  /** Ratio of the context budget that triggers consolidation. / 触发上下文压缩的预算占比阈值。 */
  contextConsolidationThreshold: 0.5,
  /** Max tokens kept when consolidating context. / 上下文压缩时保留的最大 token 数。 */
  contextConsolidationMaxTokens: 2_000,
};

/**
 * Long-section summarization needs coverage reading rather than answer-on-first-hit: used only by
 * `summarize`; the higher budget does not affect ordinary node Q&A.
 * 长章节总结需要覆盖阅读而非命中即答：仅 `summarize` 使用，更高的预算不影响普通节点问答。
 */
export const WIKI_NODE_SUMMARY_REACT_BUDGET: ReActBudget = {
  ...WIKI_NODE_REACT_BUDGET,
  maxIterations: 12,
  maxModelCalls: 14,
  maxToolCalls: 14,
  maxTotalObservationTokens: 32_000,
};

/**
 * Full direct injection (L0) when node markdown is within this char count; the system prompt
 * then declares retrieval is only for literal verification and cross-node correlation.
 * 节点 markdown ≤ 该字符数时全文直载（L0），系统提示声明检索仅用于字面核实与跨节点关联。
 */
export const WIKI_NODE_DIRECT_INJECT_CHARS = 6_000;
/**
 * Number of leading chars injected when content exceeds the direct-inject threshold.
 * 超过直载阈值时注入的头部字符数。
 */
export const WIKI_NODE_DIRECT_HEAD_CHARS = 4_000;
/**
 * Number of trailing chars injected when content exceeds the direct-inject threshold.
 * 超过直载阈值时注入的尾部字符数。
 */
export const WIKI_NODE_DIRECT_TAIL_CHARS = 1_000;
/**
 * Max markdown chars returned per wiki_read_node window (aligned with observation budget granularity).
 * wiki_read_node 单窗返回的 markdown 字符上限（对齐观察预算粒度）。
 */
export const WIKI_NODE_READ_WINDOW_CHARS = 8_000;
/**
 * Parent-chunk recall count per wiki_node_search query; Top K is taken after multi-path merging.
 * wiki_node_search 单条查询的父块召回数；多路合并后再取 Top K。
 */
export const WIKI_NODE_SEARCH_PER_QUERY_TOP_K = 3;
/**
 * Cap on parent-chunk evidence after multi-path merging in wiki_node_search.
 * wiki_node_search 多路合并后的父块证据上限。
 */
export const WIKI_NODE_SEARCH_MERGED_TOP_K = 5;
/**
 * Maximum number of queries per wiki_node_search call.
 * wiki_node_search 单次调用的最大查询条数。
 */
export const WIKI_NODE_SEARCH_MAX_QUERIES = 3;
/**
 * Max matches returned per wiki_grep_node call; overflow prompts narrowing the scope or deep reading.
 * wiki_grep_node 单次调用返回的最大命中数；超出提示缩小范围或改用深读。
 */
export const WIKI_GREP_MAX_MATCHES = 10;
/**
 * Context radius in chars around each wiki_grep_node hit (that many chars before and after the match).
 * wiki_grep_node 单条命中在原文中的上下文字符半径（命中位置前后各取该字符数）。
 */
export const WIKI_GREP_CONTEXT_CHARS = 200;
