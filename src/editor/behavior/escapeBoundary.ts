/**
 * Escape key plumbing that lets outer UI layers claim Escape when ProseMirror only suppressed it as a fallback.
 * Escape 按键管道：当 ProseMirror 仅作为兜底拦截 Escape 时，允许外层 UI 接管该按键。
 */
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

/**
 * Escape events suppressed by ProseMirror without any editor plugin claiming them.
 * 被 ProseMirror 兜底拦截、且没有编辑器插件处理的 Escape 事件集合。
 */
const unclaimedEscapes = new WeakSet<KeyboardEvent>();

/**
 * ProseMirror prevents Escape by default even when no editor plugin handles it; this extension records those unclaimed presses.
 * 即使没有编辑器插件处理 Escape，ProseMirror 也会默认拦截；本扩展记录这些无人认领的按键。
 */
export const RichTextEscapeBoundary = Extension.create({
  name: 'richTextEscapeBoundary',
  priority: -10_000,
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleKeyDown: (_view, event) => {
      if (event.key === 'Escape' && !event.isComposing) unclaimedEscapes.add(event);
      return false;
    } } })];
  },
});

/**
 * Real editor handlers still win; only ProseMirror's final fallback is ignored.
 * 真正的编辑器处理逻辑仍然优先；仅忽略 ProseMirror 的最终兜底拦截。
 *
 * @param event - Keyboard event to test / 待检测的键盘事件
 * @returns Whether an outer UI layer may handle this Escape / 外层 UI 是否可以处理该 Escape
 */
export function canHandleEditorEscape(event: KeyboardEvent): boolean {
  return !event.isComposing && (!event.defaultPrevented || unclaimedEscapes.has(event));
}

/**
 * Clear the fallback marker so this key cannot close a second UI layer.
 * 清除兜底标记，使该按键不会关闭第二层 UI。
 *
 * @param event - Escape event to consume / 待消费的 Escape 事件
 * @returns Nothing. / 无返回值。
 */
export function consumeEditorEscape(event: KeyboardEvent): void {
  unclaimedEscapes.delete(event);
  event.preventDefault();
}
