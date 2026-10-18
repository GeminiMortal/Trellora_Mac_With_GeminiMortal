/**
 * Session-scoped evidence ledger for whole-library retrieval: admits raw note
 * excerpts as evidence, merges overlapping excerpts, and verifies citations.
 * 整库检索的会话级证据账本：接纳笔记原文片段为证据、合并重叠片段，并校验引用有效性。
 */
import { createHash } from 'node:crypto';
import type { AssistantEvidenceCitation } from '../assistant/assistantTurnTypes.ts';
import { readMarkdownLineRange } from '../currentNote/currentNoteStructure.ts';
import type { CurrentNoteSnapshot } from '../currentNote/currentNoteSnapshot.ts';
import { getLibraryNoteRecord, type LibraryNoteSnapshotMap } from './libraryNoteSnapshot.ts';

/**
 * A single admitted evidence excerpt bound to a scoped note snapshot.
 * 已接纳的单条证据片段，绑定到确定作用域内的笔记快照。
 */
export interface LibraryEvidenceRecord {
  evidenceId: string; // Content-derived stable identity / 由内容推导的稳定标识
  libraryId: string; // Owning library id / 所属资料库标识
  noteId: string; // Owning note id / 所属笔记标识
  snapshotId: string; // Snapshot the excerpt belongs to / 片段所属快照标识
  contentHash: string; // Note content hash at admission time / 接纳时的笔记内容哈希
  headingPath: string[]; // Heading path of the excerpt / 片段所在章节路径
  /** Stable navigation metadata. It is intentionally excluded from evidence identity. */
  /** 稳定的导航元数据，刻意不参与证据身份计算。 */
  anchorHeadingId?: string;
  lineFrom: number; // First source line (1-based) / 起始行号（从 1 开始）
  lineTo: number; // Last source line (inclusive) / 结束行号（含）
  text: string; // Exact source text / 与快照一致的原文
  textHash: string; // SHA-256 of text, used for integrity checks / 正文哈希，用于完整性校验
  matchedTerms: string[]; // Terms that surfaced this excerpt / 命中该片段的检索词
  supports: string[]; // Requirement labels the excerpt supports / 该证据支持的需求标签
  sourceToolCallId: string; // Tool call that produced the excerpt / 产生该片段的工具调用标识
}

/**
 * Caller-supplied excerpt to admit into the ledger; validated against the snapshot.
 * 调用方提交的待接纳证据片段；会针对快照做一致性校验。
 */
export interface LibraryEvidenceInput {
  noteId: string;
  headingPath: string[];
  anchorHeadingId?: string;
  lineFrom: number;
  lineTo: number;
  text: string;
  matchedTerms: string[];
  supports: string[];
  sourceToolCallId: string;
}

/**
 * Evidence is keyed by the scoped snapshot, not by title or path.
 * 证据以限定作用域的快照为身份基准，而不是标题或路径。
 */
export class LibraryEvidenceLedger {
  private records: LibraryEvidenceRecord[] = [];

  /**
   * Creates a ledger bound to one snapshot map and session.
   * 创建绑定到指定快照映射与会话的证据账本。
   *
   * @param snapshotMap - Scoped note snapshot map / 限定作用域的笔记快照映射
   * @param sessionId - Assistant session identity / 助手会话标识
   * @param maxRawEvidenceChars - Max total raw evidence characters / 原始证据总字符上限
   */
  constructor(
    private readonly snapshotMap: LibraryNoteSnapshotMap,
    private readonly sessionId: string,
    private readonly maxRawEvidenceChars: number,
  ) {
    if (!Number.isSafeInteger(maxRawEvidenceChars) || maxRawEvidenceChars < 1) throw new Error('证据账本容量无效。');
    if (snapshotMap.sessionId !== sessionId) throw new Error('Evidence Ledger 会话范围不一致。');
  }

  /**
   * Total characters of all admitted raw evidence.
   * 已接纳原始证据的总字符数。
   */
  get totalChars(): number {
    return this.records.reduce((total, record) => total + record.text.length, 0);
  }

  /**
   * Returns defensive copies of all evidence records.
   * 返回全部证据记录的防御性副本。
   *
   * @returns Evidence record copies / 证据记录副本列表
   */
  list(): LibraryEvidenceRecord[] {
    return this.records.map(copyRecord);
  }

  /**
   * Looks up one evidence record by id.
   * 按标识查找单条证据记录。
   *
   * @param evidenceId - Evidence identity / 证据标识
   * @returns A copy of the record, or undefined / 记录副本，或 undefined
   */
  get(evidenceId: string): LibraryEvidenceRecord | undefined {
    const record = this.records.find((entry) => entry.evidenceId === evidenceId);
    return record ? copyRecord(record) : undefined;
  }

  /**
   * Admits an excerpt, merging it with overlapping excerpts of the same note revision.
   * 接纳一条片段，并与同一笔记版本上的重叠片段合并。
   *
   * @param input - Excerpt to admit / 待接纳的证据片段
   * @returns The stored record and whether it changed the ledger / 存储后的记录与账本是否变化
   */
  add(input: LibraryEvidenceInput): { record: LibraryEvidenceRecord; added: boolean } {
    const snapshot = getLibraryNoteRecord(this.snapshotMap, input.noteId, this.sessionId).localSnapshot;
    assertEvidenceInput(snapshot, input);
    // Overlapping excerpts on the same note revision are merged into one record.
    // 同一笔记版本上的重叠片段合并为一条记录。
    const overlaps = this.records.filter((record) => record.noteId === input.noteId
      && record.contentHash === snapshot.contentHash
      && record.lineFrom <= input.lineTo
      && record.lineTo >= input.lineFrom);
    const lineFrom = Math.min(input.lineFrom, ...overlaps.map((record) => record.lineFrom));
    const lineTo = Math.max(input.lineTo, ...overlaps.map((record) => record.lineTo));
    // The merged span is re-read from the snapshot so text always matches the source.
    // 合并区间从快照重新读取，确保正文始终与来源一致。
    const text = overlaps.length
      ? readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, lineTo)
      : input.text;
    const nextTotalChars = this.totalChars - overlaps.reduce((total, record) => total + record.text.length, 0) + text.length;
    if (nextTotalChars > this.maxRawEvidenceChars) throw new Error('原始证据总量已达到本轮上限。');
    const matchedTerms = [...new Set([...overlaps.flatMap((record) => record.matchedTerms), ...input.matchedTerms])].sort(compareText);
    const supports = [...new Set([...overlaps.flatMap((record) => record.supports), ...input.supports])].sort(compareText);
    const anchorHeadingId = input.anchorHeadingId ?? overlaps[0]?.anchorHeadingId;
    const record: LibraryEvidenceRecord = {
      evidenceId: createEvidenceId(this.snapshotMap.libraryId, input.noteId, snapshot.snapshotId, lineFrom, lineTo, text),
      libraryId: this.snapshotMap.libraryId,
      noteId: input.noteId,
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      headingPath: [...(overlaps[0]?.headingPath ?? input.headingPath)],
      ...(anchorHeadingId ? { anchorHeadingId } : {}),
      lineFrom,
      lineTo,
      text,
      textHash: sha256(text),
      matchedTerms,
      supports,
      sourceToolCallId: input.sourceToolCallId,
    };
    // A pure no-op merge must not be reported as fresh evidence progress.
    // 纯无变化的合并不应算作新的证据进展。
    const unchanged = overlaps.length === 1
      && overlaps[0].lineFrom === record.lineFrom
      && overlaps[0].lineTo === record.lineTo
      && overlaps[0].textHash === record.textHash;
    this.records = [...this.records.filter((entry) => !overlaps.includes(entry)), record]
      .sort((first, second) => first.noteId.localeCompare(second.noteId) || first.lineFrom - second.lineFrom || first.lineTo - second.lineTo);
    return { record: copyRecord(record), added: !unchanged };
  }

  /**
   * Filters evidence ids down to those whose source text still matches the live snapshot.
   * 过滤出源正文仍与当前快照一致的证据标识。
   *
   * @param evidenceIds - Candidate evidence ids / 候选证据标识
   * @returns Ids that are still intact / 仍然完整有效的证据标识
   */
  verifyEvidenceIds(evidenceIds: readonly string[]): string[] {
    return [...new Set(evidenceIds)].filter((evidenceId) => {
      const record = this.records.find((entry) => entry.evidenceId === evidenceId);
      if (!record) return false;
      const current = this.snapshotMap.records.get(record.noteId);
      if (!current || current.contentHash !== record.contentHash || current.snapshotId !== record.snapshotId) return false;
      const source = readMarkdownLineRange(current.localSnapshot.markdown, current.localSnapshot.lineOffsets, record.lineFrom, record.lineTo);
      return sha256(source) === record.textHash;
    });
  }

  /**
   * Projects verified evidence into assistant-facing citations with previews.
   * 将校验通过的证据投影为面向助手的引用与预览。
   *
   * @param evidenceIds - Evidence ids to project / 待投影的证据标识
   * @returns Assistant evidence citations / 助手侧证据引用列表
   */
  toAssistantCitations(evidenceIds: readonly string[]): AssistantEvidenceCitation[] {
    const validIds = new Set(this.verifyEvidenceIds(evidenceIds));
    return this.records.filter((record) => validIds.has(record.evidenceId)).map((record) => {
      const source = this.snapshotMap.records.get(record.noteId);
      return {
        evidenceId: record.evidenceId,
        notePath: source?.localSnapshot.notePath ?? '[笔记已失效]',
        libraryId: record.libraryId,
        noteId: record.noteId,
        contentHash: record.contentHash,
        headingPath: [...record.headingPath],
        lineFrom: record.lineFrom,
        lineTo: record.lineTo,
        quoteHash: record.textHash,
        preview: record.text.replace(/\s+/gu, ' ').trim().slice(0, 240),
      };
    });
  }
}

/**
 * Validates excerpt bounds and text against the live snapshot.
 * 校验片段行号与正文是否与当前快照一致。
 *
 * @param snapshot - Current note snapshot / 当前笔记快照
 * @param input - Evidence input to validate / 待校验的证据输入
 */
function assertEvidenceInput(snapshot: CurrentNoteSnapshot, input: LibraryEvidenceInput): void {
  if (!Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo)
    || input.lineFrom < 1 || input.lineTo < input.lineFrom || input.lineTo > snapshot.lineCount) {
    throw new Error('证据行号无效。');
  }
  if (!input.text.trim()) throw new Error('证据正文不能为空。');
  if (input.anchorHeadingId !== undefined
    && !snapshot.headings.some((heading) => heading.headingId === input.anchorHeadingId)) {
    throw new Error('证据章节锚点不属于当前快照。');
  }
  const source = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, input.lineFrom, input.lineTo);
  if (source !== input.text) throw new Error('证据正文与库内快照不一致。');
}

/**
 * Derives the content-addressed evidence id.
 * 推导基于内容寻址的证据标识。
 *
 * @param libraryId - Library identity / 资料库标识
 * @param noteId - Note identity / 笔记标识
 * @param snapshotId - Snapshot identity / 快照标识
 * @param lineFrom - First line (1-based) / 起始行号
 * @param lineTo - Last line (inclusive) / 结束行号
 * @param text - Source text / 原文正文
 * @returns Content-addressed evidence id / 基于内容寻址的证据标识
 */
function createEvidenceId(libraryId: string, noteId: string, snapshotId: string, lineFrom: number, lineTo: number, text: string): string {
  return `evidence-${sha256(`${libraryId}\u0000${noteId}\u0000${snapshotId}\u0000${lineFrom}\u0000${lineTo}\u0000${sha256(text)}`).slice(0, 24)}`;
}

/**
 * Copies a record while cloning its array fields.
 * 复制记录并克隆其中的数组字段。
 *
 * @param record - Source record / 来源记录
 * @returns Defensive copy / 防御性副本
 */
function copyRecord(record: LibraryEvidenceRecord): LibraryEvidenceRecord {
  return {
    ...record,
    headingPath: [...record.headingPath],
    matchedTerms: [...record.matchedTerms],
    supports: [...record.supports],
  };
}

/**
 * UTF-8 SHA-256 hex digest.
 * UTF-8 编码的 SHA-256 十六进制摘要。
 *
 * @param value - Input string / 输入字符串
 * @returns Hex-encoded SHA-256 hash / 十六进制编码的 SHA-256 哈希
 */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Plain string comparator for stable sorting.
 * 用于稳定排序的普通字符串比较器。
 *
 * @param first - First string / 第一个字符串
 * @param second - Second string / 第二个字符串
 * @returns Comparison result / 比较结果
 */
function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}