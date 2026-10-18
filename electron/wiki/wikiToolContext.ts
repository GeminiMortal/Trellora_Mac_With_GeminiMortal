/**
 * Runtime context interface for Wiki node tools, wiring retrieval dependencies, scope policy and session state.
 * Wiki 节点工具的运行时上下文接口，串联检索依赖、范围策略与会话状态。
 */

/**
 * Shared runtime context type for Wiki node tools (plan §4).
 * Wiki 节点工具的共享运行时上下文类型（方案 §4）。
 */

import type { RerankAdapter } from '../knowledge/rerankAdapters.ts';
import type { KnowledgeAgentSessionState } from '../knowledge/tools/knowledgeTools/knowledgeSessionState.ts';
import type { KnowledgeToolContext, KnowledgeToolRetrievalContext } from '../knowledge/tools/knowledgeToolContext.ts';
import type { WikiDocumentOutlineNode } from './wikiOutline.ts';
import type { WikiScopePolicy, WikiScopeState } from './wikiScopePolicy.ts';

/**
 * Runtime context for Wiki node tools (plan §4), assembled by the wikiNodeAgentTurn entry point.
 * Wiki 节点工具的运行时上下文（方案 §4），由 wikiNodeAgentTurn 入口装配后传入。
 *
 * Retrieval dependencies are decoupled via the `prepareQueryContext` callback (corresponds to
 * `prepareMaterialSearchContext` in main.ts); the citation ledger and observation budget reuse
 * the knowledge-base `KnowledgeAgentSessionState`.
 * 检索依赖通过 prepareQueryContext 回调解耦（对应 main.ts 的 prepareMaterialSearchContext），
 * 引用号台账与观察预算复用知识库的 KnowledgeAgentSessionState。
 */
export interface WikiToolContext {
  libraryPath: string;
  /** Current Wiki document id; wiki tools always scope retrieval by [documentId]. / 当前 Wiki 文档 id；wiki 工具固定按 [documentId] 限定召回文档集合。 */
  documentId: string;
  documentName: string;
  /** Current node id (e.g. wiki:<documentId>:<structureNodeId>) / 当前节点 id（形如 wiki:<documentId>:<structureNodeId>） */
  nodeId: string;
  /**
   * sourceHeadingId set of the current node's subtree, passed as sectionNodeIds to the retrieval
   * layer; undefined for the root node (entire document) meaning no section filtering.
   * 当前节点子树的 sourceHeadingId 集合，作为 sectionNodeIds 下发检索层；
   * 根节点（整篇文档）为 undefined，表示不做章节过滤。
   */
  sectionNodeIds: string[] | undefined;
  /** Full outline nodes for wiki_read_node / wiki_get_node_info in-memory projection / 完整 outline 节点，供 wiki_read_node / wiki_get_node_info 在内存中投影 */
  outlineNodes: WikiDocumentOutlineNode[];
  /** Current scope state; retrieval wrappers update counts and enforce escalation gating per search. / 本轮范围状态；检索包装器在每次搜索执行前后更新计数并实施升级门控。 */
  scopeState: WikiScopeState;
  scopePolicy: WikiScopePolicy;
  session: KnowledgeAgentSessionState;
  signal: AbortSignal;
  prepareQueryContext: (query: string) => Promise<KnowledgeToolRetrievalContext>;
  rerank: { enabled: boolean; adapter?: RerankAdapter };
  /** Reuse knowledge-base persistent image resolution and current-turn VLM budget / 复用知识库持久化图片的安全解析与本轮 VLM 预算 */
  resolveEvidenceVisuals?: KnowledgeToolContext['resolveEvidenceVisuals'];
  /** Retrieval stage status hint (feeds assistant-turn status events) / 检索阶段状态提示（接 assistant-turn 的 status 事件） */
  onStage?: (message: string) => void;
  /** Detailed trace of Wiki retrieval cycles, scope escalation and rejection reasons / Wiki 检索周期、范围升级与拒绝原因的详细轨迹 */
  onScopeTrace?: (entry: {
    action: string;
    status: 'started' | 'completed' | 'rejected';
    output?: Record<string, unknown>;
    error?: unknown;
  }) => void;
}
