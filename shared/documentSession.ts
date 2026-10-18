/**
 * Standalone document session contract: open, draft, save, close, and join-library operations for external text files.
 * 独立文档会话合同：外部文本文件的打开、草稿、保存、关闭与加入资料库操作。
 *
 * This is a standalone file contract; in-library editing still uses notes:* and does not widen note library path permissions.
 * 独立文件合同；库内编辑仍使用 notes:*，不扩大笔记库路径权限。
 */

/**
 * Maximum accepted size of an external text document.
 * 接受的外部文本文档最大大小。
 */
export const EXTERNAL_TEXT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Maximum document size for which Markdown preview rendering is enabled.
 * 启用 Markdown 预览渲染的文档最大大小。
 */
export const EXTERNAL_MARKDOWN_RENDER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Text encodings supported when opening external documents.
 * 打开外部文档时支持的文本编码。
 */
export type DocumentEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'gbk' | 'gb18030';

/**
 * Encoding and line-ending format detected for a document.
 * 为文档检测到的编码与换行格式。
 */
export interface DocumentFormat {
  /** Character encoding of the file. / 文件的字符编码。 */
  encoding: DocumentEncoding;
  /** Byte-order mark present in the file. / 文件中存在的字节序标记。 */
  bom: 'none' | 'utf8' | 'utf16le' | 'utf16be';
  /** Line-ending style of the file. / 文件的换行风格。 */
  lineEnding: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
}

/**
 * Disk identity of a document used for external change detection.
 * 用于检测外部变更的文档磁盘标识。
 */
export interface DocumentDiskVersion {
  /** Content hash of the file on disk. / 磁盘上文件的内容哈希。 */
  diskHash: string;
  /** File size in bytes. / 文件字节大小。 */
  byteLength: number;
  /** File modification time in milliseconds. / 文件修改时间（毫秒）。 */
  mtimeMs: number;
}

/**
 * Feature capabilities of a standalone document session.
 * 独立文档会话的功能能力。
 */
export interface DocumentCapabilities {
  /** Whether the content can be edited. / 是否可编辑内容。 */
  canEdit: boolean;
  /** Whether saving back to the original path is allowed. / 是否允许保存回原路径。 */
  canSaveInPlace: boolean;
  /** Whether Save As is allowed. / 是否允许另存为。 */
  canSaveAs: boolean;
  /** Whether the document may be joined into a library. / 文档是否可加入资料库。 */
  canJoinLibrary: boolean;
  /** Whether WYSIWYG editing is available. / 是否可使用所见即所得编辑。 */
  canUseWysiwyg: boolean;
  /** Whether Markdown preview is available. / 是否可使用 Markdown 预览。 */
  canPreviewMarkdown: boolean;
  /** Whether document AI actions are available. / 是否可使用文档 AI 操作。 */
  canUseDocumentAi: boolean;
  /** Library features are never available outside a library. / 资料库外的会话恒不提供库内功能。 */
  canUseLibraryFeatures: false;
  /** Whether local asset files may be written next to the document. / 是否可在文档旁写入本地资源文件。 */
  canWriteLocalAssets: boolean;
}

/**
 * Full snapshot of an opened standalone document.
 * 已打开独立文档的完整快照。
 */
export interface DocumentSnapshot {
  /** Unique document session id. / 唯一文档会话 id。 */
  documentSessionId: string;
  /** Source kind; standalone sessions are always external. / 来源类型；独立会话恒为 external。 */
  source: { kind: 'external' };
  /** Path shown in the UI. / 界面中显示的路径。 */
  displayPath: string;
  /** Whether the file is treated as Markdown or plain text. / 文件按 Markdown 还是纯文本处理。 */
  fileKind: 'markdown' | 'text';
  /** Decoded document content. / 解码后的文档内容。 */
  content: string;
  /** Detected encoding and line-ending format. / 检测到的编码与换行格式。 */
  format: DocumentFormat;
  /** Disk identity at open time. / 打开时的磁盘标识。 */
  diskVersion: DocumentDiskVersion;
  /** Monotonic draft revision counter. / 单调递增的草稿修订号。 */
  draftRevision: number;
  /** Revision last persisted to disk. / 最近一次持久化到磁盘的修订号。 */
  persistedRevision: number;
  /** Available features for this session. / 本会话可用的功能。 */
  capabilities: DocumentCapabilities;
}

/**
 * Request to open an external document by display path.
 * 按显示路径打开外部文档的请求。
 */
export interface DocumentOpenRequest {
  /** Client-generated id used to correlate the response. / 客户端生成的请求 id，用于关联响应。 */
  requestId: string;
  /** Path of the document to open. / 要打开的文档路径。 */
  displayPath: string;
}

/**
 * Outcome of opening a document: opened as standalone, redirected into a library, or awaiting encoding choice.
 * 打开文档的结果：作为独立文档打开、重定向到资料库，或等待选择编码。
 */
export type DocumentOpenResult =
  /** Opened as a standalone document session. / 作为独立文档会话打开。 */
  | { status: 'opened'; snapshot: DocumentSnapshot }
  /** The path belongs to a library and should be handled by notes:*. / 路径属于资料库，应由 notes:* 处理。 */
  | { status: 'library'; libraryPath: string; filePath: string }
  /** The file encoding must be chosen by the user first. / 需要用户先选择文件编码。 */
  | { status: 'encoding-required'; message: string };

/**
 * Request to update the in-memory draft of a document session.
 * 更新文档会话内存草稿的请求。
 */
export interface DocumentDraftRequest {
  /** Document session id. / 文档会话 id。 */
  documentSessionId: string;
  /** Draft revision this update is based on. / 本次更新所基于的草稿修订号。 */
  draftRevision: number;
  /** New draft content. / 新的草稿内容。 */
  content: string;
}

/**
 * Health of the draft recovery store after an update.
 * 更新后草稿恢复存储的健康状态。
 */
export interface DocumentDraftResult {
  /** Whether recovery data is current or degraded. / 恢复数据是最新还是已降级。 */
  recoveryState: 'current' | 'degraded';
  /** Optional user-facing recovery message. / 可选的面向用户的恢复信息。 */
  recoveryMessage?: string;
}

/**
 * Request to persist a document draft to disk under optimistic concurrency control.
 * 在乐观并发控制下将文档草稿持久化到磁盘的请求。
 */
export interface DocumentSaveRequest extends DocumentDraftRequest {
  /** Client-generated id used to correlate the response. / 客户端生成的请求 id，用于关联响应。 */
  requestId: string;
  /** Disk hash the save expects to replace; mismatch yields a conflict. / 保存期望替换的磁盘哈希；不一致则产生冲突。 */
  expectedDiskHash: string;
  /** Optional encoding or line-ending overrides for this save. / 本次保存的可选编码或换行覆盖。 */
  formatOverride?: Partial<DocumentFormat>;
}

/**
 * Outcome of a save attempt.
 * 保存尝试的结果。
 */
export type DocumentSaveResult =
  /** Content committed to disk, or already identical to the draft. / 内容已提交到磁盘，或与草稿本已一致。 */
  | { status: 'committed' | 'unchanged'; requestId: string; documentSessionId: string; committedDraftRevision: number; snapshot: DocumentSnapshot; committedContent?: string; referenceReplacements?: Record<string, string>; recoveryMessage?: string; index: { kind: 'not-applicable' } }
  /** Save blocked by an external change or an error. / 保存被外部变更或错误阻止。 */
  | { status: 'conflict' | 'failed'; requestId: string; documentSessionId: string; code: string; message: string; retryable: boolean };

/**
 * Request to close a document session with an explicit disposition of the draft.
 * 以明确的草稿处置方式关闭文档会话的请求。
 */
export interface DocumentCloseRequest {
  /** Document session id. / 文档会话 id。 */
  documentSessionId: string;
  /** Draft revision at close time. / 关闭时的草稿修订号。 */
  draftRevision: number;
  /** How the draft is disposed of. / 草稿的处置方式。 */
  reason: 'saved' | 'discard' | 'transferred';
  /** Transfer token when the session content moved into a library. / 会话内容转入资料库时的转移令牌。 */
  transferToken?: string;
}

/**
 * Confirmation that a document session was closed.
 * 文档会话已关闭的确认。
 */
export interface DocumentCloseResult {
  /** Always true on success. / 成功时恒为 true。 */
  closed: true;
  /** Optional user-facing recovery message. / 可选的面向用户的恢复信息。 */
  recoveryMessage?: string;
}

/**
 * Request to join a standalone document into a library.
 * 将独立文档加入资料库的请求。
 */
export interface DocumentJoinRequest {
  /** Document session id. / 文档会话 id。 */
  documentSessionId: string;
  /** Draft revision being joined. / 正在加入的草稿修订号。 */
  draftRevision: number;
  /** Client-generated id used to correlate the response. / 客户端生成的请求 id，用于关联响应。 */
  requestId: string;
  /** Target library absolute path. / 目标资料库绝对路径。 */
  libraryPath: string;
}

/**
 * Result of joining a document into a library.
 * 将文档加入资料库的结果。
 */
export interface DocumentJoinResult {
  /** Path of the note created inside the library. / 在资料库中创建的笔记路径。 */
  path: string;
  /** Library the document joined. / 文档加入的资料库。 */
  libraryPath: string;
  /** Draft revision carried into the library note. / 带入资料库笔记的草稿修订号。 */
  draftRevision: number;
  /** Token used to finish the session transfer. / 用于完成会话转移的令牌。 */
  transferToken: string;
  /** Indexing state of the joined note. / 加入笔记的索引状态。 */
  indexState: 'pending' | 'current' | 'degraded';
}

/**
 * Recoverable unsaved draft recorded for a standalone document.
 * 为独立文档记录的可恢复未保存草稿。
 */
export interface DocumentRecovery {
  /** Unique recovery entry id. / 唯一恢复条目 id。 */
  recoveryId: string;
  /** Display path of the document. / 文档的显示路径。 */
  displayPath: string;
  /** ISO timestamp of the last recovery update. / 最近一次恢复更新的 ISO 时间戳。 */
  updatedAt: string;
  /** Draft revision captured for recovery. / 捕获用于恢复的草稿修订号。 */
  draftRevision: number;
  /** Disk hash at the time the draft diverged. / 草稿分叉时的磁盘哈希。 */
  diskHash: string;
}

/**
 * A recently opened external document.
 * 最近打开过的外部文档。
 */
export interface DocumentRecent {
  /** Display path of the document. / 文档的显示路径。 */
  displayPath: string;
  /** ISO timestamp of the last open. / 最近一次打开的 ISO 时间戳。 */
  openedAt: string;
}

/**
 * Preview of resolved local resource URLs and any issues found while resolving them.
 * 已解析本地资源 URL 的预览及解析过程中发现的问题。
 */
export interface DocumentResourcePreview {
  /** Map from reference to resolved protocol URL. / 引用到已解析协议 URL 的映射。 */
  urls: Record<string, string>;
  /** Issues encountered while resolving references. / 解析引用时遇到的问题。 */
  issues: string[];
  /** Draft revision the preview was computed for. / 预览所对应的草稿修订号。 */
  draftRevision: number;
}
