/**
 * Visibility checks for overlay panels that interact with editor focus and shortcuts.
 * 与编辑器焦点和快捷键交互的浮层面板可见性检查。
 */

/**
 * Hidden, mounted panels must not consume editor shortcuts or pause caret following.
 * 已挂载但隐藏的面板不应占用编辑器快捷键或暂停光标跟随。
 *
 * @param selector - CSS selector for candidate overlay elements / 候选浮层元素的 CSS 选择器
 * @returns Whether any matched overlay is currently visible / 是否存在可见的匹配浮层
 */
export function hasVisibleOverlay(selector: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(selector)].some(element =>
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  );
}
