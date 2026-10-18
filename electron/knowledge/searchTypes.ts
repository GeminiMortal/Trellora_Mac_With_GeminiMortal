/**
 * Unified search types shared by the knowledge panel search layer.
 * 统一搜索类型，供知识面板搜索层共用。
 */

import type { LexicalMatchTrace } from './lexicalMatchPolicy';

/** Search mode identifier / 搜索模式标识 */
export type UnifiedSearchMode = 'keyword';

/** A single result from the unified search pipeline. / 统一搜索管道返回的单条结果。 */
export interface UnifiedSearchResult {
  path: string;
  title: string;
  relativePath: string;
  snippet?: string;
  heading?: string;
  matchTypes: Array<'关键词'>;
  score: number;
  searchTerm?: string;
  matchTrace?: LexicalMatchTrace[];
}

/** Envelope for a completed unified search invocation. / 统一搜索调用完成后的结果信封。 */
export interface UnifiedSearchOutcome {
  results: UnifiedSearchResult[];
  mode: UnifiedSearchMode;
  used: '关键词搜索';
  notice?: string;
}
