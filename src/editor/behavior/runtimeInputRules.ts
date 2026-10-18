/**
 * Runtime gating for Tiptap input rules and the editor-preferences storage extension.
 * Tiptap 输入规则的运行时开关与编辑器偏好存储扩展。
 */
import { defaultEditorPreferences } from '../../../shared/editorPreferences.ts';
import { type AnyExtension, InputRule, Extension } from '@tiptap/core';

/**
 * Gate each installed rule at execution time; keep the editor, schema and history intact.
 * 在执行时逐条门控已安装的规则；不破坏编辑器、schema 与历史。
 *
 * @param extension - Extension whose input rules should be wrapped / 需要包装输入规则的扩展
 * @param enabled - Optional runtime gate; defaults to the editorMarkdownAutoConvert preference / 可选的运行时开关；默认读取 editorMarkdownAutoConvert 偏好
 * @returns The same extension with its input rules gated / 输入规则被门控后的同一扩展
 */
export function withRuntimeInputRules<T extends AnyExtension>(extension: T, enabled?: () => boolean): T {
  return extension.extend({
    addInputRules() {
      return (this.parent?.() ?? []).map(rule => new InputRule({
        find: rule.find,
        // Return null when the gate is off so the typed text is left untouched. / 开关关闭时返回 null，输入文本保持原样。
        handler: props => (enabled ? enabled() : this.editor.storage.editorPreferences.editorMarkdownAutoConvert) ? rule.handler(props) : null,
      }));
    },
  }) as T;
}

/**
 * Storage extension exposing the default editor preferences to other extensions.
 * 存储扩展：向其他扩展暴露默认编辑器偏好。
 */
export const RuntimeEditorPreferences = Extension.create({ name: 'editorPreferences', addStorage() { return { ...defaultEditorPreferences }; } });
