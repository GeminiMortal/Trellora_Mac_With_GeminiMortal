/**
 * Keyword-based note search: candidate scoring and result packaging.
 * 基于关键词的笔记搜索：候选评分与结果打包。
 */

import type { LexicalMatchTrace } from './lexicalMatchPolicy';

/** A scored candidate before keyword method annotation. / 关键词方法标注前的评分候选。 */
export interface SearchCandidate {
  path: string;
  title: string;
  score: number;
  relativePath?: string;
  snippet?: string;
  heading?: string;
  searchTerm?: string;
  matchTrace?: LexicalMatchTrace[];
}

/** A keyword search result with method annotation. / 带方法标注的关键词搜索结果。 */
export interface KeywordSearchResult extends SearchCandidate {
  methods: ['keyword'];
}

/** Outcome envelope for a keyword search invocation. / 关键词搜索调用的结果信封。 */
export interface KeywordSearchOutcome {
  results: KeywordSearchResult[];
  mode: 'keyword' | 'none';
}

/**
 * Convert raw search candidates into a capped keyword search outcome.
 * 将原始搜索候选转换为有上限的关键词搜索结果。
 *
 * @param results - Scored candidate list / 已评分的候选列表
 * @param limit - Maximum results (clamped 1-40) / 最大返回数（限 1-40）
 * @returns Capped keyword search outcome / 有上限的关键词搜索结果
 */
export function createKeywordSearchOutcome(results: readonly SearchCandidate[], limit = 8): KeywordSearchOutcome {
  const limited = results.slice(0, Math.max(1, Math.min(40, limit))).map((result) => ({ ...result, methods: ['keyword'] as ['keyword'] }));
  return { results: limited, mode: limited.length ? 'keyword' : 'none' };
}
