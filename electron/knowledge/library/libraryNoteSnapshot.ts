/**
 * Library note snapshot map: immutable, session-scoped note descriptors plus
 * main-process-only local snapshots used by tools and the evidence ledger.
 * 笔记库快照映射：不可变的会话级笔记描述符，以及仅主进程可见的本地快照，供工具与证据账本使用。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedNote, NoteIndex } from '../../note/noteIndex.ts';
import { createCurrentNoteSnapshotFromIndexedNote, type CurrentNoteSnapshot } from '../currentNote/currentNoteSnapshot.ts';

/**
 * Schema version of library note snapshot descriptors.
 * 笔记库快照描述符的结构版本号。
 */
export const LIBRARY_NOTE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * The renderer/model-facing part of a library note snapshot.  It deliberately
 * has no absolute or relative path.  Paths stay on the main-process record.
 * 面向渲染层/模型的笔记库快照视图；刻意不包含绝对或相对路径，路径只保留在主进程记录中。
 */
export interface LibraryNoteSnapshotDescriptor {
  schemaVersion: typeof LIBRARY_NOTE_SNAPSHOT_SCHEMA_VERSION; // Descriptor schema version / 描述符结构版本
  libraryId: string; // Owning library id / 所属资料库标识
  noteId: string; // Stable note id / 稳定笔记标识
  snapshotId: string; // Snapshot identity / 快照标识
  title: string; // Note title / 笔记标题
  contentHash: string; // Content hash of the note / 笔记内容哈希
  revision: number; // Index revision / 索引修订号
  lineCount: number; // Total markdown lines / Markdown 总行数
  headings: Array<{ headingId: string; path: string[]; lineFrom: number; lineTo: number }>; // Heading ranges / 标题区间
  topTerms: string[]; // Most frequent terms for navigation / 高频词，用于导航
}

/**
 * A descriptor paired with its main-process-only local snapshot.
 * 描述符与仅主进程可见的本地快照配对而成的记录。
 */
export interface LibraryNoteSnapshotRecord extends LibraryNoteSnapshotDescriptor {
  /** Main-process-only source. Never serialize this record into a prompt. */
  /** 仅主进程可见的来源数据，禁止序列化进提示词。 */
  readonly localSnapshot: CurrentNoteSnapshot;
}

/**
 * Session-scoped collection of note snapshots for one library revision.
 * 针对某一笔记库修订版、限定会话作用域的快照集合。
 */
export interface LibraryNoteSnapshotMap {
  libraryId: string;
  sessionId: string;
  revision: number;
  indexState: 'latest' | 'updating' | 'stale'; // Index freshness state / 索引新鲜度状态
  notes: LibraryNoteSnapshotDescriptor[]; // Model-safe descriptors / 可供模型使用的描述符
  readonly records: Map<string, LibraryNoteSnapshotRecord>; // Full records keyed by noteId / 按 noteId 索引的完整记录
}

/**
 * Replaces the scoped snapshot contents after an index refresh without changing its session scope.
 * 索引刷新后替换限定作用域内的快照内容，但不改变其会话范围。
 *
 * @param target - Map to update in place / 就地更新的目标映射
 * @param next - Fresh snapshot map to copy from / 待复制的新快照映射
 */
export function replaceLibraryNoteSnapshotMap(target: LibraryNoteSnapshotMap, next: LibraryNoteSnapshotMap): void {
  if (target.libraryId !== next.libraryId || target.sessionId !== next.sessionId) throw new Error('不能把其他库或会话的快照写入当前范围。');
  target.revision = next.revision;
  target.indexState = next.indexState;
  // Arrays are deep-copied so callers can never mutate the source map.
  // 数组做深拷贝，避免调用方反向修改来源映射。
  target.notes = next.notes.map((note) => ({ ...note, headings: note.headings.map((heading) => ({ ...heading, path: [...heading.path] })), topTerms: [...note.topTerms] }));
  target.records.clear();
  for (const [noteId, record] of next.records) target.records.set(noteId, { ...record, headings: record.headings.map((heading) => ({ ...heading, path: [...heading.path] })), topTerms: [...record.topTerms] });
}

/**
 * Builds a session-scoped snapshot map from a note index.
 * 基于笔记索引构建限定会话作用域的快照映射。
 *
 * @param input - Library path, index, session and revision inputs / 资料库路径、索引、会话与修订号输入
 * @returns The created snapshot map / 新建的快照映射
 */
export function createLibraryNoteSnapshotMap(input: {
  libraryPath: string;
  index: NoteIndex;
  sessionId: string;
  revision: number;
  indexState?: LibraryNoteSnapshotMap['indexState'];
}): LibraryNoteSnapshotMap {
  const records = new Map<string, LibraryNoteSnapshotRecord>();
  let libraryId: string | undefined;
  for (const note of input.index.notes) {
    const localSnapshot = createCurrentNoteSnapshotFromIndexedNote({
      libraryPath: input.libraryPath,
      note,
      revision: input.revision,
    });
    libraryId ??= localSnapshot.libraryId;
    if (libraryId !== localSnapshot.libraryId) throw new Error('笔记库快照的 libraryId 不一致。');
    const noteId = createLibraryNoteId(localSnapshot.libraryId, note.path, input.libraryPath);
    const descriptor = toLibraryNoteSnapshotDescriptor(localSnapshot, noteId);
    records.set(noteId, { ...descriptor, localSnapshot });
  }
  const resolvedLibraryId = libraryId ?? createLibraryId(input.libraryPath);
  return {
    libraryId: resolvedLibraryId,
    sessionId: assertScopeId(input.sessionId, 'sessionId'),
    revision: input.revision,
    indexState: input.indexState ?? 'latest',
    notes: [...records.values()].map(stripLocalSnapshot),
    records,
  };
}

/**
 * Creates a single snapshot record from one indexed note.
 * 基于单条已索引笔记创建快照记录。
 *
 * @param input - Library path, note and revision inputs / 资料库路径、笔记与修订号输入
 * @returns The snapshot record with its local snapshot / 含本地快照的快照记录
 */
export function createLibraryNoteSnapshotFromIndexedNote(input: {
  libraryPath: string;
  note: IndexedNote;
  revision: number;
}): LibraryNoteSnapshotRecord {
  const localSnapshot = createCurrentNoteSnapshotFromIndexedNote(input);
  const noteId = createLibraryNoteId(localSnapshot.libraryId, input.note.path, input.libraryPath);
  return { ...toLibraryNoteSnapshotDescriptor(localSnapshot, noteId), localSnapshot };
}

/**
 * Resolves a note record inside a session-scoped map, enforcing the session boundary.
 * 在限定会话作用域的映射中解析笔记记录，并强制校验会话边界。
 *
 * @param map - Scoped snapshot map / 限定作用域的快照映射
 * @param noteId - Note identity / 笔记标识
 * @param sessionId - Expected session identity / 期望的会话标识
 * @returns The matching note record / 匹配的笔记记录
 */
export function getLibraryNoteRecord(map: LibraryNoteSnapshotMap, noteId: string, sessionId: string): LibraryNoteSnapshotRecord {
  if (map.sessionId !== sessionId) throw new Error('当前工具调用不属于本次助手会话。');
  const record = map.records.get(noteId);
  if (!record) throw new Error('noteId 不属于当前笔记库快照。');
  return record;
}

/**
 * Derives a stable library id from its resolved path.
 * 由规范化后的资料库路径推导稳定标识。
 *
 * @param libraryPath - Library root path / 资料库根路径
 * @returns Stable library id / 稳定的资料库标识
 */
export function createLibraryId(libraryPath: string): string {
  return `library-${sha256(normalizePath(path.resolve(libraryPath))).slice(0, 24)}`;
}

/**
 * Derives a stable note id from the library id and the library-relative note path.
 * 由资料库标识与库内相对路径推导稳定的笔记标识。
 *
 * @param libraryId - Owning library id / 所属资料库标识
 * @param notePath - Absolute note path / 笔记绝对路径
 * @param libraryPath - Library root path / 资料库根路径
 * @returns Stable note id / 稳定的笔记标识
 */
export function createLibraryNoteId(libraryId: string, notePath: string, libraryPath: string): string {
  const relativePath = path.relative(path.resolve(libraryPath), path.resolve(notePath)).replace(/\\/gu, '/');
  if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw new Error('笔记不在当前笔记库内。');
  }
  return `note-${sha256(`${libraryId}\u0000${normalizePath(relativePath)}`).slice(0, 24)}`;
}

/**
 * Projects a local snapshot into a model-safe descriptor with capped headings and top terms.
 * 将本地快照投影为可供模型使用的描述符，并限制标题与高频词数量。
 *
 * @param snapshot - Source local snapshot / 来源本地快照
 * @param noteId - Stable note id / 稳定笔记标识
 * @returns The model-safe descriptor / 供模型使用的描述符
 */
export function toLibraryNoteSnapshotDescriptor(snapshot: CurrentNoteSnapshot, noteId: string): LibraryNoteSnapshotDescriptor {
  const counts = new Map<string, number>();
  // Term frequency over normalized block terms powers the navigation topTerms list.
  // 统计规范化块词频，用于生成导航用的 topTerms 列表。
  for (const block of snapshot.blocks) {
    for (const term of block.normalizedTerms) {
      if (term.length < 2) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return {
    schemaVersion: LIBRARY_NOTE_SNAPSHOT_SCHEMA_VERSION,
    libraryId: snapshot.libraryId,
    noteId,
    snapshotId: snapshot.snapshotId,
    title: snapshot.title,
    contentHash: snapshot.contentHash,
    revision: snapshot.revision,
    lineCount: snapshot.lineCount,
    headings: snapshot.headings.slice(0, 120).map((heading) => ({
      headingId: heading.headingId,
      path: [...heading.path],
      lineFrom: heading.lineFrom,
      lineTo: heading.lineTo,
    })),
    topTerms: [...counts.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'zh-Hans-CN'))
      .slice(0, 20)
      .map(([term]) => term),
  };
}

/**
 * Strips the main-process-only local snapshot.
 * 剥离仅主进程可见的本地快照。
 *
 * @param record - Full snapshot record / 完整快照记录
 * @returns Model-safe descriptor / 供模型使用的描述符
 */
function stripLocalSnapshot(record: LibraryNoteSnapshotRecord): LibraryNoteSnapshotDescriptor {
  const { localSnapshot: _localSnapshot, ...descriptor } = record;
  return descriptor;
}

/**
 * Validates a scope/session id shape.
 * 校验作用域（会话）标识的格式。
 *
 * @param value - Id value to validate / 待校验的标识值
 * @param label - Field label for error message / 错误消息中的字段标签
 * @returns The validated id / 校验通过的标识
 */
function assertScopeId(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{7,96}$/u.test(value)) throw new Error(`${label} 无效。`);
  return value;
}

/**
 * Normalizes separators and case for hashing.
 * 统一路径分隔符与大小写以便哈希。
 *
 * @param value - Path string / 路径字符串
 * @returns Normalized path / 规范化后的路径
 */
function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').toLocaleLowerCase('en-US');
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