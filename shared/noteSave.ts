/**
 * Note save protocol types: disk versions, edit snapshots, save requests/results, and index change events.
 * 笔记保存协议类型：磁盘版本、编辑快照、保存请求/结果与索引变更事件。
 */

/**
 * File byte version used for save conflict detection; file byte versions are independent of the knowledge index's decoded-text hash.
 * 用于保存冲突检测的文件字节版本；文件字节版本与知识索引的解码文本哈希相互独立。
 */
export interface NoteDiskVersion {
  /** Content hash of the file bytes on disk. / 磁盘文件字节的内容哈希。 */
  diskHash: string;
  /** File size in bytes. / 文件字节大小。 */
  byteLength: number;
  /** File modification time in milliseconds. / 文件修改时间（毫秒）。 */
  mtimeMs: number;
}

/**
 * Snapshot of one note edit session with its content and disk version.
 * 单个笔记编辑会话的内容与磁盘版本快照。
 */
export interface NoteEditSnapshot {
  /** Absolute path of the library containing the note. / 包含该笔记的资料库绝对路径。 */
  libraryPath: string;
  /** Absolute path of the note file. / 笔记文件绝对路径。 */
  path: string;
  /** Id of the edit session. / 编辑会话 id。 */
  editSessionId: string;
  /** Current editor content. / 当前编辑器内容。 */
  content: string;
  /** Disk version the content is based on. / 内容所基于的磁盘版本。 */
  version: NoteDiskVersion;
}

/**
 * Request to save a note under optimistic concurrency control.
 * 在乐观并发控制下保存笔记的请求。
 */
export interface SaveNoteRequest {
  /** Id of the edit session being saved. / 正在保存的编辑会话 id。 */
  editSessionId: string;
  /** Client-generated id used to correlate the response. / 客户端生成的请求 id，用于关联响应。 */
  requestId: string;
  /** Edit revision being saved. / 正在保存的编辑修订号。 */
  editRevision: number;
  /** Disk hash the save expects to replace; mismatch yields a conflict. / 保存期望替换的磁盘哈希；不一致则产生冲突。 */
  expectedDiskHash: string;
  /** Content to write. / 要写入的内容。 */
  content: string;
}

/**
 * Outcome of a note save attempt.
 * 笔记保存尝试的结果。
 */
export type SaveNoteResult =
  /** Content committed to disk, or already identical to the stored note. / 内容已提交到磁盘，或与已存笔记本已一致。 */
  | { status: 'committed' | 'unchanged'; requestId: string; editRevision: number; version: NoteDiskVersion; indexState: 'pending' | 'current' | 'degraded'; content?: string }
  /** The note changed on disk since the expected version, or is missing. / 笔记自期望版本以来已在磁盘上变更，或已缺失。 */
  | { status: 'conflict'; requestId: string; code: 'NOTE_VERSION_CONFLICT' | 'NOTE_MISSING'; currentVersion?: NoteDiskVersion; message: string }
  /** The save failed for a reportable reason. / 保存因可报告的原因失败。 */
  | { status: 'failed'; requestId: string; code: string; message: string; retryable: boolean };

/**
 * Request for a note metadata mutation (tags update or backup restore) instead of a content save.
 * 笔记元数据变更请求（更新标签或恢复备份），而非内容保存。
 */
export interface NoteMutationRequest extends Omit<SaveNoteRequest, 'content'> {
  /** Mutation to perform. / 要执行的变更。 */
  action: 'tags' | 'restore';
  /** Replacement tag list for the tags action. / tags 操作的替换标签列表。 */
  tags?: string[];
  /** Backup entry id for the restore action. / restore 操作的备份条目 id。 */
  backupId?: string;
}

/**
 * Request to close an edit session.
 * 关闭编辑会话的请求。
 */
export interface NoteCloseRequest {
  /** Client-generated id used to correlate the response. / 客户端生成的请求 id，用于关联响应。 */
  requestId: string;
}

/**
 * Response confirming an edit session close.
 * 确认编辑会话关闭的响应。
 */
export interface NoteCloseResponse extends NoteCloseRequest {
  /** Whether the close succeeded. / 关闭是否成功。 */
  ok: boolean;
}

/**
 * Renderer-side state of an edit session and its index status.
 * 渲染进程侧的编辑会话状态及其索引状态。
 */
export interface NoteSaveState {
  /** Id of the active edit session. / 活动编辑会话 id。 */
  editSessionId?: string;
  /** Latest known edit revision. / 已知的最新编辑修订号。 */
  editRevision?: number;
  /** Latest known disk hash. / 已知的最新磁盘哈希。 */
  diskHash?: string;
  /** Knowledge index state for the note. / 笔记的知识索引状态。 */
  indexState: 'pending' | 'current' | 'degraded';
  /** Optional user-facing status message. / 可选的面向用户状态信息。 */
  message?: string;
}

/**
 * Event describing a knowledge index change batch for a library.
 * 描述资料库知识索引变更批次的事件。
 */
export interface NoteIndexChanged {
  /** Absolute path of the library whose index changed. / 索引发生变更的资料库绝对路径。 */
  libraryPath: string;
  /** Generation counter of the library registration. / 资料库注册的代次计数。 */
  libraryGeneration: number;
  /** Monotonic index revision after the change. / 变更后的单调索引修订号。 */
  indexRevision: number;
  /** File-level changes included in the batch. / 本批次包含的文件级变更。 */
  changes: Array<{ kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }>;
  /** Note fields recomputed by the change. / 本次变更重算的笔记字段。 */
  changedFields: Array<'content' | 'title' | 'tags' | 'links' | 'tree'>;
  /** Whether changes came from the app, external edits, both, or reconciliation. / 变更来自应用、外部编辑、两者混合还是对账。 */
  source: 'application' | 'external' | 'mixed' | 'reconcile';
  /** Tree nodes affected by the change. / 变更影响的树节点。 */
  nodes: Array<{ path: string; name: string; title?: string; isDirectory: boolean; kind: string; extension?: string }>;
  /** Optional ordered child lists per directory node. / 可选的按目录节点排列的子项顺序列表。 */
  orders?: Record<string, string[]>;
}
