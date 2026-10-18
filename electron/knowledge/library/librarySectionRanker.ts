/**
 * Library section ranker: BM25 ranking of note sections (body vs heading channels)
 * with query-term DF suppression and ambiguity detection for navigation only.
 * 章节排序器：对笔记章节做 BM25 排序（正文与标题双通道），支持查询词 DF 抑制与歧义检测，仅用于导航。
 */
import { createHash } from 'node:crypto';
import MiniSearch from 'minisearch';
import type { CurrentNoteSnapshot } from '../currentNote/currentNoteSnapshot.ts';
import {
  isCurrentNoteIdentifier,
  normalizeCurrentNoteText,
  tokenizeCurrentNoteText,
  type CurrentNoteEvidenceBlock,
  type CurrentNoteHeadingRange,
} from '../currentNote/currentNoteStructure.ts';
import { SEARCH_QUERY_TERM_BATCH_SIZE, type SearchQueryTerm } from '../search/searchPlanTypes.ts';

const HEADING_DF_SUPPRESSION_RATIO = 0.8; // Heading DF threshold for suppression / 标题通道 DF 抑制阈值
const RELATED_SECTION_LIMIT = 3; // Max recommended sections / 最大推荐章节数
const SECTION_PREVIEW_CHARACTERS = 240; // Preview length cap / 预览长度上限
const INDEX_TOKEN_SEPARATOR = '\u0001'; // Pre-tokenized index field marker / 预分词索引字段分隔符

/**
 * One searchable section document projected from a note snapshot.
 * 从笔记快照投影出的单个可检索章节文档。
 */
export interface LibrarySectionSearchDocument {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  headingId: string;
  headingPath: string[];
  level: number;
  lineFrom: number;
  lineTo: number;
  headingText: string;
  directBodyText: string; // Body owned directly by this heading / 该标题直接拥有的正文
  directBodyTerms: string[]; // Normalized terms of the body / 正文的规范化词项
  identifiers: string[]; // Identifier-like terms (codes, paths) / 标识符类词项（编号、路径等）
  directBlockIds: string[]; // Block ids owned by this heading / 该标题拥有的块标识
}

/**
 * A deduplicated, normalized query term with its provenance.
 * 去重并规范化后的查询词及其来源。
 */
export interface NormalizedLibrarySectionQueryTerm {
  term: string; // Original term / 原始词项
  normalizedTerm: string; // Normalized form / 规范化形式
  source: SearchQueryTerm['source']; // Provenance of the term / 词项来源
}

/**
 * A scored section candidate for related-section navigation.
 * 用于相邻章节导航的已打分章节候选。
 */
export interface LibraryRelatedSectionCandidate {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  headingId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  score: number; // Final blended score / 最终综合得分
  scoreBreakdown: {
    bodyBm25: number; // Normalized body BM25 / 归一化正文 BM25
    headingBm25: number; // Normalized heading BM25 / 归一化标题 BM25
    queryCoverage: number; // Fraction of query terms matched / 命中查询词比例
    exactBodyOrIdentifier: number; // 1 if body/identifier matched / 正文或标识符命中则为 1
  };
  matchedQueryTerms: string[]; // Terms matched in this section / 本章节命中的查询词
  suppressedHeadingTerms: string[]; // Terms suppressed on the heading channel / 标题通道被抑制的词项
  preview: string; // Body preview / 正文预览
}

/**
 * Result of ranking sections for one note under a query term set.
 * 针对一篇笔记、一组查询词的章节排序结果。
 */
export interface LibrarySectionRankResult {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  queryTermFingerprint: string; // Cache identity of the query terms / 查询词缓存指纹
  processedQueryTerms: readonly Readonly<NormalizedLibrarySectionQueryTerm>[];
  processedQueryTermCount: number;
  queryTermBatchCount: number;
  evaluatedSectionCount: number;
  suppressedHeadingTerms: readonly string[];
  ambiguous: boolean; // Ranking is not discriminative enough / 排序不具区分度
  fallbackUsed: false;
  reason?: 'no-query-terms' | 'all-query-terms-non-discriminative'; // Why no ranking was produced / 未产出排序的原因
  topSections: readonly Readonly<LibraryRelatedSectionCandidate>[];
}

/** Navigation-only recommendation. Candidates are not Evidence Ledger records. */
/** 仅用于导航的推荐结果；候选不是 Evidence Ledger 记录。 */
export interface LibrarySectionRecommendationObservation {
  goalId: string;
  sourceEvidenceId: string;
  noteId: string;
  snapshotId: string;
  contentHash: string;
  queryTermCount: number;
  evaluatedSectionCount: number;
  ambiguous: boolean;
  fallbackUsed: boolean;
  topSections: readonly Readonly<LibraryRelatedSectionCandidate>[];
}

/** MiniSearch document with separated body/heading channels. / 正文与标题通道分离的 MiniSearch 文档。 */
interface SectionIndexDocument {
  id: string;
  bodyChannel: string;
  headingChannel: string;
}

/** Document-frequency stats driving heading suppression. / 驱动标题抑制的文档频率统计。 */
interface QueryTermStats {
  term: PreparedLibrarySectionQueryTerm;
  bodyDfRatio: number;
  headingDfRatio: number;
  suppressHeading: boolean;
}

/** Query term prepared for matching against prepared documents. / 已为匹配准备的查询词。 */
interface PreparedLibrarySectionQueryTerm extends NormalizedLibrarySectionQueryTerm {
  comparableTerm: string;
  identifier: boolean;
}

/** Section document pre-normalized for scoring and indexing. / 已预规范化、用于打分与索引的章节文档。 */
interface PreparedLibrarySectionDocument {
  source: Readonly<LibrarySectionSearchDocument>;
  normalizedBodyText: string;
  normalizedHeadingText: string;
  normalizedIdentifiers: ReadonlySet<string>;
  normalizedHeadingTokens: ReadonlySet<string>;
  bodyIndexText: string;
  headingIndexText: string;
}

/** A section with its blended score and admission flag. / 带综合得分与准入标记的章节。 */
interface ScoredSection {
  candidate: LibraryRelatedSectionCandidate;
  internalScore: number;
  bodyBm25: number;
  queryCoverage: number;
  admitted: boolean;
}

/**
 * Ranks note sections for related-section navigation with BM25 scoring.
 * 使用 BM25 打分对笔记章节排序，用于相邻章节导航。
 */
export class LibrarySectionRanker {
  readonly documents: readonly Readonly<LibrarySectionSearchDocument>[];
  private readonly preparedDocuments: readonly PreparedLibrarySectionDocument[];
  private readonly sectionIndex: MiniSearch<SectionIndexDocument>;
  private readonly noteId: string;
  private readonly snapshotId: string;
  private readonly contentHash: string;

  /**
   * Builds the section index from one note snapshot.
   * 基于一篇笔记快照构建章节索引。
   *
   * @param input - Note id and its local snapshot / 笔记标识及其本地快照
   */
  constructor(input: { noteId: string; snapshot: CurrentNoteSnapshot }) {
    this.noteId = input.noteId;
    this.snapshotId = input.snapshot.snapshotId;
    this.contentHash = input.snapshot.contentHash;
    this.documents = projectLibrarySectionSearchDocuments(input);
    this.preparedDocuments = this.documents.map(prepareLibrarySectionDocument);
    this.sectionIndex = new MiniSearch<SectionIndexDocument>({
      fields: ['bodyChannel', 'headingChannel'],
      tokenize: tokenizePreparedIndexText,
    });
    this.sectionIndex.addAll(this.preparedDocuments.map((document) => ({
      id: document.source.headingId,
      bodyChannel: document.bodyIndexText,
      headingChannel: document.headingIndexText,
    })));
  }

  /**
   * Ranks sections related to the query terms, excluding already-read headings.
   * 对与查询词相关的章节排序，并排除已读取的标题。
   *
   * @param queryTerms - Query terms from the active goal / 当前目标的查询词
   * @param excludedHeadingIds - Headings to exclude (already read) / 需排除的标题（已读取）
   * @returns Frozen ranking result / 冻结的排序结果
   */
  rankRelatedSections(
    queryTerms: readonly SearchQueryTerm[],
    excludedHeadingIds: ReadonlySet<string> = new Set(),
  ): LibrarySectionRankResult {
    const normalizedTerms = normalizeLibrarySectionQueryTerms(queryTerms);
    const preparedTerms = normalizedTerms.map(prepareLibrarySectionQueryTerm);
    const queryTermFingerprint = fingerprintNormalizedQueryTerms(normalizedTerms);
    const baseResult = {
      noteId: this.noteId,
      snapshotId: this.snapshotId,
      contentHash: this.contentHash,
      queryTermFingerprint,
      processedQueryTerms: normalizedTerms,
      processedQueryTermCount: normalizedTerms.length,
      queryTermBatchCount: Math.ceil(normalizedTerms.length / SEARCH_QUERY_TERM_BATCH_SIZE),
      evaluatedSectionCount: this.documents.length,
      fallbackUsed: false as const,
    };
    if (normalizedTerms.length === 0) {
      return freezeRankResult({
        ...baseResult,
        suppressedHeadingTerms: [],
        ambiguous: false,
        reason: 'no-query-terms',
        topSections: [],
      });
    }

    // Terms that appear in most headings are suppressed there so generic titles
    // cannot dominate the ranking.
    // 出现在多数标题中的词在标题通道被抑制，避免通用标题主导排序。
    const termStats = calculateQueryTermStats(this.preparedDocuments, preparedTerms);
    const suppressedKeys = new Set(termStats.filter((stats) => stats.suppressHeading).map((stats) => stats.term.normalizedTerm));
    const bodyScores = initializeScoreMap(this.documents);
    const headingScores = initializeScoreMap(this.documents);

    for (const batch of chunkQueryTerms(normalizedTerms)) {
      accumulateMiniSearchScores(this.sectionIndex, batch, bodyScores, ['bodyChannel']);
      const headingBatch = batch.filter((term) => !suppressedKeys.has(term.normalizedTerm));
      if (headingBatch.length > 0) accumulateMiniSearchScores(this.sectionIndex, headingBatch, headingScores, ['headingChannel']);
    }

    const maximumBodyScore = maximumScore(bodyScores);
    const maximumHeadingScore = maximumScore(headingScores);
    const eligibleDocuments = this.documents.filter((document) => !excludedHeadingIds.has(document.headingId));
    const scoredSections = this.preparedDocuments.map((document) => scoreSection({
      document,
      normalizedTerms: preparedTerms,
      suppressedKeys,
      bodyBm25: normalizeScore(bodyScores.get(document.source.headingId) ?? 0, maximumBodyScore),
      headingBm25: normalizeScore(headingScores.get(document.source.headingId) ?? 0, maximumHeadingScore),
    }));
    const admittedSections = scoredSections.filter((section) => section.admitted
      && !excludedHeadingIds.has(section.candidate.headingId));
    // Ambiguous results return no candidates so the agent keeps exploring instead
    // of trusting a non-discriminative ranking.
    // 歧义结果不返回候选，让代理继续探索，而不是信任无区分度的排序。
    const allScoresZero = admittedSections.length === 0;
    const allTermsNonDiscriminative = termStats.every((stats) => stats.bodyDfRatio >= HEADING_DF_SUPPRESSION_RATIO
      || (stats.suppressHeading && stats.bodyDfRatio === 0));
    const allContentSectionsTie = admittedSections.length > 1
      && admittedSections.length === eligibleDocuments.length
      && admittedSections.every((section) => nearlyEqual(section.internalScore, admittedSections[0]?.internalScore ?? 0));
    const ambiguous = allScoresZero || allTermsNonDiscriminative || allContentSectionsTie;
    const topSections = ambiguous ? [] : admittedSections
      .sort(compareScoredSections)
      .slice(0, RELATED_SECTION_LIMIT)
      .map((section) => section.candidate);

    return freezeRankResult({
      ...baseResult,
      suppressedHeadingTerms: termStats.filter((stats) => stats.suppressHeading).map((stats) => stats.term.term),
      ambiguous,
      ...(ambiguous ? { reason: 'all-query-terms-non-discriminative' as const } : {}),
      topSections,
    });
  }

  /** Maps successful read block IDs back to the deepest content sections that own them. */
  /** 将成功读取的 blockId 映射回拥有它们的最深内容章节。 */
  findContentHeadingIdsByBlockIds(blockIds: readonly string[]): string[] {
    const selectedBlockIds = new Set(blockIds);
    if (selectedBlockIds.size === 0) return [];
    return this.documents
      .filter((document) => document.directBlockIds.some((blockId) => selectedBlockIds.has(blockId)))
      .map((document) => document.headingId);
  }
}

/**
 * Projects a note snapshot into one search document per content-bearing heading.
 * 将笔记快照投影为按内容标题划分的检索文档。
 *
 * @param input - Note id and its local snapshot / 笔记标识及其本地快照
 * @returns Section search documents / 章节检索文档列表
 */
export function projectLibrarySectionSearchDocuments(input: {
  noteId: string;
  snapshot: CurrentNoteSnapshot;
}): LibrarySectionSearchDocument[] {
  const headings = [...input.snapshot.headings]
    .sort((first, second) => first.lineFrom - second.lineFrom || first.level - second.level || first.headingId.localeCompare(second.headingId));
  const blocksByHeadingId = new Map(headings.map((heading) => [heading.headingId, [] as CurrentNoteEvidenceBlock[]]));

  // Each non-empty content block is attributed to its deepest owning heading.
  // 每个非空内容块归属于覆盖它的最深标题。
  for (const block of input.snapshot.blocks) {
    if (block.kind === 'heading' || block.kind === 'frontmatter' || !block.text.trim()) continue;
    const owner = findDeepestHeading(headings, block.lineFrom);
    if (owner) blocksByHeadingId.get(owner.headingId)?.push(block);
  }

  // Headings without direct content blocks produce no document.
  // 没有直接内容块的标题不产生文档。
  return headings.flatMap((heading) => {
    const directBlocks = blocksByHeadingId.get(heading.headingId) ?? [];
    if (directBlocks.length === 0) return [];
    return [{
      noteId: input.noteId,
      snapshotId: input.snapshot.snapshotId,
      contentHash: input.snapshot.contentHash,
      headingId: heading.headingId,
      headingPath: [...heading.path],
      level: heading.level,
      lineFrom: heading.lineFrom,
      lineTo: heading.lineTo,
      headingText: heading.text,
      directBodyText: directBlocks.map((block) => block.text).join('\n\n'),
      directBodyTerms: stableUnique(directBlocks.flatMap((block) => block.normalizedTerms)),
      identifiers: stableUnique(directBlocks.flatMap((block) => block.normalizedTerms.filter(isCurrentNoteIdentifier))),
      directBlockIds: directBlocks.map((block) => block.blockId),
    }];
  });
}

/**
 * Normalizes and deduplicates query terms for section ranking.
 * 规范化并去重用于章节排序的查询词。
 *
 * @param queryTerms - Raw query terms / 原始查询词
 * @returns Normalized, deduplicated terms / 规范化去重后的查询词
 */
export function normalizeLibrarySectionQueryTerms(
  queryTerms: readonly SearchQueryTerm[],
): NormalizedLibrarySectionQueryTerm[] {
  const seen = new Set<string>();
  const normalized: NormalizedLibrarySectionQueryTerm[] = [];
  for (const queryTerm of queryTerms) {
    const term = queryTerm.term.trim();
    const normalizedTerm = term.normalize('NFKC').toLocaleLowerCase('zh-Hans-CN').trim();
    if (!normalizedTerm || seen.has(normalizedTerm)) continue;
    seen.add(normalizedTerm);
    normalized.push({ term, normalizedTerm, source: queryTerm.source });
  }
  return normalized;
}

/**
 * Fingerprints query terms for rank-result caching.
 * 为排序结果缓存生成查询词指纹。
 *
 * @param queryTerms - Raw query terms / 原始查询词
 * @returns Stable fingerprint / 稳定指纹
 */
export function createLibrarySectionQueryTermFingerprint(queryTerms: readonly SearchQueryTerm[]): string {
  return fingerprintNormalizedQueryTerms(normalizeLibrarySectionQueryTerms(queryTerms));
}

/**
 * Fingerprints an exclusion heading-id set for caching.
 * 为排除标题集合生成缓存指纹。
 *
 * @param headingIds - Heading ids to exclude / 需排除的标题标识
 * @returns Stable fingerprint / 稳定指纹
 */
export function createLibrarySectionExclusionFingerprint(headingIds: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(stableUnique(headingIds.filter(Boolean)).sort()), 'utf8')
    .digest('hex');
}

/** Computes per-term document frequency ratios for heading suppression. / 计算每个词的文档频率比例以决定标题抑制。 */
function calculateQueryTermStats(
  documents: readonly PreparedLibrarySectionDocument[],
  queryTerms: readonly PreparedLibrarySectionQueryTerm[],
): QueryTermStats[] {
  return queryTerms.map((term) => {
    const bodyDocumentFrequency = documents.filter((document) => matchesBody(document, term)).length;
    const headingDocumentFrequency = documents.filter((document) => matchesHeading(document, term)).length;
    const bodyDfRatio = documents.length > 0 ? bodyDocumentFrequency / documents.length : 0;
    const headingDfRatio = documents.length > 0 ? headingDocumentFrequency / documents.length : 0;
    return {
      term,
      bodyDfRatio,
      headingDfRatio,
      suppressHeading: headingDfRatio >= HEADING_DF_SUPPRESSION_RATIO,
    };
  });
}

/** Blends BM25, coverage and exact-match signals into a scored candidate. / 融合 BM25、覆盖率与精确命中信号生成候选得分。 */
function scoreSection(input: {
  document: PreparedLibrarySectionDocument;
  normalizedTerms: readonly PreparedLibrarySectionQueryTerm[];
  suppressedKeys: ReadonlySet<string>;
  bodyBm25: number;
  headingBm25: number;
}): ScoredSection {
  const bodyMatches = input.normalizedTerms.filter((term) => matchesBody(input.document, term));
  const headingMatches = input.normalizedTerms.filter((term) => !input.suppressedKeys.has(term.normalizedTerm)
    && matchesHeading(input.document, term));
  const matchedTerms = input.normalizedTerms.filter((term) => bodyMatches.includes(term) || headingMatches.includes(term));
  const queryCoverage = matchedTerms.length / Math.max(1, input.normalizedTerms.length);
  const exactBodyOrIdentifier = Number(bodyMatches.length > 0);
  // Weighted blend: body evidence dominates, headings and coverage assist.
  // 加权融合：正文信号为主，标题与覆盖率起辅助作用。
  const internalScore = 100 * (0.55 * input.bodyBm25
    + 0.15 * input.headingBm25
    + 0.20 * queryCoverage
    + 0.10 * exactBodyOrIdentifier);
  return {
    internalScore,
    bodyBm25: input.bodyBm25,
    queryCoverage,
    admitted: bodyMatches.length > 0 || headingMatches.length > 0,
    candidate: {
      noteId: input.document.source.noteId,
      snapshotId: input.document.source.snapshotId,
      contentHash: input.document.source.contentHash,
      headingId: input.document.source.headingId,
      headingPath: [...input.document.source.headingPath],
      lineFrom: input.document.source.lineFrom,
      lineTo: input.document.source.lineTo,
      score: round(internalScore, 2),
      scoreBreakdown: {
        bodyBm25: round(input.bodyBm25, 6),
        headingBm25: round(input.headingBm25, 6),
        queryCoverage: round(queryCoverage, 6),
        exactBodyOrIdentifier,
      },
      matchedQueryTerms: matchedTerms.map((term) => term.term),
      suppressedHeadingTerms: input.normalizedTerms
        .filter((term) => input.suppressedKeys.has(term.normalizedTerm) && matchesHeading(input.document, term))
        .map((term) => term.term),
      preview: createPreview(input.document.source.directBodyText),
    },
  };
}

/** Finds the deepest heading covering a line via binary search. / 通过二分查找定位覆盖某行的最深标题。 */
function findDeepestHeading(
  headings: readonly CurrentNoteHeadingRange[],
  line: number,
): CurrentNoteHeadingRange | undefined {
  // Binary-search the last heading starting at or before the line.
  // 二分查找最后一个起始行不大于该行的标题。
  let left = 0;
  let right = headings.length - 1;
  let nearestIndex = -1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (headings[middle].lineFrom <= line) {
      nearestIndex = middle;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  for (let index = nearestIndex; index >= 0; index -= 1) {
    const heading = headings[index];
    if (heading.lineTo >= line) return heading;
  }
  return undefined;
}

/** Zeros a headingId → score map. / 初始化 headingId → 得分 映射。 */
function initializeScoreMap(documents: readonly Readonly<LibrarySectionSearchDocument>[]): Map<string, number> {
  return new Map(documents.map((document) => [document.headingId, 0]));
}

/** Adds OR-combined MiniSearch scores for a term batch into the score map. / 将一批词的 OR 组合 MiniSearch 得分累加进得分映射。 */
function accumulateMiniSearchScores<T extends { id: string }>(
  index: MiniSearch<T>,
  queryTerms: readonly NormalizedLibrarySectionQueryTerm[],
  scores: Map<string, number>,
  fields: string[],
): void {
  const query = queryTerms.map((term) => term.normalizedTerm).join(' ');
  for (const result of index.search(query, { combineWith: 'OR', fields })) {
    const headingId = String(result.id);
    if (!scores.has(headingId)) continue;
    scores.set(headingId, (scores.get(headingId) ?? 0) + (Number(result.score) || 0));
  }
}

/** Splits query terms into fixed-size batches. / 将查询词切分为固定大小的批次。 */
function chunkQueryTerms(
  queryTerms: readonly NormalizedLibrarySectionQueryTerm[],
): NormalizedLibrarySectionQueryTerm[][] {
  const batches: NormalizedLibrarySectionQueryTerm[][] = [];
  for (let index = 0; index < queryTerms.length; index += SEARCH_QUERY_TERM_BATCH_SIZE) {
    batches.push(queryTerms.slice(index, index + SEARCH_QUERY_TERM_BATCH_SIZE));
  }
  return batches;
}

/** Whether a term matches the body text or identifiers. / 判断词项是否命中正文或标识符。 */
function matchesBody(document: PreparedLibrarySectionDocument, term: PreparedLibrarySectionQueryTerm): boolean {
  if (!term.comparableTerm) return false;
  // Identifier terms require exact set membership; text terms use substring match.
  // 标识符词需精确集合命中；文本词使用子串匹配。
  if (term.identifier) return document.normalizedIdentifiers.has(term.comparableTerm);
  return document.normalizedBodyText.includes(term.comparableTerm)
    || document.normalizedIdentifiers.has(term.comparableTerm);
}

/** Whether a term matches the heading text or heading tokens. / 判断词项是否命中标题文本或标题词元。 */
function matchesHeading(document: PreparedLibrarySectionDocument, term: PreparedLibrarySectionQueryTerm): boolean {
  if (!term.comparableTerm) return false;
  if (term.identifier) return document.normalizedHeadingTokens.has(term.comparableTerm);
  return document.normalizedHeadingText.includes(term.comparableTerm);
}

/** Pre-normalizes a document and encodes its index fields. / 预规范化文档并编码其索引字段。 */
function prepareLibrarySectionDocument(document: Readonly<LibrarySectionSearchDocument>): PreparedLibrarySectionDocument {
  const headingValue = `${document.headingPath.join(' ')} ${document.headingText}`;
  const bodyTokens = document.directBodyTerms;
  const headingPathTokens = tokenizeCurrentNoteText(document.headingPath.join(' / '));
  return {
    source: document,
    normalizedBodyText: normalizeCurrentNoteText(document.directBodyText),
    normalizedHeadingText: normalizeCurrentNoteText(headingValue),
    normalizedIdentifiers: new Set(document.identifiers.map((identifier) => normalizeCurrentNoteText(identifier))),
    normalizedHeadingTokens: new Set(headingPathTokens.map((term) => normalizeCurrentNoteText(term))),
    bodyIndexText: encodePreparedIndexTokens(bodyTokens),
    headingIndexText: encodePreparedIndexTokens(headingPathTokens),
  };
}

/** Tokenizer that understands pre-encoded index fields. / 可识别预编码索引字段的分词器。 */
function tokenizePreparedIndexText(value: string): string[] {
  if (!value) return [];
  // Fields marked with the separator hold pre-tokenized terms; others go through
  // normal tokenization.
  // 带分隔符标记的字段保存预分词词项；其余走常规分词。
  return value.startsWith(INDEX_TOKEN_SEPARATOR)
    ? value.slice(INDEX_TOKEN_SEPARATOR.length).split(INDEX_TOKEN_SEPARATOR).filter(Boolean)
    : tokenizeCurrentNoteText(value);
}

/** Encodes pre-tokenized terms into a single index field. / 将预分词词项编码为单个索引字段。 */
function encodePreparedIndexTokens(tokens: readonly string[]): string {
  return tokens.length ? `${INDEX_TOKEN_SEPARATOR}${tokens.join(INDEX_TOKEN_SEPARATOR)}` : '';
}

/** Adds the comparable form and identifier flag to a normalized term. / 为规范化词项补充可比形式与标识符标记。 */
function prepareLibrarySectionQueryTerm(term: NormalizedLibrarySectionQueryTerm): PreparedLibrarySectionQueryTerm {
  return {
    ...term,
    comparableTerm: normalizeCurrentNoteText(term.normalizedTerm),
    identifier: isCurrentNoteIdentifier(term.normalizedTerm),
  };
}

/** Largest score in a map, never negative. / 映射中的最大得分，且不小于 0。 */
function maximumScore(scores: ReadonlyMap<string, number>): number {
  return Math.max(0, ...scores.values());
}

/** Scales a score against its maximum. / 按最大值归一化得分。 */
function normalizeScore(score: number, maximum: number): number {
  return maximum > 0 ? score / maximum : 0;
}

/** Orders candidates by score then document position. / 按得分再按文档位置排序候选。 */
function compareScoredSections(first: ScoredSection, second: ScoredSection): number {
  return second.internalScore - first.internalScore
    || second.bodyBm25 - first.bodyBm25
    || second.queryCoverage - first.queryCoverage
    || first.candidate.lineFrom - second.candidate.lineFrom
    || first.candidate.headingId.localeCompare(second.candidate.headingId);
}

/** Fingerprints normalized terms and sources for caching. / 为规范化词项与来源生成缓存指纹。 */
function fingerprintNormalizedQueryTerms(queryTerms: readonly NormalizedLibrarySectionQueryTerm[]): string {
  return createHash('sha256')
    .update(JSON.stringify(queryTerms.map((term) => [term.normalizedTerm, term.source])), 'utf8')
    .digest('hex');
}

/** Collapses whitespace and truncates a preview string. / 压缩空白并截断预览字符串。 */
function createPreview(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, SECTION_PREVIEW_CHARACTERS);
}

/** De-duplicates values preserving first-seen order. / 按首次出现顺序去重。 */
function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Whether two numbers are equal within float tolerance. / 判断两个数是否在浮点误差内相等。 */
function nearlyEqual(first: number, second: number): boolean {
  return Math.abs(first - second) < 1e-12;
}

/** Rounds to a fixed number of digits. / 按固定小数位数四舍五入。 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Freezes a rank result so shared caches cannot be mutated. / 冻结排序结果，防止共享缓存被修改。 */
function freezeRankResult(result: LibrarySectionRankResult): LibrarySectionRankResult {
  for (const term of result.processedQueryTerms) Object.freeze(term);
  for (const candidate of result.topSections) {
    Object.freeze(candidate.headingPath);
    Object.freeze(candidate.scoreBreakdown);
    Object.freeze(candidate.matchedQueryTerms);
    Object.freeze(candidate.suppressedHeadingTerms);
    Object.freeze(candidate);
  }
  Object.freeze(result.processedQueryTerms);
  Object.freeze(result.suppressedHeadingTerms);
  Object.freeze(result.topSections);
  return Object.freeze(result);
}
