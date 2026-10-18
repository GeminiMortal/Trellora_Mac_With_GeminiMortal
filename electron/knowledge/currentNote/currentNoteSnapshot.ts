/**
 * Creates and manages immutable snapshots of the current note for evidence tracking and prompt assembly.
 * 创建和管理当前笔记的不可变快照，用于证据跟踪和提示组装。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedNote } from '../../note/noteIndex';
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import { buildCurrentNoteStructure, type CurrentNoteEvidenceBlock, type CurrentNoteHeadingRange, type CurrentNoteHeadingSource } from './currentNoteStructure.ts';

/** Version tag for the snapshot structure index format. 快照结构索引格式的版本标签。 */
export const CURRENT_NOTE_INDEX_VERSION = 'current-note-structure-v2';

/** Immutable snapshot of a note's content, structure, and metadata at a point in time. 笔记在某一时间点的内容、结构和元数据的不可变快照。 */
export interface CurrentNoteSnapshot {
  snapshotId: string;
  libraryId: string;
  notePath: string;
  relativePath: string;
  title: string;
  contentHash: string;
  revision: number;
  markdown: string;
  lineOffsets: number[];
  lineCount: number;
  tokenEstimate: number;
  headings: CurrentNoteHeadingRange[];
  blocks: CurrentNoteEvidenceBlock[];
  createdAt: string;
}

/** Input parameters for constructing a CurrentNoteSnapshot. 构造 CurrentNoteSnapshot 的输入参数。 */
export interface CurrentNoteSnapshotInput {
  libraryPath: string;
  notePath: string;
  title: string;
  contentHash: string;
  markdown: string;
  headings: readonly CurrentNoteHeadingSource[];
  revision: number;
  indexVersion?: string;
  createdAt?: string;
}

/**
 * Returns the immutable source block owned by this snapshot.
 * 返回此快照拥有的不可变源块。
 *
 * @param snapshot - The snapshot to search in / 要搜索的快照
 * @param blockId - The block identifier to look up / 要查找的块标识符
 * @returns The matching block, or undefined if not found / 匹配的块，未找到则返回 undefined
 */
export function getCurrentNoteSnapshotBlock(
  snapshot: CurrentNoteSnapshot,
  blockId: string,
): CurrentNoteSnapshot['blocks'][number] | undefined {
  return snapshot.blocks.find((block) => block.blockId === blockId);
}

/**
 * Creates a new immutable snapshot from raw note input, validating path and content hash.
 * 从原始笔记输入创建新的不可变快照，验证路径和内容哈希。
 *
 * @param input - Snapshot construction parameters including library path, note path, and markdown / 包含库路径、笔记路径和 markdown 的快照构建参数
 * @returns A new immutable CurrentNoteSnapshot / 新的不可变 CurrentNoteSnapshot
 */
export function createCurrentNoteSnapshot(input: CurrentNoteSnapshotInput): CurrentNoteSnapshot {
  const libraryPath = path.resolve(input.libraryPath);
  const notePath = path.resolve(input.notePath);
  const relativePath = path.relative(libraryPath, notePath).replace(/\\/gu, '/');
  if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw new Error('当前笔记不在已打开的笔记库中。');
  }
  const calculatedHash = sha256(input.markdown);
  if (input.contentHash !== calculatedHash) throw new Error('当前笔记内容已变化，请保存后重试。');
  const structure = buildCurrentNoteStructure({
    markdown: input.markdown,
    contentHash: calculatedHash,
    headings: input.headings,
  });
  const libraryId = `library-${sha256(normalizePath(libraryPath)).slice(0, 24)}`;
  const indexVersion = input.indexVersion ?? CURRENT_NOTE_INDEX_VERSION;
  const snapshotId = `snapshot-${sha256(`${libraryId}\u0000${relativePath}\u0000${calculatedHash}\u0000${indexVersion}`).slice(0, 24)}`;
  return {
    snapshotId,
    libraryId,
    notePath,
    relativePath,
    title: input.title.trim() || path.basename(notePath, path.extname(notePath)),
    contentHash: calculatedHash,
    revision: input.revision,
    markdown: input.markdown,
    lineOffsets: structure.lineOffsets,
    lineCount: structure.lineCount,
    tokenEstimate: estimateTokenCount(input.markdown),
    headings: structure.headings,
    blocks: structure.blocks,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Convenience factory that creates a snapshot from an IndexedNote object.
 * 从 IndexedNote 对象创建快照的便捷工厂方法。
 *
 * @param input - Object containing libraryPath, note, revision, and optional overrides / 包含 libraryPath、note、revision 和可选覆盖的对象
 * @returns A new immutable CurrentNoteSnapshot / 新的不可变 CurrentNoteSnapshot
 */
export function createCurrentNoteSnapshotFromIndexedNote(input: {
  libraryPath: string;
  note: IndexedNote;
  revision: number;
  indexVersion?: string;
  createdAt?: string;
}): CurrentNoteSnapshot {
  return createCurrentNoteSnapshot({
    libraryPath: input.libraryPath,
    notePath: input.note.path,
    title: input.note.title,
    contentHash: input.note.contentHash,
    markdown: input.note.rawMarkdown,
    headings: input.note.headings,
    revision: input.revision,
    ...(input.indexVersion ? { indexVersion: input.indexVersion } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

/**
 * A library-wide revision may advance because another note changed. Compare
 * the indexed identity of this note so unrelated saves do not stale its turn.
 * 库级版本可能因其他笔记变更而推进。比较此笔记的索引标识，使无关的保存不会使其回合过期。
 *
 * @param snapshot - The current snapshot to compare against / 要比较的当前快照
 * @param note - An indexed note to match, or undefined / 要匹配的索引笔记，或 undefined
 * @returns True if the note matches this snapshot's path and content hash / 如果笔记匹配此快照的路径和内容哈希则返回 true
 */
export function matchesCurrentNoteSnapshot(
  snapshot: CurrentNoteSnapshot,
  note: Pick<IndexedNote, 'path' | 'contentHash'> | undefined,
): boolean {
  return Boolean(note
    && normalizePath(path.resolve(note.path)) === normalizePath(snapshot.notePath)
    && note.contentHash === snapshot.contentHash);
}

/**
 * Keeps immutable snapshots by content hash. A changed note gets a new cache
 * entry, so in-flight work can retain its old evidence coordinates safely.
 * 按内容哈希保存不可变快照。变更的笔记会获得新的缓存条目，使进行中的工作可以安全保留旧的证据坐标。
 */
export class CurrentNoteSnapshotCache {
  private readonly entries = new Map<string, CurrentNoteSnapshot>();
  private readonly maxEntries: number;

  constructor(maxEntries = 24) {
    this.maxEntries = maxEntries;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('快照缓存容量无效。');
  }

  /**
   * Returns an existing snapshot for the same input or creates and caches a new one (LRU eviction).
   * 返回与输入匹配的现有快照，或创建并缓存新快照（LRU 淘汰）。
   *
   * @param input - Snapshot construction parameters / 快照构建参数
   * @returns The cached or newly created snapshot / 缓存的或新创建的快照
   */
  getOrCreate(input: CurrentNoteSnapshotInput): CurrentNoteSnapshot {
    const key = snapshotCacheKey(input);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const snapshot = createCurrentNoteSnapshot(input);
    this.entries.set(key, snapshot);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
    return snapshot;
  }

  /**
   * Removes all cached snapshots for the given note path.
   * 移除给定笔记路径的所有缓存快照。
   *
   * @param notePath - Absolute path of the note whose snapshots to evict / 要淘汰快照的笔记的绝对路径
   * @returns void / 无返回值
   */
  invalidateNote(notePath: string): void {
    const normalizedPath = path.resolve(notePath);
    for (const [key, snapshot] of this.entries) {
      if (snapshot.notePath === normalizedPath) this.entries.delete(key);
    }
  }

  /** Returns the current number of cached snapshots. 返回当前缓存的快照数量。 */
  get size(): number {
    return this.entries.size;
  }
}

function snapshotCacheKey(input: CurrentNoteSnapshotInput): string {
  return [path.resolve(input.notePath), input.contentHash, input.indexVersion ?? CURRENT_NOTE_INDEX_VERSION].join('\u0000');
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').toLocaleLowerCase('en-US');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
