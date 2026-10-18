/**
 * Maintenance barrier that quiesces IPC, drafts and background writers so backup captures a consistent state.
 * 维护屏障：暂停 IPC、草稿与后台写入，使备份捕获一致状态。
 */
import { randomUUID } from 'node:crypto';

/**
 * Current phase of the maintenance barrier.
 * 维护屏障当前所处阶段。
 */
export type MaintenancePhase = 'idle' | 'preparing' | 'capturing';
/**
 * A subsystem that can pause and resume work around maintenance.
 * 可在维护前后暂停与恢复工作的子系统。
 */
export interface MaintenanceParticipant { maintenanceBusy: boolean; pauseForMaintenance(): void; resumeAfterMaintenance(): void }

/**
 * A main-process barrier covers new IPC, renderer drafts, background writers and watcher publication.
 * 主进程屏障：覆盖新 IPC、渲染进程草稿、后台写入器和文件监视发布。
 */
export class MaintenanceBarrier {
  phase: MaintenancePhase = 'idle';
  private readonly active = new Set<Promise<unknown>>();
  private preparation?: { id: string; sender: number; resolve: (ok: boolean) => void };
  /**
   * Creates the barrier with renderer prepender, phase change callback, participant list and drain/stop-resume controls.
   * 创建屏障，需提供渲染进程预备器、阶段变化回调、参与者列表和排空/停止-恢复控制。
   *
   * @param options.prepareRenderer - Prepends a renderer-save request and returns the sender id / 发起渲染进程保存请求并返回 sender id
   * @param options.changed - Notifies when the barrier phase changes / 屏障阶段变化时通知
   * @param options.participants - Returns subsystem participants to pause/resume / 返回需要暂停/恢复的子系统参与者
   * @param options.drain - Drains in-flight operations before capture / 捕获前排空进行中的操作
   * @param options.stopWatching - Stops file watchers before the snapshot / 快照前停止文件监视
   * @param options.resumeWatching - Resumes file watchers after the snapshot / 快照后恢复文件监视
   * @param options.extraBusy - Reports whether any external work is still running / 报告是否有外部工作仍在运行
   * @param options.allowResume - Whether to allow resume after an operation / 操作后是否允许恢复
   */
  constructor(private readonly options: {
    prepareRenderer: (requestId: string) => number;
    changed: (phase: MaintenancePhase) => void;
    participants: () => MaintenanceParticipant[];
    drain: () => Promise<void>;
    stopWatching: () => Promise<void>;
    resumeWatching: () => Promise<void>;
    extraBusy: () => boolean;
    allowResume?: () => boolean;
  }) {}
  /**
   * Receives the renderer's acknowledgement of a pre-capture save request.
   * 接收渲染进程对捕获前保存请求的确认。
   *
   * @param sender - WebContents sender id / WebContents sender id
   * @param requestId - Request id sent to the renderer / 发送给渲染进程的请求标识
   * @param ok - Whether the user accepted the save / 用户是否同意保存
   */
  acknowledge(sender: number, requestId: string, ok: boolean): void { if (this.preparation?.sender === sender && this.preparation.id === requestId) this.preparation.resolve(ok === true); }
  /**
   * Wraps an IPC action: rejects during non-idle phases unless the channel is a backup/restore or flushing save channel.
   * 包装 IPC 操作：非空闲阶段下拒绝调用，除非该通道属于备份/恢复或允许冲刷的保存通道。
   *
   * @param channel - IPC channel name / IPC 通道名称
   * @param action - Action to execute if allowed / 允许时执行的操作
   * @returns Promise resolving to the action's result / 兑现为操作结果的 Promise
   */
  invoke<T>(channel: string, action: () => T | Promise<T>): Promise<T> {
    const control = channel.startsWith('backup:') || channel.startsWith('restore:') || channel.startsWith('workspace-migration:') || channel.startsWith('terminal:');
    const flushing = this.phase === 'preparing' && ['notes:save', 'notes:mutate', 'documents:update-draft'].includes(channel);
    if (this.phase !== 'idle' && !control && !flushing) return Promise.reject(new Error('正在备份或恢复，完成后即可继续操作。'));
    const promise = Promise.resolve().then(action);
    if (!control) { this.active.add(promise); void promise.then(() => this.active.delete(promise), () => this.active.delete(promise)); }
    return promise;
  }
  private setPhase(phase: MaintenancePhase): void { this.phase = phase; this.options.changed(phase); }
  /**
   * Pauses all participants, waits for in-flight work to finish, stops watchers, runs the action, then resumes everything.
   * 暂停所有参与者、等待进行中工作结束、停止文件监视、执行操作，然后恢复一切。
   *
   * @param signal - Abort signal for the capture operation / 捕获操作的中止信号
   * @param action - Snapshot or restore action to run in the quiesced window / 在静默窗口中运行的快照或恢复操作
   * @returns The result returned by the action / 操作返回的结果
   */
  async capture<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (this.phase !== 'idle') throw new Error('已有备份或恢复任务正在执行。');
    const participants = this.options.participants(); let watchingStopped = false;
    this.setPhase('preparing');
    try {
      participants.forEach(participant => participant.pauseForMaintenance());
      const requestId = randomUUID();
    // Renderer save acknowledgement is attempted with a 10-second timeout; a failure means the user must resolve a save conflict manually.
    // 渲染进程保存确认尝试设置 10 秒超时；失败意味着用户必须先手动处理保存冲突。
      const ok = await new Promise<boolean>((resolve, reject) => {
        const fail = () => finish(false, new Error('备份或恢复已取消。'));
        const timer = setTimeout(() => finish(false, new Error('当前窗口未能完成草稿保存，请检查保存状态后重试。')), 10_000);
        const finish = (result: boolean, error?: Error) => { clearTimeout(timer); signal.removeEventListener('abort', fail); error ? reject(error) : resolve(result); };
        signal.addEventListener('abort', fail, { once: true });
        try { this.preparation = { id: requestId, sender: this.options.prepareRenderer(requestId), resolve: finish }; }
        catch { finish(false, new Error('当前窗口不可用，请重新打开应用后重试。')); }
        if (signal.aborted) fail();
      });
      this.preparation = undefined;
      if (!ok) throw new Error('当前笔记存在未解决的保存冲突，请先处理后再备份。');
      this.setPhase('capturing');
      const deadline = Date.now() + 30_000;
      while (this.active.size || participants.some(participant => participant.maintenanceBusy) || this.options.extraBusy()) {
        signal.throwIfAborted(); if (Date.now() > deadline) throw new Error('当前任务尚未结束，请等待资料处理或模型任务完成后再备份。');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await this.options.drain(); signal.throwIfAborted();
      watchingStopped = true; await this.options.stopWatching();
      return await action();
    } finally {
      this.preparation = undefined;
      const resume = this.options.allowResume?.() !== false;
      try { if (watchingStopped && resume) await this.options.resumeWatching(); }
      finally { try { if (resume) for (const participant of participants) participant.resumeAfterMaintenance(); } finally { this.setPhase('idle'); } }
    }
  }
}
