/**
 * Block boundary behaviors: Backspace deletes a whole table/code/quote block
 * from its first editable position, and a trailing paragraph is kept after
 * such blocks so the caret always has somewhere to land.
 * 块边界行为：在表格/代码/引用的首个可编辑位置按 Backspace 删除整块，
 * 并在此类块之后保留落尾段落，保证光标始终有可落位置。
 */
import { Extension } from '@tiptap/core';
import { Plugin, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

type DispatchTransaction = (transaction: Transaction) => void;

const boundaryBlockTypes = new Set(['blockquote', 'codeBlock', 'table']);

/**
 * True when the cursor sits at offset 0 of the first leaf inside a boundary block.
 * 光标位于边界块内第一个叶子的起始偏移时返回 true。
 */
function isAtFirstPositionOfTopLevelBlock(selection: TextSelection): boolean {
  const $cursor = selection.$cursor;
  if (!$cursor || $cursor.depth < 1 || $cursor.parentOffset !== 0) return false;

  // Every ancestor above the textblock must also be its parent's first child. / 文本块之上每一层都必须是其父节点的第一个子节点。
  for (let depth = 1; depth < $cursor.depth; depth += 1) {
    if ($cursor.index(depth) !== 0) return false;
  }

  return boundaryBlockTypes.has($cursor.node(1).type.name);
}

/**
 * Removes a table, code block, or quote when Backspace is pressed at its very
 * first editable position. Text deletion everywhere else stays untouched.
 * 在表格、代码块或引用的首个可编辑位置按 Backspace 时删除整块；
 * 其他位置的文本删除行为保持不变。
 *
 * @param state - Current editor state / 当前编辑器状态
 * @param dispatch - Transaction dispatcher (omit to only test the condition) / 事务派发函数（省略时仅判定不执行）
 * @returns True when the keystroke was handled / 快捷键被处理时返回 true
 */
export function deleteBoundaryBlockAtStart(
  state: EditorState,
  dispatch?: DispatchTransaction,
): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  if (!isAtFirstPositionOfTopLevelBlock(selection)) return false;
  if (!dispatch) return true;

  const $cursor = selection.$cursor;
  if (!$cursor) return false;

  const blockFrom = $cursor.before(1);
  const blockTo = $cursor.after(1);
  const transaction = state.tr.delete(blockFrom, blockTo);

  // ProseMirror forbids an empty doc; keep one paragraph as an anchor. / ProseMirror 不允许空文档；保留一个段落作为锚点。
  if (transaction.doc.childCount === 0) {
    const paragraph = state.schema.nodes.paragraph?.create();
    if (paragraph) transaction.insert(0, paragraph);
  }

  const selectionPosition = Math.min(blockFrom, transaction.doc.content.size);
  transaction
    .setSelection(Selection.near(transaction.doc.resolve(selectionPosition), 1))
    .scrollIntoView();
  dispatch(transaction);
  return true;
}

/**
 * Ensure the document does not end with a boundary block by appending a paragraph.
 * 通过追加段落，确保文档不以边界块结尾。
 *
 * @param state - Current editor state / 当前编辑器状态
 * @returns Insert transaction, or null when none is needed / 插入事务；无需时返回 null
 */
export function appendTrailingParagraph(state: EditorState): Transaction | null {
  const lastNode = state.doc.lastChild;
  if (!lastNode || !boundaryBlockTypes.has(lastNode.type.name)) return null;

  const paragraph = state.schema.nodes.paragraph?.create();
  return paragraph ? state.tr.insert(state.doc.content.size, paragraph) : null;
}

/**
 * Tiptap extension combining the Backspace block-delete shortcut and the
 * trailing-paragraph appendTransaction plugin.
 * 组合 Backspace 删块快捷键与落尾段落 appendTransaction 插件的 Tiptap 扩展。
 */
export const BlockBoundary = Extension.create({
  name: 'menghanBlockBoundary',
  priority: 1_200,

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteBoundaryBlockAtStart(
        this.editor.state,
        transaction => this.editor.view.dispatch(transaction),
      ),
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        // Only history-tracked user document changes need the trailing paragraph. / 仅进入历史的用户文档变更需要补落尾段落。
        const hasUserDocumentChange = transactions.some(transaction => (
          transaction.docChanged && transaction.getMeta('addToHistory') !== false
        ));
        return hasUserDocumentChange ? appendTrailingParagraph(newState) : null;
      },
    })];
  },
});
