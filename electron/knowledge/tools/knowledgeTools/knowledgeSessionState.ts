/**
 * Knowledge agent per-turn session state: evidence dedup, citation ledger, budget tracking.
 * 知识库 ReAct 单轮会话状态：证据去重、引用号台账、观察预算跟踪。
 *
 * Manages seen-chunk deduplication (by document + parent-chunk key), globally
 * incrementing citation references, web evidence registration with URL whitelist,
 * deep-read window dedup, and web tool call counting.
 * 管理按 文档+父块 键的证据去重、全局递增引用号分配、网页证据登记与 URL 白名单、
 * 深读窗口去重，以及联网工具调用次数计数。
 */

import { CitationReferenceAllocator, ObservationBudgetTracker, type ObservationBudget } from '../../reactAgent/toolResultBudget.ts';
import type { ReActCitationLedgerEntry } from '../../reactAgent/reactEngineTypes.ts';

/**
 * Evidence record registered by knowledge tools (parent-chunk granularity).
 * 工具侧登记的证据条目（父块粒度）；引用号全局递增且按块去重。
 *
 * @property documentId - Source document ID / 来源文档 ID
 * @property documentName - Display name for observation rendering / 文档显示名
 * @property parentChunkId - Parent chunk ID for dedup / 父块 ID（用于去重）
 * @property ordinal - Parent chunk ordinal / 父块序号
 * @property text - Text with section context for observation / 带章节上下文的检索文本
 * @property sourceText - Original source text for citation guard / 原文保全（终答引用校验使用）
 * @property sectionContext - Section breadcrumb / 章节路径
 * @property score - Retrieval score / 检索分数
 * @property methods - Retrieval methods used / 使用的检索方式
 */
export interface KnowledgeEvidenceRecord {
  documentId: string;
  /** 文档显示名；观察文本与引用投影使用。 */
  documentName?: string;
  parentChunkId: string;
  ordinal: number;
  /** 带章节上下文的检索文本；观察渲染使用。 */
  text: string;
  /** 原文保全；终答引用校验（assistantCitationGuard）使用。 */
  sourceText: string;
  sectionContext?: string;
  score?: number;
  methods?: Array<'keyword' | 'semantic'>;
}

/**
 * Result of registering an evidence record: allocated reference and dedup status.
 * 登记证据条目的结果：分配的引用号与去重状态。
 *
 * @property reference - Allocated citation reference, e.g. [3] / 分配的引用号，形如 [3]
 * @property alreadySeen - Whether this evidence was already registered in this session / 本会话是否已登记过
 */
export interface KnowledgeEvidenceRegistration {
  /** 分配或复用的引用号，形如 [3]。 */
  reference: string;
  /** 该证据在本会话是否已被登记过（seenChunks/seenUrls 命中）。 */
  alreadySeen: boolean;
}

/**
 * Web evidence record registered by web tools (shared citation sequence with KB chunks).
 * 工具侧登记的网页证据条目（联网搜索设计方案 §7.1）；引用号与知识库块共享同一递增序列。
 *
 * @property url - Source URL / 来源 URL
 * @property title - Page title / 页面标题
 * @property source - Provider adapter ID, e.g. 'zhipu' / 厂商适配器 ID
 * @property sourceText - Cited evidence text (snippet or excerpt) / 被引用的证据文本
 */
export interface WebEvidenceRecord {
  url: string;
  title: string;
  /** 厂商适配器 id，如 'zhipu'。 */
  source: string;
  /** 被引用的证据文本（摘要或正文摘录）；终答引用投影使用。 */
  sourceText: string;
}

/**
 * Per-turn knowledge agent session state managing evidence dedup, citation ledger, and budgets.
 * 知识库 ReAct 单轮会话状态（方案 §2.2 / §4.3）：
 * - seenChunks：按 文档+父块 去重，重复命中时复用引用号并标注"已见过"；
 * - 引用号台账：全局递增分配，终答引用投影取这里；
 * - 观察规模：委托 ObservationBudgetTracker 作兼容诊断；发送预算由 L1 投影控制。
 */
export class KnowledgeAgentSessionState {
  private readonly seen = new Map<string, string>();
  private readonly ledger = new Map<string, ReActCitationLedgerEntry>();
  private readonly allocator = new CitationReferenceAllocator();
  private readonly observations: ObservationBudgetTracker;

  /**
   * Create a new session state with the given observation budget.
   * 使用给定的观察预算创建新的会话状态。
   *
   * @param budget - Observation size budget configuration / 观察规模预算配置
   */
  constructor(budget: ObservationBudget) {
    this.observations = new ObservationBudgetTracker(budget);
  }

  /**
   * Get the observation budget tracker instance.
   * 获取观察预算跟踪器实例。
   */
  get budgetTracker(): ObservationBudgetTracker {
    return this.observations;
  }

  /**
   * Build a dedup key from document ID and parent chunk ID.
   * 根据文档 ID 和父块 ID 构建去重键。
   *
   * @param record - Object with documentId and parentChunkId / 包含 documentId 和 parentChunkId 的对象
   * @returns Composite dedup key / 复合去重键
   */
  private keyOf(record: { documentId: string; parentChunkId: string }): string {
    return `${record.documentId}|${record.parentChunkId}`;
  }

  /**
   * Check whether a knowledge evidence record has already been seen.
   * 检查知识库证据条目是否已被登记过。
   *
   * @param record - Object with documentId and parentChunkId / 包含 documentId 和 parentChunkId 的对象
   * @returns true if already seen / 已见过时返回 true
   */
  isSeen(record: { documentId: string; parentChunkId: string }): boolean {
    return this.seen.has(this.keyOf(record));
  }

  /**
   * Get the citation reference for a previously seen record, if any.
   * 获取已登记记录的引用号（如有）。
   *
   * @param record - Object with documentId and parentChunkId / 包含 documentId 和 parentChunkId 的对象
   * @returns Citation reference string or undefined / 引用号字符串或 undefined
   */
  referenceOf(record: { documentId: string; parentChunkId: string }): string | undefined {
    return this.seen.get(this.keyOf(record));
  }

  /**
   * Register knowledge evidence: reuse reference for seen parent chunks, allocate new for fresh ones.
   * 登记证据：已见过的父块复用原引用号；新块分配新引用号。
   *
   * @param record - Knowledge evidence record to register / 待登记的知识库证据记录
   * @returns Registration result with reference and dedup status / 登记结果（引用号与去重状态）
   */
  registerEvidence(record: KnowledgeEvidenceRecord): KnowledgeEvidenceRegistration {
    const key = this.keyOf(record);
    const existing = this.seen.get(key);
    if (existing) return { reference: existing, alreadySeen: true };
    const reference = this.allocator.allocate();
    this.seen.set(key, reference);
    this.ledger.set(reference, {
      reference,
      documentId: record.documentId,
      chunkId: record.parentChunkId,
      parentChunkId: record.parentChunkId,
      ordinal: record.ordinal,
      sourceText: record.sourceText,
      ...(record.sectionContext ? { sectionContext: record.sectionContext } : {}),
      ...(record.score !== undefined ? { score: record.score } : {}),
    });
    return { reference, alreadySeen: false };
  }

  /**
   * Build a deep-read window dedup key from document, ordinal, and window size.
   * 深读窗口按 文档+序号 登记，防止 list_knowledge_chunks 重复展开。
   *
   * @param documentId - Target document ID / 目标文档 ID
   * @param ordinal - Anchor parent chunk ordinal / 锚点父块序号
   * @param window - Window size in chunks / 窗口大小
   * @returns Composite window key / 复合窗口键
   */
  seenWindowKey(documentId: string, ordinal: number, window: number): string {
    return `window|${documentId}|${ordinal - window}..${ordinal + window}`;
  }

  // —— 网页证据：seenUrls 去重 + 台账登记 + 验证升级（联网搜索设计方案 §7.1）——
  private readonly seenUrls = new Map<string, string>();

  /**
   * Check whether a URL has already been registered as web evidence.
   * 检查 URL 是否已被登记为网页证据。
   *
   * @param url - URL to check / 待检查的 URL
   * @returns true if already seen / 已见过时返回 true
   */
  isUrlSeen(url: string): boolean {
    return this.seenUrls.has(url);
  }

  /**
   * Get the citation reference for a previously seen URL, if any.
   * 获取已登记 URL 的引用号（如有）。
   *
   * @param url - URL to look up / 待查找的 URL
   * @returns Citation reference or undefined / 引用号或 undefined
   */
  referenceOfUrl(url: string): string | undefined {
    return this.seenUrls.get(url);
  }

  /** 本轮 web_search 返回过的 URL 集合；web_fetch 白名单（防提示注入诱导抓取）。 */
  private readonly searchableUrls = new Set<string>();

  /**
   * Register a URL as searchable (whitelist for web_fetch anti-prompt-injection).
   * 将 URL 标记为可搜索（web_fetch 白名单，防提示注入诱导抓取）。
   *
   * @param url - URL returned by web_search / web_search 返回的 URL
   */
  markSearchableUrl(url: string): void {
    this.searchableUrls.add(url);
  }

  /**
   * Check whether a URL is in the searchable whitelist.
   * 检查 URL 是否在可搜索白名单中。
   *
   * @param url - URL to check / 待检查的 URL
   * @returns true if whitelisted / 在白名单中返回 true
   */
  isSearchableUrl(url: string): boolean {
    return this.searchableUrls.has(url);
  }

  /**
   * Check whether any searchable URLs exist from web_search results.
   * 本轮是否存在任何 web_search 返回过的 URL；无链接结果时 web_fetch 整体不可用。
   *
   * @returns true if at least one URL was registered / 至少有一个 URL 已登记时返回 true
   */
  hasSearchableUrls(): boolean {
    return this.searchableUrls.size > 0;
  }

  /**
   * Register web evidence: reuse reference for seen URLs, allocate new reference for new ones.
   * Linkless entries (some engines return title/snippet only) are deduped by title+summary
   * and do not enter the web_fetch whitelist.
   * 登记网页证据：已见过的 URL 复用原引用号；新 URL 分配新引用号。无链接条目
   * （部分引擎仅返回标题/摘要）按 标题+摘要 去重，且不进入 web_fetch 白名单。
   *
   * @param record - Web evidence to register / 待登记的网页证据
   * @returns Registration result with reference and dedup status / 登记结果（引用号与去重状态）
   */
  registerWebEvidence(record: WebEvidenceRecord): KnowledgeEvidenceRegistration {
    const hasUrl = record.url.trim().length > 0;
    // 已登记为证据的 URL 必然来自本轮搜索结果，白名单保持一致（防提示注入）。
    if (hasUrl) this.searchableUrls.add(record.url);
    const key = hasUrl ? record.url : `no-link|${record.title}|${record.sourceText.slice(0, 120)}`;
    const existing = this.seenUrls.get(key);
    if (existing) return { reference: existing, alreadySeen: true };
    const reference = this.allocator.allocate();
    this.seenUrls.set(key, reference);
    this.ledger.set(reference, {
      reference,
      kind: 'web',
      url: record.url,
      title: record.title,
      source: record.source,
      sourceText: record.sourceText,
      pageVerified: false,
    });
    return { reference, alreadySeen: false };
  }

  /**
   * Upgrade a web evidence entry to page-verified after successful web_fetch.
   * web_fetch 全文核对成功后升级原引用条目的验证状态（引用号不变）。
   *
   * @param reference - Citation reference to verify / 待验证的引用号
   * @param verifiedText - Optional verified full-text excerpt / 可选的已验证全文摘录
   * @returns true if upgrade succeeded / 升级成功返回 true
   */
  verifyWebEvidence(reference: string, verifiedText?: string): boolean {
    const entry = this.ledger.get(reference);
    if (!entry || entry.kind !== 'web') return false;
    this.ledger.set(reference, { ...entry, pageVerified: true, ...(verifiedText ? { sourceText: verifiedText } : {}) });
    return true;
  }

  /** 单轮循环内联网工具次数限额（联网搜索设计方案 §8）；超限在工具内拒绝。 */
  private webSearchCalls = 0;
  private webFetchCalls = 0;

  /**
   * Consume one web_search call within the per-turn limit.
   * 在单轮限额内消费一次 web_search 调用。
   *
   * @param limit - Max calls per turn / 单轮最大调用次数
   * @returns true if within limit, false if exceeded / 未超限返回 true，超限返回 false
   */
  consumeWebSearchCall(limit: number): boolean {
    this.webSearchCalls += 1;
    return this.webSearchCalls <= limit;
  }

  /**
   * Consume one web_fetch call within the per-turn limit.
   * 在单轮限额内消费一次 web_fetch 调用。
   *
   * @param limit - Max calls per turn / 单轮最大调用次数
   * @returns true if within limit, false if exceeded / 未超限返回 true，超限返回 false
   */
  consumeWebFetchCall(limit: number): boolean {
    this.webFetchCalls += 1;
    return this.webFetchCalls <= limit;
  }

  private readonly seenWindows = new Set<string>();

  /**
   * Mark a deep-read window key as already seen.
   * 标记深读窗口键为已读。
   *
   * @param key - Window dedup key / 窗口去重键
   */
  markWindowSeen(key: string): void {
    this.seenWindows.add(key);
  }

  /**
   * Check whether a deep-read window key has been seen.
   * 检查深读窗口键是否已被标记为已读。
   *
   * @param key - Window dedup key / 窗口去重键
   * @returns true if already seen / 已见过时返回 true
   */
  isWindowSeen(key: string): boolean {
    return this.seenWindows.has(key);
  }

  /**
   * Total number of citation references allocated in this session.
   * 本轮已分配的引用号总数。
   */
  get citationCount(): number {
    return this.allocator.count;
  }

  /**
   * Get parent-chunk keys of all registered KB evidence; used by retrieval layer
   * to relax relevance gating for historically cited content.
   * 本轮已登记证据的父块键；供检索层作为历史引用放宽门控（不凭空注入证据）。
   *
   * @returns Array of documentId + parentChunkId pairs / 文档+父块 键数组
   */
  seenEvidenceKeys(): Array<{ documentId: string; parentChunkId: string }> {
    return [...this.ledger.values()]
      .filter((entry) => entry.kind !== 'web' && entry.documentId && entry.parentChunkId)
      .map((entry) => ({ documentId: entry.documentId as string, parentChunkId: entry.parentChunkId as string }));
  }

  /**
   * Get the complete citation ledger for final-answer projection and agent stats.
   * 终答引用投影与 agentStats 使用的完整台账。
   *
   * @returns Array of all citation ledger entries / 所有引用台账条目
   */
  ledgerEntries(): ReActCitationLedgerEntry[] {
    return [...this.ledger.values()];
  }
}
