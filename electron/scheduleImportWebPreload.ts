/**
 * Preload for the schedule import browser window.
 * Injects toolbar and floating buttons via DOM (bypasses CSP), communicates via IPC.
 * 课表导入浏览器窗口的 preload。通过 DOM 注入工具栏和浮动按钮（绕过 CSP），通过 IPC 通信。
 */
import { ipcRenderer } from 'electron';

const TOOLBAR_HEIGHT = 42;

function injectUI(): void {
  if (document.getElementById('__trellora_toolbar')) return;

  // ── Styles ──────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes __trellora_spin{to{transform:rotate(360deg)}}
    #__trellora_toolbar{position:fixed;top:0;left:0;right:0;z-index:2147483647;height:${TOOLBAR_HEIGHT}px;background:#1e1e2e;display:flex;align-items:center;padding:0 8px;gap:4px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
    .__trellora_tb{background:transparent;border:none;color:#cdd6f4;font-size:16px;cursor:pointer;padding:4px 10px;border-radius:4px;display:flex;align-items:center;justify-content:center}
    .__trellora_tb:hover{background:#313244}
    #__trellora_url_input{flex:1;height:28px;background:#313244;border:1px solid #45475a;border-radius:6px;color:#cdd6f4;padding:0 10px;font-size:13px;outline:none}
    #__trellora_url_input:focus{border-color:#89b4fa}
    #__trellora_loader{display:none;width:18px;height:18px;border:2px solid #45475a;border-top-color:#89b4fa;border-radius:50%;animation:__trellora_spin 0.6s linear infinite}
    .__trellora_float_btn{position:fixed;bottom:24px;z-index:2147483646;padding:14px 28px;color:white;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;transition:all 0.2s;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    .__trellora_float_btn:hover{transform:scale(1.05)}
  `;
  document.head.appendChild(style);

  // ── Toolbar ─────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.id = '__trellora_toolbar';

  const mkBtn = (glyph: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = '__trellora_tb';
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };

  const back = mkBtn('←', '后退', () => { try { window.history.back(); } catch { /* ignore */ } });
  const fwd = mkBtn('→', '前进', () => { try { window.history.forward(); } catch { /* ignore */ } });
  const refresh = mkBtn('↻', '刷新', () => location.reload());

  const urlInput = document.createElement('input');
  urlInput.id = '__trellora_url_input';
  urlInput.type = 'text';
  urlInput.value = location.href;
  urlInput.addEventListener('focus', () => { urlInput.style.borderColor = '#89b4fa'; urlInput.select(); });
  urlInput.addEventListener('blur', () => { urlInput.style.borderColor = '#45475a'; });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      let u = urlInput.value.trim();
      if (u && !u.startsWith('http')) u = 'https://' + u;
      location.href = u;
    }
  });

  const loader = document.createElement('div');
  loader.id = '__trellora_loader';

  const closeBtn = mkBtn('✕', '关闭', () => ipcRenderer.send('schedule-import:close'));
  closeBtn.style.color = '#f38ba8';
  closeBtn.style.fontSize = '18px';
  closeBtn.style.marginLeft = '4px';

  toolbar.append(back, fwd, refresh, urlInput, loader, closeBtn);
  document.documentElement.prepend(toolbar);

  // Push page content down
  if (document.body) document.body.style.marginTop = TOOLBAR_HEIGHT + 'px';

  // ── Exit button (bottom-left) ───────────────────────────
  const exitBtn = document.createElement('button');
  exitBtn.className = '__trellora_float_btn';
  exitBtn.innerHTML = '🚪 <span>退出</span>';
  exitBtn.style.left = '24px';
  exitBtn.style.background = 'linear-gradient(135deg,#dc2626,#ef4444)';
  exitBtn.style.boxShadow = '0 4px 16px rgba(220,38,38,0.4)';
  exitBtn.addEventListener('mouseenter', () => { exitBtn.style.boxShadow = '0 6px 20px rgba(220,38,38,0.5)'; });
  exitBtn.addEventListener('mouseleave', () => { exitBtn.style.boxShadow = '0 4px 16px rgba(220,38,38,0.4)'; });
  exitBtn.addEventListener('click', () => ipcRenderer.send('schedule-import:close'));
  document.body.appendChild(exitBtn);

  // ── Extract button (bottom-right) ──────────────────────
  const extractBtn = document.createElement('button');
  extractBtn.id = '__trellora_extract_btn';
  extractBtn.className = '__trellora_float_btn';
  extractBtn.innerHTML = '📋 <span>提取课表</span>';
  extractBtn.style.right = '24px';
  extractBtn.style.background = 'linear-gradient(135deg,#16a34a,#22c55e)';
  extractBtn.style.boxShadow = '0 4px 16px rgba(22,163,74,0.4)';
  extractBtn.addEventListener('mouseenter', () => { extractBtn.style.boxShadow = '0 6px 20px rgba(22,163,74,0.5)'; });
  extractBtn.addEventListener('mouseleave', () => { extractBtn.style.boxShadow = '0 4px 16px rgba(22,163,74,0.4)'; });
  extractBtn.addEventListener('click', () => {
    extractBtn.innerHTML = '⏳ <span>提取中...</span>';
    (extractBtn as HTMLButtonElement).disabled = true;
    extractBtn.style.background = '#6b7280';
    ipcRenderer.send('schedule-import:extract', {
      html: document.documentElement.outerHTML,
      title: document.title,
    });
  });
  document.body.appendChild(extractBtn);
}

// Update URL bar from main process (on navigation)
ipcRenderer.on('schedule-import:update-url', (_e, url: string) => {
  const input = document.getElementById('__trellora_url_input') as HTMLInputElement | null;
  if (input) input.value = url;
});

// Show/hide loading spinner from main process
ipcRenderer.on('schedule-import:loading', (_e, loading: boolean) => {
  const loader = document.getElementById('__trellora_loader');
  if (loader) loader.style.display = loading ? 'block' : 'none';
});

// Mount on DOMContentLoaded or immediately
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectUI, { once: true });
} else {
  injectUI();
}