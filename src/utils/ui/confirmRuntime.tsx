/**
 * Runtime mount for showConfirm — a tiny imperative wrapper over ConfirmModal.
 * showConfirm 的运行时挂载 —— ConfirmModal 的命令式封装。
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ConfirmModal from '../../components/ui/ConfirmModal.tsx';

let activeRoot: Root | null = null;
let activeHost: HTMLElement | null = null;

export function openConfirm(
  options: {
    title: string;
    message: string;
    detail?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  },
  resolve: (confirmed: boolean) => void,
): void {
  closeActive();
  const host = document.createElement('div');
  document.body.appendChild(host);
  activeHost = host;
  const root = createRoot(host);
  activeRoot = root;

  const cleanup = (confirmed: boolean) => {
    root.unmount();
    host.remove();
    activeRoot = null;
    activeHost = null;
    resolve(confirmed);
  };

  root.render(
    <ConfirmModal
      isOpen
      title={options.title}
      message={options.message}
      detail={options.detail}
      confirmText={options.confirmText}
      cancelText={options.cancelText}
      variant={options.danger ? 'danger' : 'default'}
      onConfirm={() => {}}
      onClose={() => cleanup(false)}
    />,
  );

  // ConfirmModal calls onConfirm then onClose; we intercept here.
  // ConfirmModal 内部 onConfirm 后会 onClose；在此拦截。
}

function closeActive(): void {
  if (activeRoot && activeHost) {
    activeRoot.unmount();
    activeHost.remove();
    activeRoot = null;
    activeHost = null;
  }
}
