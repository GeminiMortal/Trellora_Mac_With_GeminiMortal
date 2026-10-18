/**
 * Startup splash overlay lifecycle: slow-start hint, error state, and fade-out.
 * 启动画面覆盖层的生命周期：慢启动提示、错误状态与淡出。
 */

let slowTimer: number | undefined;
let removalTimer: number | undefined;

/**
 * Wires splash interactions and slow-start detection; readiness itself is decided by App's real initialization.
 * 只管启动画面的交互与退出；软件就绪由 App 的真实初始化结果决定。
 *
 * @returns Nothing / 无返回值
 */
export function initializeStartupSplash(): void {
  const splash = document.getElementById('startup-splash');
  if (!splash) return;
  document.documentElement.dataset.startupState = 'loading';
  document.querySelector<HTMLButtonElement>('.startup-retry')?.addEventListener('click', () => window.location.reload());
  slowTimer = window.setTimeout(() => {
    showStartupError(document.documentElement.lang === 'en-US'
      ? 'Startup is taking longer than usual. You can reload the window.'
      : '启动时间较长，可以重新加载界面。');
  }, 15_000);
}

/**
 * Keeps the window operable after an init failure, without treating the unready UI as loaded.
 * 初始化失败仍保留可操作的窗口，不把未就绪的界面当作加载成功。
 *
 * @param message - Optional user-facing error text / 可选的用户可见错误文案
 * @returns Nothing / 无返回值
 */
export function showStartupError(message?: string): void {
  const splash = document.getElementById('startup-splash');
  if (!splash || splash.dataset.phase === 'exiting') return;
  const english = document.documentElement.lang === 'en-US';
  const status = splash.querySelector<HTMLElement>('.startup-status');
  if (status) status.textContent = message || (english ? 'Unable to open the workspace. Please reload.' : '工作空间加载失败，请重新加载。');
  splash.dataset.phase = 'error';
  const retry = splash.querySelector<HTMLButtonElement>('.startup-retry');
  if (retry) retry.hidden = false;
}

/**
 * Fades out the splash once the main UI has committed; no minimum display time and no waiting on remote model probes.
 * 主界面已提交后淡出；不设最短展示时长，也不等待远程模型探测。
 *
 * @returns Nothing / 无返回值
 */
export function finishStartupSplash(): void {
  const splash = document.getElementById('startup-splash');
  if (!splash || splash.dataset.phase === 'exiting') return;
  window.clearTimeout(slowTimer);
  const remove = () => {
    window.clearTimeout(removalTimer);
    splash.remove();
    document.getElementById('root')?.removeAttribute('inert');
    document.documentElement.dataset.startupState = 'complete';
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { remove(); return; }
  splash.dataset.phase = 'exiting';
  splash.addEventListener('animationend', event => { if (event.target === splash) remove(); });
  // Window minimization or an interrupted CSS animation must not retain the overlay. / 窗口最小化或 CSS 动画中断时也不得保留覆盖层。
  removalTimer = window.setTimeout(remove, 400);
}
