/**
 * LexScore v2: in-house lexical scorer combining per-field BM25 (body/title/keyword), coverage gating and exact-match bonuses.
 * LexScore v2：自研词法打分器。分域 BM25（body/title/keyword）× 覆盖率门控 + 精确命中加成。
 */

/**
 * Tunable parameters of the LexScore v2 scorer.
 * LexScore v2 打分器的可调参数。
 */
export interface LexicalScorerParams {
  /** BM25 k1 for body terms. / 正文词项的 BM25 k1。 */
  k1Body: number;
  /** BM25 length-normalization b for body terms. / 正文词项的 BM25 长度归一化系数 b。 */
  bBody: number;
  /** BM25 k1 for title terms. / 标题词项的 BM25 k1。 */
  k1Title: number;
  /** BM25 length-normalization b for title terms. / 标题词项的 BM25 长度归一化系数 b。 */
  bTitle: number;
  /** BM25 k1 for keyword terms. / 关键词词项的 BM25 k1。 */
  k1Kw: number;
  /** BM25 length-normalization b for keyword terms. / 关键词词项的 BM25 长度归一化系数 b。 */
  bKw: number;
  /** Weight of the body BM25 channel. / 正文 BM25 通道权重。 */
  wBody: number;
  /** Weight of the title BM25 channel. / 标题 BM25 通道权重。 */
  wTitle: number;
  /** Weight of the keyword BM25 channel. / 关键词 BM25 通道权重。 */
  wKw: number;
  /** Coverage exponent: score ∝ coverage^gamma. / 覆盖率指数：score ∝ coverage^gamma。 */
  gamma: number;
  /** Multiplicative bonus when every query term matches. / 全部查询词命中时的乘法加成。 */
  fullMatchBonus: number;
  /** Additive bonus when the raw query hits the section title as a substring. / raw query 命中章节标题子串时的加法加成。 */
  titleExactBonus: number;
  /** Additive bonus when the raw query hits the body as a phrase substring. / raw query 命中正文子串（短语）时的加法加成。 */
  phraseBonus: number;
  /** Saturation constant: final = raw/(raw+kappa). / 饱和常数：final = raw/(raw+kappa)。 */
  kappa: number;
  /** Terms with df/N above this ratio are treated as stopwords and get idf 0. / df/N 超过该阈值的词视为止停词，idf 置 0。 */
  stopwordDfRatio: number;
}

/**
 * Default LexScore v2 parameter set used when no overrides are provided.
 * 未提供覆盖参数时使用的 LexScore v2 默认参数集。
 */
export const DEFAULT_LEXICAL_SCORER_PARAMS: LexicalScorerParams = {
  k1Body: 1.2,
  bBody: 0.75,
  k1Title: 1.2,
  bTitle: 0.3,
  k1Kw: 1.2,
  bKw: 0.5,
  wBody: 1.0,
  wTitle: 2.2,
  wKw: 1.6,
  gamma: 0.9,
  fullMatchBonus: 0.25,
  titleExactBonus: 0.15,
  phraseBonus: 0.1,
  kappa: 8,
  stopwordDfRatio: 0.85,
};

/**
 * Corpus-level statistics needed for BM25 length normalization.
 * BM25 长度归一化所需的语料级统计量。
 */
export interface LexicalCorpusStats {
  /** Number of documents (chunks) in the corpus. / 语料中的文档（切块）数量。 */
  docCount: number;
  /** Average body length across the corpus. / 语料平均正文长度。 */
  avgBodyLen: number;
  /** Average keyword-list length across the corpus. / 语料平均关键词列表长度。 */
  avgKwLen: number;
}

/**
 * Document frequencies of a term in the body and keyword channels.
 * 词项在正文与关键词两个通道中的文档频率。
 */
export interface LexicalTermDf {
  /** Document frequency in body text. / 正文中的文档频率。 */
  body: number;
  /** Document frequency in keyword lists. / 关键词列表中的文档频率。 */
  keyword: number;
}

/**
 * One scoring candidate carrying precomputed term frequencies and field texts.
 * 携带预计算词频与各字段文本的打分候选。
 */
export interface LexicalScorerCandidate {
  /** Identifier used to key the score result map. / 用于索引打分结果 Map 的标识。 */
  rowId: number;
  /** Term frequency map for the body field. / 正文字段的词频映射。 */
  bodyTf: Map<string, number>;
  /** Term frequency map for the keyword field. / 关键词字段的词频映射。 */
  kwTf: Map<string, number>;
  /** Body length used for BM25 normalization. / 用于 BM25 归一化的正文长度。 */
  bodyLen: number;
  /** Keyword-list length used for BM25 normalization. / 用于 BM25 归一化的关键词列表长度。 */
  kwLen: number;
  /** Concatenated section path text used for title-channel matching. / 用于标题通道匹配的章节路径拼接文本。 */
  sectionPathText: string;
  /** Full source text used for phrase-bonus matching. / 用于短语加成匹配的完整源文本。 */
  sourceText: string;
}

/**
 * Per-channel score breakdown for one candidate.
 * 单个候选的分通道得分明细。
 */
export interface LexicalScoreBreakdown {
  /** Body BM25 channel score. / 正文 BM25 通道得分。 */
  body: number;
  /** Title BM25 channel score. / 标题 BM25 通道得分。 */
  title: number;
  /** Keyword BM25 channel score. / 关键词 BM25 通道得分。 */
  keyword: number;
  /** Fraction of query terms matched. / 命中的查询词占比。 */
  coverage: number;
  /** Exact-match bonuses applied on top of the raw score. / 叠加在原始得分上的精确命中加成。 */
  bonus: number;
  /** Weighted score before saturation. / 饱和前的加权得分。 */
  raw: number;
  /** Final saturated score in [0, 1]. / 饱和后的最终得分，取值 [0, 1]。 */
  final: number;
}

// Robertson–Sparck Jones style IDF with an explicit stopword cutoff on df/N.
// Robertson–Sparck Jones 风格 IDF，并对 df/N 施加显式停用词截断。
function idf(docCount: number, df: number, stopwordDfRatio: number): number {
  if (docCount <= 0 || df <= 0) return 0;
  if (df / docCount > stopwordDfRatio) return 0;
  return Math.max(0, Math.log(1 + (docCount - df + 0.5) / (df + 0.5)));
}

// Single-term BM25 contribution; guards zero/absent lengths to keep the score finite.
// 单词项 BM25 贡献；对零长度/缺失长度做保护，保证得分有限。
function bm25Term(tf: number, dl: number, avgdl: number, k1: number, b: number, termIdf: number): number {
  if (tf <= 0 || termIdf <= 0) return 0;
  const safeAvgdl = avgdl > 0 ? avgdl : 1;
  const safeDl = dl > 0 ? dl : safeAvgdl;
  return termIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (safeDl / safeAvgdl)));
}

/**
 * Scores all candidates with LexScore v2 and returns a breakdown keyed by rowId.
 * 使用 LexScore v2 对全部候选打分，返回以 rowId 为键的得分明细。
 *
 * @param input - Scoring inputs / 打分输入
 * @param input.queryTerms - Normalized query terms / 归一化查询词项
 * @param input.rawQuery - Raw query string used for exact-match bonuses / 用于精确命中加成的原始查询串
 * @param input.corpus - Corpus-level statistics / 语料级统计量
 * @param input.termDf - Per-term document frequencies / 各词项文档频率
 * @param input.candidates - Candidates to score / 待打分候选
 * @param input.params - Optional parameter overrides / 可选参数覆盖
 * @returns Score breakdown per candidate rowId / 每个候选 rowId 的得分明细
 */
export function scoreLexicalCandidates(input: {
  queryTerms: string[];
  rawQuery: string;
  corpus: LexicalCorpusStats;
  termDf: Map<string, LexicalTermDf>;
  candidates: LexicalScorerCandidate[];
  params?: Partial<LexicalScorerParams>;
}): Map<number, LexicalScoreBreakdown> {
  const params = { ...DEFAULT_LEXICAL_SCORER_PARAMS, ...input.params };
  const terms = [...new Set(input.queryTerms.map((term) => term.trim()).filter(Boolean))];
  const result = new Map<number, LexicalScoreBreakdown>();
  if (terms.length === 0 || input.corpus.docCount <= 0) return result;
  const rawQuery = input.rawQuery.trim();

  for (const candidate of input.candidates) {
    let bodyScore = 0;
    let titleScore = 0;
    let kwScore = 0;
    let matched = 0;
    for (const term of terms) {
      const df = input.termDf.get(term) ?? { body: 0, keyword: 0 };
      const bodyIdf = idf(input.corpus.docCount, df.body, params.stopwordDfRatio);
      const kwIdf = idf(input.corpus.docCount, df.keyword, params.stopwordDfRatio);
      // Title channel reuses the body df (max 1) as a conservative fallback IDF.
      // 标题通道复用正文 df（至少取 1）作为保守的回退 IDF。
      const titleIdf = idf(input.corpus.docCount, Math.max(df.body, 1), params.stopwordDfRatio);
      const bodyTf = candidate.bodyTf.get(term) ?? 0;
      const kwTf = candidate.kwTf.get(term) ?? 0;
      const titleHit = candidate.sectionPathText.length > 0 && candidate.sectionPathText.includes(term);
      if (bodyTf > 0) bodyScore += bm25Term(bodyTf, candidate.bodyLen, input.corpus.avgBodyLen, params.k1Body, params.bBody, bodyIdf);
      if (titleHit) titleScore += bm25Term(1, input.corpus.avgBodyLen, input.corpus.avgBodyLen, params.k1Title, params.bTitle, titleIdf);
      if (kwTf > 0) kwScore += bm25Term(kwTf, candidate.kwLen, input.corpus.avgKwLen, params.k1Kw, params.bKw, kwIdf);
      if (bodyTf > 0 || kwTf > 0 || titleHit) matched += 1;
    }
    const coverage = matched / terms.length;
    if (coverage <= 0) {
      result.set(candidate.rowId, { body: 0, title: 0, keyword: 0, coverage: 0, bonus: 0, raw: 0, final: 0 });
      continue;
    }
    // Coverage gates the weighted channel sum; a full match additionally receives a multiplicative bonus.
    // 覆盖率对加权通道和进行门控；全部命中时额外获得乘法加成。
    const weighted = params.wBody * bodyScore + params.wTitle * titleScore + params.wKw * kwScore;
    const raw = weighted * Math.pow(coverage, params.gamma) * (coverage === 1 ? 1 + params.fullMatchBonus : 1);
    let bonus = 0;
    if (rawQuery.length >= 2) {
      if (candidate.sectionPathText.includes(rawQuery)) bonus += params.titleExactBonus;
      if (candidate.sourceText.includes(rawQuery)) bonus += params.phraseBonus;
    }
    // Saturate the raw score into [0, 1] and cap the sum with bonuses at 1.
    // 将原始得分饱和映射到 [0, 1]，含加成的总和封顶为 1。
    const final = Math.min(1, raw / (raw + params.kappa) + bonus);
    result.set(candidate.rowId, {
      body: Number(bodyScore.toFixed(6)),
      title: Number(titleScore.toFixed(6)),
      keyword: Number(kwScore.toFixed(6)),
      coverage: Number(coverage.toFixed(6)),
      bonus: Number(bonus.toFixed(6)),
      raw: Number(raw.toFixed(6)),
      final: Number(final.toFixed(6)),
    });
  }
  return result;
}
