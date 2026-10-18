/**
 * Helpers for locating the editable text range of a single code block under the current selection.
 * 定位当前选区所在单个代码块可编辑文本范围的辅助函数。
 */
import type { Selection } from '@tiptap/pm/state';

/**
 * Editable text range inside one code block.
 * 单个代码块内的可编辑文本范围。
 */
export interface CodeBlockTextRange {
  from: number;
  to: number;
}

/**
 * Returns the editable text range when the selection is inside one code block.
 * 当选区位于单个代码块内时，返回其可编辑文本范围。
 *
 * @param selection - Current editor selection / 当前编辑器选区
 * @returns The text range of the enclosing code block, or null when absent or spanning multiple blocks / 所在代码块的文本范围；不存在或跨越多个块时返回 null
 */
export function getCurrentCodeBlockTextRange(selection: Selection): CodeBlockTextRange | null {
  const { $from, $to } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'codeBlock') continue;
    if ($to.depth < depth || $to.node(depth) !== $from.node(depth)) return null;
    return { from: $from.start(depth), to: $from.end(depth) };
  }
  return null;
}
