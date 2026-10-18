/**
 * Whole-library note tools: candidate search, block lookup, section ranking,
 * adjacent-section navigation and bounded reads over scoped note snapshots.
 * 整库笔记工具：候选检索、块定位、章节排序、相邻章节导航，以及限定作用域快照上的限量读取。
 */
import { createKeywordSearchOutcome, type SearchCandidate } from '../index/keywordSearch.ts';
import { getCurrentNoteMap, readCurrentNoteRange, readCurrentNoteSection, type CurrentNoteReadLimits } from '../currentNote/currentNoteTools.ts';
import { CurrentNoteLexicalIndex, type CurrentNoteSearchHit } from '../currentNote/currentNoteLexicalIndex.ts';
import {
  createLibrarySectionExclusionFingerprint,
  createLibrarySectionQueryTermFingerprint,
  LibrarySectionRanker,
  type LibrarySectionRankResult,
} from './librarySectionRanker.ts';
import { getLibraryNoteRecord, type LibraryNoteSnapshotMap, type LibraryNoteSnapshotRecord } from './libraryNoteSnapshot.ts';
import type { SearchQueryTerm } from '../search/searchPlanTypes.ts';

/**
 * A candidate note recalled by whole-library keyword search.
 * 通过整库关键词检索召回的候选笔记。
 */
export interface LibraryNoteCandidate {
  noteId: string; // Stable note id / 稳定笔记标识
  title: string; // Note title for navigation / 用于导航的笔记标题
  contentHash: string; // Content hash / 内容哈希
  score: number; // Retrieval score / 检索得分
  snippet?: string; // Optional preview snippet / 可选预览片段
  methods: ['keyword']; // Match methods used / 使用的匹配方式
  matchTrace?: SearchCandidate['matchTrace']; // Match diagnostics / 匹配诊断信息
}

/**
 * A block-level hit inside one library note.
 * 单篇笔记内的块级命中结果。
 */
export interface LibraryNoteBlockHit extends CurrentNoteSearchHit {
  noteId: string; // Owning note id / 所属笔记标识
  title: string; // Owning note title / 所属笔记标题
  contentHash: string; // Owning note content hash / 所属笔记内容哈希
}

/**
 * Injected search backends for library tools.
 * 为笔记库工具注入的检索后端。
 */
export interface LibrarySearchCallbacks {
  keywordSearch: (query: string) => SearchCandidate[]; // Keyword recall callback / 关键词召回回调
}

/**
 * Direction of adjacent-section navigation.
 * 相邻章节导航方向。
 */
export type LibraryAdjacentSectionDirection = 'previous' | 'next';

/**
 * Target section located by adjacent navigation.
 * 相邻导航定位到的目标章节。
 */
export interface LibraryAdjacentSectionTarget {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  headingId: string;
  headingPath: string[];
  level: number;
  lineFrom: number;
  lineTo: number;
}

/**
 * Main-process-only quota; the model-visible tool schema never exposes it.
 * 仅主进程可见的读取配额；模型可见的工具 schema 从不暴露该字段。
 */
export type LibraryNoteReadLimits = CurrentNoteReadLimits;

/**
 * Recalls candidate notes for a query and projects hits into the scoped snapshot map.
 * 按查询召回候选笔记，并投影到限定作用域的快照映射中。
 *
 * @param input - Snapshot map, session, query, limit and search callbacks / 快照映射、会话、查询、上限与检索回调
 * @returns Matched note candidates and the retrieval mode / 匹配的候选笔记与检索模式
 */
export async function searchLibraryNoteCandidates(input: {
  snapshotMap: LibraryNoteSnapshotMap;
  sessionId: string;
  query: string;
  limit?: number;
  callbacks: LibrarySearchCallbacks;
}): Promise<{ results: LibraryNoteCandidate[]; mode: 'keyword' | 'none' }> {
  if (input.snapshotMap.sessionId !== input.sessionId) throw new Error('整库搜索不属于当前助手会话。');
  const query = input.query.trim();
  if (!query) return { results: [], mode: 'none' };
  const limit = input.limit ?? 8;
  const outcome = createKeywordSearchOutcome(input.callbacks.keywordSearch(query), limit);
  // Hits are re-keyed by notePath so only notes inside the snapshot map survive.
  // 命中结果按 notePath 重映射，确保只保留快照映射内的笔记。
  const byPath = new Map([...input.snapshotMap.records.values()].map((record) => [record.localSnapshot.notePath, record]));
  const results = outcome.results.flatMap((result) => {
    const record = byPath.get(result.path);
    if (!record) return [];
    return [{
      noteId: record.noteId,
      title: record.title,
      contentHash: record.contentHash,
      score: result.score,
      ...(result.snippet ? { snippet: result.snippet } : {}),
      methods: result.methods,
      ...(result.matchTrace?.length ? { matchTrace: result.matchTrace } : {}),
    }];
  }).slice(0, Math.max(1, Math.min(20, limit)));
  return { results, mode: outcome.mode };
}

/**
 * Builds the scoped tool set used by the whole-library agent loop, with per-note caches.
 * 构建整库代理循环使用的限定作用域工具集，并为每篇笔记维护缓存。
 *
 * @param snapshotMap - Scoped note snapshot map / 限定作用域的笔记快照映射
 * @param sessionId - Assistant session identity / 助手会话标识
 * @returns Bound note tools / 绑定后的笔记工具集合
 */
export function createLibraryNoteTools(snapshotMap: LibraryNoteSnapshotMap, sessionId: string): {
  getNoteMap: (noteId: string, detail?: 'outline' | 'stats' | 'terms') => ReturnType<typeof getCurrentNoteMap>;
  searchNoteBlocks: (noteId: string, terms: readonly string[], limit?: number) => LibraryNoteBlockHit[];
  rankRelatedSections: (noteId: string, queryTerms: readonly SearchQueryTerm[], excludedHeadingIds?: readonly string[]) => LibrarySectionRankResult;
  findContentHeadingIdsByBlockIds: (noteId: string, blockIds: readonly string[]) => string[];
  findDeepestHeadingIdAtLine: (noteId: string, line: number) => string | undefined;
  findAdjacentSection: (noteId: string, anchorHeadingId: string, direction: LibraryAdjacentSectionDirection) => LibraryAdjacentSectionTarget | undefined;
  readNoteRange: (noteId: string, input: { lineFrom: number; lineTo: number }, limits?: LibraryNoteReadLimits) => ReturnType<typeof readCurrentNoteRange>;
  readNoteSection: (noteId: string, input: { headingId: string; cursor?: number }, limits?: LibraryNoteReadLimits) => ReturnType<typeof readCurrentNoteSection>;
} {
  // Lexical indexes and section rankers are cached per note/snapshot; rank results
  // are additionally memoized by query and exclusion fingerprints.
  // 词法索引与章节排序器按笔记/快照缓存；排序结果再按查询与排除指纹做记忆化。
  const indexes = new Map<string, CurrentNoteLexicalIndex>();
  const sectionRankers = new Map<string, LibrarySectionRanker>();
  const sectionRankResults = new Map<string, LibrarySectionRankResult>();
  const getRecord = (noteId: string) => getLibraryNoteRecord(snapshotMap, noteId, sessionId);
  const getIndex = (noteId: string) => {
    const existing = indexes.get(noteId);
    if (existing) return existing;
    const created = new CurrentNoteLexicalIndex(getRecord(noteId).localSnapshot);
    indexes.set(noteId, created);
    return created;
  };
  const getSectionRanker = (record: LibraryNoteSnapshotRecord) => {
    const existing = sectionRankers.get(record.snapshotId);
    if (existing) return existing;
    const created = new LibrarySectionRanker({ noteId: record.noteId, snapshot: record.localSnapshot });
    sectionRankers.set(record.snapshotId, created);
    return created;
  };
  return {
    getNoteMap: (noteId, detail = 'outline') => getCurrentNoteMap(getRecord(noteId).localSnapshot, detail),
    searchNoteBlocks: (noteId, terms, limit = 8) => {
      const record = getRecord(noteId);
      return getIndex(noteId).search(terms.join(' '), limit).map((hit) => ({
        ...hit,
        noteId,
        title: record.title,
        contentHash: record.contentHash,
      }));
    },
    rankRelatedSections: (noteId, queryTerms, excludedHeadingIds = []) => {
      const record = getRecord(noteId);
      const queryTermFingerprint = createLibrarySectionQueryTermFingerprint(queryTerms);
      const excludedHeadingFingerprint = createLibrarySectionExclusionFingerprint(excludedHeadingIds);
      const cacheKey = `${record.snapshotId}\u0000${queryTermFingerprint}\u0000${excludedHeadingFingerprint}`;
      const cached = sectionRankResults.get(cacheKey);
      if (cached) return cached;
      const result = getSectionRanker(record).rankRelatedSections(queryTerms, new Set(excludedHeadingIds));
      sectionRankResults.set(cacheKey, result);
      return result;
    },
    findContentHeadingIdsByBlockIds: (noteId, blockIds) => {
      const record = getRecord(noteId);
      return getSectionRanker(record).findContentHeadingIdsByBlockIds(blockIds);
    },
    findDeepestHeadingIdAtLine: (noteId, line) => {
      const record = getRecord(noteId);
      if (!Number.isInteger(line) || line < 1 || line > record.localSnapshot.lineCount) throw new Error('章节锚点行号无效。');
      // Among all headings covering the line, the deepest (largest) level wins.
      // 在所有覆盖该行的标题中，取层级最深（level 最大）的一个。
      return [...record.localSnapshot.headings]
        .filter((heading) => heading.lineFrom <= line && heading.lineTo >= line)
        .sort((first, second) => second.level - first.level || second.lineFrom - first.lineFrom || first.headingId.localeCompare(second.headingId))[0]
        ?.headingId;
    },
    findAdjacentSection: (noteId, anchorHeadingId, direction) => {
      if (direction !== 'previous' && direction !== 'next') throw new Error('相邻章节方向无效。');
      const record = getRecord(noteId);
      const anchor = record.localSnapshot.headings.find((heading) => heading.headingId === anchorHeadingId);
      if (!anchor) throw new Error('证据章节锚点已不属于当前快照。');
      // Siblings share the same parent path and level; the anchor is located by id.
      // 同级章节共享同一父路径与层级；锚点通过 headingId 定位。
      const parentPath = anchor.path.slice(0, -1);
      const siblings = record.localSnapshot.headings
        .filter((heading) => heading.level === anchor.level && arraysEqual(heading.path.slice(0, -1), parentPath))
        .sort((first, second) => first.lineFrom - second.lineFrom || first.headingId.localeCompare(second.headingId));
      const anchorIndex = siblings.findIndex((heading) => heading.headingId === anchor.headingId);
      if (anchorIndex < 0) throw new Error('证据章节锚点无法映射到同级章节。');
      const adjacent = siblings[anchorIndex + (direction === 'previous' ? -1 : 1)];
      if (!adjacent) return undefined;
      return {
        noteId,
        snapshotId: record.snapshotId,
        contentHash: record.contentHash,
        headingId: adjacent.headingId,
        headingPath: [...adjacent.path],
        level: adjacent.level,
        lineFrom: adjacent.lineFrom,
        lineTo: adjacent.lineTo,
      };
    },
    readNoteRange: (noteId, input, limits) => readCurrentNoteRange(getRecord(noteId).localSnapshot, input, limits),
    readNoteSection: (noteId, input, limits) => readCurrentNoteSection(getRecord(noteId).localSnapshot, input, limits),
  };
}

/** Element-wise string array equality. / 逐元素比较字符串数组是否相等。 */
function arraysEqual(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}