/**
 * Heading structure extraction, line-offset mapping, and evidence block
 * indexing for the current note.
 *
 * 当前笔记的标题结构提取、行偏移映射和证据块索引。
 */
import { createHash } from 'node:crypto';
import { extractMarkdownEvidenceBlocks, type MarkdownEvidenceBlockKind } from '../markdownAst.ts';
import { isTechnicalIdentifier, normalizeTechnicalTerm } from '../index/lexicalMatchPolicy.ts';

/**
 * Raw heading source extracted from the note before range computation.
 * 从笔记中提取的原始标题源，用于后续范围计算。
 */
export interface CurrentNoteHeadingSource {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
}

/**
 * Heading with computed line range and hierarchical path from root to this heading.
 * 包含计算后行范围和从根到此标题的层级路径的标题。
 */
export interface CurrentNoteHeadingRange {
  headingId: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  path: string[];
  lineFrom: number;
  lineTo: number;
}

/**
 * An evidence block extracted from the note, including its heading path and normalized terms.
 * 从笔记中提取的证据块，包含其标题路径和归一化词条。
 */
export interface CurrentNoteEvidenceBlock {
  blockId: string;
  kind: MarkdownEvidenceBlockKind;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  text: string;
  normalizedTerms: string[];
  blockHash: string;
}

/**
 * Complete structural representation of the current note: line offsets, headings, and evidence blocks.
 * 当前笔记的完整结构表示：行偏移、标题和证据块。
 */
export interface CurrentNoteStructure {
  lineOffsets: number[];
  lineCount: number;
  headings: CurrentNoteHeadingRange[];
  blocks: CurrentNoteEvidenceBlock[];
}

/**
 * Builds the full structural representation of a note from its markdown and heading sources.
 * 从笔记的 markdown 和标题源构建完整的结构表示。
 *
 * @param input.markdown - Raw markdown content / 原始 markdown 内容
 * @param input.contentHash - Content hash for block ID generation / 用于块 ID 生成的内容哈希
 * @param input.headings - Parsed heading sources / 解析后的标题源
 * @returns Complete structure with line offsets, heading ranges, and evidence blocks / 包含行偏移、标题范围和证据块的完整结构
 */
export function buildCurrentNoteStructure(input: {
  markdown: string;
  contentHash: string;
  headings: readonly CurrentNoteHeadingSource[];
}): CurrentNoteStructure {
  const lineOffsets = getMarkdownLineOffsets(input.markdown);
  const lineCount = lineOffsets.length;
  const headings = buildHeadingRanges(input.headings, lineCount);
  const blocks = extractMarkdownEvidenceBlocks(input.markdown).map((block) => {
    const blockHash = sha256(block.text);
    return {
      blockId: `block-${sha256(`${input.contentHash}\u0000${block.kind}\u0000${block.lineFrom}\u0000${block.lineTo}\u0000${blockHash}`).slice(0, 24)}`,
      kind: block.kind,
      headingPath: getHeadingPathAtLine(headings, block.lineFrom),
      lineFrom: block.lineFrom,
      lineTo: block.lineTo,
      text: block.text,
      normalizedTerms: tokenizeCurrentNoteText(block.text),
      blockHash,
    };
  });

  return { lineOffsets, lineCount, headings, blocks };
}

/**
 * Computes the byte offset of each line start in the markdown string, handling both \n and \r\n.
 * 计算 markdown 字符串中每行起始的字节偏移，同时处理 \n 和 \r\n。
 *
 * @param markdown - The markdown text to analyze / 需要分析的 markdown 文本
 * @returns Array of byte offsets, one per line / 每行一个字节偏移的数组
 */
export function getMarkdownLineOffsets(markdown: string): number[] {
  const offsets = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character === '\r') {
      if (markdown[index + 1] === '\n') index += 1;
      offsets.push(index + 1);
    } else if (character === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

/**
 * Extracts a contiguous line range from the markdown source using precomputed offsets.
 * 使用预计算的偏移从 markdown 源中提取连续行范围。
 *
 * @param markdown - The full markdown text / 完整的 markdown 文本
 * @param lineOffsets - Precomputed line start offsets / 预计算的行起始偏移
 * @param lineFrom - First line to extract (1-indexed) / 要提取的第一行（从1开始）
 * @param lineTo - Last line to extract (1-indexed, inclusive) / 要提取的最后一行（从1开始，包含）
 * @returns The extracted text for the specified line range / 指定行范围的提取文本
 */
export function readMarkdownLineRange(markdown: string, lineOffsets: readonly number[], lineFrom: number, lineTo: number): string {
  if (!Number.isInteger(lineFrom) || !Number.isInteger(lineTo) || lineFrom < 1 || lineTo < lineFrom || lineTo > lineOffsets.length) {
    throw new Error('读取行范围无效。');
  }
  const start = lineOffsets[lineFrom - 1] ?? 0;
  const nextLineStart = lineOffsets[lineTo] ?? markdown.length;
  let end = nextLineStart;
  if (end > start && markdown[end - 1] === '\n') {
    end -= 1;
    if (end > start && markdown[end - 1] === '\r') end -= 1;
  } else if (end > start && markdown[end - 1] === '\r') {
    end -= 1;
  }
  return markdown.slice(start, end);
}

/**
 * Shared deterministic tokenizer for block indexing and query coverage.
 * 用于块索引和查询覆盖的共享确定性分词器。
 *
 * @param value - Text to tokenize / 需要分词的文本
 * @param maxTerms - Maximum number of terms to return / 最大返回词条数
 * @returns Array of normalized terms / 归一化词条数组
 */
export function tokenizeCurrentNoteText(value: string, maxTerms = 256): string[] {
  const terms = new Set<string>();
  const add = (term: string) => {
    const normalized = normalizeTechnicalTerm(term);
    if (normalized && terms.size < maxTerms) terms.add(normalized);
  };

  for (const chunk of value.match(/[\u3400-\u9fff]+|[A-Za-z][A-Za-z0-9_./:-]*|\d+(?:\.\d+)?/gu) ?? []) {
    // CJK characters: emit each unigram plus adjacent bigrams for partial matching.
    // 中日韩字符：输出每个单字和相邻双字组合以支持部分匹配。
    if (/^[\u3400-\u9fff]+$/u.test(chunk)) {
      for (const character of chunk) add(character);
      for (let index = 0; index < chunk.length - 1; index += 1) add(chunk.slice(index, index + 2));
      continue;
    }
    // Latin/numeric identifiers: emit the full token plus sub-segments from camelCase/snake_case splitting.
    // 拉丁/数字标识符：输出完整 token 以及驼峰/下划线拆分的子段。
    add(chunk);
    for (const segment of splitIdentifier(chunk)) add(segment);
  }
  return [...terms];
}

/**
 * Normalizes text by applying technical term normalization and stripping whitespace.
 * 通过应用技术术语归一化并去除空白来规范化文本。
 *
 * @param value - Text to normalize / 需要规范化的文本
 * @returns Normalized text with whitespace removed / 去除空白后的规范化文本
 */
export function normalizeCurrentNoteText(value: string): string {
  return normalizeTechnicalTerm(value).replace(/\s+/gu, '');
}

/**
 * Checks whether a value is a technical identifier (e.g. code name, camelCase).
 * 检查值是否为技术标识符（例如代码名、驼峰命名）。
 *
 * @param value - Text to check / 需要检查的文本
 * @returns True if the value is a technical identifier / 若值是技术标识符则返回 true
 */
export function isCurrentNoteIdentifier(value: string): boolean {
  return isTechnicalIdentifier(value);
}

function buildHeadingRanges(headings: readonly CurrentNoteHeadingSource[], lineCount: number): CurrentNoteHeadingRange[] {
  const ordered = [...headings]
    .filter((heading) => heading.text.trim() && heading.line >= 1 && heading.line <= lineCount)
    .sort((first, second) => first.line - second.line || first.level - second.level || first.id.localeCompare(second.id));
  // Maintain a stack of ancestor headings to compute the hierarchical path for each heading.
  // 维护一个祖先标题栈，用于计算每个标题的层级路径。
  const stack: CurrentNoteHeadingRange[] = [];
  const usedHeadingIds = new Set<string>();
  return ordered.map((heading, index) => {
    // Pop ancestors at the same or deeper level to maintain the correct nesting hierarchy.
    // 弹出同级或更深层的祖先，以维护正确的嵌套层级。
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
    const headingId = allocateUniqueHeadingId(heading.id, index, usedHeadingIds);
    const range: CurrentNoteHeadingRange = {
      headingId,
      level: heading.level,
      text: heading.text.trim(),
      path: [...stack.map((entry) => entry.text), heading.text.trim()],
      lineFrom: heading.line,
      lineTo: findHeadingEndLine(ordered, index, lineCount),
    };
    stack.push(range);
    return range;
  });
}

function allocateUniqueHeadingId(value: string, index: number, usedHeadingIds: Set<string>): string {
  const base = value.trim() || `heading-${index + 1}`;
  let headingId = base;
  let occurrence = 2;
  while (usedHeadingIds.has(headingId)) {
    headingId = `${base}-${occurrence}`;
    occurrence += 1;
  }
  usedHeadingIds.add(headingId);
  return headingId;
}

function findHeadingEndLine(headings: readonly CurrentNoteHeadingSource[], index: number, lineCount: number): number {
  const heading = headings[index];
  for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
    const next = headings[nextIndex];
    if (next.level <= heading.level) return Math.max(heading.line, next.line - 1);
  }
  return lineCount;
}

function getHeadingPathAtLine(headings: readonly CurrentNoteHeadingRange[], line: number): string[] {
  let current: CurrentNoteHeadingRange | undefined;
  for (const heading of headings) {
    if (heading.lineFrom > line) break;
    if (heading.lineTo >= line) current = heading;
  }
  return current ? [...current.path] : [];
}

// Split camelCase, snake_case, and dot/slash-separated identifiers into meaningful sub-terms.
// 将驼峰、下划线和点/斜杠分隔的标识符拆分为有意义的子词。
function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .split(/[_./:-]+|\s+/u)
    .flatMap((segment) => segment.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/gu) ?? [])
    .filter(Boolean);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
