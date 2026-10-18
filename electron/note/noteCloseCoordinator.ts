/**
 * Coordinates the save-before-close handshake so a window is not destroyed with unsaved changes.
 * 协调“关闭前保存”握手，避免窗口在存在未保存更改时被销毁。
 */
import { randomUUID } from 'node:crypto';
import type { NoteCloseResponse } from '../../shared/noteSave.ts';

/**
 * The first close is blocked synchronously; only a completed save handshake releases it.
 * 首次关闭会被同步拦截；只有完成保存握手后才放行关闭。
 */
export class NoteCloseCoordinator {
  private pending?: { requestId: string; sender: number; finish: (ok: boolean) => void; timer?: ReturnType<typeof setTimeout> };
  /** Whether the close has been authorized after a successful save / 保存成功后是否已授权关闭 */
  allowed = false;
  /**
   * Creates a coordinator bound to the app's drain and failure-reporting hooks.
   * 创建绑定到应用落盘与失败上报钩子的协调器。
   *
   * @param drain - Flushes pending saves before closing / 关闭前冲刷未完成的保存
   * @param failed - Reports a user-visible failure message / 上报用户可见的失败信息
   */
  constructor(private readonly drain: () => Promise<void>, private readonly failed: (message: string) => void) {}

  /**
   * Starts a close attempt: sends a save request, waits for the handshake, then closes.
   * 发起关闭尝试：发送保存请求、等待握手完成后执行关闭。
   *
   * @param sender - WebContents id of the closing window / 关闭窗口的 WebContents id
   * @param send - Callback that delivers the save request id to the renderer / 向渲染进程发送保存请求 id 的回调
   * @param close - Callback that actually closes the window / 实际关闭窗口的回调
   * @returns Promise resolving once the close attempt finishes / 关闭尝试结束后 resolve
   */
  async request(sender: number, send: (requestId: string) => void, close: () => void): Promise<void> {
    if (this.pending || this.allowed) return;
    const requestId = randomUUID();
    const saved = new Promise<boolean>((finish) => { this.pending = { requestId, sender, finish }; });
    // Timeout prevents a hung renderer from keeping the window alive forever.
    // 超时防止渲染进程卡死导致窗口永远无法关闭。
    const timer = setTimeout(() => { this.pending?.finish(false); }, 10_000);
    if (this.pending) this.pending.timer = timer;
    try {
      send(requestId);
      if (!await saved) { this.failed('保存尚未完成，窗口保持打开。请处理保存提示后重试关闭。'); return; }
      await this.drain();
      this.allowed = true;
      close();
    } catch (error) {
      this.allowed = false;
      this.failed(`关闭前保存未完成，窗口保持打开：${String(error)}`);
    } finally { clearTimeout(timer); this.pending = undefined; }
  }

  /**
   * Completes the pending handshake when the renderer's response matches the request and sender.
   * 当渲染进程的响应与请求及发送方匹配时，完成挂起的握手。
   *
   * @param sender - WebContents id that replied / 回复的 WebContents id
   * @param response - Save-close response from the renderer / 渲染进程的保存关闭响应
   */
  respond(sender: number, response: NoteCloseResponse): void {
    if (response?.requestId === this.pending?.requestId && sender === this.pending?.sender) this.pending.finish(response.ok === true);
  }

  /**
   * 人工保存选择没有 IO 超时；仅持有当前窗口的同一关闭握手。
   * Manual save choices have no I/O timeout; only the current window's close handshake is held.
   *
   * @param sender - WebContents id awaiting the user's choice / 等待用户选择的 WebContents id
   * @param requestId - Id of the save request awaiting a manual decision / 等待人工决定的保存请求 id
   */
  waitForUser(sender: number, requestId: string): void {
    if (this.pending?.sender === sender && this.pending.requestId === requestId) clearTimeout(this.pending.timer);
  }
  /**
   * Aborts a pending close handshake for the given sender, e.g. when the window is destroyed.
   * 中止指定发送方的挂起关闭握手，例如窗口被销毁时。
   *
   * @param sender - WebContents id whose handshake is cancelled / 要取消握手的 WebContents id
   */
  cancelPending(sender: number): void { if (this.pending?.sender === sender) this.pending.finish(false); }
}
