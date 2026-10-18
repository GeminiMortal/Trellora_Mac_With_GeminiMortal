/**
 * Node view factory that renders math formulas via KaTeX while keeping the plain source editable.
 * 通过 KaTeX 渲染公式、同时保持纯文本源码可编辑的节点视图工厂。
 */
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';
import { t } from '../../i18n/index.ts';
import { renderMathHtml } from '../../utils/markdown/markdownMath.ts';

/**
 * Render math separately from contentDOM so KaTeX markup never enters the saved source.
 * 将公式渲染与 contentDOM 分离，KaTeX 标记不会进入保存的源码。
 *
 * @param props - Node view renderer props from Tiptap / Tiptap 传入的节点视图渲染属性
 * @returns The node view driving one formula node / 驱动单个公式节点的节点视图
 */
export function createFormulaNodeView({ node: initialNode, editor, view, getPos }: NodeViewRendererProps): NodeView {
  let node = initialNode;
  const block = node.type.name === 'formulaBlock';
  const dom = document.createElement(block ? 'div' : 'span');
  dom.className = `formula-node ${block ? 'formula-block' : 'formula-inline'}`;
  dom.dataset.type = node.type.name;
  dom.dataset.editing = 'false';

  const preview = document.createElement('span');
  preview.className = 'formula-preview';
  preview.contentEditable = 'false';
  preview.title = t('点击编辑公式');
  const contentDOM = document.createElement('code');
  contentDOM.className = 'formula-source';
  dom.append(preview, contentDOM);
  let finishingEditClick = false;

  /**
   * Re-render the KaTeX preview from the node text and display flag.
   * 根据节点文本与 display 标志重新渲染 KaTeX 预览。
   */
  const render = () => {
    const display = block || node.attrs.mathDisplay === 'true';
    dom.dataset.display = String(display);
    preview.innerHTML = renderMathHtml(node.textContent, display);
  };
  /**
   * Toggle the editing flag when the selection enters or leaves this node.
   * 当选区进入或离开该节点时切换 editing 标志。
   */
  const syncSelection = () => {
    const pos = getPos();
    const { from, to } = view.state.selection;
    dom.dataset.editing = String(editor.isFocused && typeof pos === 'number'
      && from >= pos + 1 && to <= pos + node.nodeSize - 1);
  };
  /**
   * Reveal the source and anchor the caret inside it, then focus the editor.
   * 显示源码并把光标锚定在其中，然后聚焦编辑器。
   */
  const placeCaret = () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    dom.dataset.editing = 'true';
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
    view.focus();
    // Native inline-node boundary selection may land before the node; anchor inside its source. / 原生内联节点边界选区可能落在节点之前；改为锚定到源码内部。
    view.dom.ownerDocument.getSelection()?.collapse(contentDOM.firstChild ?? contentDOM, 0);
    syncSelection();
  };
  /**
   * Complete an edit click once the mouse is released, re-anchoring the caret.
   * 鼠标释放后完成编辑点击，重新锚定光标。
   */
  const finishEditClick = () => {
    if (!finishingEditClick) return;
    finishingEditClick = false;
    placeCaret();
  };
  /**
   * Handle preview clicks: enter editing instead of moving the ProseMirror caret to the boundary.
   * 处理预览区点击：进入编辑，而不是把 ProseMirror 光标移到节点边界。
   */
  const edit = (event: MouseEvent) => {
    if (!editor.isEditable || event.button !== 0) return;
    event.preventDefault();
    // Reveal contentDOM before ProseMirror maps the new text selection into the DOM. / 在 ProseMirror 把新文本选区映射进 DOM 前先显示 contentDOM。
    finishingEditClick = true;
    placeCaret();
    view.dom.ownerDocument.addEventListener('mouseup', finishEditClick, { once: true });
  };
  preview.addEventListener('mousedown', edit);
  editor.on('selectionUpdate', syncSelection);
  editor.on('focus', syncSelection);
  editor.on('blur', syncSelection);
  render();

  return {
    dom,
    contentDOM,
    /**
     * Adopt the updated node and re-render when its text or display flag changed.
     * 采用更新后的节点，并在其文本或 display 标志变化时重新渲染。
     */
    update(nextNode: ProseMirrorNode) {
      if (nextNode.type !== node.type) return false;
      const changed = nextNode.textContent !== node.textContent || nextNode.attrs.mathDisplay !== node.attrs.mathDisplay;
      node = nextNode;
      if (changed) render();
      syncSelection();
      return true;
    },
    /**
     * Keep preview mouse events away from ProseMirror's own handling.
     * 将预览区的鼠标事件挡在 ProseMirror 自身处理之外。
     */
    stopEvent(event) {
      return preview.contains(event.target as globalThis.Node);
    },
    /**
     * Ignore preview and attribute mutations while letting selection changes through.
     * 忽略预览区与属性变更，但放行选区变化。
     */
    ignoreMutation(mutation) {
      if (mutation.type === 'selection') return false;
      return mutation.type === 'attributes' || !contentDOM.contains(mutation.target);
    },
    destroy() {
      preview.removeEventListener('mousedown', edit);
      view.dom.ownerDocument.removeEventListener('mouseup', finishEditClick);
      editor.off('selectionUpdate', syncSelection);
      editor.off('focus', syncSelection);
      editor.off('blur', syncSelection);
    },
  };
}
