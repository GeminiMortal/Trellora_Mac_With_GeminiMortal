/**
 * Local rule-based query expansion and expansion-round result merging.
 * Pure rules, zero model calls (inspired by the WeKnora expansion idea).
 * 本地规则式查询扩写与扩写轮次结果合并。纯规则实现，零模型调用（借鉴 WeKnora 扩写思想）。
 */
import { reciprocalRankFusion, type HybridChildFusion } from '../hybridRetrievalFusion.ts';

/**
 * Upper bound of fallback expansion variants; a v1 constant not exposed in settings.
 * 召回不足兜底扩写的变体上限；第一版常量，不进设置面板。
 */
export const QUERY_EXPANSION_MAX_VARIANTS = 5;

/** Chinese/English stopwords dropped before recombining query terms. / 重组查询词前需剔除的中英文停用词。 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '吗', '呢', '吧', '啊', '也', '都', '就', '并', '及', '对', '把', '被', '从', '到', '向', '给', '为', '以', '等', '这', '那', '有', '没有',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'about',
  'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whom', 'whose',
]);

// Long prefixes first so "什么是" is not truncated by "什么". / 长前缀优先，避免「什么是」被「什么」截断。
const QUESTION_WORD_PREFIXES = [
  '请告诉我', '我想知道', '我想了解', '请介绍', '什么是', '请问', '怎样', '怎么', '为什么', '何时', '何地', '哪个', '哪些', '介绍', '如何', '为何', '什么', '帮我', '谁',
];

/** Matches quoted phrases of 3+ chars across common quote styles. / 匹配多种引号风格中 3 字以上的引号短语。 */
const QUOTED_PHRASE_PATTERN = /["'"'「」『』《》]([^"'"'「」『』《》]{3,})["'"'「」『』《》]/g;
/** Splits composite questions on common delimiters. / 按常见分隔符拆分复合问题。 */
const DELIMITER_PATTERN = /[,，;；、。！？!?\s]+/;

/**
 * Result of local query expansion.
 * 本地查询扩写的结果。
 */
export interface QueryExpansionOutcome {
  variants: string[];   /** Deduplicated rewritten variants. / 去重后的改写变体。 */
  strategies: string[]; /** Names of the strategies that fired, for trace explanation. / 命中的策略名，供 trace 解释。 */
}

/**
 * Local rule expansion on insufficient recall (zero model calls):
 * ① join non-stopword terms; ② keep quoted phrases verbatim;
 * ③ strip question-word prefixes; ④ split on delimiters.
 * Merged, deduplicated and capped at QUERY_EXPANSION_MAX_VARIANTS; variants equal to the original are dropped.
 * 召回不足时的本地规则扩写（零模型调用）：
 * ① 分词去停用词重组；② 引号短语原样保留；③ 去疑问词前缀；④ 分隔符拆分。
 * 合并去重后取前 QUERY_EXPANSION_MAX_VARIANTS 条；与原文重复的变体一律剔除。
 *
 * @param query - Original user query. / 用户原始查询。
 * @param queryTerms - Optional pre-extracted terms for the rejoin strategy. / 可选的预提取词条，用于重组策略。
 * @returns Expanded variants and the strategy names that produced them. / 扩写出的变体及其产生策略名。
 */
export function expandQueriesLocally(query: string, queryTerms?: string[]): QueryExpansionOutcome {
  const original = query.trim();
  if (!original) return { variants: [], strategies: [] };
  // Seed `seen` with the original so it can never be echoed back as a variant. / 用原文初始化 `seen`，确保原文不会被当成变体回显。
  const seen = new Set<string>([original]);
  const variants: string[] = [];
  const strategies = new Set<string>();
  const push = (variant: string, strategy: string): void => {
    const text = variant.trim();
    if (!text || text.length > 120 || seen.has(text)) return;
    seen.add(text);
    variants.push(text);
    strategies.add(strategy);
  };

  // ① Term rejoin: drop stopwords and join with spaces to fit FTS token matching. / ① 分词重组：去停用词后用空格连接，贴合 FTS 词元匹配。
  const terms = (queryTerms ?? []).map((term) => term.trim()).filter((term) => term && !STOPWORDS.has(term.toLowerCase()));
  if (terms.length >= 2) push(terms.join(' '), 'term-join');

  // ② Quoted phrases: keep proper nouns / fixed wording verbatim. / ② 引号短语：专有名词/固定措辞按原文保留。
  for (const match of original.matchAll(QUOTED_PHRASE_PATTERN)) {
    if (match[1]) push(match[1], 'quoted-phrase');
  }

  // ③ Question-word strip: declarative variants cover both vector and lexical channels. / ③ 去疑问词前缀：让陈述式变体同时覆盖向量与词法通道。
  const stripped = removeQuestionWordPrefix(original);
  if (stripped && stripped !== original) push(stripped, 'question-word-strip');

  // ④ Delimiter split: break composite questions into standalone clauses. / ④ 分隔符拆分：复合问题拆成独立子句。
  const segments = original.split(DELIMITER_PATTERN).map((segment) => segment.trim()).filter((segment) => [...segment].length >= 2);
  if (segments.length >= 2) for (const segment of segments.slice(0, QUERY_EXPANSION_MAX_VARIANTS)) push(segment, 'delimiter-split');

  return { variants: variants.slice(0, QUERY_EXPANSION_MAX_VARIANTS), strategies: [...strategies] };
}

/** Removes the first matching question-word prefix, if any remains substantial. / 移除首个命中的疑问词前缀（若剩余部分足够长）。 */
function removeQuestionWordPrefix(query: string): string {
  for (const prefix of QUESTION_WORD_PREFIXES) {
    if (query.startsWith(prefix)) {
      const remainder = query.slice(prefix.length).trim();
      if ([...remainder].length >= 2) return remainder;
    }
  }
  return query;
}

/**
 * Merges first-round and expansion-round child hits: concatenates per-channel ranks
 * (first round first, then expansion rounds in order) and reruns canonical RRF, avoiding
 * direct score addition across calls with different rrf scales.
 * Field bodies keep the first-round row; expansion-only children keep their own row.
 * 首轮召回与扩写召回的子块合并：按「首轮优先、扩写轮次依次追加」拼接各通道名次后
 * 重走一次规范 RRF，避免跨调用 rrf 分值尺度差异直接相加。
 * 字段主体保留首轮行；扩写独有的子块使用自身行。
 *
 * @param firstRound - Children recalled in the first round. / 首轮召回的子块。
 * @param expansionRounds - Children recalled per expansion round. / 各扩写轮次召回的子块。
 * @returns Merged children re-scored by canonical RRF, sorted deterministically. / 经规范 RRF 重打分并确定性排序的合并子块。
 */
export function mergeRecalledChildren(firstRound: HybridChildFusion[], expansionRounds: HybridChildFusion[][]): HybridChildFusion[] {
  const rounds = [firstRound, ...expansionRounds];
  const byKey = new Map<string, HybridChildFusion>();
  // Build a cross-round ordered key list per channel: earlier rounds win the better rank. / 为每个通道构建跨轮次有序 key 列表：靠前轮次占据更优名次。
  const channelKeys = (channel: 'vector' | 'lexical'): string[] => {
    const ordered: string[] = [];
    const seenKeys = new Set<string>();
    for (const round of rounds) {
      const ranked = round
        .filter((child) => child.ranks?.[channel] !== undefined)
        .sort((first, second) => (first.ranks?.[channel] ?? 0) - (second.ranks?.[channel] ?? 0));
      for (const child of ranked) {
        const key = `${child.documentId}\u0000${child.chunkId}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        ordered.push(key);
      }
    }
    return ordered;
  };
  // Keep the first occurrence of each child as its canonical field row. / 每个子块的首次出现作为其规范字段行。
  for (const round of rounds) {
    for (const child of round) {
      const key = `${child.documentId}\u0000${child.chunkId}`;
      if (!byKey.has(key)) byKey.set(key, child);
    }
  }
  const fused = reciprocalRankFusion({ vectorKeys: channelKeys('vector'), lexicalKeys: channelKeys('lexical') });
  return [...byKey.entries()]
    .map(([key, child]) => {
      const entry = fused.get(key);
      return {
        ...child,
        score: Number((entry?.rrfScore ?? 0).toFixed(6)),
        rrfScore: Number((entry?.rrfScore ?? 0).toFixed(6)),
        ranks: {
          ...(entry?.vectorRank !== undefined ? { vector: entry.vectorRank } : {}),
          ...(entry?.lexicalRank !== undefined ? { lexical: entry.lexicalRank } : {}),
        },
      };
    })
    // Deterministic order: rrfScore desc, then documentId, then ordinal. / 确定性排序：rrfScore 降序，再按 documentId、ordinal。
    .sort((first, second) => second.rrfScore - first.rrfScore || first.documentId.localeCompare(second.documentId) || first.ordinal - second.ordinal);
}