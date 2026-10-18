/**
 * Conservative lexical evidence gate for zero-search Wiki answers.
 * 面向零检索 Wiki 终答的保守词法证据门控。
 */

import type { WikiActionKind } from './wikiQuickActions.ts';

/**
 * Result of the direct-evidence assessment for a candidate zero-search answer.
 * 直载证据评估结果，用于判断候选零检索终答是否可接受。
 */
export interface WikiDirectEvidenceAssessment {
  /** Whether the action/question must be grounded in evidence / 该动作/问题是否必须有证据支撑 */
  requiresEvidence: boolean;
  /** Whether the question is an overview/summary request / 问题是否为总览/总结类请求 */
  overviewRequest: boolean;
  /** Whether the loaded node text likely supports the answer / 直载节点正文是否可能支撑该回答 */
  likelySupported: boolean;
  /** Whether the candidate answer cites reference [0] / 候选终答是否标注了引用号 [0] */
  directCitationPresent: boolean;
  /** Whether the answer may end without any tool search / 是否允许不调用任何检索工具即收束 */
  acceptWithoutSearch: boolean;
  /** Distinctive terms extracted from the question / 从问题中提取的显著词项 */
  queryTerms: string[];
  /** Subset of queryTerms found in the loaded node / 在直载节点中命中的 queryTerms 子集 */
  matchedTerms: string[];
}

const NON_FACTUAL_PATTERN = /^(?:你好|您好|嗨|谢谢|感谢|辛苦了|再见|好的|明白了)[！!。.，,\s]*$/u;
const OVERVIEW_PATTERNS = [
  /(?:这篇|这份|这个|当前|该|本|这一|这)(?:文章|文档|章节|章|节|节点|部分).{0,12}(?:讲(?:了)?什么|说(?:了)?什么|主要(?:内容|讲)|核心内容|内容(?:是)?什么|关于什么|大意|主旨)/u,
  /(?:总结|概括|梳理|介绍)(?:一下|下)?(?:这篇|这份|这个|当前|该|本|这一|这)(?:文章|文档|章节|章|节|节点|部分)/u,
  /^(?:请|帮我|麻烦)?(?:简单|简要|详细)?(?:总结|概括|梳理|介绍)(?:一下|下)?[？?！!。.，,\s]*$/u,
];
const QUESTION_FILLERS = [
  '只根据本节回答', '只依据本节回答', '仅根据本节回答', '仅依据本节回答',
  '当前章节', '当前节点', '本章节', '本节', '本文', '全文', '整篇文档',
  '请问', '请说明', '请解释', '请回答', '回答', '是什么', '有什么', '是多少',
  '多少', '多久', '哪里', '哪一处', '怎么', '如何', '为何', '为什么', '呢',
  '吗', '会吗', '会不会',
  '的规定', '规定', '说明了', '说明', '相关内容', '内容',
];
const GENERIC_TERMS = new Set([
  '当前', '章节', '节点', '本节', '本文', '全文', '回答', '说明', '规定', '内容',
  '什么', '多少', '多久', '哪里', '怎么', '如何', '是否', '这个', '那个',
]);

/**
 * A conservative lexical gate for zero-search Wiki answers. It does not judge
 * semantic correctness; it only prevents a model from citing [0] when none of
 * the question's distinctive wording is present in the directly loaded node.
 * 面向零检索 Wiki 终答的保守词法门控。它不判断语义正确性，只防止模型在直载
 * 节点中不含问题任何显著措辞时仍引用 [0]。
 *
 * @param input - Question, loaded node markdown, candidate answer and action kind / 问题、直载节点正文、候选终答与快捷动作类型
 * @returns Evidence flags plus extracted and matched query terms / 证据标志位以及提取、命中的查询词项
 */
export function assessWikiDirectEvidence(input: {
  question: string;
  nodeMarkdown: string;
  answer: string;
  actionKind: WikiActionKind;
}): WikiDirectEvidenceAssessment {
  const question = input.question.trim();
  const requiresEvidence = input.actionKind !== 'free' || !NON_FACTUAL_PATTERN.test(question);
  const overviewRequest = OVERVIEW_PATTERNS.some((pattern) => pattern.test(question.normalize('NFKC')));
  const queryTerms = extractDistinctiveTerms(question);
  const normalizedNode = normalizeEvidenceText(input.nodeMarkdown);
  const matchedTerms = queryTerms.filter((term) => normalizedNode.includes(term));
  const exactCoreMatch = queryTerms.some((term) => term.length >= 4 && normalizedNode.includes(term));
  const chineseBigramTerms = queryTerms.filter((term) => /^[\p{Script=Han}]{2}$/u.test(term));
  const matchedChineseBigrams = chineseBigramTerms.filter((term) => normalizedNode.includes(term));
  // The source may say “原始文件” while the user asks about “原始文档”. A
  // broad match across several Chinese bigrams is strong enough for the direct
  // node, even when no single four-character phrase is identical.
  // 原文可能写“原始文件”而用户问“原始文档”。多个中文二字词的宽泛命中对直载
  // 节点已足够，即使没有任何单一四字短语完全一致。
  const broadChineseCoverage = matchedChineseBigrams.length >= 4
    && matchedChineseBigrams.length / Math.max(1, chineseBigramTerms.length) >= 0.35;
  const likelySupported = input.actionKind !== 'free'
    || (overviewRequest && normalizedNode.replace(/\s/gu, '').length > 0)
    || queryTerms.length === 0
    || exactCoreMatch
    || broadChineseCoverage
    || (matchedTerms.length >= 2 && matchedTerms.length / queryTerms.length >= 0.5);
  const directCitationPresent = input.answer.includes('[0]');
  return {
    requiresEvidence,
    overviewRequest,
    likelySupported,
    directCitationPresent,
    // Wiki factual/content requests are Agentic RAG tasks: direct node content
    // may support the answer, but it no longer bypasses the first evidence-tool
    // round. Pure non-factual conversation remains eligible for zero-tool exit.
    // Wiki 事实/内容类请求属于 Agentic RAG 任务：直载节点正文可以支撑回答，
    // 但不再豁免首轮证据工具调用。纯非事实寒暄仍可零工具收束。
    acceptWithoutSearch: !requiresEvidence,
    queryTerms,
    matchedTerms,
  };
}

/** Extract distinctive terms after stripping question fillers; Chinese tokens yield four-grams and bigrams. / 去除提问填充词后提取显著词项；中文词条再展开为四字词与二字词。 */
function extractDistinctiveTerms(value: string): string[] {
  let normalized = normalizeEvidenceText(value);
  for (const filler of QUESTION_FILLERS) normalized = normalized.replaceAll(normalizeEvidenceText(filler), ' ');
  const terms: string[] = [];
  for (const token of normalized.match(/[\p{Script=Han}A-Za-z0-9_.%-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 4 && !GENERIC_TERMS.has(token)) terms.push(token);
      // Long Chinese clauses used to be reduced to bigrams only. That made the
      // `exactCoreMatch` branch below unreachable for the most common Chinese
      // questions and rejected answers even when a distinctive four-character
      // phrase (for example “原始文档”) was present in the loaded node.
      // 过去长中文从句只被切成二字词，导致下方 `exactCoreMatch` 分支对最常见的
      // 中文问题永远不可达，即使直载节点中已有显著四字短语（如“原始文档”）也会误拒。
      for (let index = 0; index < token.length - 3; index += 1) {
        const fourGram = token.slice(index, index + 4);
        if (!GENERIC_TERMS.has(fourGram)) terms.push(fourGram);
      }
      for (let index = 0; index < token.length - 1; index += 1) {
        const bigram = token.slice(index, index + 2);
        if (!GENERIC_TERMS.has(bigram)) terms.push(bigram);
      }
    } else if (token.length >= 2) {
      terms.push(token);
    }
  }
  return [...new Set(terms.filter((term) => term.length >= 2))];
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{Letter}\p{Number}_.%-]+/gu, ' ');
}
