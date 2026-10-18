/**
 * Undo-history extension that closes the history event after every user document change.
 * 撤销历史扩展：在每次用户文档变更后关闭历史事件。
 */
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin } from '@tiptap/pm/state';

/**
 * Ends the current undo step after each user document change, so undo stays fine-grained per edit.
 * 在每次用户文档变更后结束当前撤销步，使撤销保持按次编辑的细粒度。
 */
export const FineGrainedHistory = Extension.create({
  name: 'menghanFineGrainedHistory',
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        const hasUserDocumentChange = transactions.some((transaction) => (
          transaction.docChanged && transaction.getMeta('addToHistory') !== false
        ));
        // closeHistory seals the just-created undo step without starting a new one. / closeHistory 封存刚产生的撤销步，不开启新的撤销步。
        return hasUserDocumentChange ? closeHistory(newState.tr) : null;
      },
    })];
  },
});
