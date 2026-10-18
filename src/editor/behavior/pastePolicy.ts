/**
 * Clipboard paste policy: Markdown auto-conversion, literal text insertion,
 * and plain-text extraction shared by keyboard and context-menu paste paths.
 * 剪贴板粘贴策略：Markdown 自动转换、字面文本插入，以及键盘与右键菜单粘贴路径共用的纯文本提取。
 */
import type { Editor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorClipboardContent } from '../../../shared/editorClipboard.ts';
import type { EditorPreferences } from '../../../shared/editorPreferences.ts';
import { markdownToHtml } from '../../utils/markdown/markdown.ts';

const formattedClipboardSelector = 'h1,h2,h3,h4,h5,h6,strong,b,em,i,s,del,a[href],ul,ol,blockquote,pre,code,table,img,hr,[data-pm-slice],[data-type]';
const markdownSyntaxPattern = /(^|\n) {0,3}(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}(?:\n|$))|[*_`~]|!?\[[^\]\n]+\]\(|\[\[|\$/;

function hasClipboardFormatting(html: string): boolean {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  return Boolean(dom.querySelector(formattedClipboardSelector));
}

/**
 * Insert literal text without HTML parsing or input/paste-rule metadata.
 * 插入字面文本，不经过 HTML 解析，也不带 input/paste-rule 元数据。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param text - Text to insert / 待插入的文本
 * @returns Nothing / 无返回值
 */
export function pasteLiteralText(editor: Editor, text: string): void {
  if (!editor.isEditable || !text) return;
  const { state } = editor;
  const normalized = text.replace(/\r\n?/g, '\n');
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const inSource = state.selection.$from.parent.type.spec.code || ['formulaBlock', 'inlineFormula'].includes(state.selection.$from.parent.type.name);
  const lines = normalized.split('\n');
  // Multi-line text becomes open paragraphs (1,1) to merge with surrounding blocks; code/formula keeps one raw run. / 多行文本拆成开放段落（1,1）以与周围块合并；代码/公式内保持单一原文片段。
  const slice = inSource || lines.length === 1
    ? new Slice(Fragment.from(state.schema.text(normalized, marks)), 0, 0)
    : new Slice(Fragment.fromArray(lines.map(line => state.schema.nodes.paragraph.create(null, line ? state.schema.text(line, marks) : undefined))), 1, 1);
  editor.view.dispatch(state.tr.replaceSelection(slice).scrollIntoView());
}

/**
 * Both keyboard and context-menu text pass through this same policy.
 * 键盘粘贴与右键菜单文本都经过同一策略。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param data - Clipboard content (text and/or HTML) / 剪贴板内容（文本与/或 HTML）
 * @param mode - User paste preference / 用户粘贴偏好
 * @returns Nothing / 无返回值
 */
export function pasteClipboardText(editor: Editor, data: EditorClipboardContent, mode: EditorPreferences['editorPasteMode']): void {
  const inSource = editor.state.selection.$from.parent.type.spec.code || ['formulaBlock', 'inlineFormula'].includes(editor.state.selection.$from.parent.type.name);
  if (mode === 'preserve-format' && !inSource) {
    // Parse Markdown sources once, while keeping rich clipboard HTML and explicit plain paste intact. / 仅对 Markdown 源做一次转换，富文本剪贴板 HTML 与显式纯文本粘贴保持原样。
    const text = clipboardPlainText(data);
    // Convert only when the clipboard HTML carries no formatting of its own. / 仅当剪贴板 HTML 自身无格式时才做 Markdown 转换。
    if (editor.storage.editorPreferences.editorMarkdownAutoConvert && markdownSyntaxPattern.test(text)
      && (!data.html || !hasClipboardFormatting(data.html))) {
      const html = markdownToHtml(text, { taskListMode: 'editor' });
      if (hasClipboardFormatting(html)) {
        editor.view.pasteHTML(html);
        return;
      }
    }
    if (data.html) editor.view.pasteHTML(data.html);
    else pasteLiteralText(editor, text);
  } else {
    const text = clipboardPlainText(data);
    pasteLiteralText(editor, text);
  }
}

/**
 * Clipboard HTML without a text flavor still has a plain-text representation.
 * 没有 text 分片的剪贴板 HTML 也能导出纯文本表示。
 *
 * @param data - Clipboard payload / 剪贴板载荷
 * @returns Plain-text representation / 纯文本表示
 */
export function clipboardPlainText(data: Pick<EditorClipboardContent, 'text' | 'html'>): string {
  if (data.text || !data.html) return data.text;
  const dom = document.createElement('div');
  dom.innerHTML = data.html;
  dom.querySelectorAll('script,style').forEach(node => node.remove());
  dom.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  // Approximate block boundaries with newlines before reading textContent. / 读取 textContent 前用换行近似块边界。
  dom.querySelectorAll('p,div,li,tr').forEach(node => node.append('\n'));
  return dom.textContent ?? '';
}
