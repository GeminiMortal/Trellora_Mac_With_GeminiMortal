/**
 * Table exit behavior: pressing Enter twice at the end of the bottom-right
 * cell leaves the table into a fresh paragraph below it.
 * 表格退出行为：在右下角单元格末尾连按两次 Enter 时离开表格，落到表后新段落。
 */
import { Extension } from '@tiptap/core';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

type DispatchTransaction = (transaction: Transaction) => void;

/**
 * Resolved depths of the table, row, and cell ancestors around the cursor.
 * 光标周围 table、row、cell 祖先节点的深度。
 */
interface TableSelectionDepths {
  table: number;
  row: number;
  cell: number;
}

/**
 * Walk up from the cursor collecting contiguous cell/row/table depths.
 * 自光标向上遍历，收集严格相邻的 cell/row/table 深度。
 */
function findTableSelectionDepths($cursor: TextSelection['$cursor']): TableSelectionDepths | null {
  if (!$cursor) return null;

  let table = -1;
  let row = -1;
  let cell = -1;

  // Track the nearest cell first, then its row and table, scanning inward-out. / 先定位最近的单元格，再依次找其行与表，自内向外扫描。
  for (let depth = $cursor.depth; depth > 0; depth -= 1) {
    const nodeName = $cursor.node(depth).type.name;
    if (cell < 0 && (nodeName === 'tableCell' || nodeName === 'tableHeader')) {
      cell = depth;
    } else if (cell >= 0 && row < 0 && nodeName === 'tableRow') {
      row = depth;
    } else if (row >= 0 && nodeName === 'table') {
      table = depth;
      break;
    }
  }

  // Reject unless cell → row → table are exactly one level apart. / 除非 cell → row → table 严格相邻一层，否则视为不在表格内。
  if (table < 0 || row !== table + 1 || cell !== row + 1) return null;
  return { table, row, cell };
}

/**
 * Exits a table only from the empty paragraph produced by the first Enter at
 * the end of the bottom-right cell. Returning false preserves Tiptap's normal
 * Enter behavior everywhere else, including ordinary line breaks in cells.
 * 仅当光标位于右下角单元格末尾首次 Enter 产生的空段落时退出表格。
 * 返回 false 可保留 Tiptap 在其他位置的正常 Enter 行为，包括单元格内的普通换行。
 *
 * @param state - Current editor state / 当前编辑器状态
 * @param dispatch - Transaction dispatcher (omit to only test the condition) / 事务派发函数（省略时仅判定不执行）
 * @returns True when the keystroke was handled / 快捷键被处理时返回 true
 */
export function exitTableOnSecondEnter(
  state: EditorState,
  dispatch?: DispatchTransaction,
): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty || !selection.$cursor) return false;

  const $cursor = selection.$cursor;
  const depths = findTableSelectionDepths($cursor);
  if (!depths) return false;

  const table = $cursor.node(depths.table);
  const row = $cursor.node(depths.row);
  const cell = $cursor.node(depths.cell);
  if ($cursor.index(depths.table) !== table.childCount - 1) return false;
  if ($cursor.index(depths.row) !== row.childCount - 1) return false;

  const blockDepth = depths.cell + 1;
  if ($cursor.depth !== blockDepth) return false;

  const blockIndex = $cursor.index(depths.cell);
  const currentBlock = $cursor.node(blockDepth);
  // Only the trailing empty paragraph created by the previous Enter counts;
  // its previous sibling must hold real content, otherwise stay in the table.
  // 仅认作上一次 Enter 产生的末尾空段落；其前一个兄弟块必须有实际内容，否则留在表内。
  if (
    blockIndex === 0
    || blockIndex !== cell.childCount - 1
    || currentBlock.type.name !== 'paragraph'
    || currentBlock.content.size !== 0
    || $cursor.parentOffset !== 0
    || cell.child(blockIndex - 1).textContent.length === 0
  ) {
    return false;
  }

  const paragraph = state.schema.nodes.paragraph?.create();
  if (!paragraph) return false;
  if (!dispatch) return true;

  const emptyParagraphFrom = $cursor.before(blockDepth);
  const emptyParagraphTo = $cursor.after(blockDepth);
  const tableEnd = $cursor.after(depths.table);
  const transaction = state.tr.delete(emptyParagraphFrom, emptyParagraphTo);
  // Map the table end through the deletion so the insert lands after the table. / 通过映射把表尾位置换算到删除后坐标，使插入落在表格之后。
  const exitPosition = transaction.mapping.map(tableEnd);

  transaction
    .insert(exitPosition, paragraph)
    .setSelection(TextSelection.create(transaction.doc, exitPosition + 1))
    .scrollIntoView();
  dispatch(transaction);
  return true;
}

/**
 * Tiptap extension binding Enter to the double-Enter table exit behavior.
 * 将 Enter 绑定到“双击 Enter 退出表格”行为的 Tiptap 扩展。
 */
export const TableDoubleEnterExit = Extension.create({
  name: 'menghanTableDoubleEnterExit',
  priority: 1_000,
  addKeyboardShortcuts() {
    return {
      Enter: () => exitTableOnSecondEnter(
        this.editor.state,
        transaction => this.editor.view.dispatch(transaction),
      ),
    };
  },
});
