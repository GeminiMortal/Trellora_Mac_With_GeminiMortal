/**
 * Selection locator: validates renderer-owned selection receipts and maps selected text to source lines in the note snapshot.
 * 选区定位器：验证渲染器持有的选区回执，并将选中文本映射到笔记快照中的源行。
 */
import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import { normalizeSelectionProjection } from '../../../shared/selectionExpansionPolicy.ts';
import type { SelectionLocatorCapture } from '../../../shared/selectionLocatorTypes.ts';
import type { CurrentNoteSnapshot } from '../currentNote/currentNoteSnapshot.ts';
import type { SelectionSnapshotV2 } from './selectionEditTypes.ts';

/** Internal AST node representation used during Markdown source walk. / Markdown 源遍历时使用的内部 AST 节点表示。 */
interface SourceNode {
  type: string;
  value?: string;
  children?: SourceNode[];
  data?: { alias?: string };
  position?: { start: { line: number }; end: { line: number } };
}
const parser = unified().use(remarkParse).use(remarkGfm)
  .use(remarkWikiLink as never, { aliasDivider: '|' });

/**
 * Validate the bounded, renderer-owned selection receipt before source lookup.
 * Validates the shape, field types, hash integrity, and structural consistency of the capture.
 *
 * 在源查找前验证渲染器持有的有界选区回执。验证捕获的形状、字段类型、哈希完整性和结构一致性。
 *
 * @param value - Raw unknown value to validate. / 要验证的原始未知值。
 * @returns Validated SelectionLocatorCapture or undefined if input is undefined.
 *   / 已验证的 SelectionLocatorCapture，若输入为 undefined 则返回 undefined。
 * @throws {Error} If any validation rule fails. / 若任何验证规则失败。
 */
export function validateSelectionLocatorCapture(value: unknown): SelectionLocatorCapture | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('选区定位信息格式无效。');
  const v = value as Record<string, unknown>;
  const string = (key: string, max = 200_000): string => {
    if (typeof v[key] !== 'string' || (v[key] as string).length > max) throw new Error('选区定位字段无效。');
    return v[key] as string;
  };
  const integer = (key: string): number => {
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0) throw new Error('选区定位坐标无效。');
    return v[key] as number;
  };
  const documentTextHash = string('documentTextHash', 64);
  const selectedTextHash = string('selectedTextHash', 64);
  if (![documentTextHash, selectedTextHash].every((hash) => /^[a-f0-9]{64}$/u.test(hash))) throw new Error('选区定位哈希无效。');
  const canonicalSliceJson = string('canonicalSliceJson');
  try { JSON.parse(canonicalSliceJson); } catch { throw new Error('选区结构数据无效。'); }
  const rect = v.rect as SelectionLocatorCapture['rect'];
  if (!rect || !['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(rect[key as keyof typeof rect]))) throw new Error('选区显示坐标无效。');
  if (!Array.isArray(v.blockKinds) || v.blockKinds.length > 100 || v.blockKinds.some((kind) => typeof kind !== 'string' || kind.length > 80)) throw new Error('选区块类型无效。');
  const capture: SelectionLocatorCapture = {
    editorSessionId: string('editorSessionId', 200), docRevision: integer('docRevision'),
    from: integer('from'), to: integer('to'), textOffset: integer('textOffset'), documentTextHash, selectedTextHash,
    canonicalSliceJson, markdownFragment: string('markdownFragment'),
    selectionStructureSignature: string('selectionStructureSignature'), documentStructureSignature: string('documentStructureSignature'),
    blockKinds: [...v.blockKinds] as string[], rect: { ...rect },
  };
  if (capture.to <= capture.from) throw new Error('选区范围不能为空。');
  return capture;
}

/**
 * Map a validated text projection to source lines, including repeated passages.
 * Parses the note Markdown, walks AST to extract text blocks, verifies hash integrity,
 * and resolves the line range and heading path for the selection.
 *
 * 将已验证的文本投影映射到源行，包括重复段落。解析笔记 Markdown，遍历 AST 提取文本块，
 * 验证哈希完整性，并解析选区的行范围和标题路径。
 *
 * @param snapshot - Current note snapshot containing markdown and headings.
 *   / 包含 markdown 和标题的当前笔记快照。
 * @param selectedText - The user-selected text to locate. / 用户选中要定位的文本。
 * @param capture - Validated selection locator capture from renderer. / 来自渲染器的已验证选区定位捕获。
 * @returns SelectionSnapshotV2 with resolved line range and heading path.
 *   / 包含已解析行范围和标题路径的 SelectionSnapshotV2。
 * @throws {Error} If hash verification fails or selection cannot be located.
 *   / 若哈希验证失败或无法定位选区。
 */
export function locateSelectionInSnapshot(snapshot: CurrentNoteSnapshot, selectedText: string, capture: SelectionLocatorCapture): SelectionSnapshotV2 {
  const parts: Array<{ text: string; from: number; to: number }> = [];
  const nodeText = (node: SourceNode): string => {
    if (node.type === 'image' || node.type === 'yaml' || node.type === 'toml') return '';
    if (node.type === 'wikiLink') return node.data?.alias ?? node.value ?? '';
    return node.value ?? (node.children ?? []).map(nodeText).join('');
  };
  const walk = (node: SourceNode): void => {
    if (['paragraph', 'heading', 'code', 'tableCell'].includes(node.type)) {
      const text = normalizeSelectionProjection(nodeText(node));
      if (text && node.position) parts.push({ text, from: node.position.start.line, to: node.position.end.line });
    } else if (node.type !== 'yaml' && node.type !== 'toml') (node.children ?? []).forEach(walk);
  };
  // Editor renders display formulas as raw text blocks; preserve those values
  // rather than interpreting LaTeX underscores as Markdown emphasis.
  const projectedMarkdown = snapshot.markdown.replace(/(^|\n)\$\$[ \t]*\r?\n([\s\S]*?)\r?\n\$\$(?=\r?\n|$)/gu,
    (_match, prefix: string, source: string) => `${prefix}~~~~~formula\n${source}\n~~~~~`);
  walk(parser.parse(projectedMarkdown) as unknown as SourceNode);
  const projection = parts.map((part) => part.text).join('');
  const selected = normalizeSelectionProjection(selectedText);
  const end = capture.textOffset + selected.length;
  if (hash(projection) !== capture.documentTextHash || hash(selectedText) !== capture.selectedTextHash
    || !selected || projection.slice(capture.textOffset, end) !== selected) {
    throw new Error('无法确认选区在已保存笔记中的位置，请保存后重新选择文字。');
  }
  let offset = 0;
  const covered = parts.filter((part) => {
    const start = offset;
    offset += part.text.length;
    return start < end && offset > capture.textOffset;
  });
  if (!covered.length) throw new Error('无法确认选区原文行范围。');
  const lineFrom = covered[0].from;
  const lineTo = covered[covered.length - 1].to;
  const heading = snapshot.headings.filter((entry) => entry.lineFrom <= lineFrom && entry.lineTo >= lineFrom).at(-1);
  return {
    ...capture, libraryId: snapshot.libraryId, currentPath: snapshot.notePath, noteContentHash: snapshot.contentHash,
    selectedText, sliceJson: JSON.parse(capture.canonicalSliceJson) as unknown, lineFrom, lineTo,
    headingPath: heading ? heading.path.map((text, index) => ({ id: `${heading.headingId}:${index}`, text })) : [],
  };
}

/** Compute SHA-256 hex digest of a UTF-8 string. / 计算 UTF-8 字符串的 SHA-256 十六进制摘要。 */
function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
