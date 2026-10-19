/**
 * Knowledge tool runtime context and XML escaping utilities.
 * 知识工具运行时上下文定义与 XML 转义工具函数。
 *
 * This module defines the shared context interfaces consumed by all knowledge-base
 * retrieval tools (search, graph, grep, web) and provides XML escaping helpers for
 * building observation text that is safe for LLM consumption.
 * 本模块定义所有知识库检索工具（语义搜索、图谱检索、字面量匹配、联网搜索）共享的
 * 上下文接口，并提供 XML 转义辅助函数以构建对 LLM 安全的观察文本。
 */

import type { MaterialEmbeddingAdapter } from '../../pipeline/materialEmbeddingAdapters';
import type { MaterialEmbeddingProfile } from '../../pipeline/materialEmbeddingTypes';
import type { RerankAdapter } from '../search/rerankAdapters.ts';
import type { KnowledgeAgentSessionState } from './knowledgeTools/knowledgeSessionState';
import type { WebSearchProviderAdapter, WebSearchRuntimeConfig } from '../../websearch/webSearchTypes.ts';
import type { AiTransportImage } from '../ai/aiGenerationTransport.ts';
import type { KnowledgeBaseVisualEvidence, KnowledgeBaseVisualMapping } from './knowledgeBaseImageResolver.ts';

/**
 * Retrieval dependencies assembled per query: path validation, Jieba tokenization,
 * and locked embedding adapter.
 * 按查询装配的检索依赖：路径校验、Jieba 分词、锁定 embedding 适配器。
 *
 * @property targetPath - Validated library path for this query / 本次查询校验后的资料库路径
 * @property queryTerms - Jieba tokenized terms for lexical search / Jieba 分词后的词条列表
 * @property lexicalError - Error message if tokenization failed / 分词失败时的错误信息
 * @property adapter - Locked embedding adapter instance / 锁定的 embedding 适配器实例
 * @property embeddingProfile - Locked profile for graph tools to self-embed queries / 锁定的 embedding profile
 * @property embeddingError - Error message if adapter resolution failed / 适配器解析失败时的错误信息
 */
export interface KnowledgeToolRetrievalContext {
  targetPath: string;
  queryTerms?: string[];
  lexicalError?: string;
  adapter?: MaterialEmbeddingAdapter;
  /** 锁定的 embedding profile（优化方案 P1-4）：供图谱检索工具自算问题 embedding。 */
  embeddingProfile?: MaterialEmbeddingProfile;
  embeddingError?: string;
}

/**
 * Query preprocessing strategy overrides for individual tools.
 * 单个工具准备检索上下文时可覆盖的查询预处理策略。
 *
 * @property tokenize - When false, skip program-side tokenization (e.g., for graph tools with entity anchors) / 为 false 时跳过程序侧分词
 */
export interface KnowledgeToolQueryOptions {
  /** false 时跳过程序侧分词；用于由 Agent 直接提供实体锚点的图谱检索。 */
  tokenize?: boolean;
}

/**
 * Minimal runtime context for web tools (shared by KB and open-chat paths).
 * 联网工具的最小运行时上下文（联网搜索设计方案 §4）：
 * 知识库与开放式问答两条链路共用 web_search/web_fetch 时的结构子集。
 *
 * @property session - Current agent session state for evidence dedup / 当前会话状态（证据去重）
 * @property signal - Abort signal for cancellation / 取消信号
 * @property webSearch - Web search runtime adapter and config; absent when disabled / 联网搜索运行时适配器与配置
 * @property onStage - Stage status callback for UI progress / 检索阶段状态回调
 */
export interface WebSearchToolContext {
  session: KnowledgeAgentSessionState;
  signal: AbortSignal;
  /** 联网搜索运行时（联网搜索设计方案 §8）；未启用时缺省，联网工具不注册。 */
  webSearch?: {
    adapter: WebSearchProviderAdapter;
    runtimeConfig: WebSearchRuntimeConfig;
    maxResults: number;
  };
  /** 检索阶段状态提示（接 emitAssistantTurnEvent 的 status 事件）。 */
  onStage?: (message: string) => void;
}

/**
 * Full runtime context for knowledge tools; assembled by knowledgeAgentTurn entry.
 * 知识工具的运行时上下文；由 knowledgeAgentTurn 入口装配后传入
 * （prepareQueryContext 对应 main.ts 的 prepareMaterialSearchContext，
 * 通过回调解耦避免工具层直接依赖主进程单例）。
 *
 * @property libraryPath - Absolute path to the knowledge library / 资料库绝对路径
 * @property libraryLabel - Display label for the library / 资料库显示名
 * @property documentNameById - Resolve document display name by ID / 文档显示名解析函数
 * @property prepareQueryContext - Async factory for retrieval context / 异步构建检索上下文
 * @property rerank - Rerank adapter toggle and instance / Rerank 适配器开关与实例
 * @property documentAffinityFactors - Weak document affinity coefficients / 弱文档亲和度系数
 * @property resolveEvidenceVisuals - Resolve image placeholders in evidence / 将证据中的图片引用转为 VLM 输入
 * @property graphGlobalSearch - GraphRAG map-reduce LLM runtime / 全局图谱检索 LLM 运行时
 */
export interface KnowledgeToolContext extends WebSearchToolContext {
  libraryPath: string;
  libraryLabel: string;
  /** 文档显示名解析；未知文档返回 undefined。 */
  documentNameById: (documentId: string) => string | undefined;
  prepareQueryContext: (query: string, options?: KnowledgeToolQueryOptions) => Promise<KnowledgeToolRetrievalContext>;
  rerank: { enabled: boolean; adapter?: RerankAdapter };
  /** M8：检索相关性门控后使用的弱文档亲和度系数。 */
  documentAffinityFactors?: (documentIds: readonly string[]) => ReadonlyMap<string, number>;
  /** 将命中证据中的持久化图片引用改写为占位符，并按本轮预算物化为 VLM 输入。 */
  resolveEvidenceVisuals?: <T extends KnowledgeBaseVisualEvidence>(evidence: readonly T[]) => {
    evidence: T[];
    images: AiTransportImage[];
    mappings: KnowledgeBaseVisualMapping[];
  };
  /** 全局图谱检索运行时（GraphRAG 方案 §4.2）：注入 map-reduce 的 LLM 调用；未注入时工具不注册。 */
  graphGlobalSearch?: {
    callModel: (prompt: string) => Promise<string>;
  };
}

/**
 * Escape a string for safe use inside an XML attribute value.
 * XML 属性转义，保证观察文本对模型是良构的标记。
 *
 * @param value - Raw string to escape / 待转义的原始字符串
 * @returns Escaped string safe for XML attribute / 转义后可安全用于 XML 属性的字符串
 */
export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape a string for safe use inside XML element text content; preserves quotes for readability.
 * XML 元素文本转义；保留引号以保证提示文本对模型可读。
 *
 * @param value - Raw string to escape / 待转义的原始字符串
 * @returns Escaped string safe for XML text nodes / 转义后可安全用于 XML 元素文本的字符串
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Compact observation text by collapsing redundant blank lines and trailing whitespace.
 * 观察正文统一压缩连续空白行，避免引用块里的排版空行挤占预算。
 *
 * @param text - Raw observation text / 原始观察文本
 * @returns Compacted text with reduced blank lines / 压缩连续空白行后的文本
 */
export function compactObservationText(text: string): string {
  return text
    .replace(/[ \t]+(\r?\n)/g, '$1')
    .replace(/(\r?\n){3,}/g, '$1$1')
    .trim();
}

/**
 * Produce a bounded preview of tool result text for debug/public display.
 * 调试轨道使用的工具返回正文投影；保留真实文本，但限制单条体积。
 *
 * @param text - Full tool result text / 完整的工具返回文本
 * @param limit - Max character count (default 2400) / 最大字符数（默认 2400）
 * @returns Truncated text with ellipsis if over limit / 超限时截断并附加省略号
 */
export function toBoundedPublicToolResultText(text: string, limit = 2_400): string {
  const compacted = compactObservationText(text);
  return compacted.length > limit ? `${compacted.slice(0, limit)}…` : compacted;
}
