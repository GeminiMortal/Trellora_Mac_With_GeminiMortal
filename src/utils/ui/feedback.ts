/**
 * Unified feedback helpers: replace native window.alert / window.confirm.
 * 统一反馈工具：替代原生 window.alert / window.confirm。
 *
 * - showToast(): lightweight notification (replaces window.alert)
 * - showConfirm(): promise-based themed confirm (replaces window.confirm)
 *
 * Implementation uses a self-contained DOM toast + ConfirmModal runtime
 * so we do NOT add new npm dependencies (only uses existing Mantine core).
 * 使用自包含的 DOM toast + ConfirmModal 运行时，不引入新 npm 依赖。
 */

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  type?: ToastType;
  title?: string;
  message: string;
  autoClose?: number | false;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

// ── Self-contained toast ─────────────────────────────────────────────────────

const TOAST_CONTAINER_ID = '__trellora_toast_container__';

function ensureContainer(): HTMLElement {
  let el = document.getElementById(TOAST_CONTAINER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = TOAST_CONTAINER_ID;
    el.style.cssText = [
      'position:fixed',
      'top:20px',
      'right:20px',
      'z-index:9999',
      'display:flex',
      'flex-direction:column',
      'gap:10px',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  }
  return el;
}

const typeColorMap: Record<ToastType, string> = {
  info: '#3d7388',
  success: '#26745b',
  warning: '#b98532',
  error: '#c94a4a',
};

export function showToast(options: ToastOptions): void {
  const { type = 'info', title, message, autoClose = 5000 } = options;
  const container = ensureContainer();

  const toast = document.createElement('div');
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'pointer-events:auto',
    'min-width:260px',
    'max-width:380px',
    'padding:12px 16px',
    'border-radius:8px',
    'background:var(--bg-secondary, #fff)',
    'color:var(--text-primary, #111)',
    'box-shadow:0 4px 16px rgba(0,0,0,0.18)',
    'border-left:4px solid ' + typeColorMap[type],
    'font-size:13px',
    'line-height:1.5',
    'animation:trellora-toast-in 0.2s ease-out',
  ].join(';');

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:4px;';
  titleEl.textContent = title ?? (type === 'error' ? '错误' : type === 'success' ? '成功' : type === 'warning' ? '警告' : '提示');

  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'color:var(--text-secondary, #555);word-break:break-word;';
  msgEl.textContent = message;

  toast.appendChild(titleEl);
  toast.appendChild(msgEl);
  container.appendChild(toast);

  if (autoClose !== false) {
    window.setTimeout(() => {
      toast.style.animation = 'trellora-toast-out 0.2s ease-in forwards';
      window.setTimeout(() => toast.remove(), 220);
    }, autoClose);
  }
}

// ── Inject keyframes once ───────────────────────────────────────────────────

let keyframesInjected = false;
function injectKeyframes(): void {
  if (keyframesInjected) return;
  keyframesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes trellora-toast-in {
      from { opacity: 0; transform: translateX(12px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes trellora-toast-out {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(12px); }
    }
  `;
  document.head.appendChild(style);
}

// ── Promise-based confirm ───────────────────────────────────────────────────

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  injectKeyframes();
  return new Promise((resolve) => {
    void import('./confirmRuntime.tsx').then(({ openConfirm }) => {
      openConfirm({ title: options.title ?? '确认', ...options }, resolve);
    });
  });
}
