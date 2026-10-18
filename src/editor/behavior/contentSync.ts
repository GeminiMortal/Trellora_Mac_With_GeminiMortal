/**
 * Programmatic document replacement that stays out of the user's undo history.
 * 不进入用户撤销历史的程序化文档替换。
 */
import { createDocument, type Editor } from '@tiptap/core';

/**
 * Replace the entire document with parsed HTML, suppressing both history and update events.
 * 用解析后的 HTML 替换整篇文档，同时抑制历史记录与更新事件。
 *
 * @param editor - Target editor instance / 目标编辑器实例
 * @param html - HTML source to parse and insert / 要解析并插入的 HTML 源
 * @returns Nothing. / 无返回值。
 */
export function replaceContentWithoutHistory(editor: Editor, html: string): void {
  const document = createDocument(html, editor.schema);
  // Skip change listeners and undo grouping for this programmatic swap. / 该程序化替换跳过变更监听与撤销分组。
  const transaction = editor.state.tr
    .replaceWith(0, editor.state.doc.content.size, document)
    .setMeta('preventUpdate', true)
    .setMeta('addToHistory', false);
  editor.view.dispatch(transaction);
}
