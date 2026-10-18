/**
 * Tool: web_search — search the internet for latest information.
 * 工具：web_search — 在互联网上搜索最新信息。
 *
 * KB path: only usable after knowledge_search + grep_chunks are exhausted.
 * Open-chat path: usable when the question involves recent events or external facts.
 * Results are registered in the citation ledger with reference numbers; URLs are
 * simultaneously added to the web_fetch whitelist. Limited to 3 calls per turn.
 * 知识库路径：仅在 knowledge_search 与 grep_chunks 穷尽后可用。
 * 开放式聊天路径：涉及最新进展或外部事实时可用。结果登记到引用台账并分配引用号；
 * URL 同时进入 web_fetch 白名单。单轮限额 3 次。
 */

import type { ReActTool, ReActToolExecution } from '../../reactAgent/toolRegistry.ts';
import type { WebSearchResult } from '../../../websearch/webSearchTypes.ts';
import type { AssistantPublicToolResultView } from '../../assistant/assistantTurnTypes.ts';
import { compactObservationText, escapeXmlAttribute, escapeXmlText, type WebSearchToolContext } from '../knowledgeToolContext.ts';

/**
 * web_search 工具（联网搜索设计方案 §4.2，对标 WeKnora web_search.go）：
 * 知识库与开放式聊天共用执行逻辑，但分别下发与场景匹配的工具说明；
 * 结果登记台账分配引用号，URL 同时进入 web_fetch 白名单。单轮循环内
 * 限额由会话计数执行。
 */

const WEB_SEARCH_CALL_LIMIT = 3;
const WEB_RESULT_CONTENT_LIMIT = 800;

/**
 * ReAct tool definition for web search (KB path, with KB-first prerequisite description).
 * 联网搜索 ReAct 工具定义（知识库路径，含知识库优先前提描述）。
 */
export const webSearchTool: ReActTool<WebSearchToolContext> = {
  name: 'web_search',
  description: [
    '在互联网上搜索最新信息。仅当 knowledge_search 与 grep_chunks 都已执行且知识库证据不足，',
    '且问题涉及最新进展、时效信息或知识库未覆盖的库外知识时使用；先穷尽知识库是硬性前提。',
    '传一条完整的语义化查询，不要传关键词碎片；单轮循环内最多调用 3 次。',
    '返回带引用号的网页结果（标题/URL/摘要/正文摘录），标注 page_verified="false"，',
    '关键结论建议再用 web_fetch 核对全文。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        maxLength: 120,
        description: '一条完整的语义化搜索问题或陈述',
      },
    },
    required: ['query'],
  },
  execute: async (args, ctx) => runWebSearch(args, ctx),
};

/**
 * Web search tool variant for open-chat path (no KB-first prerequisite).
 * 开放式聊天路径的联网搜索工具变体（无知识库优先前提）。
 *
 * The chat path has no knowledge retrieval tools, so the description must not
 * reference knowledge_search to avoid the model fabricating calls to satisfy
 * preconditions.
 * 聊天链路没有知识库检索工具，不能复用 KB First 描述，否则模型可能为满足
 * 前置条件而虚构 knowledge_search 调用。
 */
export const chatWebSearchTool: ReActTool<WebSearchToolContext> = {
  ...webSearchTool,
  description: [
    '在互联网上搜索最新信息。仅当问题涉及最新进展、新闻、行情、天气、近期事件，',
    '或需要核实自身知识不足以覆盖的外部事实时使用；稳定、常识性、历史性问题通常无需联网。',
    '传一条完整的语义化查询，不要传关键词碎片；单轮循环内最多调用 3 次。',
    '返回带引用号的网页结果（标题/URL/摘要/正文摘录），标注 page_verified="false"，',
    '关键结论建议再用 web_fetch 核对全文。',
  ].join(''),
};

/**
 * Execute web_search: search the internet and register results as web evidence.
 * 执行 web_search：联网搜索并将结果登记为网页证据。
 *
 * @param args - Tool arguments (query) / 工具参数（query）
 * @param ctx - Web search tool context / 联网搜索工具上下文
 * @returns Tool execution result / 工具执行结果
 */
async function runWebSearch(args: Record<string, unknown>, ctx: WebSearchToolContext): Promise<ReActToolExecution> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { ok: false, observation: '<tool_error>web_search 需要非空的 query。</tool_error>', message: '联网搜索查询为空，已拒绝执行。' };
  }
  const runtime = ctx.webSearch;
  if (!runtime) {
    return { ok: false, observation: '<tool_error>联网搜索未启用，请基于知识库证据作答。</tool_error>', message: '联网搜索未启用。' };
  }
  if (!ctx.session.consumeWebSearchCall(WEB_SEARCH_CALL_LIMIT)) {
    return { ok: false, observation: '<tool_error>联网检索次数已达上限，请基于已有证据直接作答。</tool_error>', message: '联网检索次数已达上限。' };
  }

  ctx.onStage?.(`正在联网搜索「${truncateForStatus(query)}」…`);
  let results: WebSearchResult[];
  try {
    results = await runtime.adapter.search({ query, maxResults: runtime.maxResults, config: runtime.runtimeConfig, signal: ctx.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      observation: `<tool_error>联网搜索失败：${escapeXmlText(message)}。可稍后换一种查询重试，或直接基于知识库证据作答。</tool_error>`,
      message: `联网搜索失败：${message}`,
    };
  }
  if (results.length === 0) {
    return {
      ok: true,
      observation: `<web_search_results query="${escapeXmlAttribute(query)}">\n</web_search_results>\n<web_note>未找到相关网页结果。可换一种查询角度重试，或回到知识库作答。</web_note>`,
      message: '联网搜索没有返回结果。',
      referenceCount: 0,
    };
  }

  const rendered: string[] = [];
  const publicResults: AssistantPublicToolResultView[] = [];
  let registered = 0;
  const seenNotes: string[] = [];
  for (const result of results) {
    if (result.url) ctx.session.markSearchableUrl(result.url);
    const evidenceText = (result.snippet || result.content || '').trim();
    const registration = ctx.session.registerWebEvidence({
      url: result.url,
      title: result.title,
      source: result.source,
      sourceText: evidenceText || result.title,
    });
    if (registration.alreadySeen) {
      seenNotes.push(`${registration.reference} 在本会话已见过，不再展开`);
    } else {
      registered += 1;
    }
    publicResults.push({
      reference: registration.reference,
      title: result.title,
      ...(result.url ? { url: result.url } : {}),
      ...(evidenceText ? { snippet: truncateText(evidenceText, 240) } : {}),
      ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
      source: result.source,
      pageVerified: false,
    });
    const content = result.content?.trim() ? truncateText(result.content.trim(), WEB_RESULT_CONTENT_LIMIT) : undefined;
    rendered.push([
      `  <result reference="${registration.reference}"${result.url ? ` url="${escapeXmlAttribute(result.url)}"` : ''} source="${escapeXmlAttribute(result.source)}" page_verified="false"${result.publishedAt ? ` published="${escapeXmlAttribute(result.publishedAt)}"` : ''}>`,
      `    <title>${escapeXmlText(result.title)}</title>`,
      ...(result.snippet?.trim() ? [`    <snippet>${escapeXmlText(truncateText(result.snippet.trim(), 400))}</snippet>`] : []),
      ...(content ? [`    <content>${escapeXmlText(content)}</content>`] : []),
      '  </result>',
    ].join('\n'));
  }
  const noteParts = [`命中 ${results.length} 条网页结果，新增引用 ${registered} 条。`];
  if (seenNotes.length) noteParts.push(`其中 ${seenNotes.join('；')}。`);
  if (!results.some((result) => result.url)) noteParts.push('搜索引擎本轮未提供来源链接，web_fetch 全文核对不可用，不要尝试抓取；作答时披露来源无链接。');
  noteParts.push('摘要级证据未经全文验证；关键事实建议用 web_fetch 核对，或仅将其作为线索，并在终答中注明未经全文验证。');
  const observation = [
    `<web_search_results query="${escapeXmlAttribute(query)}">`,
    ...rendered,
    '</web_search_results>',
    `<web_note>${escapeXmlText(noteParts.join(''))}</web_note>`,
  ].join('\n');
  return {
    ok: true,
    observation: compactObservationText(observation),
    message: `联网搜索命中 ${results.length} 条结果。`,
    referenceCount: registered,
    publicResults,
  };
}

/**
 * Truncate text to a character limit with ellipsis.
 * 将文本截断到指定字符数，超出时附加省略号。
 *
 * @param text - Input text / 输入文本
 * @param limit - Max characters / 最大字符数
 * @returns Truncated text / 截断后的文本
 */
function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Truncate text for status line display (24 char max).
 * 将文本截断用于状态栏显示（最多 24 字符）。
 *
 * @param text - Input text / 输入文本
 * @returns Truncated text / 截断后的文本
 */
function truncateForStatus(text: string): string {
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}
