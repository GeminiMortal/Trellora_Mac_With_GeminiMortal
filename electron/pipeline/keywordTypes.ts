/**
 * Shared contract types and schema versions for the keyword extraction stage.
 * 关键词抽取阶段的共享契约类型与 schema 版本定义。
 */

/**
 * Schema version of the keyword-stage input/output contract.
 * 关键词阶段输入/输出契约的 schema 版本。
 */
export const KEYWORD_CONTRACT_SCHEMA_VERSION = 1;

/**
 * Schema version of the keyword-stage output payload written to artifacts.
 * 写入阶段产物的关键词输出载荷的 schema 版本。
 */
export const KEYWORD_OUTPUT_SCHEMA_VERSION = 3;

/**
 * Version identifier of the baseline keyword extraction algorithm.
 * 基线关键词抽取算法的版本标识。
 */
export const KEYWORD_BASELINE_ALGORITHM_VERSION = 'kw-baseline-1';

/**
 * One chunk of a material document handed to the keyword extractor.
 * 交给关键词抽取器的资料文档单个切块。
 */
export interface KeywordChunkInput {
  /** Contract schema version of this input record. / 本输入记录的契约 schema 版本。 */
  schemaVersion: number;
  /** Owning document identifier. / 所属文档标识。 */
  documentId: string;
  /** Unique chunk identifier within the document. / 文档内唯一切块标识。 */
  chunkId: string;
  /** Parent chunk identifier, or null for top-level chunks. / 父切块标识，顶层切块为 null。 */
  parentChunkId: string | null;
  /** Whether this chunk comes from a legacy flat (non-parent/child) layout. / 是否来自旧版扁平（非父子）切块布局。 */
  legacyFlatChunk?: boolean;
  /** Stable ordinal of the chunk inside the document. / 切块在文档内的稳定序号。 */
  ordinal: number;
  /** Raw chunk text used for keyword extraction. / 用于关键词抽取的切块原文。 */
  text: string;
  /** Ordered structural section path from the document root to this chunk. / 从文档根到该切块的有序结构路径。 */
  sectionPath: readonly Record<string, unknown>[];
  /** Structure-tree node identifiers covering this chunk. / 覆盖该切块的结构树节点标识。 */
  nodeIds: readonly string[];
  /** Source references pointing back to original document locations. / 指回原始文档位置的来源引用。 */
  sourceRefs: readonly Record<string, unknown>[];
  /** Chunk this chunk overlaps with, or null when there is no overlap. / 本切块与之重叠的切块，无重叠时为 null。 */
  overlapFromChunkId: string | null;
  /** Number of overlapping characters with the previous chunk. / 与前一切块的重叠字符数。 */
  overlapChars: number;
}

/**
 * A single matched occurrence of a keyword inside the chunk text.
 * 关键词在切块文本中的一次命中位置。
 */
export interface KeywordOccurrence {
  /** Start offset of the match in the chunk text. / 命中在切块文本中的起始偏移。 */
  start: number;
  /** End offset (exclusive) of the match in the chunk text. / 命中在切块文本中的结束偏移（不含）。 */
  end: number;
  /** Index of the sentence containing the match. / 命中所在句子的序号。 */
  sentenceIndex: number;
}

/**
 * Numeric features explaining why a candidate keyword was scored as it was.
 * 解释候选关键词得分构成的数值特征。
 */
export interface KeywordFeatures {
  /** TF-IDF based relevance score. / 基于 TF-IDF 的相关性得分。 */
  tfidf: number;
  /** TextRank based centrality score. / 基于 TextRank 的中心性得分。 */
  textRank: number;
  /** Position-based score favouring earlier occurrences. / 偏好靠前出现位置的位置得分。 */
  position: number;
  /** Score rewarding terms spread across many sentences. / 奖励跨多句分布词项的得分。 */
  sentenceSpread: number;
  /** Score rewarding terms that also appear in the section path. / 奖励同时出现在章节路径中的词项得分。 */
  sectionMatch: number;
  /** Heuristic surface-form quality score. / 启发式词面质量得分。 */
  termQuality: number;
  /** Whether the term matched a curated domain dictionary. / 是否命中了人工整理的领域词典。 */
  domainBoost: boolean;
  /** Whether the term only appears inside the overlap region. / 是否仅出现在切块重叠区域内。 */
  overlapOnly: boolean;
}

/**
 * One ranked keyword extracted from a chunk.
 * 从切块中抽取的一个已排序关键词。
 */
export interface KeywordItem {
  /** Surface form as it appears in the text. / 文本中出现的词面形式。 */
  term: string;
  /** Normalized form used for matching and deduplication. / 用于匹配与去重的归一化形式。 */
  normalizedTerm: string;
  /** Whether the keyword is a single word, phrase, or domain term. / 关键词类型：单词、短语或领域术语。 */
  kind: 'word' | 'phrase' | 'term';
  /** 1-based rank of the keyword in the output list. / 关键词在输出列表中的名次（从 1 开始）。 */
  rank: number;
  /** Final aggregate score of the keyword. / 关键词的最终综合得分。 */
  score: number;
  /** All matched occurrences of the keyword in the chunk. / 关键词在切块内的全部命中位置。 */
  occurrences: readonly KeywordOccurrence[];
  /** Breakdown of the features that produced the score. / 构成该得分的特征明细。 */
  features: KeywordFeatures;
  /** Whether the keyword was forced into the top-1 slot by a rule. / 是否由规则强制置顶为第 1 名。 */
  forcedTop1: boolean;
}

/**
 * Provenance metadata describing the algorithm and dictionaries used.
 * 描述所用算法与词典来源的元数据。
 */
export interface KeywordAlgorithmMetadata {
  /** Algorithm name. / 算法名称。 */
  name: string;
  /** Algorithm version. / 算法版本。 */
  version: string;
  /** Tokenizer implementation name (e.g. Jieba). / 分词器实现名称（如 Jieba）。 */
  tokenizer: string;
  /** Tokenizer version string. / 分词器版本字符串。 */
  tokenizerVersion: string;
  /** Hash of the domain dictionary used. / 所用领域词典的内容哈希。 */
  dictionaryHash: string;
  /** Hash of the stopword list used. / 所用停用词表的内容哈希。 */
  stopwordHash: string;
}

/**
 * Keyword-stage output record for a single chunk.
 * 单个切块的关键词阶段输出记录。
 */
export interface KeywordChunkOutput {
  /** Contract schema version of this output record. / 本输出记录的契约 schema 版本。 */
  schemaVersion: number;
  /** Owning document identifier. / 所属文档标识。 */
  documentId: string;
  /** Unique chunk identifier within the document. / 文档内唯一切块标识。 */
  chunkId: string;
  /** Parent chunk identifier, or null for top-level chunks. / 父切块标识，顶层切块为 null。 */
  parentChunkId: string | null;
  /** Content hash of the chunk text this output was derived from. / 派生本输出的切块文本内容哈希。 */
  chunkContentHash: string;
  /** Algorithm and dictionary provenance metadata. / 算法与词典来源元数据。 */
  algorithm: KeywordAlgorithmMetadata;
  /**
   * Compact surface terms for the future semanticization input.
   * 面向未来语义化输入的紧凑表层词项。
   */
  keyword: readonly string[];
  /**
   * Ordered Jieba tokens used to build the FTS5 full-text projection.
   * 用于构建 FTS5 全文投影的有序 Jieba 分词结果。
   */
  searchTokens: readonly string[];
  /** Full ranked keyword list with features and occurrences. / 带特征与命中位置的完整关键词排序列表。 */
  keywords: readonly KeywordItem[];
  /** Reason the keyword list is empty, or null when keywords were produced. / 关键词列表为空的原因，非空结果时为 null。 */
  emptyReason: string | null;
}

/**
 * Quality and performance report produced by the keyword baseline evaluation.
 * 关键词基线评测产出的质量与性能报告。
 */
export interface KeywordBaselineReport {
  /** Contract schema version of this report. / 本报告的契约 schema 版本。 */
  schemaVersion: number;
  /** Stage identifier, always 'keywords-baseline'. / 阶段标识，恒为 'keywords-baseline'。 */
  stage: 'keywords-baseline';
  /** Algorithm version evaluated. / 被评测的算法版本。 */
  algorithmVersion: string;
  /** Number of fixtures processed. / 处理的评测用例数量。 */
  fixtureCount: number;
  /** Total evaluation duration in milliseconds. / 评测总耗时（毫秒）。 */
  durationMs: number;
  /** Average processing time per chunk in milliseconds. / 每切块平均处理耗时（毫秒）。 */
  avgMsPerChunk: number;
  /** Precision of the top-5 keywords against gold labels. / Top-5 关键词相对金标准的准确率。 */
  precisionAt5: number;
  /** Recall of the top-5 keywords against gold labels. / Top-5 关键词相对金标准的召回率。 */
  recallAt5: number;
  /** F1 of the top-5 keywords against gold labels. / Top-5 关键词相对金标准的 F1 值。 */
  f1At5: number;
  /** Accuracy of predicted occurrence offsets. / 预测命中偏移量的准确率。 */
  offsetAccuracy: number;
  /** Whether repeated runs produce identical outputs. / 多次运行是否产生完全一致的输出。 */
  deterministic: boolean;
  /** SHA-256 digest of all outputs, used for determinism checks. / 全部输出的 SHA-256 摘要，用于确定性校验。 */
  outputsSha256: string;
}
