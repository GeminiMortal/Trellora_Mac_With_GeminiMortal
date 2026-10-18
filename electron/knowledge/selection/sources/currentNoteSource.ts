/**
 * Current-note evidence source adapter for selection editing: gathers bounded,
 * Ledger-admitted raw text from the active note under the strict small-note
 * policy, with no model, IPC, filesystem, or writeback authority.
 * 选区编辑的当前笔记证据源适配器：在严格小笔记策略下从当前笔记采集受限、
 * 经证据账本准入的原文，不持有模型、IPC、文件系统或回写权限。
 */
import { CurrentNoteEvidenceLedger } from '../../currentNote/currentNoteEvidenceLedger.ts';
import { evaluateStrictSmallNotePolicy, type CurrentNoteContextCapacity, type StrictSmallNoteDecision } from '../../currentNote/currentNotePolicy.ts';
import type { CurrentNoteSnapshot } from '../../currentNote/currentNoteSnapshot.ts';
import { createCurrentNoteTools, materializeCurrentNoteSearchHit } from '../../currentNote/currentNoteTools.ts';
import { tokenizeCurrentNoteText } from '../../currentNote/currentNoteStructure.ts';
import { estimateTokenCount } from '../../model/tokenEstimator.ts';
import type { SelectionContextReceipt, SelectionEvidenceItem } from '../../selectionEditTypes.ts';

/**
 * Default evidence budgets shared by the adapter: character/token ceilings, a
 * per-goal deep-read cap, a source record cap, and the search page size.
 * 适配器共享的默认证据预算：字符/Token 上限、每个目标的深读上限、来源记录上限与搜索分页大小。
 */
const DEFAULT_MAX_EVIDENCE_CHARACTERS = 9_000;
const DEFAULT_MAX_EVIDENCE_TOKENS = 2_048;
const DEFAULT_MAX_EVIDENCE_PER_GOAL = 2;
const DEFAULT_MAX_SOURCE_RECORDS = 8;
const SEARCH_PAGE_SIZE = 8;

/**
 * A research goal guiding which parts of the current note are worth reading.
 * 指导当前笔记哪些部分值得深读的研究目标。
 */
/**
 * A research goal guiding which parts of the current note are worth reading.
 * 指导当前笔记哪些部分值得深读的研究目标。
 */
export interface SelectionEditCurrentNoteGoal {
  goalId: string;
  question: string;
  queryTerms: readonly string[];
}

/**
 * Optional caller overrides for the evidence budgets of this source adapter.
 * 调用方可选的证据预算覆盖项。
 */
export interface SelectionEditCurrentNoteSourceLimits {
  maxEvidenceCharacters?: number;
  maxEvidenceTokens?: number;
  maxEvidencePerGoal?: number;
  maxSourceEvidenceRecords?: number;
}

/**
 * A receipt describes what this source adapter really read. Search hits are
 * deliberately kept separate from `used`: only Ledger-admitted raw text is
 * allowed to enter the synthesis prompt.
 * 回执描述本证据源适配器真实读取的内容。搜索命中与 `used` 刻意分离：
 * 只有经证据账本准入的原文才能进入合成提示词。
 */
export interface CurrentNoteSelectionContextReceipt extends SelectionContextReceipt {
  snapshotId: string;
  contentHash: string;
  strictSmallNote: StrictSmallNoteDecision;
  noteMap: {
    read: true;
    headingCount: number;
    lineCount: number;
  };
  candidateSearches: Array<{
    goalId: string;
    queryTerms: string[];
    candidateCount: number;
    candidateExhausted: boolean;
    nextCursorAvailable: boolean;
    materializedCount: number;
  }>;
  evidenceCharacters: number;
  evidenceTokens: number;
  evidenceTokenBudget: number;
}

/**
 * Output of the current-note adapter: admitted evidence plus its receipt.
 * 当前笔记适配器的输出：已准入证据及其回执。
 */
export interface SelectionEditCurrentNoteSourceResult {
  evidence: SelectionEvidenceItem[];
  receipt: CurrentNoteSelectionContextReceipt;
}

/**
 * Input required to collect current-note context for one selection edit run.
 * 单次选区编辑运行采集当前笔记上下文所需的输入。
 */
export interface CollectSelectionEditCurrentNoteContextInput {
  snapshot: CurrentNoteSnapshot;
  selectedText: string;
  goals: readonly SelectionEditCurrentNoteGoal[];
  capacity: CurrentNoteContextCapacity;
  limits?: SelectionEditCurrentNoteSourceLimits;
  isSnapshotCurrent?: () => boolean;
  onProgress?: (message: string) => void;
}

/**
 * Current-note adapter for selection editing. It has no model, IPC, filesystem
 * or writeback authority. A full note is admissible only under the strict
 * policy; every other path is map -> paged candidate search -> raw deep read
 * -> Evidence Ledger.
 * 选区编辑的当前笔记适配器。它不持有模型、IPC、文件系统或回写权限。仅在严格
 * 策略下允许全文直读；其余路径均为：笔记地图 -> 分页候选搜索 -> 原文深读 -> 证据账本。
 *
 * @param input - Snapshot, selection, goals, capacity and limits / 快照、选区、目标、容量与预算
 * @returns Admitted evidence and the collection receipt / 已准入证据与采集回执
 */
export function collectSelectionEditCurrentNoteContext(
  input: CollectSelectionEditCurrentNoteContextInput,
): SelectionEditCurrentNoteSourceResult {
  const { snapshot, selectedText } = input;
  if (!selectedText.trim()) throw new Error('选区正文不能为空。');
  assertSnapshotCurrent(input);

  const limits = resolveLimits(input.limits, input.capacity);
  // Strict policy gates the only path that may admit the whole note as one read.
  // 严格策略是唯一允许把整篇笔记一次性准入路径的闸门。
  const strictSmallNote = evaluateStrictSmallNotePolicy({
    characters: snapshot.markdown.length,
    lineCount: snapshot.lineCount,
    tokenEstimate: snapshot.tokenEstimate,
  }, input.capacity);
  const tools = createCurrentNoteTools(snapshot);
  input.onProgress?.('已读取当前笔记结构。');
  const noteMap = tools.getNoteMap('outline');
  assertSnapshotCurrent(input);

  // The ledger enforces raw-evidence character budgets and per-source record caps.
  // 证据账本强制执行原文证据的字符预算与每来源记录上限。
  const ledger = new CurrentNoteEvidenceLedger(snapshot, limits.maxEvidenceCharacters, {
    enforceRawEvidenceChars: true,
    maxSourceEvidenceRecords: limits.maxSourceEvidenceRecords,
  });
  const candidateSearches: CurrentNoteSelectionContextReceipt['candidateSearches'] = [];
  let evidenceTokens = 0;
  const plannedReason = strictSmallNote.allowed
    ? '当前笔记满足严格小笔记全文直读门槛。'
    : '当前笔记未满足全文直读门槛，按结构、候选和原文深读取证。';

  if (strictSmallNote.allowed) {
    input.onProgress?.('当前笔记满足严格小笔记策略，正在读取全文原文。');
    const fullNote = tools.readNoteRange({ lineFrom: 1, lineTo: snapshot.lineCount });
    ledger.add({
      blockIds: fullNote.blockIds,
      headingPath: fullNote.headingPath,
      lineFrom: fullNote.lineFrom,
      lineTo: fullNote.lineTo,
      text: fullNote.text,
      matchedTerms: [],
      supports: input.goals.map((goal) => goal.question),
      sourceToolCallId: 'selection-edit:current-note:strict-full-read',
      admission: 'explicit-read',
    });
    evidenceTokens = estimateTokenCount(fullNote.text);
    assertSnapshotCurrent(input);
    return finalizeContext({
      snapshot,
      strictSmallNote,
      noteMap,
      candidateSearches,
      ledger,
      evidenceTokens,
      evidenceTokenBudget: limits.maxEvidenceTokens,
      plannedReason,
      fullNoteMode: 'strict-direct',
    });
  }

  const selectedFragments = splitSelectedFragments(selectedText);
  for (const goal of input.goals) {
    assertSnapshotCurrent(input);
    const queryTerms = resolveQueryTerms(goal.queryTerms, selectedText);
    if (queryTerms.length === 0) {
      candidateSearches.push({
        goalId: goal.goalId,
        queryTerms: [],
        candidateCount: 0,
        candidateExhausted: true,
        nextCursorAvailable: false,
        materializedCount: 0,
      });
      continue;
    }

    input.onProgress?.(`正在定位“${goal.question.slice(0, 48)}”的候选原文。`);
    const page = tools.searchNotePage(queryTerms, SEARCH_PAGE_SIZE);
    let materializedCount = 0;
    // Per-hit admission: skip the selection itself, then check char/token budgets.
    // 每条命中的准入：先跳过选区自身，再校验字符/Token 预算。
    for (const hit of page.hits) {
      if (materializedCount >= limits.maxEvidencePerGoal || ledger.totalChars >= limits.maxEvidenceCharacters) break;
      const original = materializeCurrentNoteSearchHit(snapshot, hit);
      if (isSelectedBlock(original.text, selectedText, selectedFragments)) continue;
      if (original.text.length + ledger.totalChars > limits.maxEvidenceCharacters) continue;
      const originalTokens = estimateTokenCount(original.text);
      if (originalTokens + evidenceTokens > limits.maxEvidenceTokens) continue;
      input.onProgress?.(`正在读取第 ${original.lineFrom}–${original.lineTo} 行原文。`);
      const admitted = ledger.add({
        blockIds: [original.blockId],
        headingPath: original.headingPath,
        lineFrom: original.lineFrom,
        lineTo: original.lineTo,
        text: original.text,
        matchedTerms: hit.matchedTerms,
        supports: [goal.question],
        sourceToolCallId: `selection-edit:current-note:${goal.goalId}:search`,
        admission: 'search-hit',
        goalId: goal.goalId,
        searchHitId: hit.hitId,
        bestScore: hit.score,
      });
      if (admitted.added) {
        materializedCount += 1;
        evidenceTokens += originalTokens;
      }
      assertSnapshotCurrent(input);
    }
    candidateSearches.push({
      goalId: goal.goalId,
      queryTerms,
      candidateCount: page.hits.length,
      candidateExhausted: page.candidateExhausted,
      nextCursorAvailable: Boolean(page.nextCursor),
      materializedCount,
    });
  }

  return finalizeContext({
    snapshot,
    strictSmallNote,
    noteMap,
    candidateSearches,
    ledger,
    evidenceTokens,
    evidenceTokenBudget: limits.maxEvidenceTokens,
    plannedReason,
    fullNoteMode: 'map-and-read',
  });
}

/**
 * Converts admitted ledger records into evidence items and builds the receipt.
 * 将已准入的账本记录转换为证据条目并构建回执。
 */
function finalizeContext(input: {
  snapshot: CurrentNoteSnapshot;
  strictSmallNote: StrictSmallNoteDecision;
  noteMap: ReturnType<ReturnType<typeof createCurrentNoteTools>['getNoteMap']>;
  candidateSearches: CurrentNoteSelectionContextReceipt['candidateSearches'];
  ledger: CurrentNoteEvidenceLedger;
  evidenceTokens: number;
  evidenceTokenBudget: number;
  plannedReason: string;
  fullNoteMode: CurrentNoteSelectionContextReceipt['fullNoteMode'];
}): SelectionEditCurrentNoteSourceResult {
  const evidence = input.ledger.list().map((record) => ({
    evidenceId: record.evidenceId,
    sourceKind: 'current-note' as const,
    title: input.snapshot.title,
    locator: `当前笔记 L${record.lineFrom}-L${record.lineTo}`,
    headingPath: [...record.headingPath],
    content: record.text,
    sourceContentHash: input.snapshot.contentHash,
    textHash: record.textHash,
    goalIds: [...record.goalIds],
    readVerified: true,
    pageVerified: true,
  }));
  const skipped: SelectionContextReceipt['skipped'] = [];
  if (!input.strictSmallNote.allowed) {
    skipped.push({ sourceKind: 'current-note', reason: `未全文直读：${input.strictSmallNote.rejections.join('、')}。` });
  }
  if (evidence.length === 0) {
    skipped.push({ sourceKind: 'current-note', reason: '未找到可在当前读取预算内深读的原文证据。' });
  }
  return {
    evidence,
    receipt: {
      planned: [{ sourceKind: 'current-note', reason: input.plannedReason }],
      used: evidence.map((item) => ({
        sourceKind: 'current-note',
        title: item.title,
        locator: item.locator,
        characterCount: item.content.length,
      })),
      skipped,
      candidates: [],
      conflicts: [],
      personalization: { requested: false, applied: false, itemCount: 0 },
      fullNoteMode: input.fullNoteMode,
      snapshotId: input.snapshot.snapshotId,
      contentHash: input.snapshot.contentHash,
      strictSmallNote: input.strictSmallNote,
      noteMap: {
        read: true,
        headingCount: input.noteMap.headings.length,
        lineCount: input.noteMap.lineCount,
      },
      candidateSearches: input.candidateSearches.map((item) => ({ ...item, queryTerms: [...item.queryTerms] })),
      evidenceCharacters: input.ledger.totalChars,
      evidenceTokens: input.evidenceTokens,
      evidenceTokenBudget: input.evidenceTokenBudget,
    },
  };
}

/**
 * Resolves effective limits, deriving the token budget from the model context
 * window (20%, clamped to [256, 4096]) when no override is supplied.
 * 解析生效预算；未提供覆盖时，从模型上下文窗口推导 Token 预算（20%，夹取到 [256, 4096]）。
 */
function resolveLimits(
  value: SelectionEditCurrentNoteSourceLimits | undefined,
  capacity: CurrentNoteContextCapacity,
): Required<SelectionEditCurrentNoteSourceLimits> {
  // Context-derived token budget: 20% of the window, bounded for safety.
  // 上下文推导的 Token 预算：窗口的 20%，并做安全夹取。
  const contextDerivedTokenBudget = capacity.contextWindowTokens
    ? Math.max(256, Math.min(4_096, Math.floor(capacity.contextWindowTokens * 0.2)))
    : DEFAULT_MAX_EVIDENCE_TOKENS;
  return {
    maxEvidenceCharacters: readPositiveLimit(value?.maxEvidenceCharacters, DEFAULT_MAX_EVIDENCE_CHARACTERS),
    maxEvidenceTokens: readPositiveLimit(value?.maxEvidenceTokens, contextDerivedTokenBudget),
    maxEvidencePerGoal: readPositiveLimit(value?.maxEvidencePerGoal, DEFAULT_MAX_EVIDENCE_PER_GOAL),
    maxSourceEvidenceRecords: readPositiveLimit(value?.maxSourceEvidenceRecords, DEFAULT_MAX_SOURCE_RECORDS),
  };
}

/**
 * Merges goal query terms with tokens from the selection, deduplicating
 * case-insensitively and capping at 6 terms of 2–80 characters.
 * 合并目标查询词与选区分词，忽略大小写去重，并限制为最多 6 个 2–80 字符的词。
 */
function resolveQueryTerms(queryTerms: readonly string[], selectedText: string): string[] {
  const candidates = [...queryTerms, ...tokenizeCurrentNoteText(selectedText)];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (normalized.length < 2 || normalized.length > 80) continue;
    const key = normalized.toLocaleLowerCase('zh-CN');
    if (unique.has(key)) continue;
    unique.add(key);
    if (unique.size >= 6) break;
  }
  return [...unique];
}

/**
 * Splits the selection into non-trivial fragments (>= 4 chars) used to detect
 * blocks that merely restate the selection.
 * 将选区拆分为非平凡片段（>= 4 字符），用于识别仅复述选区的块。
 */
function splitSelectedFragments(selectedText: string): string[] {
  return selectedText.split(/\n+/u).map((item) => item.trim()).filter((item) => item.length >= 4);
}

/**
 * True when a block merely restates the selection, so it must not be admitted
 * as external new-fact evidence.
 * 当块仅复述选区时返回 true，此类块不得作为外部新增事实证据准入。
 */
function isSelectedBlock(blockText: string, selectedText: string, selectedFragments: readonly string[]): boolean {
  return blockText.includes(selectedText)
    || selectedText.includes(blockText)
    || selectedFragments.some((fragment) => blockText.includes(fragment));
}

/** Returns the value when it is a positive safe integer, otherwise the fallback. / 值为正安全整数时返回该值，否则返回回退值。 */
function readPositiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Throws when the underlying note changed since the snapshot was taken. / 当底层笔记自快照后已变化时抛出异常。 */
function assertSnapshotCurrent(input: CollectSelectionEditCurrentNoteContextInput): void {
  if (input.isSnapshotCurrent && !input.isSnapshotCurrent()) {
    throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
  }
}
