/**
 * Coordinate and hit-testing helpers that translate editor DOM geometry through CSS zoom.
 * 在 CSS 缩放下换算编辑器 DOM 坐标与命中测试的辅助函数。
 */
import type { EditorView } from '@tiptap/pm/view';
/**
 * Rectangle edges in CSS-zoom-local pixels.
 * CSS 缩放本地像素下的矩形边缘坐标。
 */
interface RectEdges { top: number; right: number; bottom: number; left: number }

/**
 * Convert CSS-zoom-local DOM/selection rectangles to window viewport pixels.
 * 将 CSS 缩放本地的 DOM/选区矩形换算为窗口视口像素。
 *
 * @param rect - Rectangle edges in zoom-local coordinates / 缩放本地坐标下的矩形边缘
 * @param element - Element used to locate the zoomed editor surface / 用于定位缩放编辑器容器的元素
 * @returns Rectangle in window viewport pixels / 窗口视口像素下的矩形
 */
export function getNoteViewportRect(rect: RectEdges, element?: HTMLElement | null) {
  const surface = element?.closest<HTMLElement>('.editor-container, .source-editor-zoom');
  const zoom = Number(surface?.style.zoom) || 1;
  const bounds = surface?.getBoundingClientRect();
  // Electron versions differ in whether DOMRect includes CSS zoom. Measure instead of sniffing. / 不同 Electron 版本的 DOMRect 是否含 CSS zoom 不一致，改为实测而非嗅探版本。
  const nativeScale = surface?.offsetWidth && bounds?.width ? bounds.width / surface.offsetWidth : 1;
  const factor = zoom / nativeScale;
  const top = rect.top * factor, right = rect.right * factor;
  const bottom = rect.bottom * factor, left = rect.left * factor;
  return { top, right, bottom, left, width: right - left, height: bottom - top };
}

/**
 * Browser caret hit testing uses window pixels and avoids zoom-sensitive ProseMirror fallbacks.
 * 浏览器插入符命中测试使用窗口像素，避开对缩放敏感的 ProseMirror 回退路径。
 *
 * @param view - Editor view to resolve positions in / 用于解析文档位置的编辑器视图
 * @param point - Point in window viewport pixels / 窗口视口像素下的坐标点
 * @returns Document position at the point, or null when unresolved / 该点的文档位置；无法解析时返回 null
 */
export function getNotePositionAtPoint(view: EditorView, point: { left: number; top: number }): number | null {
  const range = view.dom.ownerDocument.caretRangeFromPoint?.(point.left, point.top);
  if (range && view.dom.contains(range.startContainer)) {
    try { return view.posAtDOM(range.startContainer, range.startOffset); } catch { /* NodeView headers use the editor fallback. / 节点视图页眉使用编辑器回退路径。 */ }
  }
  return view.posAtCoords(point)?.pos ?? null;
}
