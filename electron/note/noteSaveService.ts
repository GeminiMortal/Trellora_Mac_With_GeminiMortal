/**
 * Coordinates authorized note edits and serialized disk writes, with conflict detection, backups, and async index projection.
 * 协调经授权的笔记编辑与串行化磁盘写入，具备冲突检测、备份与异步索引投影。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteEditSnapshot, NoteSaveState, SaveNoteRequest, SaveNoteResult } from '../../shared/noteSave.ts';
import { atomicTextWrite, NoteFileError, readNoteBytes } from '../atomicTextWrite.ts';
import { getFileTypeInfo } from '../files/fileTypes.ts';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import { createNoteBackup, pruneNoteBackups, type BackupEntry } from './noteBackups.ts';

interface EditSession { sender: number; libraryPath: string; path: string; revision: number; requests: Map<string, { fingerprint: string; result: Promise<SaveNoteResult> }>; busy: number }
/**
 * Hooks and dependencies injected into NoteSaveService.
 * 注入 NoteSaveService 的钩子与依赖。
 */
export interface NoteSaveServiceOptions {
  /** Resolves the currently active library path, or null / 解析当前激活的资料库路径，可为 null */
  getLibraryPath: () => string | null;
  /**
   * 兼容旧调用方；备份窗口现在固定为三份。
   * Kept for legacy callers; the backup window is now fixed at three copies.
   */
  backupRetention?: () => number;
  /** Callback fired after a save is committed so the index can catch up / 保存提交后触发的回调，供索引跟进 */
  committed: (libraryPath: string, filePath: string, diskHash: string) => Promise<void>;
  /** Pushes save state updates to the owning renderer / 向所属渲染进程推送保存状态更新 */
  state?: (sender: number, state: NoteSaveState) => void;
  /** Observability hook reporting phase durations / 上报各阶段耗时的可观测性钩子 */
  timing?: (phase: string, durationMs: number) => void;
}

/**
 * Owns editor authorization and application writes, while indexing remains a projection.
 * 持有编辑器授权与应用写入；索引始终只是投影。
 */
export class NoteSaveService {
  private sessions = new Map<string, EditSession>();
  private writes = new Map<string, Promise<unknown>>();
  private structures = new Map<string, Promise<unknown>>();
  private projections = new Set<Promise<void>>();
  /**
   * Creates the service with the given hooks.
   * 使用给定钩子创建服务。
   *
   * @param options - Injected hooks and dependencies / 注入的钩子与依赖
   */
  constructor(private readonly options: NoteSaveServiceOptions) {}

  /**
   * Opens an edit session after validating the file, returning the current snapshot.
   * 校验文件后打开编辑会话，返回当前快照。
   *
   * @param sender - WebContents id requesting the session / 请求会话的 WebContents id
   * @param filePath - Note file to open / 要打开的笔记文件
   * @returns Snapshot with content and version for the editor / 供编辑器使用的内容与版本快照
   */
  async open(sender: number, filePath: string): Promise<NoteEditSnapshot> {
    const libraryPath = this.requireLibrary();
    const safePath = await this.safePath(libraryPath, filePath);
    const read = await readNoteBytes(safePath);
    const editSessionId = randomUUID();
    this.sessions.set(editSessionId, { sender, libraryPath, path: safePath, revision: 0, requests: new Map(), busy: 0 });
    return { libraryPath, path: safePath, editSessionId, content: read.content, version: read.version };
  }

  /**
   * Re-reads the note for an open session, refusing while a save is in flight.
   * 为已打开会话重新读取笔记；保存进行中时拒绝。
   *
   * @param sender - WebContents id owning the session / 拥有该会话的 WebContents id
   * @param id - Edit session id / 编辑会话 id
   * @returns Fresh snapshot with content and version / 带有内容与版本的新快照
   */
  async refresh(sender: number, id: string): Promise<NoteEditSnapshot> {
    const session = this.session(sender, id);
    if (session.busy) throw new NoteFileError('NOTE_BUSY', '笔记仍在保存，请稍后重试。', true);
    const read = await readNoteBytes(await this.safePath(session.libraryPath, session.path));
    return { libraryPath: session.libraryPath, path: session.path, editSessionId: id, content: read.content, version: read.version };
  }

  /**
   * Closes an idle session belonging to the sender.
   * 关闭属于该发送方的空闲会话。
   *
   * @param sender - WebContents id owning the session / 拥有该会话的 WebContents id
   * @param id - Edit session id / 编辑会话 id
   * @returns Whether the session is gone / 会话是否已消失
   */
  close(sender: number, id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return true;
    if (session.sender !== sender || session.busy) return false;
    return this.sessions.delete(id);
  }

  /**
   * Returns the note path backing a session.
   * 返回会话对应的笔记路径。
   *
   * @param sender - WebContents id owning the session / 拥有该会话的 WebContents id
   * @param id - Edit session id / 编辑会话 id
   * @returns The session's absolute note path / 会话的绝对笔记路径
   */
  pathForSession(sender: number, id: string): string { return this.session(sender, id).path; }

  /**
   * Drops all idle sessions of a sender, e.g. when its window closes.
   * 丢弃某发送方的全部空闲会话，例如其窗口关闭时。
   *
   * @param sender - WebContents id to release / 要释放的 WebContents id
   */
  release(sender: number): void { for (const [id, session] of this.sessions) if (session.sender === sender && !session.busy) this.sessions.delete(id); }

  /**
   * Retry by request identity reuses the same commit; changed parameters are rejected.
   * 按请求标识重试会复用同一次提交；参数变化的重试会被拒绝。
   *
   * @param sender - WebContents id owning the edit session / 拥有该编辑会话的 WebContents id
   * @param request - Save request with revision and expected disk hash / 带有修订号与期望磁盘哈希的保存请求
   * @param transform - Optional transform applied to the current disk content / 可选的当前磁盘内容变换
   * @param operationKey - Discriminator so distinct operations never share a retry / 区分不同操作、避免共享重试的标识
   * @param forceBackup - Bypasses backup throttling when true / 为 true 时绕过备份频率限制
   * @returns The save outcome (committed, unchanged, conflict, or failed) / 保存结果（已提交、未变化、冲突或失败）
   */
  save(sender: number, request: SaveNoteRequest, transform?: (current: string) => Promise<string> | string, operationKey = '', forceBackup = false): Promise<SaveNoteResult> {
    const fail = (code: string, message: string): Promise<SaveNoteResult> => Promise.resolve({ status: 'failed', requestId: request?.requestId ?? '', code, message, retryable: false });
    if (!request || typeof request.content !== 'string' || typeof request.requestId !== 'string' || !request.requestId || !Number.isSafeInteger(request.editRevision) || request.editRevision < 1 || !/^[a-f0-9]{64}$/.test(request.expectedDiskHash)) return fail('NOTE_REQUEST_INVALID', '笔记保存参数无效。');
    let session: EditSession;
    try { session = this.session(sender, request.editSessionId); } catch (error) { return fail('NOTE_SESSION_INVALID', (error as Error).message); }
    const fingerprint = JSON.stringify([request.editRevision, request.expectedDiskHash, request.content, operationKey, forceBackup]);
    const previous = session.requests.get(request.requestId);
    // Idempotent retries return the original promise; a reused id with different parameters is a client bug.
    // 幂等重试返回原始 Promise；同一 id 参数不同属于客户端错误。
    if (previous) return previous.fingerprint === fingerprint ? previous.result : fail('NOTE_REQUEST_MISMATCH', '同一次保存的重试参数不能变化。');
    session.busy++;
    const result = this.fileQueue(session.libraryPath, session.path, async (): Promise<SaveNoteResult> => {
      try {
        this.session(sender, request.editSessionId);
        if (request.editRevision <= session.revision) throw new NoteFileError('NOTE_REVISION_STALE', '该保存请求已过期，请使用最新编辑。');
        let started = performance.now();
        const safePath = await this.safePath(session.libraryPath, session.path);
        const current = await readNoteBytes(safePath);
        this.options.timing?.('version-read', performance.now() - started);
        if (current.version.diskHash !== request.expectedDiskHash) return { status: 'conflict', requestId: request.requestId, code: 'NOTE_VERSION_CONFLICT', currentVersion: current.version, message: '磁盘笔记已被其他程序修改，当前草稿已保留。' };
        const content = transform ? await transform(current.content) : request.content;
        let version = current.version;
        const unchanged = current.bytes.equals(Buffer.from(content, 'utf8'));
        if (!unchanged) {
          started = performance.now();
          await createNoteBackup(session.path, session.libraryPath, current.bytes, new Date(), forceBackup ? 0 : undefined);
          this.options.timing?.('backup', performance.now() - started);
          version = await atomicTextWrite(safePath, content, async () => {
            this.session(sender, request.editSessionId);
            await this.safePath(session.libraryPath, safePath);
            const check = await readNoteBytes(safePath);
            if (check.version.diskHash !== request.expectedDiskHash) throw new NoteFileError('NOTE_VERSION_CONFLICT', '磁盘笔记已发生变化，当前草稿已保留。');
          }, this.options.timing);
        }
        session.revision = request.editRevision;
        // 正文提交之前不删除任何旧备份；清理失败也不能把已提交的保存报告为失败。
        // No old backup is deleted before the content commit; a cleanup failure must not report an already-committed save as failed.
        try { pruneNoteBackups(session.path, session.libraryPath); }
        catch (error) { console.warn('笔记已保存，旧备份清理暂未完成：', error); }
        const committed: SaveNoteResult = { status: unchanged ? 'unchanged' : 'committed', requestId: request.requestId, editRevision: request.editRevision, version, indexState: 'pending', ...(transform ? { content } : {}) };
        // Equal disk bytes do not prove a failed or pending index is current.
        // 磁盘字节相同并不能证明失败或待处理的索引已是最新。
        const projection = Promise.resolve().then(() => this.options.committed(session.libraryPath, safePath, version.diskHash))
          .then(() => this.options.state?.(sender, { editSessionId: request.editSessionId, editRevision: request.editRevision, diskHash: version.diskHash, indexState: 'current' }))
          .catch(() => this.options.state?.(sender, { editSessionId: request.editSessionId, editRevision: request.editRevision, diskHash: version.diskHash, indexState: 'degraded', message: '内容已保存，索引更新失败，请重试索引。' }));
        this.projections.add(projection);
        void projection.finally(() => this.projections.delete(projection)).catch(() => undefined);
        return committed;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'NOTE_WRITE_FAILED';
        if (code === 'ENOENT' || code === 'NOTE_VERSION_CONFLICT') return { status: 'conflict', requestId: request.requestId, code: code === 'ENOENT' ? 'NOTE_MISSING' : code, message: code === 'ENOENT' ? '原笔记已被删除，当前草稿已保留，可另存为新笔记。' : (error as Error).message };
        return { status: 'failed', requestId: request.requestId, code, message: (error as Error).message, retryable: (error as NoteFileError).retryable ?? true };
      }
    }).finally(() => { session.busy--; });
    session.requests.set(request.requestId, { fingerprint, result });
    if (session.requests.size > 64) { const oldest = session.requests.keys().next().value; if (oldest) session.requests.delete(oldest); }
    return result;
  }

  /** Structural operations reserve the library before awaiting existing file writers. */
  async structure<T>(libraryPath: string, action: () => Promise<T> | T): Promise<T> {
    const library = path.resolve(libraryPath);
    const previous = this.structures.get(library) ?? Promise.resolve();
    const writers = [...this.writes.entries()].filter(([key]) => key.startsWith(`${library.toLowerCase()}\u0000`)).map(([, task]) => task);
    const task = previous.catch(() => undefined).then(() => Promise.allSettled(writers)).then(action);
    this.structures.set(library, task);
    try { return await task; } finally { if (this.structures.get(library) === task) this.structures.delete(library); }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.writes.values(), ...this.structures.values()]);
    await Promise.allSettled([...this.projections]);
  }

  /** 与保存共用单文件队列，让旧备份收敛到三份，避免读清单时清理尚未写完的备份。 */
  async listBackups(filePath: string): Promise<BackupEntry[]> {
    const library = this.requireLibrary();
    const safePath = await this.safePath(library, filePath);
    return this.fileQueue(library, safePath, async () => {
      if (this.requireLibrary() !== library) throw new NoteFileError('NOTE_LIBRARY_CHANGED', '笔记库已切换，请重新读取备份。');
      return pruneNoteBackups(await this.safePath(library, safePath), library);
    });
  }

  private fileQueue<T>(library: string, filePath: string, action: () => Promise<T>): Promise<T> {
    const key = `${library.toLowerCase()}\u0000${filePath.toLowerCase()}`;
    const task = Promise.allSettled([this.writes.get(key), this.structures.get(library)]).then(action);
    this.writes.set(key, task);
    void task.finally(() => { if (this.writes.get(key) === task) this.writes.delete(key); }).catch(() => undefined);
    return task;
  }

  private requireLibrary(): string { const library = this.options.getLibraryPath(); if (!library) throw new NoteFileError('NOTE_LIBRARY_MISSING', '请先打开笔记库。'); return path.resolve(library); }
  private session(sender: number, id: string): EditSession { const session = this.sessions.get(id); if (!session || session.sender !== sender || session.libraryPath !== this.requireLibrary()) throw new NoteFileError('NOTE_SESSION_INVALID', '笔记编辑会话已失效，请重新打开笔记。'); return session; }
  private async safePath(library: string, filePath: string): Promise<string> {
    if (typeof filePath !== 'string' || !getFileTypeInfo(filePath)) throw new NoteFileError('NOTE_TYPE_INVALID', '不支持的笔记文件。');
    assertInsideDirectory(filePath, library);
    const [root, real] = await Promise.all([fs.realpath(library), fs.realpath(filePath)]);
    assertInsideDirectory(real, root);
    if (!(await fs.stat(real)).isFile()) throw new NoteFileError('NOTE_TYPE_INVALID', '目标不是笔记文件。');
    return path.join(path.resolve(library), path.relative(root, real));
  }

}
