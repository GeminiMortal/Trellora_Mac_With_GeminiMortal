/**
 * Web evidence source for selection editing (SE-6 boundary): one bounded web
 * search for navigation candidates, then full-text fetch verification before
 * any page text can become model-visible evidence.
 * 选区编辑的联网证据源（SE-6 边界）：一次受限网页搜索产生导航候选，
 * 之后必须经全文抓取核验，页面正文才能成为模型可见证据。
 */
import { createHash } from 'node:crypto';
import { fetchWebPage, parsePublicWebUrl } from '../../../websearch/webFetchClient.ts';
import type { WebSearchProviderAdapter, WebSearchRuntimeConfig } from '../../../websearch/webSearchTypes.ts';
import type {
  SelectionContextReceipt,
  SelectionEditContextGoal,
  SelectionEvidenceItem,
} from '../../selectionEditTypes.ts';

/**
 * SE-6 source-local budgets. Search snippets are navigation only and never
 * consume evidence budget.
 * SE-6 证据源本地预算。搜索摘要仅用于导航，绝不消耗证据预算。
 */
const MAX_WEB_SEARCH_RESULTS = 3;
const MAX_WEB_FETCHES = 2;
const MAX_WEB_PAGE_CHARS = 1_600;
const MIN_WEB_PAGE_BUDGET = 160;

/**
 * Web search runtime injected by Electron main when web use is authorized and
 * the provider is ready.
 * 当联网使用已获授权且厂商就绪时，由 Electron 主进程注入的联网搜索运行时。
 */
export interface SelectionEditWebSourceRuntime {
  adapter: WebSearchProviderAdapter;
  runtimeConfig: WebSearchRuntimeConfig;
  maxResults: number;
}

/**
 * Input for one web collection pass: goals, optional runtime, cancellation
 * signal, and the remaining evidence character budget.
 * 单次联网采集的输入：目标、可选运行时、取消信号与剩余原文证据字符预算。
 */
export interface CollectSelectionEditWebSourcesInput {
  goals: readonly SelectionEditContextGoal[];
  runtime?: SelectionEditWebSourceRuntime;
  signal: AbortSignal;
  remainingCharacters: number;
  onProgress?: (message: string) => void;
}

/**
 * Output of the web adapter: verified evidence plus the planned/used/skipped/
 * candidates receipt slice.
 * 联网适配器的输出：已核验证据，以及 planned/used/skipped/candidates 回执切片。
 */
export interface SelectionEditWebSourcesResult {
  evidence: SelectionEvidenceItem[];
  receipt: Pick<SelectionContextReceipt, 'planned' | 'used' | 'skipped' | 'candidates'>;
}

/**
 * SE-6 web boundary:
 * 1. A single bounded web_search call creates navigation candidates only.
 * 2. Only URLs returned by that search may enter web_fetch.
 * 3. Only successfully fetched full text becomes a `web` evidence item.
 *
 * This deliberately does not reuse a search snippet as a fallback evidence
 * source. A failed fetch remains visible in the receipt as "未全文核验" and is
 * never passed to the model as factual context.
 * SE-6 联网边界：
 * 1. 一次受限的 web_search 调用只产生导航候选。
 * 2. 只有该次搜索返回的 URL 才能进入 web_fetch。
 * 3. 只有成功抓取的全文才能成为 `web` 证据条目。
 *
 * 此处刻意不把搜索摘要当作兜底证据来源。抓取失败会在回执中以「未全文核验」
 * 留痕，且绝不会作为事实上下文传给模型。
 *
 * @param input - Goals, optional web runtime, signal and remaining budget / 目标、可选联网运行时、信号与剩余预算
 * @returns Verified web evidence and its receipt / 已核验的联网证据及其回执
 */
export async function collectSelectionEditWebSources(input: CollectSelectionEditWebSourcesInput): Promise<SelectionEditWebSourcesResult> {
  const planned: SelectionContextReceipt['planned'] = [];
  const used: SelectionContextReceipt['used'] = [];
  const skipped: SelectionContextReceipt['skipped'] = [];
  const candidates: SelectionContextReceipt['candidates'] = [];
  const evidence: SelectionEvidenceItem[] = [];
  // Guard clauses: no runtime, insufficient budget, or no terms all skip the
  // round without sending any network request.
  // 守卫分支：无运行时、预算不足或无主题词时直接跳过本轮，不发送任何网络请求。
  if (!input.runtime) {
    skipped.push({ sourceKind: 'web', reason: '联网补充未就绪，未发送搜索请求。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }
  if (input.remainingCharacters < MIN_WEB_PAGE_BUDGET) {
    skipped.push({ sourceKind: 'web', reason: '本轮原文证据预算不足，未发送联网搜索请求。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }
  const queryTerms = uniqueTerms(input.goals.flatMap((goal) => goal.queryTerms));
  if (queryTerms.length === 0) {
    skipped.push({ sourceKind: 'web', reason: '选区没有可用于联网定位的主题词。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }

  const query = queryTerms.join(' ');
  planned.push({ sourceKind: 'web', reason: '先执行一次受限网页搜索，再仅抓取本次搜索返回的 URL 全文核验。' });
  input.onProgress?.('正在联网定位候选网页；搜索摘要不会进入生成上下文…');
  // The single bounded search; snippets stay navigation-only and never become evidence.
  // 本次唯一受限搜索；摘要仅用于导航，绝不成为证据。
  let results: Awaited<ReturnType<WebSearchProviderAdapter['search']>>;
  try {
    results = await input.runtime.adapter.search({
      query,
      maxResults: Math.min(MAX_WEB_SEARCH_RESULTS, input.runtime.maxResults),
      config: input.runtime.runtimeConfig,
      signal: input.signal,
    });
  } catch {
    skipped.push({ sourceKind: 'web', reason: '网页搜索失败，未将任何摘要作为事实证据。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }
  throwIfAborted(input.signal);
  if (results.length === 0) {
    skipped.push({ sourceKind: 'web', reason: '网页搜索没有返回可核验的候选。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }

  // Register navigation candidates; non-public or non-HTTP(S) URLs are marked
  // skipped and never fetched.
  // 登记导航候选；非公开或非 HTTP(S) 地址被标记为跳过，永不抓取。
  for (const [index, result] of results.slice(0, MAX_WEB_SEARCH_RESULTS).entries()) {
    const safeUrl = normalizeSearchResultUrl(result.url);
    const candidateId = `web:${index}:${hashText(`${result.title}\u0000${result.url}`).slice(0, 16)}`;
    if (!safeUrl) {
      candidates.push({
        candidateId,
        sourceKind: 'web',
        title: boundedText(result.title, '网页搜索结果'),
        locator: '网页 / 受限地址',
        queryTerms,
        retrievalMethod: 'web_search（摘要仅用于定位）',
        readState: 'skipped',
        pageVerified: false,
        reason: '搜索结果不是可抓取的公开 HTTP/HTTPS 地址，摘要未纳入合成。',
      });
      continue;
    }
    candidates.push({
      candidateId,
      sourceKind: 'web',
      title: boundedText(result.title, safeUrl.hostname),
      locator: `网页 / ${safeUrl.hostname}`,
      queryTerms,
      retrievalMethod: 'web_search（摘要仅用于定位）',
      readState: 'candidate',
      pageVerified: false,
    });
  }

  // Bounded full-text verification of at most MAX_WEB_FETCHES candidates, each
  // consuming the remaining character budget only on success.
  // 对至多 MAX_WEB_FETCHES 个候选做受限全文核验，仅在成功时消耗剩余字符预算。
  let remainingCharacters = input.remainingCharacters;
  for (const candidate of candidates.filter((item) => item.readState === 'candidate').slice(0, MAX_WEB_FETCHES)) {
    throwIfAborted(input.signal);
    if (remainingCharacters < MIN_WEB_PAGE_BUDGET) break;
    const url = findCandidateUrl(candidate.candidateId, results);
    if (!url) {
      candidate.readState = 'skipped';
      candidate.reason = '候选 URL 身份校验失败，摘要未纳入合成。';
      continue;
    }
    input.onProgress?.(`正在全文核验网页「${candidate.title}」…`);
    try {
      const outcome = await fetchWebPage({ url, signal: input.signal });
      if (outcome.empty || !outcome.text.trim()) {
        candidate.readState = 'skipped';
        candidate.reason = '网页正文为空，未全文核验；摘要未纳入合成。';
        continue;
      }
      const content = outcome.text.slice(0, Math.min(MAX_WEB_PAGE_CHARS, remainingCharacters));
      if (content.length < MIN_WEB_PAGE_BUDGET) {
        candidate.readState = 'skipped';
        candidate.reason = '网页正文超出本轮受限读取预算，摘要未纳入合成。';
        continue;
      }
      const sourceContentHash = hashText(outcome.text);
      const evidenceId = `evidence-web-${hashText(`${url}\u0000${sourceContentHash}\u0000${content}`).slice(0, 24)}`;
      const title = boundedText(outcome.title ?? candidate.title, candidate.title);
      const item: SelectionEvidenceItem = {
        evidenceId,
        sourceKind: 'web',
        title,
        locator: `网页 / ${new URL(url).hostname}`,
        content,
        sourceContentHash,
        textHash: hashText(content),
        goalIds: input.goals.map((goal) => goal.goalId),
        readVerified: true,
        pageVerified: true,
      };
      evidence.push(item);
      used.push({ sourceKind: 'web', title: item.title, locator: item.locator, characterCount: item.content.length });
      candidate.title = title;
      candidate.locator = item.locator;
      candidate.readState = 'deep-read';
      candidate.pageVerified = true;
      remainingCharacters -= content.length;
    } catch (error) {
      if (isAbortError(error)) throw error;
      candidate.readState = 'skipped';
      candidate.reason = '网页全文读取失败，未全文核验；摘要未纳入合成。';
    }
  }
  // Any candidate never fetched is marked skipped so the receipt is complete.
  // 所有未被抓取的候选均标记为跳过，保证回执完整。
  for (const candidate of candidates) {
    if (candidate.readState === 'candidate') {
      candidate.readState = 'skipped';
      candidate.reason = '候选未进入本轮全文核验配额，摘要未纳入合成。';
    }
  }
  if (evidence.length === 0) skipped.push({ sourceKind: 'web', reason: '没有全文核验通过的网页原文，未将搜索摘要用于生成。' });
  return { evidence, receipt: { planned, used, skipped, candidates } };
}

/** Parses a search result URL as a fetchable public HTTP/HTTPS address. / 将搜索结果 URL 解析为可抓取的公开 HTTP/HTTPS 地址。 */
function normalizeSearchResultUrl(value: string): URL | undefined {
  try {
    return parsePublicWebUrl(value);
  } catch {
    return undefined;
  }
}

/**
 * Recovers the original URL for a candidate from its `web:<index>:<hash>` ID,
 * re-validating the URL before use.
 * 根据 `web:<index>:<hash>` 候选 ID 反查原始 URL，使用前再次校验。
 */
function findCandidateUrl(candidateId: string, results: readonly { title: string; url: string }[]): string | undefined {
  const match = /^web:(\d+):/u.exec(candidateId);
  if (!match) return undefined;
  const result = results[Number(match[1])];
  return result && normalizeSearchResultUrl(result.url) ? result.url : undefined;
}

/** Deduplicates trimmed goal terms, keeping 2–80 char terms, at most 6. / 对目标主题词去重并修剪，保留 2–80 字符的词，最多 6 个。 */
function uniqueTerms(values: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    const term = value.trim();
    if (term.length < 2 || term.length > 80) continue;
    terms.add(term);
    if (terms.size >= 6) break;
  }
  return [...terms];
}

/** Trims text to 160 characters with an ellipsis, falling back when empty. / 将文本截断到 160 字符并加省略号，空值时使用回退文本。 */
function boundedText(value: string, fallback: string): string {
  const text = value.trim() || fallback;
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** SHA-256 hex hash of UTF-8 text, used for IDs and content fingerprints. / UTF-8 文本的 SHA-256 十六进制哈希，用于 ID 与内容指纹。 */
function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Throws an AbortError when the task has been cancelled. / 任务已取消时抛出 AbortError。 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('已取消 AI 编辑任务。', 'AbortError');
}

/** Type guard distinguishing DOMException AbortError from other failures. / 区分 DOMException AbortError 与其他失败的类型守卫。 */
function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}
