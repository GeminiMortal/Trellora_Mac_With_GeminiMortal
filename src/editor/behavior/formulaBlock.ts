/**
 * Tiptap node definitions for display and inline math formulas, backed by a KaTeX node view.
 * 显示公式与内联公式的 Tiptap 节点定义，使用 KaTeX 节点视图渲染。
 */
import { mergeAttributes, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { createFormulaNodeView } from '../nodeViews/FormulaNodeView.ts';

/**
 * Build attribute specs for the shared math fields, mapping camelCase names to kebab-case `data-*` attributes.
 * 为共享的公式字段生成属性规格，将驼峰名映射为 kebab-case 的 `data-*` 属性。
 */
const formulaAttributes = () => Object.fromEntries(
  ['mathSource', 'mathMarkdown', 'mathDelimiter', 'mathDisplay'].map((name) => {
    const attribute = `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return [name, {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute(attribute),
      renderHTML: (attributes: Record<string, unknown>) => attributes[name] == null ? {} : { [attribute]: attributes[name] },
    }];
  }),
);

/**
 * Display math block that keeps editable text and its original delimiters, with a separate KaTeX view.
 * 显示公式块：保留可编辑文本及其原始分隔符，并用独立的 KaTeX 视图渲染。
 */
export const FormulaBlock = Node.create({
  name: 'formulaBlock',

  group: 'block',
  content: 'text*',
  code: true,
  marks: '',
  defining: true,
  isolating: true,

  addAttributes: formulaAttributes,
  addNodeView: () => createFormulaNodeView,

  parseHTML() {
    return [{
      tag: 'div[data-type="formulaBlock"]',
      contentElement: 'code',
    }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'formulaBlock',
        'data-formula-block': 'true',
      }),
      ['code', 0],
    ];
  },
});

/**
 * Inline math node; it also covers display delimiters embedded in an existing paragraph.
 * 内联公式节点；也覆盖嵌入已有段落中的显示公式分隔符。
 */
export const InlineFormula = Node.create({
  name: 'inlineFormula',
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '',
  code: true,
  isolating: true,
  addAttributes: formulaAttributes,
  addNodeView: () => createFormulaNodeView,
  addProseMirrorPlugins() {
    /**
     * Insert typed text through a document transaction when the selection sits inside this formula node.
     * 当选区位于该公式节点内时，通过文档事务插入输入的文本。
     *
     * @param view - Editor view to dispatch on / 用于派发事务的编辑器视图
     * @param text - Typed text / 输入的文本
     * @returns Whether the input was handled / 是否已处理该输入
     */
    const insertSource = (view: import('@tiptap/pm/view').EditorView, text: string) => {
      const { $from, $to } = view.state.selection;
      if ($from.parent.type.name !== this.name || !$from.sameParent($to)) return false;
      view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      return true;
    };
    return [new Plugin({
      props: {
        // Native DOM reparsing moves input out of a non-leaf inline node at its boundary. / 原生 DOM 重解析会把输入移出非叶子内联节点的边界。
        // Commit source typing through the document transaction before that reparse. / 在该重解析前通过文档事务提交源文本输入。
        handleDOMEvents: {
          beforeinput(view, event) {
            const input = event as InputEvent;
            if (input.inputType !== 'insertText' || input.isComposing || input.data == null) return false;
            if (!insertSource(view, input.data)) return false;
            event.preventDefault();
            return true;
          },
        },
        handleTextInput(view, _from, _to, text) {
          return insertSource(view, text);
        },
      },
    })];
  },
  parseHTML() {
    return [{ tag: 'span[data-type="inlineFormula"]', contentElement: 'code' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'inlineFormula' }), ['code', 0]];
  },
});
