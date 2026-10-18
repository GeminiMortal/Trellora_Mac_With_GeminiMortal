/**
 * Draft and save controller for standalone external document editing sessions.
 * 独立外部文件编辑会话的草稿与保存控制器。
 */
import type { DocumentSnapshot, DocumentDraftRequest, DocumentDraftResult, DocumentSaveRequest, DocumentSaveResult, DocumentFormat } from '../../../shared/documentSession.ts';
import { rewriteDocumentReferences } from '../../../shared/documentResourceManifest.ts';

/**
 * Transport callbacks used to push recovery drafts and persist documents.
 * 用于推送恢复草稿并持久化文档的传输回调。
 */
export interface DocumentTransport {
  updateDraft: (request: DocumentDraftRequest) => Promise<DocumentDraftResult>;
  save: (request: DocumentSaveRequest) => Promise<DocumentSaveResult>;
  saveAs: (request: DocumentSaveRequest) => Promise<DocumentSaveResult | null>;
}
/**
 * Save controller for external files: only explicit calls commit to disk, while
 * the input timer only refreshes the app-private recovery record.
 * 外部文件只手动提交；输入定时器仅更新应用私有恢复记录。
 */
export class DocumentSaveController {
  snapshot?: DocumentSnapshot;
  content = '';
  revision = 0;
  persistedRevision = 0;
  status: 'clean' | 'dirty' | 'saving' | 'conflict' | 'error' = 'clean';
  message?: string;
  recoveryMessage?: string;
  private savedContent = '';
  private timer?: ReturnType<typeof setTimeout>;
  private syncing: Promise<void> = Promise.resolve();
  private saving?: Promise<boolean>;
  private pending?: { request: DocumentSaveRequest; mode: 'save' | 'saveAs' };
  private readonly transport: DocumentTransport;
  private readonly changed: () => void;
  constructor(transport: DocumentTransport, changed: () => void) { this.transport = transport; this.changed = changed; }
  /** Whether unsaved local content or in-flight work remains. / 是否仍有未保存的本地内容或进行中的操作。 */
  get dirty(): boolean { return Boolean(this.snapshot && (this.content !== this.savedContent || this.pending || this.saving)); }
  /** Whether a save is in flight or was interrupted and awaits replay. / 是否有保存进行中或已中断待重放。 */
  get uncertain(): boolean { return Boolean(this.pending); }
  /**
   * Loads a document snapshot and resets draft/save state.
   * 加载文档快照并重置草稿/保存状态。
   *
   * @param snapshot - Snapshot opened in the editor / 在编辑器中打开的快照
   */
  open(snapshot: DocumentSnapshot): void {
    this.cancelTimer(); this.snapshot = structuredClone(snapshot); this.content = snapshot.content;
    this.revision = snapshot.draftRevision; this.persistedRevision = snapshot.persistedRevision;
    // Sentinel forces dirty when the draft was never committed to disk. / 草稿从未落盘时用哨兵值强制为脏。
    this.savedContent = snapshot.persistedRevision < 0 ? '\u0000' : snapshot.content;
    this.pending = undefined; this.message = undefined; this.recoveryMessage = undefined; this.status = this.dirty ? 'dirty' : 'clean'; this.changed();
  }
  /**
   * Records an edit and schedules a debounced recovery-draft write.
   * 记录编辑并安排防抖的恢复草稿写入。
   *
   * @param content - New editor content / 新的编辑器内容
   */
  edit(content: string): void {
    if (!this.snapshot || content === this.content) return;
    this.content = content; this.revision++; this.status = this.dirty ? 'dirty' : 'clean'; this.changed();
    this.cancelTimer(); this.timer = setTimeout(() => { void this.synchronize().catch(() => undefined); }, 300);
  }
  /**
   * Accepts an AI draft snapshot after verifying the session and revision.
   * 校验会话与修订号后接受 AI 建议快照。
   *
   * @param snapshot - Draft snapshot proposed by AI / AI 提议的草稿快照
   */
  acceptDraft(snapshot: DocumentSnapshot): void {
    if (snapshot.documentSessionId !== this.snapshot?.documentSessionId || snapshot.draftRevision < this.revision) throw new Error('文档已切换，AI 建议不能写入当前文件。');
    this.snapshot = structuredClone(snapshot); this.content = snapshot.content; this.revision = snapshot.draftRevision; this.status = this.dirty ? 'dirty' : 'clean'; this.changed();
  }
  /**
   * Builds a recovery-draft request for the current editor content.
   * 用当前编辑器内容构造恢复草稿请求。
   *
   * @returns Draft request payload / 草稿请求负载
   */
  request(): DocumentDraftRequest {
    if (!this.snapshot) throw new Error('请先打开独立文件。');
    return { documentSessionId: this.snapshot.documentSessionId, draftRevision: this.revision, content: this.content };
  }
  /**
   * Queues a recovery-draft write, serializing writes through this.syncing.
   * 排队写入恢复草稿，并通过 this.syncing 串行化写入。
   *
   * @returns Resolves when the queued draft write settles / 排队的草稿写入结束时兑现
   */
  synchronize(): Promise<void> {
    this.cancelTimer(); if (!this.snapshot) return Promise.resolve();
    const request = this.request();
    this.syncing = this.syncing.catch(() => undefined).then(async () => {
      const result = await this.transport.updateDraft(request);
      // Drop the result if the document switched meanwhile. / 文档已切换时丢弃该结果。
      if (request.documentSessionId !== this.snapshot?.documentSessionId) return;
      this.recoveryMessage = result.recoveryMessage; this.changed();
    });
    void this.syncing.catch(error => { this.message = `恢复草稿写入失败：${String(error)}`; this.status = 'error'; this.changed(); });
    return this.syncing;
  }
  /**
   * Saves the document, coalescing concurrent calls into one in-flight task.
   * 保存文档，并将并发调用合并为同一个进行中任务。
   *
   * @param mode - 'save' to overwrite, 'saveAs' to pick a new path / 'save' 覆盖保存，'saveAs' 另存为
   * @param formatOverride - Optional target format overrides / 可选的目标格式覆盖
   * @returns Whether the document was written / 文档是否已写入
   */
  save(mode: 'save' | 'saveAs' = 'save', formatOverride?: Partial<DocumentFormat>): Promise<boolean> {
    if (this.saving) return this.saving;
    if (!this.snapshot) return Promise.resolve(true);
    const task = this.performSave(mode, formatOverride).finally(() => { this.saving = undefined; this.changed(); });
    this.saving = task; return task;
  }
  /**
   * Runs one save transaction, replaying an interrupted request when present.
   * 执行一次保存事务；存在中断请求时按原请求标识重放。
   *
   * @param mode - Save mode used when no pending request exists / 无挂起请求时使用的保存模式
   * @param formatOverride - Optional target format overrides / 可选的目标格式覆盖
   * @returns Whether the document was written / 文档是否已写入
   */
  private async performSave(mode: 'save' | 'saveAs', formatOverride?: Partial<DocumentFormat>): Promise<boolean> {
    try {
      await this.synchronize();
      // Reuse the interrupted request so retries keep the same identity and cannot double-commit. / 复用中断请求，使重试保持同一标识，避免重复提交。
      const operation = this.pending ?? { mode, request: { ...this.request(), requestId: crypto.randomUUID(), expectedDiskHash: this.snapshot!.diskVersion.diskHash, formatOverride } };
      this.pending = operation; this.status = 'saving'; this.message = undefined; this.changed();
      const result = await this.transport[operation.mode](operation.request);
      this.pending = undefined;
      if (!result) { this.status = this.dirty ? 'dirty' : 'clean'; this.changed(); return false; }
      if (!('snapshot' in result)) { this.status = result.status === 'conflict' ? 'conflict' : 'error'; this.message = result.message; this.changed(); return false; }
      // Rewrite resource references after Save As renames them on disk. / 另存为在磁盘上改名资源后改写文档内引用。
      if (result.referenceReplacements) this.content = rewriteDocumentReferences(this.content, result.referenceReplacements);
      this.snapshot = { ...result.snapshot, content: this.content, draftRevision: this.revision };
      this.savedContent = result.committedContent ?? operation.request.content; this.persistedRevision = result.committedDraftRevision;
      this.recoveryMessage = result.recoveryMessage;
      this.status = this.content === this.savedContent ? 'clean' : 'dirty'; this.changed(); return true;
    } catch (error) { this.status = 'error'; this.message = String(error); this.changed(); return false; }
  }
  /**
   * Clears all controller state when the document is closed.
   * 文档关闭时清空控制器全部状态。
   */
  reset(): void { this.cancelTimer(); this.snapshot = undefined; this.pending = undefined; this.content = ''; this.message = undefined; this.recoveryMessage = undefined; this.status = 'clean'; this.changed(); }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
