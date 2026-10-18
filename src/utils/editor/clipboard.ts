/**
 * Plain-text clipboard helpers for the editor, with a fallback copy path.
 * 编辑器纯文本剪贴板工具，包含降级复制路径。
 */

/**
 * Copies plain text through the modern Clipboard API when available, with a
 * focused-document fallback for packaged or permission-restricted contexts.
 * 优先使用现代 Clipboard API 复制纯文本，在打包或权限受限场景下回退到聚焦文档方案。
 *
 * @param value - Text to copy / 要复制的文本
 * @returns Whether the copy succeeded / 复制是否成功
 */
export async function copyPlainText(value: string): Promise<boolean> {
  if (!value) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Electron can deny Clipboard API access for a rendered local document; fall through to the focused-document fallback. / Electron 可能拒绝渲染本地文档的 Clipboard API 访问，此时回退到聚焦文档方案。
    }
  }

  if (typeof document === 'undefined') return false;

  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}
