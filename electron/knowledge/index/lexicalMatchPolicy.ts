/**
 * Lexical matching policy shared by local keyword indexes: term normalization,
 * safe fuzzy matching rules and explainable match traces.
 * 本地词法索引共享的匹配策略：词条规范化、安全的模糊匹配规则与可解释匹配轨迹。
 */

/**
 * A kind of lexical match between a query term and an index term.
 * 查询词与索引词条之间的词法匹配类型。
 */
export type LexicalMatchType = 'exact' | 'prefix' | 'fuzzy' | 'alias';

/**
 * One explainable match trace entry describing how a query term matched.
 * 描述查询词如何命中的一条可解释匹配轨迹。
 */
export interface LexicalMatchTrace {
  queryTerm: string;    /** Normalized query term. / 规范化后的查询词。 */
  matchedTerm: string;  /** Normalized term returned by the index. / 索引返回的规范化词条。 */
  matchType: LexicalMatchType; /** How the two terms matched. / 两者的匹配方式。 */
  editDistance?: number;        /** Edit distance for fuzzy matches. / 模糊匹配时的编辑距离。 */
  confidence: number;           /** Confidence in [0, 1]. / 置信度，取值 [0, 1]。 */
}

/** Patterns identifying technical identifiers and value shapes that must avoid fuzzy matching. / 识别技术标识符与需规避模糊匹配的取值形态的正则。 */
const TECHNICAL_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_./:-]*$/u;
const PURE_NUMERIC_OR_VERSION_PATTERN = /^\d+(?:[._/-]\d+)*$/u;
const VERSION_PATTERN = /^v?\d+(?:\.\d+)+(?:[-+][a-z0-9.-]+)?$/u;
const DATE_PATTERN = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/u;
const NUMERIC_ID_PATTERN = /^[a-z]+[-_]\d+(?:[-_.]\d+)*$/u;
const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PATH_FRAGMENT_PATTERN = /^[a-z0-9._-]+(?:[\\/][a-z0-9._-]+)+$/u;
/** The single fuzzy edit-distance ratio used by local indexes. / 本地索引使用的唯一模糊编辑距离比例。 */
const FUZZY_RATIO = 0.2;

/**
 * Normalizes terms without removing separators that may be meaningful to an index.
 * 规范化词条，但不移除对索引可能有意义的分隔符。
 *
 * @param value - Raw term text. / 原始词条文本。
 * @returns NFKC-normalized, lowercased and trimmed term. / NFKC 规范化、转小写并去空白后的词条。
 */
export function normalizeTechnicalTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-Hans-CN').trim();
}

/**
 * Returns true only for an ASCII technical identifier, not a free-form phrase.
 * 仅对 ASCII 技术标识符返回 true，自由文本短语不命中。
 *
 * @param value - Candidate text. / 候选文本。
 * @returns Whether the value is a technical identifier. / 是否为技术标识符。
 */
export function isTechnicalIdentifier(value: string): boolean {
  return TECHNICAL_IDENTIFIER_PATTERN.test(normalizeTechnicalTerm(value));
}

/**
 * Numeric values, versions and dates must never enter the fuzzy path.
 * 数值、版本号与日期绝不能进入模糊匹配路径。
 *
 * @param value - Candidate text. / 候选文本。
 * @returns Whether the value looks like a number, version or date. / 是否形如数值、版本或日期。
 */
export function isNumericOrVersionLike(value: string): boolean {
  const normalized = normalizeTechnicalTerm(value).replace(/\s+/gu, '');
  if (!normalized) return false;
  if (PURE_NUMERIC_OR_VERSION_PATTERN.test(normalized)) return true;
  if (VERSION_PATTERN.test(normalized) || DATE_PATTERN.test(normalized)) return true;
  if (NUMERIC_ID_PATTERN.test(normalized) || UUID_PATTERN.test(normalized)) return true;
  if (PATH_FRAGMENT_PATTERN.test(normalized)) return true;
  // Compound forms such as "1.2.3" embedded in an otherwise literal token. / 形如嵌在字面量中的 "1.2.3" 复合形式。
  return /\d+(?:\.\d+){1,}/u.test(normalized) && /^[a-z0-9._:+-]+$/u.test(normalized);
}

/**
 * Short ASCII abbreviations are candidates, never silent spelling corrections.
 * 短 ASCII 缩写只作为候选项，绝不做静默拼写纠正。
 *
 * @param value - Candidate text. / 候选文本。
 * @returns Whether the value is a short technical abbreviation. / 是否为短技术缩写。
 */
export function isShortTechnicalAbbreviation(value: string): boolean {
  const normalized = normalizeTechnicalTerm(value).replace(/\s+/gu, '');
  return /^[a-z]{2,5}$/u.test(normalized);
}

/**
 * Used only to keep near-identical acronym variants explicitly uncertain.
 * 仅用于将近乎相同的缩写变体显式标记为不确定。
 *
 * @param query - Query term. / 查询词。
 * @param candidate - Candidate term. / 候选词。
 * @returns Whether the pair looks like a one-edit short identifier correction. / 该词对是否形如单编辑距离的短标识符纠正。
 */
export function isLikelyShortIdentifierCorrection(query: string, candidate: string): boolean {
  const normalizedQuery = normalizeTechnicalTerm(query).replace(/\s+/gu, '');
  const normalizedCandidate = normalizeTechnicalTerm(candidate).replace(/\s+/gu, '');
  if (!normalizedQuery || normalizedQuery === normalizedCandidate) return false;
  if (!isShortTechnicalAbbreviation(normalizedQuery) || !isShortTechnicalAbbreviation(normalizedCandidate)) return false;
  return boundedLevenshteinDistance(normalizedQuery, normalizedCandidate, 1) <= 1;
}

/**
 * Returns the only fuzzy threshold used by local lexical indexes.
 * 返回本地词法索引使用的唯一模糊匹配阈值。
 *
 * @param value - Query term. / 查询词。
 * @returns FUZZY_RATIO when the term may fuzzily match, otherwise 0. / 可模糊匹配时返回 FUZZY_RATIO，否则返回 0。
 */
export function resolveFuzzyRatio(value: string): number {
  const normalized = normalizeTechnicalTerm(value).replace(/\s+/gu, '');
  // Identifiers shorter than 6 chars or value-like terms stay exact-only. / 短于 6 字符的标识符或值类词条只允许精确匹配。
  if (!isTechnicalIdentifier(normalized) || isNumericOrVersionLike(normalized) || normalized.length < 6) return 0;
  return FUZZY_RATIO;
}

/**
 * Strictly rejects a numeric/version candidate that does not contain the full query.
 * 严格拒绝未完整包含查询串的数值/版本类候选。
 *
 * @param query - Query term. / 查询词。
 * @param candidateText - Candidate text from the index. / 索引返回的候选文本。
 * @returns Whether the candidate must be rejected as a numeric mismatch. / 是否应作为数值不匹配而拒绝该候选。
 */
export function rejectsNumericVersionMismatch(query: string, candidateText: string): boolean {
  const normalizedQuery = normalizeTechnicalTerm(query).replace(/\s+/gu, '');
  if (!isNumericOrVersionLike(normalizedQuery)) return false;
  const normalizedCandidate = normalizeTechnicalTerm(candidateText).replace(/\s+/gu, '');
  return !normalizedCandidate.includes(normalizedQuery);
}

/**
 * Builds explainable traces from the query terms and the terms returned by an index.
 * 基于查询词与索引返回的词条构建可解释匹配轨迹。
 *
 * @param queryTerms - Query terms to explain. / 待解释的查询词列表。
 * @param matchedTerms - Terms returned by the index. / 索引返回的命中词条。
 * @returns One trace per matched query term, best match first within each kind. / 每个命中查询词一条轨迹，同类型内取最优匹配。
 */
export function buildLexicalMatchTrace(
  queryTerms: readonly string[],
  matchedTerms: readonly string[],
): LexicalMatchTrace[] {
  const normalizedQueries = uniqueNormalized(queryTerms);
  const normalizedMatches = uniqueNormalized(matchedTerms);
  const traces: LexicalMatchTrace[] = [];

  for (const queryTerm of normalizedQueries) {
    // Exact match wins immediately with full confidence. / 精确匹配直接命中并给出满置信度。
    const exact = normalizedMatches.filter((term) => term === queryTerm);
    if (exact.length) {
      traces.push({ queryTerm, matchedTerm: exact[0], matchType: 'exact', confidence: 1 });
    }

    // Prefix matches keep the lowest code-point term for determinism. / 前缀匹配取码点最小的词条以保证确定性。
    const prefixes = normalizedMatches.filter((term) => term !== queryTerm && term.startsWith(queryTerm));
    if (prefixes.length) {
      const matchedTerm = [...prefixes].sort(compareCodePointStrings)[0];
      traces.push({ queryTerm, matchedTerm, matchType: 'prefix', confidence: 1 });
    }
    // Fuzzy matching is a last resort once exact/prefix hits exist. / 一旦有精确/前缀命中，就不再进入模糊兜底。
    if (exact.length || prefixes.length) {
      continue;
    }

    const ratio = resolveFuzzyRatio(queryTerm);
    if (ratio <= 0) continue;
    const maxDistance = Math.max(1, Math.round(queryTerm.length * ratio));
    // Keep only candidates within the bounded edit distance, sorted deterministically. / 只保留编辑距离以内的候选，并做确定性排序。
    const candidates = normalizedMatches
      .map((matchedTerm) => ({ matchedTerm, editDistance: boundedLevenshteinDistance(queryTerm, matchedTerm, maxDistance) }))
      .filter((candidate): candidate is { matchedTerm: string; editDistance: number } => candidate.editDistance <= maxDistance)
      .sort((first, second) => first.editDistance - second.editDistance || compareCodePointStrings(first.matchedTerm, second.matchedTerm));
    const best = candidates[0];
    if (best) {
      traces.push({
        queryTerm,
        matchedTerm: best.matchedTerm,
        matchType: 'fuzzy',
        editDistance: best.editDistance,
        // Confidence decays linearly with edit distance over the longer term. / 置信度随编辑距离在较长词条上按比例线性衰减。
        confidence: Number((1 - best.editDistance / Math.max(queryTerm.length, best.matchedTerm.length)).toFixed(4)),
      });
    }
  }

  return traces;
}

/**
 * Sort priority for lexical results; lower values are shown first.
 * 词法结果的排序优先级，值越小越靠前。
 *
 * @param traces - Match traces for one result. / 单条结果的匹配轨迹。
 * @returns Sort priority from 0 (best) to 4 (worst). / 排序优先级，0（最优）到 4（最差）。
 */
export function lexicalMatchPriority(traces: readonly LexicalMatchTrace[]): number {
  if (traces.some((trace) => trace.matchType === 'exact')) return 0;
  if (traces.some((trace) => trace.matchType === 'prefix')) return 1;
  if (traces.some((trace) => trace.matchType === 'alias')) return 2;
  if (traces.some((trace) => trace.matchType === 'fuzzy')) return 4;
  return 3;
}

/** Normalizes and deduplicates a list of terms. / 规范化并去重词条列表。 */
function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeTechnicalTerm(value).replace(/\s+/gu, '')).filter(Boolean))];
}

/** Bounded Levenshtein distance that aborts early once the row minimum exceeds the limit. / 带上限的 Levenshtein 距离，行最小值超限时提前终止。 */
function boundedLevenshteinDistance(left: string, right: string, maxDistance: number): number {
  // Length gap alone already proves the distance is out of range. / 仅长度差就足以证明距离超界。
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      // Classic DP recurrence: substitution / insertion / deletion. / 经典动态规划递推：替换 / 插入 / 删除。
      const substitution = previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]);
      const insertion = current[rightIndex - 1] + 1;
      const deletion = previous[rightIndex] + 1;
      const distance = Math.min(substitution, insertion, deletion);
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    // Early exit keeps long terms cheap to compare. / 提前退出使长词条比较保持低成本。
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length];
}

/** Compares strings by code points for deterministic ordering. / 按码点比较字符串，保证排序确定性。 */
function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0) ?? 0);
  const rightPoints = [...right].map((character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}