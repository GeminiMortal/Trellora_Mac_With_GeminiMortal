/**
 * Builds a MiniSearch-backed lexical index over a current-note snapshot and
 * reranks hits with a deterministic scope-aware second stage.
 * 基于 MiniSearch 为当前笔记快照构建词法索引，并使用确定性的范围感知二阶段对命中结果重排。
 */
import MiniSearch from 'minisearch';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot.ts';
import {
  buildLexicalMatchTrace,
  lexicalMatchPriority,
  rejectsNumericVersionMismatch,
  resolveFuzzyRatio,
  type LexicalMatchTrace,
} from '../index/lexicalMatchPolicy.ts';
import { isCurrentNoteIdentifier, normalizeCurrentNoteText, tokenizeCurrentNoteText } from './currentNoteStructure.ts';
import type { CurrentNoteSearchScope, CurrentNoteScopeMode } from './currentNoteSearchScope.ts';

/**
 * Kinds of lexical matches that a current-note search hit can report.
 * 当前笔记搜索命中可报告的词法匹配类型。
 */
export type CurrentNoteMatchType = 'exact' | 'heading' | 'prefix' | 'keyword' | 'fuzzy' | 'identifier';

/**
 * One lexical search hit against a block of the current-note snapshot.
 * 当前笔记快照中某个块的一条词法搜索命中。
 */
export interface CurrentNoteSearchHit {
  hitId: string;
  blockId: string;
  /** Undefined means the block belongs to the preamble rather than a heading. 未定义表示该块属于前言部分而非某个标题。 */
  headingId?: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  snippet: string;
  /** Query terms matched inside this hit. 在该命中中匹配到的查询词。 */
  matchedTerms: string[];
  /** All match kinds that contributed to this hit. 构成该命中的全部匹配类型。 */
  matchTypes: CurrentNoteMatchType[];
  /** Per-term match traces used for match-priority ordering. 用于匹配优先级排序的逐词匹配轨迹。 */
  matchTrace: LexicalMatchTrace[];
  /** Weighted relevance score aggregated from the match features. 由各匹配特征加权聚合出的相关性分数。 */
  score: number;
  /** Stable rank from the first-stage lexical ordering, before diversity selection. 第一阶段词法排序得到的稳定排名，位于多样性筛选之前。 */
  relevanceRank: number;
}

/** Stable ordering contract used by the current-note search cursor. 当前笔记搜索游标使用的稳定排序契约。 */
export const CURRENT_NOTE_SEARCH_SORT_VERSION = 'current-note-lexical-rerank-v2';

/**
 * One page of lexical hits plus the total candidate count before paging.
 * 一页词法命中结果，外加分页前的候选总数。
 */
export interface CurrentNoteSearchIndexPage {
  hits: CurrentNoteSearchHit[];
  /** Total candidate count across every page. 跨所有分页的候选总数。 */
  total: number;
}

/**
 * Scope accepted by search entry points: a partial scope object or a bare mode.
 * 搜索入口接受的范围：部分范围对象或单独的模式字符串。
 */
export type CurrentNoteSearchScopeInput = Pick<CurrentNoteSearchScope, 'mode' | 'targetTopic' | 'targetAspects'> | CurrentNoteScopeMode;

/**
 * Frozen per-mode weights driving the second-stage selection score.
 * 驱动二阶段选择评分的按模式冻结权重。
 */
export const CURRENT_NOTE_SEARCH_RERANK_WEIGHTS = Object.freeze({
  focused: Object.freeze({ relevance: 0.70, scopeFit: 0.20, aspectGain: 0.10, sectionNovelty: 0, duplicatePenalty: 0.20 }),
  'topic-wide': Object.freeze({ relevance: 0.45, scopeFit: 0.20, aspectGain: 0.15, sectionNovelty: 0.20, duplicatePenalty: 0.20 }),
} as const);

/** Synthetic section key used for hits that precede the first heading. 用于首个标题之前命中的合成章节键。 */
export const CURRENT_NOTE_PREAMBLE_GROUP = '__preamble__';

interface IndexedCurrentNoteBlock {
  id: string;
  heading: string;
  content: string;
  identifiers: string;
}

type CurrentNoteQueryIntent = 'definition' | 'general';

interface CurrentNoteQueryProfile {
  intent: CurrentNoteQueryIntent;
  searchQuery: string;
  normalizedQuery: string;
  queryTerms: string[];
  focusTerms: string[];
}

const DEFINITION_QUESTION_PATTERN = /(?:是什么|是啥|什么是|定义|含义|指什么|什么意思|解释一下)/u;
const ENGLISH_DEFINITION_QUESTION_PATTERN = /\b(?:what\s+is|what's|define|definition\s+of|meaning\s+of)\b/iu;
const DEFINITION_QUESTION_SYNTAX_PATTERN = /(?:是什么|是啥|什么是|定义|含义|指什么|什么意思|解释一下)/gu;
const ENGLISH_DEFINITION_SYNTAX_PATTERN = /\b(?:what\s+is|what's|define|definition\s+of|meaning\s+of)\b/giu;
const DEFINITION_POLITE_WORD_PATTERN = /(?:请问|请|麻烦|帮我|一下|到底)/gu;
const DEFINITION_FIELD_BOOST = Object.freeze({ heading: 0.7, content: 2, identifiers: 2.4 });
const GENERAL_FIELD_BOOST = Object.freeze({ heading: 1.25, content: 1, identifiers: 1.6 });

/**
 * In-memory lexical index over one immutable current-note snapshot.
 * 针对单个不可变当前笔记快照的内存词法索引。
 */
export class CurrentNoteLexicalIndex {
  private readonly searchIndex: MiniSearch<IndexedCurrentNoteBlock>;
  private readonly blocks: Map<string, CurrentNoteSnapshot['blocks'][number]>;

  /**
   * Indexes every snapshot block and keeps a block-id lookup for scoring.
   * 为快照中的每个块建索引，并保留按 block id 的查找表用于评分。
   *
   * @param snapshot - Immutable snapshot to index / 要建立索引的不可变快照
   */
  constructor(private readonly snapshot: CurrentNoteSnapshot) {
    this.blocks = new Map(snapshot.blocks.map((block) => [block.blockId, block]));
    this.searchIndex = new MiniSearch<IndexedCurrentNoteBlock>({
      fields: ['heading', 'content', 'identifiers'],
      storeFields: ['id'],
      tokenize: (text) => tokenizeCurrentNoteText(text),
    });
    this.searchIndex.addAll(snapshot.blocks.map((block) => ({
      id: block.blockId,
      heading: block.headingPath.join(' / '),
      content: block.text,
      identifiers: block.normalizedTerms.filter(isCurrentNoteIdentifier).join(' '),
    })));
  }

  /**
   * Runs a lexical search and optionally applies the scope-aware rerank.
   * 执行词法搜索，并可选地应用范围感知重排。
   *
   * @param query - Raw user query text / 原始用户查询文本
   * @param limit - Maximum hits to return, clamped to 1..20 / 返回的最大命中数，收敛到 1..20
   * @param scope - Optional scope enabling the second-stage rerank / 可选范围，启用二阶段重排
   * @returns Ordered search hits / 有序的搜索命中结果
   */
  search(query: string, limit = 20, scope?: CurrentNoteSearchScopeInput): CurrentNoteSearchHit[] {
    const firstStageHits = this.collectOrderedHits(query, Math.max(1, Math.min(20, limit)));
    // The legacy array API remains byte-for-byte ordered as before when no
    // controller scope is supplied. Scope-aware Plan routes opt into the
    // second-stage section selection explicitly.
    // 未提供控制器范围时，旧的数组 API 保持与原先逐字节一致的排序。
    // 感知范围的 Plan 路由会显式启用二阶段章节选择。
    return scope ? rerankCurrentNoteSearchHits(firstStageHits, scope) : firstStageHits;
  }

  /**
   * Returns a deterministic page without changing the legacy array API. The
   * full lexical ordering is built before the scope-aware rerank so a later
   * page cannot duplicate or skip a hit because of the public 20-hit cap.
   * 返回确定性的分页结果，且不改变旧的数组 API。完整词法排序在范围感知
   * 重排之前构建，因此后续分页不会因公开的 20 条命中上限而重复或跳过命中。
   *
   * @param query - Raw user query text / 原始用户查询文本
   * @param limit - Page size / 每页命中数
   * @param offset - Zero-based start offset into the full ordering / 完整排序中的从零开始偏移
   * @param scope - Optional scope enabling the second-stage rerank / 可选范围，启用二阶段重排
   * @returns One page of hits plus the total candidate count / 一页命中结果及候选总数
   */
  searchPage(query: string, limit = 20, offset = 0, scope?: CurrentNoteSearchScopeInput): CurrentNoteSearchIndexPage {
    const allHits = this.collectOrderedHits(query);
    const orderedHits = scope ? rerankCurrentNoteSearchHits(allHits, scope) : allHits;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('搜索分页偏移无效。');
    if (offset > orderedHits.length) throw new Error('搜索分页游标已超出候选范围。');
    return {
      hits: orderedHits.slice(offset, offset + Math.max(1, limit)),
      total: orderedHits.length,
    };
  }

  /**
   * Snapshot identifier backing this index.
   * 支撑该索引的快照标识。
   */
  get snapshotId(): string {
    return this.snapshot.snapshotId;
  }

  private collectOrderedHits(query: string, maxHits?: number): CurrentNoteSearchHit[] {
    const profile = analyzeCurrentNoteQuery(query);
    if (!profile.normalizedQuery || profile.queryTerms.length === 0) return [];

    const rawResults = this.searchIndex.search(profile.searchQuery, {
      prefix: true,
      fuzzy: (term) => resolveFuzzyRatio(term),
      combineWith: 'OR',
      boost: profile.intent === 'definition' ? DEFINITION_FIELD_BOOST : GENERAL_FIELD_BOOST,
      boostDocument: profile.intent === 'definition'
        ? (documentId) => definitionDocumentBoost(this.blocks.get(String(documentId)), profile.focusTerms)
        : undefined,
    });
    // Candidate stage: MiniSearch BM25 hits are collected, with a normalized-
    // substring fallback below so exact multi-character queries survive misses.
    // 候选阶段：先收集 MiniSearch BM25 命中，再通过下方的规范化子串回退
    // 确保多字符精确查询不会因分词未命中而丢失。
    const candidates = new Map<string, { bm25: number; matchedTerms: string[] }>();
    for (const result of rawResults) {
      const block = this.blocks.get(String(result.id));
      if (!block || rejectsNumericVersionMismatch(profile.searchQuery, `${block.headingPath.join(' ')}\n${block.text}`)) continue;
      candidates.set(String(result.id), {
        bm25: Number(result.score) || 0,
        matchedTerms: readStringArray((result as unknown as { terms?: unknown }).terms),
      });
    }
    // Substring fallback: blocks whose normalized text contains the whole
    // query are kept even when MiniSearch tokenization produced no hit.
    // 子串回退：规范化文本包含完整查询的块会被保留，即使 MiniSearch 分词未命中。
    if (profile.normalizedQuery.length >= 2) {
      for (const block of this.snapshot.blocks) {
        if (!rejectsNumericVersionMismatch(profile.searchQuery, `${block.headingPath.join(' ')}\n${block.text}`)
          && normalizeCurrentNoteText(`${block.headingPath.join(' ')}\n${block.text}`).includes(profile.normalizedQuery)) {
          candidates.set(block.blockId, candidates.get(block.blockId) ?? { bm25: 0, matchedTerms: [] });
        }
      }
    }

    const maximumBm25 = Math.max(...[...candidates.values()].map((candidate) => candidate.bm25), 0);
    // Deterministic ordering: match-priority class, then score, then document
    // position, then block id — so identical inputs always rank alike.
    // 确定性排序：先按匹配优先级类别，再按分数，再按文档位置，最后按 block id，
    // 保证相同输入始终得到相同排名。
    const sortedHits = [...candidates.entries()]
      .flatMap(([blockId, candidate]) => {
        const block = this.blocks.get(blockId);
        return block ? [toSearchHit(this.snapshot, block, profile, candidate.matchedTerms, candidate.bm25, maximumBm25)] : [];
      })
      .sort((first, second) => lexicalMatchPriority(first.matchTrace) - lexicalMatchPriority(second.matchTrace)
        || second.score - first.score
        || first.lineFrom - second.lineFrom
        || first.blockId.localeCompare(second.blockId));
    const boundedHits = maxHits === undefined ? sortedHits : sortedHits.slice(0, maxHits);
    return boundedHits.map((hit, index) => ({ ...hit, relevanceRank: index + 1 }));
  }
}

/**
 * Groups hits under their heading id, falling back to the preamble key.
 * 按标题 id 对命中分组，缺失标题时回退到前言分组键。
 *
 * @param hits - Hits to group / 要分组的命中结果
 * @returns Map from heading id (or preamble key) to grouped hits / 从标题 id（或前言键）到分组命中的映射
 */
export function groupCurrentNoteSearchHitsByHeading(hits: readonly CurrentNoteSearchHit[]): Map<string, CurrentNoteSearchHit[]> {
  const groups = new Map<string, CurrentNoteSearchHit[]>();
  for (const hit of hits) {
    const key = hit.headingId ?? CURRENT_NOTE_PREAMBLE_GROUP;
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Applies the deterministic second-stage selection after lexical ranking.
 * 在词法排序之后应用确定性的二阶段选择。
 *
 * @param hits - Lexically ordered candidate hits / 词法排序后的候选命中
 * @param scope - Optional scope steering diversity and aspect coverage / 可选范围，引导多样性与方面覆盖
 * @returns Hits reordered by the greedy section-aware selection / 按贪心章节感知选择重排后的命中
 */
export function rerankCurrentNoteSearchHits(
  hits: readonly CurrentNoteSearchHit[],
  scope?: CurrentNoteSearchScopeInput,
): CurrentNoteSearchHit[] {
  if (hits.length < 2) return [...hits];
  const resolvedScope = normalizeScopeInput(scope);
  const rankedHits = hits.map((hit, index) => ({
    hit,
    relevanceRank: hit.relevanceRank ?? index + 1,
    sectionKey: hit.headingId ?? CURRENT_NOTE_PREAMBLE_GROUP,
  }));
  // Drop out-of-scope hits when the scope actually excludes something; if the
  // filter would eliminate everything, fall back to the unfiltered pool so
  // search always returns results.
  // 当范围确实排除了某些命中时剔除它们；若范围排除了全部候选，
  // 则回退到未过滤池，保证搜索始终有结果。
  const scopedCandidates = rankedHits.filter((candidate) => calculateScopeFit(candidate.hit, resolvedScope) > 0);
  const ranked = scopedCandidates.length > 0 ? scopedCandidates : rankedHits;
  const selected: typeof ranked = [];
  const selectedSections = new Set<string>();
  const selectedRanges: Array<{ lineFrom: number; lineTo: number }> = [];
  // Greedy round-robin: repeatedly pick the candidate with the best weighted
  // selection score, preferring unseen sections and non-overlapping ranges.
  // 贪心轮转：反复选取加权选择分最高的候选，优先未出现过的章节与不重叠的行范围。
  while (ranked.length > 0) {
    const unselectedSectionCandidates = resolvedScope.mode === 'topic-wide'
      ? ranked.filter((candidate) => !selectedSections.has(candidate.sectionKey))
      : ranked;
    const pool = unselectedSectionCandidates.length ? unselectedSectionCandidates : ranked;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRank = Number.POSITIVE_INFINITY;
    // Tie-breaks are fully deterministic: higher score wins, then better
    // first-stage rank, then earlier document position.
    // 平局处理完全确定：更高分优先，其次更靠前的第一阶段排名，再其次更靠前的文档位置。
    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index];
      const score = selectionScore(candidate, resolvedScope, selectedSections, selectedRanges, hits.length);
      if (score > bestScore || (score === bestScore && candidate.relevanceRank < bestRank)
        || (score === bestScore && candidate.relevanceRank === bestRank && isEarlier(candidate.hit, pool[bestIndex].hit))) {
        bestIndex = index;
        bestScore = score;
        bestRank = candidate.relevanceRank;
      }
    }
    const chosen = pool[bestIndex];
    selected.push(chosen);
    selectedSections.add(chosen.sectionKey);
    selectedRanges.push({ lineFrom: chosen.hit.lineFrom, lineTo: chosen.hit.lineTo });
    const originalIndex = ranked.indexOf(chosen);
    if (originalIndex >= 0) ranked.splice(originalIndex, 1);
  }
  return selected.map((candidate) => candidate.hit);
}

function toSearchHit(
  snapshot: CurrentNoteSnapshot,
  block: CurrentNoteSnapshot['blocks'][number],
  profile: CurrentNoteQueryProfile,
  matchedIndexTerms: string[],
  bm25: number,
  maximumBm25: number,
): CurrentNoteSearchHit {
  const { focusTerms, intent, normalizedQuery, queryTerms } = profile;
  const definitionFocusTerms = [...new Set([
    ...focusTerms,
    ...matchedIndexTerms.filter(isCurrentNoteIdentifier).map((term) => normalizeCurrentNoteText(term)),
  ])];
  const normalizedHeading = normalizeCurrentNoteText(block.headingPath.join(' '));
  const normalizedBlock = normalizeCurrentNoteText(`${block.headingPath.join(' ')}\n${block.text}`);
  const matchedTerms = queryTerms.filter((term) => block.normalizedTerms.includes(term) || normalizedBlock.includes(term));
  const headingTerms = queryTerms.filter((term) => normalizedHeading.includes(term));
  const exact = normalizedQuery.length >= 2 && normalizedBlock.includes(normalizedQuery);
  const identifier = queryTerms.some((term) => isCurrentNoteIdentifier(term) && block.normalizedTerms.includes(term));
  const coverage = matchedTerms.length / Math.max(1, queryTerms.length);
  const headingCoverage = headingTerms.length / Math.max(1, queryTerms.length);
  const normalizedBm25 = maximumBm25 > 0 ? bm25 / maximumBm25 : 0;
  const matchTrace = buildLexicalMatchTrace(
    queryTerms,
    [...matchedIndexTerms, ...block.normalizedTerms, ...tokenizeCurrentNoteText(block.headingPath.join(' '))],
  );
  const prefix = matchTrace.some((trace) => trace.matchType === 'prefix');
  const fuzzy = matchTrace.some((trace) => trace.matchType === 'fuzzy');
  const matchTypes: CurrentNoteMatchType[] = [];
  if (exact) matchTypes.push('exact');
  if (headingTerms.length) matchTypes.push('heading');
  if (prefix) matchTypes.push('prefix');
  if (matchedTerms.length) matchTypes.push('keyword');
  if (identifier) matchTypes.push('identifier');
  if (fuzzy) matchTypes.push('fuzzy');
  // Weighted feature blend; definition intent adds a cue-based bonus capped
  // by definitionCandidateSignal's [-1, 1] range.
  // 加权特征融合；定义意图额外加入受 definitionCandidateSignal [-1, 1] 范围约束的提示词加成。
  const definitionAdjustment = intent === 'definition' ? 0.22 * definitionCandidateSignal(block, definitionFocusTerms) : 0;
  const score = 0.3 * Number(exact) + 0.22 * coverage + 0.16 * headingCoverage + 0.14 * normalizedBm25
    + 0.08 * Number(identifier) + definitionAdjustment;
  const headingId = findHeadingIdAtLine(snapshot, block.lineFrom);
  return {
    hitId: `hit-${hash(`${snapshot.snapshotId}\u0000${block.blockId}\u0000${normalizedQuery}`).slice(0, 24)}`,
    blockId: block.blockId,
    ...(headingId ? { headingId } : {}),
    headingPath: [...block.headingPath],
    lineFrom: block.lineFrom,
    lineTo: block.lineTo,
    snippet: createSnippet(block.text, normalizedQuery),
    matchedTerms,
    matchTypes,
    matchTrace,
    score: Number(score.toFixed(4)),
    relevanceRank: 0,
  };
}

function normalizeScopeInput(scope?: CurrentNoteSearchScopeInput): {
  mode: CurrentNoteScopeMode;
  targetTopic?: string;
  targetAspects: string[];
} {
  if (typeof scope === 'string') return { mode: scope, targetAspects: [] };
  return {
    mode: scope?.mode ?? 'focused',
    ...(scope?.targetTopic ? { targetTopic: scope.targetTopic } : {}),
    targetAspects: [...(scope?.targetAspects ?? [])],
  };
}

function selectionScore(
  candidate: { hit: CurrentNoteSearchHit; relevanceRank: number; sectionKey: string },
  scope: { mode: CurrentNoteScopeMode; targetTopic?: string; targetAspects: string[] },
  selectedSections: ReadonlySet<string>,
  selectedRanges: readonly { lineFrom: number; lineTo: number }[],
  candidateCount: number,
): number {
  const relevance01 = 1 - (candidate.relevanceRank - 1) / Math.max(1, candidateCount - 1);
  const scopeFit = calculateScopeFit(candidate.hit, scope);
  const aspectGain = calculateAspectGain(candidate.hit, scope.targetAspects);
  const sectionNovelty = selectedSections.has(candidate.sectionKey) ? 0 : 1;
  // Inclusive line-range overlap: any shared line counts as a duplicate.
  // 闭区间行范围重叠：只要共用任意一行即视为重复。
  const duplicatePenalty = selectedSections.has(candidate.sectionKey)
    || selectedRanges.some((range) => candidate.hit.lineFrom <= range.lineTo && candidate.hit.lineTo >= range.lineFrom)
    ? 1
    : 0;
  const weights = CURRENT_NOTE_SEARCH_RERANK_WEIGHTS[scope.mode];
  return weights.relevance * relevance01
    + weights.scopeFit * scopeFit
    + weights.aspectGain * aspectGain
    + weights.sectionNovelty * sectionNovelty
    - weights.duplicatePenalty * duplicatePenalty;
}

function calculateScopeFit(
  hit: CurrentNoteSearchHit,
  scope: { targetTopic?: string; targetAspects: string[] },
): number {
  const normalizedText = normalizeCurrentNoteText(`${hit.headingPath.join(' ')} ${hit.snippet} ${hit.matchedTerms.join(' ')}`);
  const topicFit = scope.targetTopic ? Number(normalizedText.includes(normalizeCurrentNoteText(scope.targetTopic))) : 1;
  const aspectFit = scope.targetAspects.length
    ? scope.targetAspects.filter((aspect) => normalizedText.includes(normalizeCurrentNoteText(aspect))).length / scope.targetAspects.length
    : 1;
  // A hit that misses the target topic (and any required aspects) is fully
  // out of scope; otherwise blend topic and aspect coverage.
  // 未命中目标主题（且未命中所需方面）的命中完全出界；否则融合主题与方面的覆盖程度。
  if (scope.targetTopic && topicFit === 0 && (scope.targetAspects.length === 0 || aspectFit === 0)) return 0;
  return Math.min(1, 0.65 * topicFit + 0.35 * aspectFit);
}

function calculateAspectGain(hit: CurrentNoteSearchHit, targetAspects: readonly string[]): number {
  if (targetAspects.length === 0) return 1;
  const normalizedText = normalizeCurrentNoteText(`${hit.headingPath.join(' ')} ${hit.snippet} ${hit.matchedTerms.join(' ')}`);
  return targetAspects.filter((aspect) => normalizedText.includes(normalizeCurrentNoteText(aspect))).length / targetAspects.length;
}

function isEarlier(first: CurrentNoteSearchHit, second: CurrentNoteSearchHit): boolean {
  return first.lineFrom < second.lineFrom || (first.lineFrom === second.lineFrom && first.blockId.localeCompare(second.blockId) < 0);
}

function findHeadingIdAtLine(snapshot: CurrentNoteSnapshot, line: number): string | undefined {
  let headingId: string | undefined;
  for (const heading of snapshot.headings) {
    if (heading.lineFrom > line) break;
    if (heading.lineTo >= line) headingId = heading.headingId;
  }
  return headingId;
}

function analyzeCurrentNoteQuery(query: string): CurrentNoteQueryProfile {
  const trimmedQuery = query.trim().replace(/[?？!！。]+$/gu, '').trim();
  const normalizedOriginal = normalizeCurrentNoteText(trimmedQuery);
  const intent: CurrentNoteQueryIntent = DEFINITION_QUESTION_PATTERN.test(normalizedOriginal)
    || ENGLISH_DEFINITION_QUESTION_PATTERN.test(trimmedQuery)
    ? 'definition'
    : 'general';
  // Definition questions are stripped of question scaffolding and polite
  // filler so the remaining subject phrase drives the search.
  // 定义类问题会去掉疑问句式与客套填充词，让剩余的主体短语驱动搜索。
  let searchQuery = trimmedQuery;
  if (intent === 'definition') {
    const stripped = trimmedQuery
      .replace(ENGLISH_DEFINITION_SYNTAX_PATTERN, ' ')
      .replace(DEFINITION_QUESTION_SYNTAX_PATTERN, ' ')
      .replace(DEFINITION_POLITE_WORD_PATTERN, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (stripped) searchQuery = stripped;
  }
  const queryTerms = tokenizeCurrentNoteText(searchQuery);
  return {
    intent,
    searchQuery,
    normalizedQuery: normalizeCurrentNoteText(searchQuery),
    queryTerms,
    focusTerms: extractFocusTerms(searchQuery),
  };
}

/**
 * Normalizes a raw query the same way the lexical index does.
 * 以与词法索引相同的方式规范化原始查询。
 *
 * @param query - Raw user query / 原始用户查询
 * @returns Normalized query text / 规范化后的查询文本
 */
export function normalizeCurrentNoteSearchQuery(query: string): string {
  return analyzeCurrentNoteQuery(query).normalizedQuery;
}

function extractFocusTerms(value: string): string[] {
  return [...new Set((value.match(/[\u3400-\u9fff]{2,}|[A-Za-z][A-Za-z0-9_./:-]*|\d+(?:\.\d+)?/gu) ?? [])
    .map((term) => normalizeCurrentNoteText(term))
    .filter(Boolean))];
}

function definitionDocumentBoost(
  block: CurrentNoteSnapshot['blocks'][number] | undefined,
  focusTerms: readonly string[],
): number {
  if (!block) return 1;
  const signal = definitionCandidateSignal(block, focusTerms);
  if (signal >= 0.75) return 1.8;
  if (signal <= -0.5) return 0.3;
  if (block.kind === 'heading') return 0.75;
  return 1.05;
}

// Scores how well a block reads like a definition of the focus terms: positive
// cues (是/指/即…) raise the signal, negation cues (不是/并非…) lower it.
// 评估某块文本在多大程度上像是对焦点词的定义：肯定提示词（是/指/即…）提高信号，
// 否定提示词（不是/并非…）降低信号。
function definitionCandidateSignal(
  block: CurrentNoteSnapshot['blocks'][number],
  focusTerms: readonly string[],
): number {
  const normalizedText = normalizeCurrentNoteText(block.text);
  let signal = block.kind === 'heading' ? -0.35 : 0.1;
  for (const term of focusTerms) {
    if (!term || !normalizedText.includes(term)) continue;
    if (hasNearbyCue(normalizedText, term, ['是', '指', '即', '表示', '代表', '全称'], 'after', 2)
      || hasNearbyCue(normalizedText, term, ['所谓'], 'before', 2)) {
      signal += 0.9;
    }
    if (hasNearbyCue(normalizedText, term, ['不是', '并非', '不属于'], 'after', 4)
      || hasNearbyCue(normalizedText, term, ['不是', '并非', '不属于'], 'before', 4)) {
      signal -= 1.2;
    }
  }
  return Math.max(-1, Math.min(1, signal));
}

// Scans every occurrence of `term` and checks whether a cue word sits within
// `maxGap` characters on the requested side.
// 扫描 `term` 的每次出现，并检查指定一侧在 `maxGap` 个字符内是否出现提示词。
function hasNearbyCue(
  text: string,
  term: string,
  cues: readonly string[],
  position: 'before' | 'after',
  maxGap: number,
): boolean {
  let termAt = text.indexOf(term);
  while (termAt >= 0) {
    const adjacent = position === 'before'
      ? text.slice(Math.max(0, termAt - maxGap - 3), termAt)
      : text.slice(termAt + term.length, termAt + term.length + maxGap + 3);
    if (cues.some((cue) => {
      const cueAt = adjacent.indexOf(cue);
      if (cueAt < 0) return false;
      const gap = position === 'before'
        ? adjacent.length - cueAt - cue.length
        : cueAt;
      return gap <= maxGap;
    })) return true;
    termAt = text.indexOf(term, termAt + term.length);
  }
  return false;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// Builds a compact 360-char snippet windowed around the normalized query match.
// 构建紧凑的 360 字符摘要，以规范化查询的匹配位置为中心开窗。
function createSnippet(value: string, normalizedQuery: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length <= 360) return compact;
  const normalizedCompact = normalizeCurrentNoteText(compact);
  const matchedAt = normalizedQuery ? normalizedCompact.indexOf(normalizedQuery) : -1;
  const start = Math.max(0, matchedAt >= 0 ? matchedAt - 80 : 0);
  const end = Math.min(compact.length, start + 360);
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

// FNV-1a 32-bit hash used to derive stable, short hit ids.
// 用于派生稳定短命中 id 的 FNV-1a 32 位哈希。
function hash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
