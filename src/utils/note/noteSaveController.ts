/**
 * Autosave/flush controller for note editing, including mutation freezing and index-state tracking.
 * 笔记编辑的自动保存/冲刷控制器，含变更冻结与索引状态跟踪。
 */
import type { NoteEditSnapshot, SaveNoteRequest, SaveNoteResult } from '../../../shared/noteSave.ts';

/** Save lifecycle state shown to the UI. / 向 UI 展示的保存生命周期状态。 */
export type NoteSaveStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'error';
/** Projection of controller state consumed by view components. / 视图组件消费的控制器状态投影。 */
export interface NoteSaveView { status: NoteSaveStatus; message?: string; frozen: boolean; path?: string; indexState?: 'current' | 'pending' | 'degraded' }

/**
 * Keep the newest draft separate from the immutable in-flight request.
 * 将最新草稿与不可变的在途请求分离保存。
 */
export class NoteSaveController {
  snapshot?: NoteEditSnapshot;
  content = '';
  revision = 0;
  persistedRevision = 0;
  private pendingRequest?: SaveNoteRequest;
  private pendingMutation?: () => Promise<SaveNoteResult>;
  private flushPromise?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private status: NoteSaveStatus = 'clean';
  private frozen = false;
  private readonly freezeReasons = new Set<string>();
  private message?: string;
  private projection: 'current' | 'pending' | 'degraded' = 'current';
  private projectionRevision = 0;
  private readonly save: (request: SaveNoteRequest) => Promise<SaveNoteResult>;
  private readonly changed: (view: NoteSaveView) => void;

  constructor(save: (request: SaveNoteRequest) => Promise<SaveNoteResult>, changed: (view: NoteSaveView) => void) {
    this.save = save;
    this.changed = changed;
  }

  /** Whether unsaved edits or in-flight work remain. / 是否仍有未保存的编辑或进行中的操作。 */
  get dirty(): boolean { return this.status === 'conflict' || this.revision !== this.persistedRevision || Boolean(this.pendingMutation) || Boolean(this.pendingRequest) || Boolean(this.flushPromise); }
  /** Whether edits are frozen by a mutation or shutdown. / 是否因变更或关闭而冻结编辑。 */
  get blocked(): boolean { return this.frozen; }
  /** Whether a flush is currently running. / 是否有冲刷正在执行。 */
  get saving(): boolean { return Boolean(this.flushPromise); }

  /**
   * Loads a note snapshot, keeping the revision when the session is unchanged.
   * 加载笔记快照；会话未变时保留当前修订号。
   *
   * @param snapshot - Note edit snapshot to open / 待打开的笔记编辑快照
   */
  open(snapshot: NoteEditSnapshot): void {
    this.cancelTimer();
    // Keep the revision only for the same edit session; otherwise start from 0. / 仅在同一编辑会话中保留修订号，否则从 0 开始。
    const revision = this.snapshot?.editSessionId === snapshot.editSessionId ? this.revision : 0;
    this.snapshot = snapshot;
    this.content = snapshot.content;
    this.revision = this.persistedRevision = revision;
    this.projectionRevision = revision;
    this.projection = 'current';
    this.pendingRequest = undefined;
    this.pendingMutation = undefined;
    this.status = 'clean';
    this.message = undefined;
    this.notify();
  }

  /**
   * Records an edit and schedules a delayed flush unless frozen or conflicted.
   * 记录编辑；非冻结且无冲突时安排延迟冲刷。
   *
   * @param content - New editor content / 新的编辑器内容
   * @param delay - Debounce delay in milliseconds / 防抖延迟（毫秒）
   */
  edit(content: string, delay: number): void {
    if (this.frozen || !this.snapshot || content === this.content) return;
    this.content = content;
    this.revision++;
    if (this.status !== 'conflict') this.status = 'dirty';
    this.cancelTimer();
    // A conflict must be resolved before any new timer-driven flush. / 冲突未解决前不得由定时器触发新的冲刷。
    if (this.status !== 'conflict') this.timer = setTimeout(() => { void this.flush(); }, delay);
    this.notify();
  }

  /**
   * Wait for all edits, including a request that already left the renderer.
   * 等待全部编辑落盘，包括已离开渲染进程的请求。
   *
   * @returns Whether all pending work was persisted / 全部待处理工作是否已持久化
   */
  flush(): Promise<boolean> {
    this.cancelTimer();
    if (this.flushPromise) return this.flushPromise;
    if (this.status === 'conflict') return Promise.resolve(false);
    const task = this.performFlush().finally(() => { this.flushPromise = undefined; this.notify(); });
    this.flushPromise = task;
    return task;
  }

  /**
   * Drains pending mutations and drafts until revision matches persisted state.
   * 冲刷挂起的变更与草稿，直到修订号与持久化状态一致。
   *
   * @returns Whether the note reached a clean persisted state / 笔记是否达到干净的持久化状态
   */
  private async performFlush(): Promise<boolean> {
    if (this.pendingMutation && !await this.finishMutation()) return false;
    // Loop: new edits may arrive while awaiting a save, so re-check before finishing. / 循环：等待保存期间可能产生新编辑，结束前需重新检查。
    while (this.snapshot && (this.revision !== this.persistedRevision || this.pendingRequest)) {
      const snapshot = this.snapshot;
      // Reuse pendingRequest so an interrupted IPC call retries with the same identity. / 复用 pendingRequest，使中断的 IPC 调用以同一标识重试。
      const request = this.pendingRequest ?? { editSessionId: snapshot.editSessionId, requestId: crypto.randomUUID(), editRevision: this.revision, expectedDiskHash: snapshot.version.diskHash, content: this.content };
      this.pendingRequest = request;
      this.status = 'saving';
      this.notify();
      let result: SaveNoteResult;
      try { result = await this.save(request); }
      catch (error) { this.status = 'error'; this.message = error instanceof Error ? error.message : String(error); this.notify(); return false; }
      this.pendingRequest = undefined;
      if (result.status === 'conflict' || result.status === 'failed') {
        this.status = result.status === 'conflict' ? 'conflict' : 'error';
        this.message = result.message;
        this.notify();
        return false;
      }
      snapshot.version = result.version;
      this.persistedRevision = request.editRevision;
      // Only trust an index projection newer than the last one observed. / 仅信任比上次观察到的更新的索引投影。
      if (request.editRevision > this.projectionRevision) this.projection = result.indexState;
      this.message = this.projection === 'degraded' ? '内容已保存，索引更新失败。' : undefined;
    }
    this.status = 'clean';
    this.notify();
    return true;
  }

  /**
   * Mutations and closing freeze edits before draining the existing draft.
   * 变更与关闭操作先冻结编辑，再冲刷既有草稿。
   *
   * @param action - Mutation to run after the flush succeeds / 冲刷成功后执行的变更
   * @returns Action result, or undefined when frozen or flush failed / 操作结果；冻结或冲刷失败时为 undefined
   */
  async mutate<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (this.frozen) return undefined;
    this.freeze(true);
    try { if (!await this.flush()) return undefined; return await action(); }
    finally { this.freeze(false); }
  }

  /**
   * Builds the immutable request shell for the next mutation, bumping the revision.
   * 构造下一次变更的不可变请求外壳，并递增修订号。
   *
   * @returns Save request without content / 不含 content 的保存请求
   */
  nextMutation(): Omit<SaveNoteRequest, 'content'> {
    if (!this.snapshot) throw new Error('请先打开笔记。');
    return { editSessionId: this.snapshot.editSessionId, requestId: crypto.randomUUID(), editRevision: ++this.revision, expectedDiskHash: this.snapshot.version.diskHash };
  }

  /**
   * Retain mutation identity when IPC fails after a possible disk commit.
   * IPC 在可能已写盘后失败时仍保留变更标识，以便安全重试。
   *
   * @param operation - IPC call performing the mutation / 执行变更的 IPC 调用
   * @returns Whether the mutation was committed / 变更是否已提交
   */
  async commitMutation(operation: (request: Omit<SaveNoteRequest, 'content'>) => Promise<SaveNoteResult>): Promise<boolean> {
    if (!this.frozen) throw new Error('修改笔记前必须冻结编辑并完成保存。');
    const request = this.nextMutation();
    // Stored so a retry reuses the same request identity after an ambiguous failure. / 保存起来，使不确定失败后的重试复用同一请求标识。
    this.pendingMutation = () => operation(request);
    return this.finishMutation();
  }
  /**
   * Executes the stored mutation and folds its result into controller state.
   * 执行存储的变更，并把结果并入控制器状态。
   *
   * @returns Whether the mutation succeeded / 变更是否成功
   */
  private async finishMutation(): Promise<boolean> {
    try {
      const result = await this.pendingMutation!();
      this.pendingMutation = undefined;
      return this.acceptMutation(result);
    } catch (error) { this.status = 'error'; this.message = String(error); this.notify(); return false; }
  }

  /**
   * Applies a successful mutation result to snapshot, revision, and index state.
   * 将成功的变更结果应用到快照、修订号与索引状态。
   *
   * @param result - Save result returned by the main process / 主进程返回的保存结果
   * @returns Whether the result was accepted / 结果是否被接受
   */
  acceptMutation(result: SaveNoteResult): boolean {
    if (result.status === 'failed' || result.status === 'conflict') { this.status = result.status === 'conflict' ? 'conflict' : 'error'; this.message = result.message; this.notify(); return false; }
    if (this.snapshot) { this.snapshot.version = result.version; this.snapshot.content = result.content ?? this.content; }
    // Adopt returned content only when no newer local edit exists. / 仅当没有更新的本地编辑时才采用返回的内容。
    if (this.revision === result.editRevision) this.content = result.content ?? this.content;
    this.persistedRevision = result.editRevision;
    if (result.editRevision > this.projectionRevision) this.projection = result.indexState;
    this.status = this.revision === this.persistedRevision ? 'clean' : 'dirty';
    this.message = this.projection === 'degraded' ? '内容已保存，索引更新失败。' : undefined;
    this.notify();
    return true;
  }

  /**
   * Forces the conflict state and blocks further automatic flushes.
   * 强制进入冲突状态，并阻止后续自动冲刷。
   *
   * @param message - User-facing conflict explanation / 面向用户的冲突说明
   */
  conflict(message: string): void { this.cancelTimer(); this.status = 'conflict'; this.message = message; this.notify(); }
  /**
   * Records the index projection for the currently persisted revision.
   * 为当前已持久化修订号记录索引投影。
   *
   * @param message - Degraded-mode warning, or undefined when healthy / 降级警告；正常时为 undefined
   */
  indexState(message?: string): void { this.message = message; this.projection = message ? 'degraded' : 'current'; this.projectionRevision = this.persistedRevision; this.notify(); }
  /**
   * Accepts an external index-state update when it is not stale and no error is active.
   * 在不陈旧且无活动错误时接受外部索引状态更新。
   *
   * @param state - New index projection / 新的索引投影
   * @param revision - Revision the projection corresponds to / 投影对应的修订号
   * @param message - Optional warning text / 可选警告文本
   */
  acknowledgeIndex(state: 'current' | 'pending' | 'degraded', revision: number, message?: string): void {
    // Ignore updates older than any observed revision or while an error/conflict is showing. / 忽略早于任何已观察修订号的更新，或错误/冲突展示期间的更新。
    if (revision < this.revision || revision < this.persistedRevision || revision < this.projectionRevision || this.status === 'conflict' || this.status === 'error') return;
    this.projectionRevision = revision; this.projection = state; this.message = message; this.notify();
  }
  /**
   * Clears all controller state when the note is closed.
   * 笔记关闭时清空控制器全部状态。
   */
  reset(): void { this.cancelTimer(); this.snapshot = undefined; this.pendingRequest = undefined; this.pendingMutation = undefined; this.revision = this.persistedRevision = 0; this.content = ''; this.status = 'clean'; this.notify(); }
  /**
   * Adds or removes a freeze reason; edits stay frozen while any reason remains.
   * 增删冻结原因；只要仍有原因存在，编辑保持冻结。
   *
   * @param value - Whether to add (true) or remove (false) the reason / true 添加原因，false 移除原因
   * @param reason - Named freeze reason / 冻结原因名称
   */
  freeze(value: boolean, reason = 'default'): void { if (value) this.freezeReasons.add(reason); else this.freezeReasons.delete(reason); this.frozen = this.freezeReasons.size > 0; this.notify(); }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private notify(): void { this.changed({ status: this.status, message: this.message, frozen: this.frozen, path: this.snapshot?.path, indexState: this.projection }); }
}
