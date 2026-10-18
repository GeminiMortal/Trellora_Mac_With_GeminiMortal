/**
 * Task-local evidence ledger for selection-edit research sessions.
 * 选择编辑研究会话的任务级证据台账。
 *
 * Manages retrieval candidates (materials, web, current-note, library) separately
 * from verified evidence: only bounded deep reads or successful web fetches can
 * promote a candidate into a `SelectionEvidenceItem`.
 * 管理检索候选项（资料库、网页、当前笔记、笔记库）与已验证证据的分离：
 * 只有受限深读或成功的网页抓取才能将候选项提升为 `SelectionEvidenceItem`。
 */
import { createHash } from 'node:crypto';
import type {
  SelectionContextReceipt,
  SelectionEditFactSourceKind,
  SelectionEvidenceItem,
} from './selectionEditTypes.ts';

/**
 * Candidate parent-block from the materials library before deep read.
 * 资料库父块候选项，在深读之前的状态。
 */
export interface SelectionEditMaterialCandidate {
  documentId: string;
  ordinal: number;
  title: string;
  sourceContentHash: string;
  queryTerms: readonly string[];
  retrievalMethod: 'knowledge_search' | 'grep_chunks';
  score?: number;
  goalIds: readonly string[];
}

/**
 * Candidate web page before full-page fetch verification.
 * 网页候选项，在全文抓取核验之前的状态。
 */
export interface SelectionEditWebCandidate {
  url: string;
  title: string;
  source: string;
  queryTerms: readonly string[];
  goalIds: readonly string[];
}

/**
 * Candidate block range within the current editing note.
 * 当前编辑笔记中的候选块范围。
 */
export interface SelectionEditCurrentNoteCandidate {
  snapshotId: string;
  contentHash: string;
  blockId: string;
  title: string;
  headingPath: readonly string[];
  lineFrom: number;
  lineTo: number;
  queryTerms: readonly string[];
  goalIds: readonly string[];
  score?: number;
}

/**
 * Candidate note from the note library (same vault).
 * 笔记库中的候选笔记（同库）。
 */
export interface SelectionEditLibraryNoteCandidate {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  title: string;
  relativePath: string;
  queryTerms: readonly string[];
  goalIds: readonly string[];
  score?: number;
}

/**
 * Candidate block within a library note.
 * 笔记库笔记中的候选块。
 */
export interface SelectionEditLibraryBlockCandidate {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  blockId: string;
  title: string;
  headingPath: readonly string[];
  lineFrom: number;
  lineTo: number;
  queryTerms: readonly string[];
  goalIds: readonly string[];
  score?: number;
}

/**
 * Task-local selection-edit ledger. Retrieval candidates remain separate from
 * verified evidence: only a bounded material deep read or a successful web
 * fetch can add a SelectionEvidenceItem.
 * 任务级选择编辑台账。检索候选项与已验证证据保持分离：
 * 只有受限的资料深读或成功的网页抓取才能添加 SelectionEvidenceItem。
 */
export class SelectionEditEvidenceSession {
  private readonly candidates = new Map<string, SelectionContextReceipt['candidates'][number]>();
  private readonly materialCandidates = new Map<string, SelectionEditMaterialCandidate>();
  private readonly webCandidates = new Map<string, SelectionEditWebCandidate>();
  private readonly currentNoteCandidates = new Map<string, SelectionEditCurrentNoteCandidate>();
  private readonly libraryNoteCandidates = new Map<string, SelectionEditLibraryNoteCandidate>();
  private readonly libraryBlockCandidates = new Map<string, SelectionEditLibraryBlockCandidate>();
  private readonly evidence = new Map<string, SelectionEvidenceItem>();
  private readonly planned: SelectionContextReceipt['planned'] = [];
  private readonly skipped: SelectionContextReceipt['skipped'] = [];

  constructor(private readonly maxEvidenceCharacters = 9_000) {
    if (!Number.isSafeInteger(maxEvidenceCharacters) || maxEvidenceCharacters < 1) {
      throw new Error('选择编辑证据容量无效。');
    }
  }

  /**
   * Total character count of all verified evidence items.
   * 所有已验证证据项的总字符数。
   */
  get evidenceCharacters(): number {
    return [...this.evidence.values()].reduce((total, item) => total + item.content.length, 0);
  }

  /**
   * Remaining character budget before evidence capacity is exhausted.
   * 证据容量耗尽前的剩余字符预算。
   */
  get remainingEvidenceCharacters(): number {
    return Math.max(0, this.maxEvidenceCharacters - this.evidenceCharacters);
  }

  /**
   * Record a planned evidence source (deduplicated by kind + reason).
   * 记录计划的证据来源（按类型+原因去重）。
   *
   * @param sourceKind - The source category / 来源类别
   * @param reason - Why this source is planned / 计划该来源的原因
   */
  plan(sourceKind: SelectionEditFactSourceKind, reason: string): void {
    if (!this.planned.some((item) => item.sourceKind === sourceKind && item.reason === reason)) {
      this.planned.push({ sourceKind, reason });
    }
  }

  /**
   * Record a skipped evidence source with reason.
   * 记录被跳过的证据来源及原因。
   *
   * @param sourceKind - The source category / 来源类别
   * @param reason - Why this source was skipped / 跳过原因
   */
  skip(sourceKind: SelectionEditFactSourceKind, reason: string): void {
    this.skipped.push({ sourceKind, reason });
  }

  /**
   * Record or merge a material library retrieval candidate.
   * 记录或合并资料库检索候选项。
   *
   * If the candidate already exists, query terms, goal IDs, retrieval method
   * and score are merged; otherwise a new candidate and receipt are created.
   * 若候选项已存在，则合并查询词、目标 ID、检索方法和分数；
   * 否则创建新的候选项和收据。
   *
   * @param input - Material candidate data / 资料候选数据
   */
  recordMaterialCandidate(input: SelectionEditMaterialCandidate): void {
    const candidateId = `materials:${input.documentId}:${input.ordinal}`;
    const existing = this.materialCandidates.get(candidateId);
    if (existing) {
      this.materialCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        retrievalMethod: existing.retrievalMethod === input.retrievalMethod ? existing.retrievalMethod : 'knowledge_search',
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.retrievalMethod = unique([receipt.retrievalMethod, input.retrievalMethod]).join(' + ');
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.materialCandidates.set(candidateId, { ...input, queryTerms: unique(input.queryTerms), goalIds: unique(input.goalIds) });
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'materials',
      title: input.title,
      locator: `资料库 / ${input.title} / 父块 ${input.ordinal}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: input.retrievalMethod,
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.sourceContentHash,
    });
  }

  /**
   * Look up a material candidate by document ID and ordinal.
   * 按文档 ID 和序号查找资料候选项。
   *
   * @param documentId - Document identifier / 文档标识
   * @param ordinal - Parent block ordinal / 父块序号
   * @returns The candidate if found / 找到时返回候选项
   */
  materialCandidate(documentId: string, ordinal: number): SelectionEditMaterialCandidate | undefined {
    return this.materialCandidates.get(`materials:${documentId}:${ordinal}`);
  }

  /**
   * Record or merge a web page candidate from web search.
   * 记录或合并来自网页搜索的候选项。
   *
   * @param input - Web candidate data / 网页候选数据
   */
  recordWebCandidate(input: SelectionEditWebCandidate): void {
    const candidateId = `web:${hashText(input.url).slice(0, 24)}`;
    const existing = this.webCandidates.get(input.url);
    if (existing) {
      this.webCandidates.set(input.url, {
        ...existing,
        title: input.title || existing.title,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
      return;
    }
    this.webCandidates.set(input.url, { ...input, queryTerms: unique(input.queryTerms), goalIds: unique(input.goalIds) });
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'web',
      title: input.title,
      locator: `网页 / ${safeHostname(input.url)}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'web_search（摘要仅用于定位）',
      readState: 'candidate',
      pageVerified: false,
    });
  }

  /**
   * Look up a web candidate by URL.
   * 按 URL 查找网页候选项。
   *
   * @param url - The web page URL / 网页 URL
   * @returns The candidate if found / 找到时返回候选项
   */
  webCandidate(url: string): SelectionEditWebCandidate | undefined {
    return this.webCandidates.get(url);
  }

  /**
   * Record or merge a current-note block candidate.
   * 记录或合并当前笔记的块候选项。
   *
   * @param input - Current note candidate data / 当前笔记候选数据
   */
  recordCurrentNoteCandidate(input: SelectionEditCurrentNoteCandidate): void {
    const candidateId = currentNoteCandidateId(input.snapshotId, input.blockId);
    const existing = this.currentNoteCandidates.get(candidateId);
    if (existing) {
      this.currentNoteCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.currentNoteCandidates.set(candidateId, copyCurrentNoteCandidate(input));
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'current-note',
      title: input.title,
      locator: `当前笔记 / L${input.lineFrom}-L${input.lineTo}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'search_note（候选仅用于定位）',
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.contentHash,
    });
  }

  /**
   * Find a current-note candidate that covers the given line range.
   * 查找覆盖指定行范围的当前笔记候选项。
   *
   * @param snapshotId - Note snapshot ID / 笔记快照 ID
   * @param lineFrom - Start line / 起始行
   * @param lineTo - End line / 结束行
   * @returns The covering candidate if found / 找到时返回覆盖候选项
   */
  currentNoteCandidateForRange(snapshotId: string, lineFrom: number, lineTo: number): SelectionEditCurrentNoteCandidate | undefined {
    return [...this.currentNoteCandidates.values()].find((candidate) => candidate.snapshotId === snapshotId
      && candidate.lineFrom <= lineFrom && candidate.lineTo >= lineTo);
  }

  /**
   * Record or merge a library note candidate.
   * 记录或合并笔记库笔记候选项。
   *
   * @param input - Library note candidate data / 笔记库候选数据
   */
  recordLibraryNoteCandidate(input: SelectionEditLibraryNoteCandidate): void {
    const candidateId = libraryNoteCandidateId(input.noteId);
    const existing = this.libraryNoteCandidates.get(candidateId);
    if (existing) {
      this.libraryNoteCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.libraryNoteCandidates.set(candidateId, copyLibraryNoteCandidate(input));
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'note-library',
      title: input.title,
      locator: `笔记库 / ${input.relativePath}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'search_note_library（候选仅用于定位）',
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.contentHash,
    });
  }

  /**
   * Look up a library note candidate by note ID.
   * 按笔记 ID 查找笔记库候选项。
   *
   * @param noteId - Library note identifier / 笔记库笔记标识
   * @returns The candidate if found / 找到时返回候选项
   */
  libraryNoteCandidate(noteId: string): SelectionEditLibraryNoteCandidate | undefined {
    return this.libraryNoteCandidates.get(libraryNoteCandidateId(noteId));
  }

  /**
   * Record or merge a library block candidate. The parent note must already be a candidate.
   * 记录或合并笔记库块候选项。父笔记必须已经是候选项。
   *
   * @param input - Library block candidate data / 笔记库块候选数据
   * @throws If the parent note is not yet a candidate / 若父笔记尚未成为候选项则抛出异常
   */
  recordLibraryBlockCandidate(input: SelectionEditLibraryBlockCandidate): void {
    if (!this.libraryNoteCandidate(input.noteId)) throw new Error('同库块候选必须来自本轮笔记候选。');
    const candidateId = libraryBlockCandidateId(input.noteId, input.blockId);
    const existing = this.libraryBlockCandidates.get(candidateId);
    if (existing) {
      this.libraryBlockCandidates.set(candidateId, {
        ...existing,
        queryTerms: unique([...existing.queryTerms, ...input.queryTerms]),
        goalIds: unique([...existing.goalIds, ...input.goalIds]),
        score: Math.max(existing.score ?? 0, input.score ?? 0),
      });
      const receipt = this.candidates.get(candidateId);
      if (receipt) {
        receipt.queryTerms = unique([...receipt.queryTerms, ...input.queryTerms]);
        receipt.score = Math.max(receipt.score ?? 0, input.score ?? 0);
      }
      return;
    }
    this.libraryBlockCandidates.set(candidateId, copyLibraryBlockCandidate(input));
    this.candidates.set(candidateId, {
      candidateId,
      sourceKind: 'note-library',
      title: input.title,
      locator: `笔记库 / ${input.title} / L${input.lineFrom}-L${input.lineTo}`,
      queryTerms: unique(input.queryTerms),
      retrievalMethod: 'search_library_note_blocks（候选仅用于定位）',
      readState: 'candidate',
      ...(input.score === undefined ? {} : { score: input.score }),
      sourceContentHash: input.contentHash,
    });
  }

  /**
   * Find a library block candidate that covers the given line range.
   * 查找覆盖指定行范围的笔记库块候选项。
   *
   * @param noteId - Library note ID / 笔记库笔记 ID
   * @param lineFrom - Start line / 起始行
   * @param lineTo - End line / 结束行
   * @returns The covering candidate if found / 找到时返回覆盖候选项
   */
  libraryBlockCandidateForRange(noteId: string, lineFrom: number, lineTo: number): SelectionEditLibraryBlockCandidate | undefined {
    return [...this.libraryBlockCandidates.values()].find((candidate) => candidate.noteId === noteId
      && candidate.lineFrom <= lineFrom && candidate.lineTo >= lineTo);
  }

  /**
   * Register verified evidence from a material deep read.
   * 注册来自资料深读的已验证证据。
   *
   * The target must be an existing material candidate; content hash is verified
   * to prevent stale reads from becoming evidence.
   * 目标必须是已有的资料候选项；验证内容哈希以防止过期读取成为证据。
   *
   * @param input - Deep-read result / 深读结果
   * @returns The evidence item and whether it was newly added / 证据项及其是否为新添加
   */
  registerMaterialEvidence(input: {
    documentId: string;
    ordinal: number;
    title: string;
    sourceContentHash: string;
    content: string;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const candidate = this.materialCandidate(input.documentId, input.ordinal);
    if (!candidate) throw new Error('资料深读目标不在本轮检索候选中。');
    const evidenceId = `evidence-${hashText(`${input.documentId}\u0000${input.ordinal}\u0000${input.sourceContentHash}\u0000${input.content}`).slice(0, 24)}`;
    const existing = this.evidence.get(evidenceId);
    if (!existing) this.assertEvidenceCapacity(input.content, evidenceId);
    this.markCandidateRead(`materials:${input.documentId}:${input.ordinal}`, `资料库 / ${input.title} / 父块 ${input.ordinal}`, true);
    if (existing) return { item: existing, added: false };
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'materials',
      title: input.title,
      locator: `资料库 / ${input.title} / 父块 ${input.ordinal}`,
      content: input.content,
      sourceContentHash: input.sourceContentHash,
      textHash: hashText(input.content),
      goalIds: [...candidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  /**
   * Register verified evidence from a web page full fetch.
   * 注册来自网页全文抓取的已验证证据。
   *
   * @param input - Web fetch result / 网页抓取结果
   * @returns The evidence item and whether it was newly added / 证据项及其是否为新添加
   */
  registerWebEvidence(input: {
    url: string;
    title: string;
    verifiedContentHash: string;
    content: string;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const candidate = this.webCandidate(input.url);
    if (!candidate) throw new Error('网页抓取地址不在本轮 web_search 白名单中。');
    const evidenceId = `evidence-web-${hashText(`${input.url}\u0000${input.verifiedContentHash}`).slice(0, 24)}`;
    const candidateId = `web:${hashText(input.url).slice(0, 24)}`;
    const existing = this.evidence.get(evidenceId);
    if (!existing) this.assertEvidenceCapacity(input.content, evidenceId);
    this.markCandidateRead(candidateId, `网页 / ${safeHostname(input.url)}`, true);
    if (existing) return { item: existing, added: false };
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'web',
      title: input.title,
      locator: `网页 / ${safeHostname(input.url)}`,
      content: input.content,
      sourceContentHash: input.verifiedContentHash,
      textHash: hashText(input.content),
      goalIds: [...candidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  /**
   * Register verified evidence from a current-note deep read.
   * 注册来自当前笔记深读的已验证证据。
   *
   * @param input - Current-note read result / 当前笔记读取结果
   * @returns The evidence item and whether it was newly added / 证据项及其是否为新添加
   */
  registerCurrentNoteEvidence(input: {
    snapshotId: string;
    contentHash: string;
    title: string;
    headingPath: readonly string[];
    lineFrom: number;
    lineTo: number;
    text: string;
    contentOffset?: number;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const candidate = this.currentNoteCandidateForRange(input.snapshotId, input.lineFrom, input.lineTo);
    if (!candidate || candidate.contentHash !== input.contentHash) {
      throw new Error('当前笔记深读目标不属于本轮稳定候选。');
    }
    const evidenceId = `evidence-current-${hashText(`${input.snapshotId}\u0000${input.lineFrom}\u0000${input.lineTo}\u0000${input.contentOffset ?? ''}\u0000${input.text}`).slice(0, 24)}`;
    const candidateId = currentNoteCandidateId(candidate.snapshotId, candidate.blockId);
    const existing = this.evidence.get(evidenceId);
    if (existing) return { item: existing, added: false };
    this.assertEvidenceCapacity(input.text, evidenceId);
    this.markCandidateRead(candidateId, `当前笔记 / L${input.lineFrom}-L${input.lineTo}`, true);
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'current-note',
      title: input.title,
      locator: `当前笔记 / L${input.lineFrom}-L${input.lineTo}${input.contentOffset === undefined ? '' : ` / 起始字符 ${input.contentOffset + 1}`}`,
      headingPath: [...input.headingPath],
      content: input.text,
      sourceContentHash: input.contentHash,
      textHash: hashText(input.text),
      goalIds: [...candidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  /**
   * Register verified evidence from a library note deep read.
   * 注册来自笔记库深读的已验证证据。
   *
   * Both the parent note and the block must already be candidates with matching
   * snapshot and content hashes.
   * 父笔记和块都必须已经是候选项，且快照和内容哈希匹配。
   *
   * @param input - Library note read result / 笔记库读取结果
   * @returns The evidence item and whether it was newly added / 证据项及其是否为新添加
   */
  registerLibraryEvidence(input: {
    noteId: string;
    snapshotId: string;
    contentHash: string;
    title: string;
    relativePath: string;
    headingPath: readonly string[];
    lineFrom: number;
    lineTo: number;
    text: string;
  }): { item: SelectionEvidenceItem; added: boolean } {
    const noteCandidate = this.libraryNoteCandidate(input.noteId);
    const blockCandidate = this.libraryBlockCandidateForRange(input.noteId, input.lineFrom, input.lineTo);
    if (!noteCandidate || !blockCandidate || noteCandidate.snapshotId !== input.snapshotId
      || blockCandidate.snapshotId !== input.snapshotId || noteCandidate.contentHash !== input.contentHash
      || blockCandidate.contentHash !== input.contentHash) {
      throw new Error('同库深读目标不属于本轮稳定候选。');
    }
    const evidenceId = `evidence-library-${hashText(`${input.noteId}\u0000${input.snapshotId}\u0000${input.lineFrom}\u0000${input.lineTo}\u0000${input.text}`).slice(0, 24)}`;
    const existing = this.evidence.get(evidenceId);
    if (existing) return { item: existing, added: false };
    this.assertEvidenceCapacity(input.text, evidenceId);
    this.markCandidateRead(libraryNoteCandidateId(input.noteId), `笔记库 / ${input.relativePath}`, true);
    this.markCandidateRead(libraryBlockCandidateId(blockCandidate.noteId, blockCandidate.blockId), `笔记库 / ${input.relativePath} / L${input.lineFrom}-L${input.lineTo}`, true);
    const item: SelectionEvidenceItem = {
      evidenceId,
      sourceKind: 'note-library',
      title: input.title,
      locator: `笔记库 / ${input.relativePath} / L${input.lineFrom}-L${input.lineTo}`,
      headingPath: [...input.headingPath],
      content: input.text,
      sourceContentHash: input.contentHash,
      textHash: hashText(input.text),
      goalIds: [...blockCandidate.goalIds],
      readVerified: true,
      pageVerified: true,
    };
    this.evidence.set(evidenceId, item);
    return { item, added: true };
  }

  /**
   * Mark a candidate as skipped with a reason (only if not already deep-read).
   * 将候选项标记为跳过并附原因（仅当尚未深读时生效）。
   *
   * @param candidateId - Candidate identifier / 候选标识
   * @param reason - Skip reason / 跳过原因
   */
  markCandidateSkipped(candidateId: string, reason: string): void {
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.readState === 'deep-read') return;
    candidate.readState = 'skipped';
    candidate.reason = reason;
  }

  /**
   * Return all verified evidence items collected in this session.
   * 返回本会话中收集的所有已验证证据项。
   */
  evidenceItems(): SelectionEvidenceItem[] {
    return [...this.evidence.values()];
  }

  /**
   * Build the final context receipt, marking remaining candidates as skipped.
   * 构建最终上下文收据，将剩余候选项标记为跳过。
   *
   * Candidates that were never deep-read are automatically marked as skipped
   * since they cannot serve as verified evidence.
   * 从未深读的候选项会被自动标记为跳过，因为它们不能作为已验证证据。
   */
  receipt(): Pick<SelectionContextReceipt, 'planned' | 'used' | 'skipped' | 'candidates' | 'conflicts'> {
    for (const candidate of this.candidates.values()) {
      if (candidate.readState === 'candidate') {
        candidate.readState = 'skipped';
        candidate.reason = '候选未完成本轮受限深读或网页全文核验，不能作为事实证据。';
      }
    }
    const evidence = this.evidenceItems();
    return {
      planned: [...this.planned],
      used: evidence.map((item) => ({ sourceKind: item.sourceKind, title: item.title, locator: item.locator, characterCount: item.content.length })),
      skipped: [...this.skipped],
      candidates: [...this.candidates.values()].map((item) => ({ ...item, queryTerms: [...item.queryTerms] })),
      conflicts: [],
    };
  }

  /**
   * Internal: mark a candidate receipt as deep-read.
   * 内部方法：将候选收据标记为已深读。
   */
  private markCandidateRead(candidateId: string, locator: string, pageVerified: boolean): void {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return;
    candidate.readState = 'deep-read';
    candidate.locator = locator;
    if (candidate.sourceKind === 'web') candidate.pageVerified = pageVerified;
  }

  /**
   * Internal: assert that adding new evidence won't exceed the character budget.
   * 内部方法：确认添加新证据不会超出字符预算。
   *
   * @throws If capacity would be exceeded / 若超出容量则抛出异常
   */
  private assertEvidenceCapacity(content: string, evidenceId: string): void {
    const existing = this.evidence.get(evidenceId);
    if (existing) return;
    if (content.length + this.evidenceCharacters > this.maxEvidenceCharacters) {
      throw new Error('本轮选择编辑的原文证据已达到总量上限。');
    }
  }
}

/**
 * Build a deterministic candidate ID for a current-note block.
 * 为当前笔记块构建确定性候选 ID。
 */
function currentNoteCandidateId(snapshotId: string, blockId: string): string {
  return `current-note:${snapshotId}:${blockId}`;
}

/**
 * Build a deterministic candidate ID for a library note.
 * 为笔记库笔记构建确定性候选 ID。
 */
function libraryNoteCandidateId(noteId: string): string {
  return `note-library:${noteId}`;
}

/**
 * Build a deterministic candidate ID for a library block.
 * 为笔记库块构建确定性候选 ID。
 */
function libraryBlockCandidateId(noteId: string, blockId: string): string {
  return `note-library:${noteId}:${blockId}`;
}

/**
 * Deep-copy a current-note candidate to prevent shared-reference mutation.
 * 深拷贝当前笔记候选项以防止共享引用突变。
 */
function copyCurrentNoteCandidate(candidate: SelectionEditCurrentNoteCandidate): SelectionEditCurrentNoteCandidate {
  return { ...candidate, headingPath: [...candidate.headingPath], queryTerms: [...candidate.queryTerms], goalIds: [...candidate.goalIds] };
}

/**
 * Deep-copy a library note candidate to prevent shared-reference mutation.
 * 深拷贝笔记库笔记候选项以防止共享引用突变。
 */
function copyLibraryNoteCandidate(candidate: SelectionEditLibraryNoteCandidate): SelectionEditLibraryNoteCandidate {
  return { ...candidate, queryTerms: [...candidate.queryTerms], goalIds: [...candidate.goalIds] };
}

/**
 * Deep-copy a library block candidate to prevent shared-reference mutation.
 * 深拷贝笔记库块候选项以防止共享引用突变。
 */
function copyLibraryBlockCandidate(candidate: SelectionEditLibraryBlockCandidate): SelectionEditLibraryBlockCandidate {
  return { ...candidate, headingPath: [...candidate.headingPath], queryTerms: [...candidate.queryTerms], goalIds: [...candidate.goalIds] };
}

/**
 * SHA-256 hash of a UTF-8 string, returned as hex.
 * UTF-8 字符串的 SHA-256 哈希，返回十六进制。
 */
function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Deduplicate and trim a string array, filtering out empty values.
 * 去重并修剪字符串数组，过滤空值。
 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Safely extract hostname from a URL, returning fallback on parse failure.
 * 安全地从 URL 中提取主机名，解析失败时返回兜底值。
 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '受限地址';
  }
}
