/**
 * Tracks evidence line ranges admitted from the current note, providing deduplication, validation, and citation export.
 * 跟踪从当前笔记中准入的证据行范围，提供去重、验证和引用导出功能。
 */
import { createHash } from 'node:crypto';
import type { AssistantEvidenceCitation } from '../assistant/assistantTurnTypes.ts';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot.ts';
import { readMarkdownLineRange } from './currentNoteStructure.ts';

/** A single evidence record admitted from the current note snapshot. 从当前笔记快照准入的单条证据记录。 */
export interface CurrentNoteEvidenceRecord {
  evidenceId: string;
  snapshotId: string;
  contentHash: string;
  blockIds: string[];
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  text: string;
  textHash: string;
  matchedTerms: string[];
  supports: string[];
  sourceToolCallId: string;
  sourceToolCallIds: string[];
  admission: CurrentNoteEvidenceAdmission;
  admissions: CurrentNoteEvidenceAdmission[];
  goalIds: string[];
  searchHitIds: string[];
  firstSeenSeq: number;
  bestScore?: number;
}

/** Allowed admission source types for evidence records. 证据记录允许的准入来源类型。 */
export const currentNoteEvidenceAdmissions = [
  'search-hit',
  'explicit-read',
  'expanded-read',
  'memory-reuse',
] as const;

/** Union type of all allowed evidence admission sources. 所有允许的证据准入来源的联合类型。 */
export type CurrentNoteEvidenceAdmission = typeof currentNoteEvidenceAdmissions[number];

/** Input parameters for admitting a new evidence line range into the ledger. 准入新的证据行范围到账本的输入参数。 */
export interface CurrentNoteEvidenceInput {
  blockIds: string[];
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  text: string;
  matchedTerms: string[];
  supports: string[];
  sourceToolCallId: string;
  sourceToolCallIds?: readonly string[];
  admission?: CurrentNoteEvidenceAdmission;
  goalId?: string;
  searchHitId?: string;
  bestScore?: number;
}

/** Configuration options for the evidence ledger resource guards. 证据账本资源守卫的配置选项。 */
export interface CurrentNoteEvidenceLedgerOptions {
  /** Structural guard for source-record count; it is not a relevance limit. 源记录数量的结构守卫；不是相关性限制。 */
  maxSourceEvidenceRecords?: number;
  /** Legacy minimal mode keeps its raw-character guard; all-retrieved disables it. 遗留最小模式保留原始字符守卫；全部检索模式禁用它。 */
  enforceRawEvidenceChars?: boolean;
}

/**
 * Manages a sorted, deduplicated collection of evidence records for the current note.
 * Supports atomic batch admission, resource guards, and citation export.
 * 管理当前笔记的排序、去重的证据记录集合。
 * 支持原子批量准入、资源守卫和引用导出。
 */
export class CurrentNoteEvidenceLedger {
  private records: CurrentNoteEvidenceRecord[] = [];
  private nextSequence = 1;
  private readonly enforceRawEvidenceChars: boolean;
  private readonly maxSourceEvidenceRecords?: number;

  /**
   * Creates a new ledger bound to an immutable snapshot.
   * 创建绑定到不可变快照的新账本。
   *
   * @param snapshot - The immutable note snapshot this ledger validates against / 此账本验证所依据的不可变笔记快照
   * @param maxRawEvidenceChars - Maximum total raw characters allowed / 允许的最大原始字符总数
   * @param options - Optional resource guard configuration / 可选的资源守卫配置
   */
  constructor(
    private readonly snapshot: CurrentNoteSnapshot,
    private readonly maxRawEvidenceChars = Number.MAX_SAFE_INTEGER,
    options: CurrentNoteEvidenceLedgerOptions = {},
  ) {
    if (!Number.isSafeInteger(maxRawEvidenceChars) || maxRawEvidenceChars < 1) throw new Error('证据账本容量无效。');
    if (options.maxSourceEvidenceRecords !== undefined
      && (!Number.isSafeInteger(options.maxSourceEvidenceRecords) || options.maxSourceEvidenceRecords < 1)) {
      throw new Error('证据源记录容量无效。');
    }
    this.enforceRawEvidenceChars = options.enforceRawEvidenceChars ?? maxRawEvidenceChars < Number.MAX_SAFE_INTEGER;
    this.maxSourceEvidenceRecords = options.maxSourceEvidenceRecords;
  }

  /** Returns the total character count of all admitted evidence text. 返回所有已准入证据文本的总字符数。 */
  get totalChars(): number {
    return this.records.reduce((total, record) => total + record.text.length, 0);
  }

  /**
   * Returns defensive copies of all evidence records sorted by line position.
   * 返回按行位置排序的所有证据记录的防御性副本。
   *
   * @returns Array of evidence record copies / 证据记录副本数组
   */
  list(): CurrentNoteEvidenceRecord[] {
    return this.records.map(copyRecord);
  }

  /**
   * Looks up a single evidence record by its ID.
   * 按 ID 查找单条证据记录。
   *
   * @param evidenceId - The evidence ID to look up / 要查找的证据 ID
   * @returns A defensive copy of the matching record, or undefined / 匹配记录的防御性副本，或 undefined
   */
  get(evidenceId: string): CurrentNoteEvidenceRecord | undefined {
    const record = this.records.find((entry) => entry.evidenceId === evidenceId);
    return record ? copyRecord(record) : undefined;
  }

  /**
   * Admits a single evidence input, merging with an existing record if the same line range is already tracked.
   * 准入单条证据输入，如果相同的行范围已被跟踪则与现有记录合并。
   *
   * @param input - Evidence input to admit / 要准入的证据输入
   * @returns The resulting record and whether it was newly added / 结果记录及是否为新添加
   */
  add(input: CurrentNoteEvidenceInput): { record: CurrentNoteEvidenceRecord; added: boolean } {
    const result = this.addBatch([input]);
    return { record: result.records[0], added: result.addedRecords.length > 0 };
  }

  /**
   * Atomically admits a search page. Every input is validated against this
   * immutable snapshot before the ledger is changed, so a malformed hit can
   * never leave half of a page in retrieved evidence.
   * 原子准入搜索页面。每条输入在账本变更前都会针对此不可变快照进行验证，因此格式错误的命中不会留下半页检索证据。
   *
   * @param inputs - Array of evidence inputs to admit atomically / 要原子准入的证据输入数组
   * @returns All resulting records and the subset that were newly added / 所有结果记录及新添加的子集
   */
  addBatch(inputs: readonly CurrentNoteEvidenceInput[]): {
    records: CurrentNoteEvidenceRecord[];
    addedRecords: CurrentNoteEvidenceRecord[];
  } {
    if (inputs.length === 0) return { records: [], addedRecords: [] };
    const working = this.records.map(copyRecord);
    let nextSequence = this.nextSequence;
    const addedRecords: CurrentNoteEvidenceRecord[] = [];
    const records: CurrentNoteEvidenceRecord[] = [];
    for (const input of inputs) {
      assertEvidenceInput(this.snapshot, input);
      const textHash = sha256(input.text);
      const existingIndex = working.findIndex((record) => canonicalKey(record.snapshotId, record.lineFrom, record.lineTo, record.textHash)
        === canonicalKey(this.snapshot.snapshotId, input.lineFrom, input.lineTo, textHash));
      if (existingIndex >= 0) {
        const merged = mergeRecord(working[existingIndex], input);
        working[existingIndex] = merged;
        records.push(copyRecord(merged));
        continue;
      }
      if (this.maxSourceEvidenceRecords !== undefined && working.length >= this.maxSourceEvidenceRecords) {
        throw new Error('当前笔记证据源记录已达到资源保护上限。');
      }
      const nextTotalChars = working.reduce((total, record) => total + record.text.length, 0) + input.text.length;
      if (this.enforceRawEvidenceChars && nextTotalChars > this.maxRawEvidenceChars) {
        throw new Error('原始证据总量已达到本轮上限。');
      }
      const record = createRecord(this.snapshot, input, textHash, nextSequence);
      nextSequence += 1;
      working.push(record);
      records.push(copyRecord(record));
      addedRecords.push(copyRecord(record));
    }
    this.records = working.sort((first, second) => first.lineFrom - second.lineFrom || first.lineTo - second.lineTo || first.firstSeenSeq - second.firstSeenSeq);
    this.nextSequence = nextSequence;
    return { records, addedRecords };
  }

  /**
   * Converts a set of evidence IDs into citation objects suitable for the assistant response.
   * 将一组证据 ID 转换为适合助手响应的引用对象。
   *
   * @param evidenceIds - IDs of the evidence records to cite / 要引用的证据记录 ID
   * @returns Array of citation objects with preview text / 包含预览文本的引用对象数组
   */
  toCitations(evidenceIds: readonly string[]): AssistantEvidenceCitation[] {
    const ids = new Set(evidenceIds);
    return this.records.filter((record) => ids.has(record.evidenceId)).map((record) => ({
      evidenceId: record.evidenceId,
      notePath: this.snapshot.notePath,
      contentHash: this.snapshot.contentHash,
      headingPath: [...record.headingPath],
      lineFrom: record.lineFrom,
      lineTo: record.lineTo,
      quoteHash: record.textHash,
      preview: record.text.replace(/\s+/gu, ' ').trim().slice(0, 240),
    }));
  }
}

function assertEvidenceInput(snapshot: CurrentNoteSnapshot, input: CurrentNoteEvidenceInput): void {
  if (!Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo) || input.lineFrom < 1 || input.lineTo < input.lineFrom || input.lineTo > snapshot.lineCount) {
    throw new Error('证据行号无效。');
  }
  if (!input.text.trim()) throw new Error('证据正文不能为空。');
  const snapshotBlockIds = new Set(snapshot.blocks.map((block) => block.blockId));
  if (input.blockIds.some((blockId) => !snapshotBlockIds.has(blockId))) throw new Error('证据块不属于当前笔记快照。');
  const source = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, input.lineFrom, input.lineTo);
  if (source !== input.text) throw new Error('证据正文与当前快照不一致。');
}

function createRecord(
  snapshot: CurrentNoteSnapshot,
  input: CurrentNoteEvidenceInput,
  textHash: string,
  firstSeenSeq: number,
): CurrentNoteEvidenceRecord {
  const admission = input.admission ?? 'explicit-read';
  const sourceToolCallIds = uniqueStrings([...(input.sourceToolCallIds ?? []), input.sourceToolCallId]);
  const goalIds = input.goalId ? [input.goalId] : [];
  const searchHitIds = input.searchHitId ? [input.searchHitId] : [];
  return {
    evidenceId: createEvidenceId(snapshot.snapshotId, input.lineFrom, input.lineTo, textHash),
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    blockIds: uniqueStrings(input.blockIds).sort(compareText),
    headingPath: [...input.headingPath],
    lineFrom: input.lineFrom,
    lineTo: input.lineTo,
    text: input.text,
    textHash,
    matchedTerms: uniqueStrings(input.matchedTerms).sort(compareText),
    supports: uniqueStrings(input.supports).sort(compareText),
    sourceToolCallId: sourceToolCallIds[0] ?? input.sourceToolCallId,
    sourceToolCallIds,
    admission,
    admissions: [admission],
    goalIds,
    searchHitIds,
    firstSeenSeq,
    ...(input.bestScore !== undefined ? { bestScore: input.bestScore } : {}),
  };
}

function mergeRecord(record: CurrentNoteEvidenceRecord, input: CurrentNoteEvidenceInput): CurrentNoteEvidenceRecord {
  const admission = input.admission ?? 'explicit-read';
  const admissions = uniqueValues([...record.admissions, admission]);
  const sourceToolCallIds = uniqueStrings([
    ...(record.sourceToolCallIds ?? [record.sourceToolCallId]),
    ...(input.sourceToolCallIds ?? []),
    input.sourceToolCallId,
  ]);
  return {
    ...record,
    blockIds: uniqueStrings([...record.blockIds, ...input.blockIds]).sort(compareText),
    matchedTerms: uniqueStrings([...record.matchedTerms, ...input.matchedTerms]).sort(compareText),
    supports: uniqueStrings([...record.supports, ...input.supports]).sort(compareText),
    sourceToolCallId: record.sourceToolCallId,
    sourceToolCallIds,
    admission: admissions.includes('search-hit') ? 'search-hit' : record.admission,
    admissions,
    goalIds: uniqueStrings([...record.goalIds, ...(input.goalId ? [input.goalId] : [])]).sort(compareText),
    searchHitIds: uniqueStrings([...record.searchHitIds, ...(input.searchHitId ? [input.searchHitId] : [])]).sort(compareText),
    ...(record.bestScore === undefined && input.bestScore === undefined
      ? {}
      : { bestScore: Math.max(record.bestScore ?? Number.NEGATIVE_INFINITY, input.bestScore ?? Number.NEGATIVE_INFINITY) }),
  };
}

function createEvidenceId(snapshotId: string, lineFrom: number, lineTo: number, textHash: string): string {
  return `evidence-${sha256(`${snapshotId}\u0000${lineFrom}\u0000${lineTo}\u0000${textHash}`).slice(0, 24)}`;
}

function canonicalKey(snapshotId: string, lineFrom: number, lineTo: number, textHash: string): string {
  return `${snapshotId}\u0000${lineFrom}\u0000${lineTo}\u0000${textHash}`;
}

function copyRecord(record: CurrentNoteEvidenceRecord): CurrentNoteEvidenceRecord {
  return {
    ...record,
    blockIds: [...record.blockIds],
    headingPath: [...record.headingPath],
    matchedTerms: [...record.matchedTerms],
    supports: [...record.supports],
    sourceToolCallIds: [...(record.sourceToolCallIds ?? [record.sourceToolCallId])],
    admissions: [...(record.admissions ?? [record.admission])],
    goalIds: [...(record.goalIds ?? [])],
    searchHitIds: [...(record.searchHitIds ?? [])],
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueValues<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
