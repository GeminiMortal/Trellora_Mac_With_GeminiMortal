/**
 * Tool surface for the current-note agent: note map, lexical search paging,
 * and bounded original-text reads over one immutable snapshot.
 * 面向当前笔记 Agent 的工具面：笔记地图、词法搜索分页，以及对单个不可变快照的有界原文读取。
 */
import { randomBytes } from 'node:crypto';
import { getCurrentNoteSnapshotBlock, type CurrentNoteSnapshot } from './currentNoteSnapshot.ts';
import {
  CURRENT_NOTE_SEARCH_SORT_VERSION,
  CurrentNoteLexicalIndex,
  normalizeCurrentNoteSearchQuery,
  type CurrentNoteSearchHit,
  type CurrentNoteSearchScopeInput,
} from './currentNoteLexicalIndex.ts';
import type { CurrentNoteScopeMode } from './currentNoteSearchScope.ts';
import { SEARCH_QUERY_TERM_BATCH_SIZE } from '../search/searchPlanTypes.ts';
import { readMarkdownLineRange } from './currentNoteStructure.ts';
import { estimateTokenCount } from '../model/tokenEstimator.ts';

/**
 * Detail level requested from the note map tool.
 * 笔记地图工具请求的详情级别。
 */
export type CurrentNoteMapDetail = 'outline' | 'stats' | 'terms';

/**
 * Structural map of the current note for agent navigation.
 * 供 Agent 导航使用的当前笔记结构地图。
 */
export interface CurrentNoteMap {
  snapshotId: string;
  title: string;
  lineCount: number;
  detail: CurrentNoteMapDetail;
  /** Flattened heading table with line spans and block counts. 展平的标题表，含行范围与块计数。 */
  headings: Array<{
    headingId: string;
    level: number;
    text: string;
    path: string[];
    lineFrom: number;
    lineTo: number;
    blockCount: number;
  }>;
  /** Per-kind block counts when detail is `stats`. detail 为 `stats` 时的按类型块计数。 */
  structureCounts?: Record<string, number>;
  /** Highest-frequency normalized terms when detail is `terms`. detail 为 `terms` 时的高频规范化词。 */
  topTerms?: string[];
}

/**
 * Result of a bounded line-range read over the snapshot.
 * 对快照进行有界行范围读取的结果。
 */
export interface CurrentNoteRangeRead {
  snapshotId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  /** Caller-requested span before block expansion. 块扩展前调用方请求的范围。 */
  requestedLineFrom: number;
  /** Caller-requested span before block expansion. 块扩展前调用方请求的范围。 */
  requestedLineTo: number;
  /** Blocks overlapping the returned range. 与返回范围重叠的块。 */
  blockIds: string[];
  text: string;
  /** Next start line when text remains unread. 仍有未读文本时的下一起始行。 */
  nextCursor?: number;
}

/**
 * Result of a paged named-section read over the snapshot.
 * 对快照进行分页命名章节读取的结果。
 */
export interface CurrentNoteSectionRead {
  snapshotId: string;
  headingId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  /** Blocks overlapping the returned range. 与返回范围重叠的块。 */
  blockIds: string[];
  text: string;
  /** Next start line when text remains unread. 仍有未读文本时的下一起始行。 */
  nextCursor?: number;
}

/**
 * One page of current-note search hits with an opaque continuation cursor.
 * 当前笔记搜索命中的一页结果及不透明续传游标。
 */
export interface CurrentNoteSearchPage {
  snapshotId: string;
  hits: CurrentNoteSearchHit[];
  /** Opaque cursor token issued by the main process. 主进程签发的不透明游标令牌。 */
  nextCursor?: string;
  /** True when no further candidates remain. 已无更多候选时为 true。 */
  candidateExhausted: boolean;
}

const MAX_SEARCH_TERMS = SEARCH_QUERY_TERM_BATCH_SIZE;
const MAX_SEARCH_TERM_CHARS = 80;
const MAX_SEARCH_HITS = 20;
const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 8_000;
const MAX_SECTION_CHARS = 12_000;
const MAX_SEARCH_CURSOR_LENGTH = 160;
const MAX_SEARCH_CURSOR_STORE = 256;

interface CurrentNoteSearchCursorPayload {
  snapshotId: string;
  normalizedQuery: string;
  scopeMode: CurrentNoteScopeMode;
  scopeFingerprint: string;
  sortVersion: string;
  offset: number;
}

/**
 * Main-process map holding issued search-cursor payloads by token.
 * 主进程按令牌保存已签发搜索游标载荷的映射。
 */
export type CurrentNoteSearchCursorStore = Map<string, CurrentNoteSearchCursorPayload>;

const defaultSearchCursorStore: CurrentNoteSearchCursorStore = new Map();

/** Maximum number of terms accepted by one lexical search call. 单次词法搜索调用可接受的最大词数。 */
export const CURRENT_NOTE_SEARCH_TERM_LIMIT = MAX_SEARCH_TERMS;

/**
 * Materialized original-text block behind a lexical hit.
 * 词法命中对应的物化原文块。
 */
export interface CurrentNoteSearchHitOriginal {
  snapshotId: string;
  blockId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  /** Full original block text, never a snippet. 完整原始块文本，绝非摘要。 */
  text: string;
}

/**
 * Internal controller limits. They are never included in model-visible tool arguments.
 * 内部控制器限额，绝不出现在模型可见的工具参数中。
 */
export interface CurrentNoteReadLimits {
  maxTokens?: number;
  maxChars?: number;
  maxLines?: number;
}

/**
 * Builds the structural note map at the requested detail level.
 * 按请求的详情级别构建结构笔记地图。
 *
 * @param snapshot - Snapshot to describe / 要描述的快照
 * @param detail - Detail level, defaults to `outline` / 详情级别，默认 `outline`
 * @returns Note map / 笔记地图
 */
export function getCurrentNoteMap(snapshot: CurrentNoteSnapshot, detail: CurrentNoteMapDetail = 'outline'): CurrentNoteMap {
  const headings = snapshot.headings.map((heading) => ({
    headingId: heading.headingId,
    level: heading.level,
    text: heading.text,
    path: [...heading.path],
    lineFrom: heading.lineFrom,
    lineTo: heading.lineTo,
    blockCount: snapshot.blocks.filter((block) => block.lineFrom >= heading.lineFrom && block.lineTo <= heading.lineTo).length,
  }));
  const result: CurrentNoteMap = { snapshotId: snapshot.snapshotId, title: snapshot.title, lineCount: snapshot.lineCount, detail, headings };
  if (detail === 'stats') result.structureCounts = countStructures(snapshot);
  if (detail === 'terms') result.topTerms = getTopTerms(snapshot);
  return result;
}

/**
 * Runs a legacy non-paged lexical search over the snapshot index.
 * 在快照索引上执行旧式非分页词法搜索。
 *
 * @param index - Lexical index bound to the snapshot / 绑定到该快照的词法索引
 * @param terms - Raw search terms / 原始搜索词
 * @param limit - Maximum hits, 1..20, defaults to 8 / 最大命中数，1..20，默认 8
 * @param scope - Optional scope enabling the second-stage rerank / 可选范围，启用二阶段重排
 * @returns Ordered search hits / 有序的搜索命中结果
 */
export function searchCurrentNote(index: CurrentNoteLexicalIndex, terms: readonly string[], limit = 8, scope?: CurrentNoteSearchScopeInput): CurrentNoteSearchHit[] {
  const normalizedTerms = normalizeSearchTerms(terms);
  assertSearchLimit(limit);
  return index.search(normalizedTerms.join(' '), limit, scope);
}

/**
 * Materializes the complete block represented by a lexical hit. The hit is
 * only a locator; snippets are deliberately never admitted as evidence.
 * 将词法命中所代表的完整块物化出来。命中只是定位符；
 * 摘要片段被刻意禁止作为证据进入。
 *
 * @param snapshot - Snapshot the hit belongs to / 命中所属的快照
 * @param hit - Lexical hit to materialize / 要物化的词法命中
 * @returns Original-text block backing the hit / 支撑该命中的原文块
 */
export function materializeCurrentNoteSearchHit(snapshot: CurrentNoteSnapshot, hit: CurrentNoteSearchHit): CurrentNoteSearchHitOriginal {
  const block = getCurrentNoteSnapshotBlock(snapshot, hit.blockId);
  if (!block || block.lineFrom !== hit.lineFrom || block.lineTo !== hit.lineTo) {
    throw new Error('搜索命中无法映射到当前笔记快照原文。');
  }
  const text = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, block.lineFrom, block.lineTo);
  if (text !== block.text) throw new Error('搜索命中对应的当前快照原文不一致。');
  return {
    snapshotId: snapshot.snapshotId,
    blockId: block.blockId,
    headingPath: [...block.headingPath],
    lineFrom: block.lineFrom,
    lineTo: block.lineTo,
    text,
  };
}

/**
 * Validates an entire hit page before any caller admits it to a Ledger.
 * 在调用方将命中页写入台账之前校验整页命中。
 *
 * @param snapshot - Snapshot the hits belong to / 命中所属的快照
 * @param hits - Hits to materialize / 要物化的命中
 * @returns Materialized original blocks / 物化后的原文块
 */
export function materializeCurrentNoteSearchHits(
  snapshot: CurrentNoteSnapshot,
  hits: readonly CurrentNoteSearchHit[],
): CurrentNoteSearchHitOriginal[] {
  return hits.map((hit) => materializeCurrentNoteSearchHit(snapshot, hit));
}

/**
 * Mechanical batching only; it does not normalize or rewrite query terms.
 * 仅做机械分批，不规范化也不改写查询词。
 *
 * @param terms - Query terms to batch / 要分批的查询词
 * @param maxTerms - Terms per batch, defaults to the term limit / 每批词数，默认为词数上限
 * @returns Ordered deduplicated batches / 有序去重后的批次
 */
export function batchCurrentNoteSearchTerms(
  terms: readonly string[],
  maxTerms = CURRENT_NOTE_SEARCH_TERM_LIMIT,
): string[][] {
  if (!Number.isInteger(maxTerms) || maxTerms < 1) throw new Error('搜索词批次上限无效。');
  const ordered = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  const batches: string[][] = [];
  for (let index = 0; index < ordered.length; index += maxTerms) batches.push(ordered.slice(index, index + maxTerms));
  return batches;
}

/**
 * Plan-only paging API. The cursor is intentionally an opaque main-process
 * token; its bound payload never crosses the renderer/model boundary.
 * 仅供 Plan 使用的分页 API。游标刻意设计为不透明的主进程令牌；
 * 其绑定载荷永远不会跨越渲染进程/模型边界。
 *
 * @param index - Lexical index bound to the snapshot / 绑定到该快照的词法索引
 * @param terms - Raw search terms / 原始搜索词
 * @param limit - Page size, 1..20, defaults to 8 / 每页命中数，1..20，默认 8
 * @param cursor - Opaque cursor from a previous page / 上一页返回的不透明游标
 * @param scope - Optional scope enabling the second-stage rerank / 可选范围，启用二阶段重排
 * @param cursorStore - Cursor store backing the tokens / 支撑游标令牌的存储
 * @returns One search page with optional continuation cursor / 一页搜索结果及可选续传游标
 */
export function searchCurrentNotePage(
  index: CurrentNoteLexicalIndex,
  terms: readonly string[],
  limit = 8,
  cursor?: string,
  scope?: CurrentNoteSearchScopeInput,
  cursorStore: CurrentNoteSearchCursorStore = defaultSearchCursorStore,
): CurrentNoteSearchPage {
  const normalizedTerms = normalizeSearchTerms(terms);
  assertSearchLimit(limit);
  const normalizedQuery = normalizeCurrentNoteSearchQuery(normalizedTerms.join(' '));
  const scopeBinding = getSearchCursorScopeBinding(scope);
  let offset = 0;
  let consumedCursor: string | undefined;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_SEARCH_CURSOR_LENGTH) {
      throw new Error('search_note cursor 无效。');
    }
    const payload = cursorStore.get(cursor);
    if (!payload) throw new Error('search_note cursor 不是主进程发出的 nextCursor。');
    // Cursor reuse is only valid against the exact same snapshot, normalized
    // query, scope fingerprint and sort version; anything else is rejected.
    // 游标只能在完全相同的快照、规范化查询、范围指纹与排序版本下复用，否则一律拒绝。
    if (payload.snapshotId !== index.snapshotId
      || payload.normalizedQuery !== normalizedQuery
      || payload.scopeMode !== scopeBinding.mode
      || payload.scopeFingerprint !== scopeBinding.fingerprint
      || payload.sortVersion !== CURRENT_NOTE_SEARCH_SORT_VERSION) {
      throw new Error('search_note cursor 与当前快照、查询、范围或排序版本不匹配。');
    }
    offset = payload.offset;
    consumedCursor = cursor;
  }
  const page = index.searchPage(normalizedTerms.join(' '), limit, offset, scope);
  const candidateExhausted = offset + page.hits.length >= page.total;
  const nextCursor = candidateExhausted
    ? undefined
    : issueSearchCursor(cursorStore, {
      snapshotId: index.snapshotId,
      normalizedQuery,
      scopeMode: scopeBinding.mode,
      scopeFingerprint: scopeBinding.fingerprint,
      sortVersion: CURRENT_NOTE_SEARCH_SORT_VERSION,
      offset: offset + page.hits.length,
    });
  if (consumedCursor) cursorStore.delete(consumedCursor);
  return {
    snapshotId: index.snapshotId,
    hits: page.hits,
    ...(nextCursor ? { nextCursor } : {}),
    candidateExhausted,
  };
}

/**
 * Reads an inclusive line range, expanding to whole blocks and paging by limits.
 * 读取闭区间行范围，扩展到完整块并按限额分页。
 *
 * @param snapshot - Snapshot to read / 要读取的快照
 * @param input - Requested line range / 请求的行范围
 * @param limits - Optional internal read limits / 可选的内部读取限额
 * @returns Bounded range read, possibly with a continuation cursor / 有界范围读取结果，可能带续传游标
 */
export function readCurrentNoteRange(snapshot: CurrentNoteSnapshot, input: { lineFrom: number; lineTo: number }, limits: CurrentNoteReadLimits = {}): CurrentNoteRangeRead {
  assertLineRange(snapshot, input.lineFrom, input.lineTo);
  const overlappingBlocks = snapshot.blocks.filter((block) => block.lineFrom <= input.lineTo && block.lineTo >= input.lineFrom);
  // Expand the request to whole overlapping blocks so evidence never starts
  // or ends mid-block; the expansion is capped by MAX_READ_LINES.
  // 将请求扩展到完整重叠块，保证证据不会从块中间截断；扩展受 MAX_READ_LINES 限制。
  const fullLineFrom = overlappingBlocks.length ? Math.min(...overlappingBlocks.map((block) => block.lineFrom)) : input.lineFrom;
  const fullLineTo = overlappingBlocks.length ? Math.max(...overlappingBlocks.map((block) => block.lineTo)) : input.lineTo;
  if (fullLineTo - fullLineFrom + 1 > MAX_READ_LINES) throw new Error(`扩展后的读取范围不能超过 ${MAX_READ_LINES} 行。`);
  const page = findBoundedPage(snapshot, fullLineFrom, fullLineTo, limits, MAX_READ_CHARS, MAX_READ_LINES);
  const lineFrom = page.lineFrom;
  const lineTo = page.lineTo;
  const text = page.text;
  const headingPath = overlappingBlocks[0]?.headingPath ?? getHeadingPath(snapshot, lineFrom);
  return {
    snapshotId: snapshot.snapshotId,
    headingPath: [...headingPath],
    lineFrom,
    lineTo,
    requestedLineFrom: input.lineFrom,
    requestedLineTo: input.lineTo,
    blockIds: snapshot.blocks.filter((block) => block.lineFrom <= lineTo && block.lineTo >= lineFrom).map((block) => block.blockId),
    text,
    ...(lineTo < fullLineTo ? { nextCursor: lineTo + 1 } : {}),
  };
}

/**
 * Reads only a named section of the immutable snapshot, optionally page by page.
 * 只读取不可变快照中的命名章节，可选地按页读取。
 *
 * @param snapshot - Snapshot to read / 要读取的快照
 * @param input - Section id plus optional start cursor / 章节 id 及可选起始游标
 * @param limits - Optional internal read limits / 可选的内部读取限额
 * @returns Section read page, possibly with a continuation cursor / 章节读取页，可能带续传游标
 */
export function readCurrentNoteSection(snapshot: CurrentNoteSnapshot, input: { headingId: string; cursor?: number }, limits: CurrentNoteReadLimits = {}): CurrentNoteSectionRead {
  const headingId = input.headingId.trim();
  const heading = snapshot.headings.find((entry) => entry.headingId === headingId);
  if (!heading) throw new Error('章节标识无效。');
  const lineFrom = input.cursor ?? heading.lineFrom;
  if (!Number.isInteger(lineFrom) || lineFrom < heading.lineFrom || lineFrom > heading.lineTo) throw new Error('章节游标无效。');
  const lineTo = findSectionPageEnd(snapshot, lineFrom, heading.lineTo, limits);
  const text = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, lineTo);
  const blockIds = snapshot.blocks
    .filter((block) => block.lineFrom <= lineTo && block.lineTo >= lineFrom)
    .map((block) => block.blockId);
  return {
    snapshotId: snapshot.snapshotId,
    headingId,
    headingPath: [...heading.path],
    lineFrom,
    lineTo,
    blockIds,
    text,
    ...(lineTo < heading.lineTo ? { nextCursor: lineTo + 1 } : {}),
  };
}

/**
 * Binds map/search/read tools to one snapshot and a private cursor store.
 * 将地图/搜索/读取工具绑定到单个快照与私有游标存储。
 *
 * @param snapshot - Immutable snapshot the tools operate on / 工具操作的不可变快照
 * @returns Tool object for the agent surface / 供 Agent 工具面使用的工具对象
 */
export function createCurrentNoteTools(snapshot: CurrentNoteSnapshot): {
  getNoteMap: (detail?: CurrentNoteMapDetail) => CurrentNoteMap;
  searchNote: (terms: readonly string[], limit?: number, scope?: CurrentNoteSearchScopeInput) => CurrentNoteSearchHit[];
  searchNotePage: (terms: readonly string[], limit?: number, cursor?: string, scope?: CurrentNoteSearchScopeInput) => CurrentNoteSearchPage;
  readNoteRange: (input: { lineFrom: number; lineTo: number }, limits?: CurrentNoteReadLimits) => CurrentNoteRangeRead;
  readNoteSection: (input: { headingId: string; cursor?: number }, limits?: CurrentNoteReadLimits) => CurrentNoteSectionRead;
} {
  const index = new CurrentNoteLexicalIndex(snapshot);
  const cursorStore: CurrentNoteSearchCursorStore = new Map();
  return {
    getNoteMap: (detail = 'outline') => getCurrentNoteMap(snapshot, detail),
    searchNote: (terms, limit = 8, scope) => searchCurrentNote(index, terms, limit, scope),
    searchNotePage: (terms, limit = 8, cursor, scope) => searchCurrentNotePage(index, terms, limit, cursor, scope, cursorStore),
    readNoteRange: (input, limits) => readCurrentNoteRange(snapshot, input, limits),
    readNoteSection: (input, limits) => readCurrentNoteSection(snapshot, input, limits),
  };
}

function assertSearchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_HITS) throw new Error(`搜索命中数必须在 1 到 ${MAX_SEARCH_HITS} 之间。`);
}

function getSearchCursorScopeBinding(scope?: CurrentNoteSearchScopeInput): { mode: CurrentNoteScopeMode; fingerprint: string } {
  const mode = typeof scope === 'string' ? scope : scope?.mode ?? 'focused';
  const targetTopic = typeof scope === 'string' ? '' : normalizeCurrentNoteSearchQuery(scope?.targetTopic ?? '');
  const targetAspects = typeof scope === 'string'
    ? []
    : [...(scope?.targetAspects ?? [])].map((aspect) => normalizeCurrentNoteSearchQuery(aspect)).filter(Boolean).sort();
  return { mode, fingerprint: JSON.stringify({ targetTopic, targetAspects }) };
}

function issueSearchCursor(store: CurrentNoteSearchCursorStore, payload: CurrentNoteSearchCursorPayload): string {
  let token = '';
  do {
    token = `search-cursor-${randomBytes(18).toString('base64url')}`;
  } while (store.has(token));
  store.set(token, payload);
  // Insertion-ordered Map eviction drops the oldest cursors beyond the cap.
  // 利用 Map 的插入顺序淘汰超出上限的最早游标。
  while (store.size > MAX_SEARCH_CURSOR_STORE) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
  return token;
}

function normalizeSearchTerms(terms: readonly string[]): string[] {
  if (!Array.isArray(terms) || terms.length === 0 || terms.length > MAX_SEARCH_TERMS) {
    throw new Error(`搜索词数量必须在 1 到 ${MAX_SEARCH_TERMS} 个之间。`);
  }
  const values = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error('搜索词不能为空。');
  for (const term of values) {
    if (term.length < 2 || term.length > MAX_SEARCH_TERM_CHARS) throw new Error(`每个搜索词必须在 2 到 ${MAX_SEARCH_TERM_CHARS} 个字符之间。`);
  }
  return values;
}

function assertLineRange(snapshot: CurrentNoteSnapshot, lineFrom: number, lineTo: number): void {
  if (!Number.isInteger(lineFrom) || !Number.isInteger(lineTo) || lineFrom < 1 || lineTo < lineFrom || lineTo > snapshot.lineCount) {
    throw new Error('读取行范围无效。');
  }
  if (lineTo - lineFrom + 1 > MAX_READ_LINES) throw new Error(`单次最多读取 ${MAX_READ_LINES} 行。`);
}

function countStructures(snapshot: CurrentNoteSnapshot): Record<string, number> {
  return Object.fromEntries(snapshot.blocks.reduce((counts, block) => {
    counts.set(block.kind, (counts.get(block.kind) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()));
}

function getTopTerms(snapshot: CurrentNoteSnapshot): string[] {
  const counts = new Map<string, number>();
  for (const block of snapshot.blocks) {
    for (const term of block.normalizedTerms) {
      if (term.length < 2) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'zh-Hans-CN'))
    .slice(0, 20)
    .map(([term]) => term);
}

function getHeadingPath(snapshot: CurrentNoteSnapshot, line: number): string[] {
  let match: CurrentNoteSnapshot['headings'][number] | undefined;
  for (const heading of snapshot.headings) {
    if (heading.lineFrom > line) break;
    if (heading.lineTo >= line) match = heading;
  }
  return match ? [...match.path] : [];
}

function findSectionPageEnd(snapshot: CurrentNoteSnapshot, lineFrom: number, maxLine: number, limits: CurrentNoteReadLimits): number {
  const maxChars = Math.min(MAX_SECTION_CHARS, positiveLimit(limits.maxChars, MAX_SECTION_CHARS));
  const maxTokens = positiveLimit(limits.maxTokens, Number.MAX_SAFE_INTEGER);
  const maxLines = Math.min(MAX_READ_LINES, positiveLimit(limits.maxLines, MAX_READ_LINES));
  const boundedMaxLine = Math.min(maxLine, lineFrom + maxLines - 1);
  // Grow the page line by line until a char/token/line limit would be exceeded.
  // 逐行扩展页面，直到字符/词元/行数限额将被超出为止。
  let lineTo = lineFrom;
  for (let line = lineFrom; line <= boundedMaxLine; line += 1) {
    const candidate = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, line);
    if (candidate.length > maxChars || estimateTokenCount(candidate) > maxTokens) {
      if (line === lineFrom) throw new Error(`章节单行不能超过 ${MAX_SECTION_CHARS} 个字符。`);
      break;
    }
    lineTo = line;
  }
  return lineTo;
}

function findBoundedPage(
  snapshot: CurrentNoteSnapshot,
  lineFrom: number,
  fullLineTo: number,
  limits: CurrentNoteReadLimits,
  defaultMaxChars: number,
  defaultMaxLines: number,
): { lineFrom: number; lineTo: number; text: string } {
  const maxChars = Math.min(defaultMaxChars, positiveLimit(limits.maxChars, defaultMaxChars));
  const maxTokens = positiveLimit(limits.maxTokens, Number.MAX_SAFE_INTEGER);
  const maxLines = Math.min(defaultMaxLines, positiveLimit(limits.maxLines, defaultMaxLines));
  const boundedMaxLine = Math.min(fullLineTo, lineFrom + maxLines - 1);
  // Same incremental line-growth algorithm as findSectionPageEnd.
  // 与 findSectionPageEnd 相同的逐行增长算法。
  let lineTo = lineFrom;
  for (let line = lineFrom; line <= boundedMaxLine; line += 1) {
    const candidate = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, line);
    if (candidate.length > maxChars || estimateTokenCount(candidate) > maxTokens) {
      if (line === lineFrom) throw new Error('单行原文超过当前主进程读取额度。');
      break;
    }
    lineTo = line;
  }
  return { lineFrom, lineTo, text: readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, lineTo) };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
