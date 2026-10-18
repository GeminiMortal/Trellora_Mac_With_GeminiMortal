/**
 * Deterministic validator for selection-edit candidate output. Enforces
 * protected-anchor preservation, action-specific heuristics (shorten/expand/
 * proofread/translate), and evidence-backed additive claims without trusting
 * the model to self-police.
 * 选区编辑候选输出的确定性校验器。强制受保护锚点保留、动作相关启发式
 * （精简/扩写/校对/翻译）以及基于证据的增补声明校验，不信任模型的自我约束。
 */

import { countMeaningfulCharacters } from '../../../shared/selectionExpansionPolicy.ts';
import { expansionMarkdownFormatLosses, expansionMarkdownText } from '../../../shared/selectionExpansionMarkdown.ts';
import type {
  SelectionEditAction,
  SelectionEditQualityIssue,
  SelectionEditValidation,
  SelectionEvidenceItem,
} from './selectionEditTypes.ts';
import type { SelectionEditProtectedAnchorKind } from './selectionEditProfiles.ts';

/**
 * Input for validating a selection-edit candidate: original text/markdown,
 * candidate output, evidence list, and protected anchor kinds.
 * 校验选区编辑候选结果的输入：原文文本/Markdown、候选输出、证据列表与受保护锚点类型。
 */
/**
 * Input for selection-edit output validation.
 * 选区编辑输出校验的输入。
 */
export interface SelectionEditValidationInput {
  /** The edit action being validated. / 正在校验的编辑动作。 */
  action: SelectionEditAction;
  /** Original selected text (plain text). / 原始选中文本（纯文本）。 */
  selectedText: string;
  /** Original selected Markdown (for structured content). / 原始选中 Markdown（用于结构化内容）。 */
  selectedMarkdown?: string;
  /** Generated candidate text from the model. / 模型生成的候选文本。 */
  candidateText: string;
  /** Target language for translation actions. / 翻译动作的目标语言。 */
  targetLanguage?: string;
  /** Evidence items read during the edit. / 编辑期间读取的证据项。 */
  evidence: readonly SelectionEvidenceItem[];
  /** Kinds of protected anchors to preserve (numbers, dates, URLs, etc.). / 需要保留的受保护锚点类型（数字、日期、URL 等）。 */
  protectedAnchorKinds: readonly SelectionEditProtectedAnchorKind[];
}

/**
 * The model is deliberately not trusted to enforce edit boundaries. This
 * validator does not attempt to prove prose true; it enforces the stable,
 * deterministic constraints that decide whether a suggestion can be applied
 * inline. Additive sentences must overlap an already-read evidence record.
 * 故意不信任模型来执行编辑边界。此校验器不试图证明文本真实性；
 * 它强制执行决定建议是否可内联应用的稳定、确定性约束。
 * 新增句子必须与已读证据记录重叠。
 *
 * @param input - Validation input with original, candidate, and evidence / 包含原文、候选和证据的校验输入
 * @returns Validation result with warnings, losses, and issues / 包含警告、丢失和问题的校验结果
 */
export function validateSelectionEditOutput(input: SelectionEditValidationInput): SelectionEditValidation {
  // Structured selections (tables/lists/code blocks) are measured by rendered
  // text for length and rewrite amplitude; anchor comparison uses the original
  // Markdown so table separators are not misread as additions and code/link
  // targets are not silently dropped.
  // 结构化选区（含表格/列表/代码块等）以 Markdown 为准：长度与改写幅度按渲染文本度量，
  // 锚点比对使用原始 Markdown，避免把表格分隔符误判成新增内容或丢掉代码/链接目标。
  const structured = Boolean(input.selectedMarkdown);
  const original = normalizeForValidation(structured ? expansionMarkdownText(input.selectedMarkdown ?? '') : input.selectedText);
  const candidate = normalizeForValidation(structured ? expansionMarkdownText(input.candidateText) : input.candidateText);
  const anchorSource = structured ? (input.selectedMarkdown ?? input.selectedText) : original;
  const anchorCandidate = structured ? input.candidateText : candidate;
  const protectedAnchorLosses = findProtectedAnchorLosses(
    anchorSource,
    anchorCandidate,
    input.protectedAnchorKinds,
  );
  const warnings: string[] = [];
  const unsupportedClaims: string[] = [];
  const issues: SelectionEditQualityIssue[] = [];

  // For structured markdown, double-check code/link targets and format losses
  // against the raw markdown to catch structural regressions.
  // 对结构化 Markdown，额外用原始 Markdown 检查代码/链接目标与格式丢失，
  // 以捕获结构性退化。
  if (input.selectedMarkdown) {
    protectedAnchorLosses.push(...findProtectedAnchorLosses(input.selectedMarkdown, input.candidateText, ['code', 'link-target']));
    const lostFormats = expansionMarkdownFormatLosses(input.selectedMarkdown, input.candidateText);
    if (lostFormats.length) {
      const message = input.action === 'expand' ? '扩写未保留原文 Markdown 格式' : '建议未保留原文 Markdown 结构';
      warnings.push(message);
      issues.push({ code: 'MARKDOWN_FORMAT_LOST', message, retryable: true });
    }
  }

  // Action-specific heuristics: empty output, shorten length, expand growth,
  // proofread rewrite amplitude, and translate language match.
  // 动作相关启发式：空输出、精简长度、扩写增长、校对改写幅度与翻译语言匹配。
  if (!candidate) warnings.push('模型没有返回可用建议。');
  if (input.action === 'shorten' && candidate.length >= original.length) {
    warnings.push('精简建议没有比原文更短。');
  }
  if (input.action === 'expand' && countMeaningfulCharacters(candidate) <= countMeaningfulCharacters(original)) {
    const message = '扩写未达到目标长度';
    warnings.push(message);
    issues.push({ code: 'EXPAND_NOT_LONGER', message, retryable: true });
  }
  if (input.action === 'proofread' && isBroadRewrite(original, candidate)) {
    warnings.push('校对建议改写幅度过大。');
  }
  if (input.action === 'translate' && !matchesTargetLanguage(candidate, input.targetLanguage)) {
    warnings.push('翻译结果与目标语言不一致。');
  }

  // Expand/explain: new sentences must overlap read evidence. Other non-translate
  // actions: no new concrete tokens (numbers/dates/urls) may appear.
  // 扩写/解释：新增句子必须与已读证据重叠。其他非翻译动作：
  // 不允许出现新的具体信息 token（数字/日期/URL）。
  if (input.action === 'expand' || input.action === 'explain') {
    const additions = findUnsupportedAdditions(original, candidate, input.evidence);
    unsupportedClaims.push(...additions.messages);
    if (additions.messages.length > 0) {
      // Whether a planned evidence goal was covered is decided by the final
      // coordinator gate. Here we only describe this candidate's unsupported
      // new sentence, so result UI never mistakes it for a planning failure.
      // 计划证据目标是否被覆盖由最终协调器门决定。这里仅描述该候选的
      // 无依据新增句，使结果 UI 不会将其误判为规划失败。
      issues.push({ code: 'UNSUPPORTED_ADDITION', message: additions.messages[0]!, retryable: true });
    }
  } else if (input.action !== 'translate') {
    const additions = findNewConcreteTokens(original, candidate);
    unsupportedClaims.push(...additions);
    if (additions.length > 0) {
      issues.push({ code: 'UNSUPPORTED_ADDITION', message: additions[0]!, retryable: false });
    }
  }

  // Protected anchors (numbers, dates, URLs, code, etc.) must survive the edit.
  // 受保护锚点（数字、日期、URL、代码等）必须在编辑后完整保留。
  if (protectedAnchorLosses.length > 0) {
    issues.push({
      code: 'PROTECTED_ANCHOR_LOST',
      message: `原文关键信息未完整保留：${protectedAnchorLosses.join('、')}`,
      retryable: true,
    });
  }

  return {
    passed: protectedAnchorLosses.length === 0 && warnings.length === 0 && unsupportedClaims.length === 0,
    warnings,
    protectedAnchorLosses,
    unsupportedClaims,
    issues,
  };
}

// Normalizes line endings and trims whitespace for consistent comparison.
// 规范化换行符并去除首尾空白，保证比较一致性。
/**
 * Normalizes line endings and trims whitespace for consistent comparison.
 * 规范化换行符并修剪空白以进行一致比较。
 */
function normalizeForValidation(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

// Collects anchors from the original text and returns those missing in the candidate.
// 从原文收集锚点，并返回候选文本中缺失的锚点列表。
/**
 * Finds protected anchors present in the original but missing from the candidate.
 * 查找存在于原文但缺失于候选文本中的受保护锚点。
 *
 * @param original - Original text to extract anchors from / 从中提取锚点的原文
 * @param candidate - Candidate text to check against / 用于对照检查的候选文本
 * @param kinds - Anchor kinds to protect / 需要保护的锚点类型
 * @returns Array of missing anchor strings / 缺失锚点字符串数组
 */
function findProtectedAnchorLosses(
  original: string,
  candidate: string,
  kinds: readonly SelectionEditProtectedAnchorKind[],
): string[] {
  const anchors = new Set<string>();
  for (const kind of kinds) {
    for (const anchor of collectAnchors(original, kind)) anchors.add(anchor);
  }
  return [...anchors].filter((anchor) => !candidate.includes(anchor));
}

// Extracts anchor tokens of a given kind from the input string using regex patterns.
// 使用正则模式从输入字符串中提取指定类型的锚点 token。
/**
 * Extracts all anchor values of a given kind from the input text using regex patterns.
 * 使用正则表达式从输入文本中提取给定类型的所有锚点值。
 *
 * @param value - Text to scan / 待扫描的文本
 * @param kind - Anchor kind to extract / 待提取的锚点类型
 * @returns Array of matched anchor strings / 匹配的锚点字符串数组
 */
function collectAnchors(value: string, kind: SelectionEditProtectedAnchorKind): string[] {
  const patterns: Record<SelectionEditProtectedAnchorKind, RegExp> = {
    number: /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?%?(?![\p{L}\p{N}])/gu,
    date: /\b\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b/gu,
    url: /(?:https?:\/\/|www\.)[^\s)\]}>,]+/giu,
    code: /`[^`\n]+`|```[\s\S]*?```/gu,
    'proper-noun': /\b[A-Z][A-Za-z0-9_-]{1,}\b/gu,
    'link-target': /\[[^\]]*\]\(([^)]+)\)/gu,
    placeholder: /\{\{[^}]+\}\}|\$\{[^}]+\}|%[A-Za-z]\d*|<[^<>\n]+>/gu,
  };
  const pattern = patterns[kind];
  const matches = value.matchAll(pattern);
  const values: string[] = [];
  for (const match of matches) {
    const anchor = kind === 'link-target' ? (match[1] ?? '') : match[0];
    if (anchor.trim()) values.push(anchor);
  }
  return values;
}

// Heuristic: a candidate is a "broad rewrite" if it grows too much or shares
// less than 56% character overlap with the original.
// 启发式判断：若候选文本增长过多或与原文字符重叠率低于 56%，则视为"大幅改写"。
/**
 * Detects whether a candidate is a broad rewrite of the original by checking
 * length inflation and character overlap ratio.
 * 通过检查长度膨胀和字符重叠率来检测候选文本是否为原文的大幅改写。
 *
 * @param original - Original text / 原文
 * @param candidate - Candidate text / 候选文本
 * @returns True if the candidate is a broad rewrite / 如果候选是大幅改写则返回 true
 */
function isBroadRewrite(original: string, candidate: string): boolean {
  if (!original || !candidate) return true;
  if (candidate.length > Math.ceil(original.length * 1.35) + 48) return true;
  const overlap = characterOverlapRatio(original, candidate);
  return overlap < 0.56;
}

// Computes the multiset character overlap ratio between two strings.
// 计算两个字符串之间的多重集字符重叠率。
/**
 * Calculates the character-level overlap ratio between two strings.
 * 计算两个字符串之间的字符级重叠率。
 */
function characterOverlapRatio(left: string, right: string): number {
  const leftCounts = characterCounts(left);
  const rightCounts = characterCounts(right);
  let shared = 0;
  for (const [character, count] of leftCounts) shared += Math.min(count, rightCounts.get(character) ?? 0);
  return shared / Math.max(1, Math.min([...left].length, [...right].length));
}

// Counts non-whitespace character occurrences in the input string.
// 统计输入字符串中非空白字符的出现次数。
/**
 * Builds a frequency map of non-whitespace characters in the input.
 * 构建输入中非空白字符的频率映射。
 */
function characterCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of value.replace(/\s/gu, '')) counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
}

// Checks whether the candidate text matches the expected target language
// (Chinese or English); unknown languages always pass.
// 检查候选文本是否与目标语言匹配（中文或英文）；未知语言一律通过。
/**
 * Checks whether the candidate text matches the expected target language.
 * Supports Chinese and English detection.
 * 检查候选文本是否与预期目标语言匹配。支持中文和英文检测。
 */
function matchesTargetLanguage(value: string, targetLanguage: string | undefined): boolean {
  const target = targetLanguage?.trim().toLocaleLowerCase('en-US');
  if (!target) return false;
  if (/中文|汉语|chinese|mandarin/u.test(target)) return /[\u3400-\u9fff]/u.test(value);
  if (/英语|英文|english/u.test(target)) return /[A-Za-z]/u.test(value);
  return true;
}

// Detects new numbers, dates, or URLs in the candidate that were not present in the original.
// 检测候选文本中原文未出现的新数字、日期或 URL。
/**
 * Finds concrete tokens (numbers, dates, URLs) in the candidate that are not
 * present in the original. Used for non-expand/explain actions.
 * 查找候选文本中存在但原文中没有的具体标记（数字、日期、URL）。
 * 用于非扩写/解释动作。
 */
function findNewConcreteTokens(original: string, candidate: string): string[] {
  const originalTokens = new Set([
    ...collectAnchors(original, 'number'),
    ...collectAnchors(original, 'date'),
    ...collectAnchors(original, 'url'),
  ]);
  const additions = [
    ...collectAnchors(candidate, 'number'),
    ...collectAnchors(candidate, 'date'),
    ...collectAnchors(candidate, 'url'),
  ].filter((token) => !originalTokens.has(token));
  return [...new Set(additions)].map((token) => `新增具体信息“${token}”没有原文依据。`);
}

// Finds additive sentences in the candidate that cannot be linked to read
// evidence by at least two shared meaningful terms.
// 查找候选文本中无法通过至少两个共有语义词关联到已读证据的新增句子。
/**
 * Finds additive sentences in the candidate that cannot be linked to any
 * evidence item by meaningful term overlap. Used for expand/explain actions.
 * 查找候选文本中无法通过有意义的术语重叠关联到任何证据项的新增句子。
 * 用于扩写/解释动作。
 *
 * @param original - Original text / 原文
 * @param candidate - Candidate text / 候选文本
 * @param evidence - Evidence items to check against / 用于对照检查的证据项
 * @returns Object with unsupported addition messages / 包含不支持的新增内容消息的对象
 */
function findUnsupportedAdditions(
  original: string,
  candidate: string,
  evidence: readonly SelectionEvidenceItem[],
): { messages: string[] } {
  const originalSentences = new Set(splitSentences(original).map(normalizeSentence));
  const additiveSentences = splitSentences(candidate)
    .filter((sentence) => {
      const normalized = normalizeSentence(sentence);
      return Boolean(normalized) && !originalSentences.has(normalized);
    });
  if (additiveSentences.length === 0) return { messages: [] };
  if (evidence.length === 0) {
    return {
      messages: ['没有已读证据，不能为扩写或解释提供一键应用。'],
      
    };
  }
  const evidenceTerms = new Set(evidence.flatMap((item) => collectMeaningfulTerms(item.content)));
  const unsupported: string[] = [];
  for (const sentence of additiveSentences) {
    const overlap = collectMeaningfulTerms(sentence).filter((term) => evidenceTerms.has(term));
    if (overlap.length < 2) unsupported.push(`新增内容“${sentence.slice(0, 80)}”无法关联已读证据。`);
  }
  return { messages: unsupported.slice(0, 6) };
}

// Splits text into sentences on Chinese/English punctuation and newlines.
// 按中英文标点和换行符将文本切分为句子。
function splitSentences(value: string): string[] {
  return value.split(/(?<=[。！？!?；;]|\n)/u).map((item) => item.trim()).filter(Boolean);
}

// Collapses internal whitespace and trims for deduplication.
// 折叠内部连续空白并首尾裁剪，用于去重比较。
function normalizeSentence(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

// Extracts meaningful terms from text: Latin words and bigrams of CJK characters,
// lowercased for locale-aware comparison.
// 从文本中提取语义词：拉丁文单词和 CJK 双字符组合，转换为小写以进行本地化比较。
function collectMeaningfulTerms(value: string): string[] {
  const latin = value.match(/[A-Za-z][A-Za-z0-9_-]{1,}/gu) ?? [];
  const cjkPairs: string[] = [];
  const cjk = value.match(/[\u3400-\u9fff]/gu) ?? [];
  for (let index = 0; index < cjk.length - 1; index += 1) cjkPairs.push(`${cjk[index]}${cjk[index + 1]}`);
  return [...new Set([...latin, ...cjkPairs].map((item) => item.toLocaleLowerCase('zh-CN')))];
}
