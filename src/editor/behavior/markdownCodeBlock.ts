/**
 * Code-block language handling: paste-time language normalization, the Lowlight
 * code-block extension (language attribute + Mermaid/CodeMirror node views),
 * and Mod-A select-all scoped to the current code block.
 * 代码块语言处理：粘贴时的语言归一化、Lowlight 代码块扩展（language 属性 +
 * Mermaid/CodeMirror 节点视图），以及仅作用于当前代码块的 Mod-A 全选。
 */
import { Extension } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { TextSelection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import CodeBlockNodeView from '../nodeViews/CodeBlockNodeView.tsx';
import { createCodeMirrorCodeBlockNodeView, isMermaidCodeBlock } from '../nodeViews/CodeMirrorCodeBlockNodeView.ts';
import { getCurrentCodeBlockTextRange } from './codeBlockShortcuts.ts';
import { CODE_LANGUAGE_OPTIONS, normalizeCodeLanguage } from '../../utils/ui/codeLanguages.ts';

/**
 * Minimal lowlight-like API used for auto language detection.
 * 用于自动语言检测的最小 lowlight 风格接口。
 */
interface CodeLanguageHighlighter {
  highlightAuto: (
    value: string,
    options?: { subset?: ReadonlyArray<string> | null },
  ) => { data?: { language?: string } };
  registered: (language: string) => boolean;
}

const MAX_PASTED_CODE_LANGUAGE_DETECTION_LENGTH = 100_000;
const DETECTABLE_CODE_LANGUAGES = CODE_LANGUAGE_OPTIONS
  .map(option => option.value)
  .filter(language => language !== 'plaintext' && language !== 'mermaid');

function normalizeSourceLanguage(value: string | null | undefined): string | null {
  const language = value?.trim().toLocaleLowerCase('en-US') ?? '';
  return language || null;
}

function getLanguageAttribute(element: Element | null | undefined): string | null {
  if (!element) return null;
  return normalizeSourceLanguage(
    element.getAttribute('data-language')
    || element.getAttribute('data-lang')
    || element.getAttribute('data-code-language')
    || element.getAttribute('data-highlighted-language'),
  );
}

function getLanguageClass(element: Element | null): string | null {
  if (!element) return null;
  const languageClass = [...element.classList]
    .find(className => /^(?:language|lang)-/i.test(className));
  return normalizeSourceLanguage(languageClass?.replace(/^(?:language|lang)-/i, ''));
}

/**
 * Resolve a code block's language from attributes/classes on the <pre>, its
 * <code> child, or the two nearest wrapper elements.
 * 从 <pre>、其 <code> 子元素或最近两层包装元素上的属性/类名解析代码块语言。
 */
function getSourceLanguage(element: HTMLElement): string | null {
  const code = element.querySelector('code');
  const directLanguage = getLanguageAttribute(element)
    || getLanguageAttribute(code)
    || getLanguageClass(element)
    || getLanguageClass(code);
  if (directLanguage) {
    return directLanguage;
  }

  // Several Markdown renderers put the language on the wrapper that owns the
  // toolbar instead of on <pre>/<code>. Inspect only the two nearest wrappers
  // so unrelated page-level data attributes cannot leak into the code block.
  // 部分 Markdown 渲染器把语言放在持有工具栏的包装元素而非 <pre>/<code> 上；只检查最近两层包装，避免页面级 data 属性漏进代码块。
  const parentLanguage = getLanguageAttribute(element.parentElement);
  return parentLanguage || getLanguageAttribute(element.parentElement?.parentElement);
}

/**
 * Auto-detect the language of pasted code using the editor's lowlight instance.
 * 使用编辑器的 lowlight 实例自动检测粘贴代码的语言。
 *
 * @param source - Raw code text / 原始代码文本
 * @param syntaxHighlighter - Lowlight-compatible highlighter / lowlight 兼容高亮器
 * @returns Normalized language id, or null when undetectable / 规范化的语言 id；无法检测时返回 null
 */
function detectPastedCodeLanguage(
  source: string,
  syntaxHighlighter: CodeLanguageHighlighter,
): string | null {
  if (!source.trim() || source.length > MAX_PASTED_CODE_LANGUAGE_DETECTION_LENGTH) return null;

  const subset = DETECTABLE_CODE_LANGUAGES.filter(language => syntaxHighlighter.registered(language));
  if (subset.length === 0) return null;

  try {
    const detected = syntaxHighlighter.highlightAuto(source, { subset }).data?.language;
    const normalized = normalizeCodeLanguage(detected);
    return normalized && normalized !== 'plaintext' ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Preserves language metadata supplied by external Markdown renderers. If a
 * pasted code block has no language metadata, use the editor's existing
 * lowlight instance to detect one before ProseMirror parses the clipboard HTML.
 * 保留外部 Markdown 渲染器提供的语言元数据。若粘贴的代码块没有语言信息，
 * 则在 ProseMirror 解析剪贴板 HTML 之前，用编辑器现有 lowlight 实例检测语言。
 *
 * @param html - Clipboard HTML / 剪贴板 HTML
 * @param syntaxHighlighter - Lowlight-compatible highlighter / lowlight 兼容高亮器
 * @returns HTML with data-language set on code blocks / 代码块已设置 data-language 的 HTML
 */
export function normalizePastedCodeBlockLanguages(
  html: string,
  syntaxHighlighter: CodeLanguageHighlighter,
): string {
  if (!/<pre(?:\s|>)/i.test(html)) return html;

  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
    const language = getSourceLanguage(pre)
      || detectPastedCodeLanguage(pre.textContent ?? '', syntaxHighlighter);
    if (language) pre.dataset.language = language;
  });
  return template.innerHTML;
}

/**
 * Keeps a fenced Markdown language as a CodeBlock attribute while the note is
 * being parsed. The explicit data attribute is also retained in editor HTML,
 * so it remains available to UI controls even if syntax-highlight decorations
 * replace the contents of the code element.
 * 解析笔记时把围栏 Markdown 语言保留为 CodeBlock 属性。显式 data 属性也保留在
 * 编辑器 HTML 中，即使语法高亮装饰替换了 code 元素内容，UI 控件仍可读取语言。
 */
export const MarkdownCodeBlockLowlight = CodeBlockLowlight.extend({
  // Schema priority also decides which node fills a generic `block+` slot.
  // Keep code below paragraphs so new table cells are paragraphs, not empty
  // code blocks. The high-priority Mod-A behavior lives in a plain extension.
  // Schema 优先级同时决定通用 `block+` 槽位由哪种节点填充；代码块优先级低于段落，使新建表格单元格是段落而非空代码块。高优先级的 Mod-A 行为放在独立扩展中。
  priority: 90,
  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: this.options.defaultLanguage,
        parseHTML: element => getSourceLanguage(element as HTMLElement),
        renderHTML: attributes => {
          const language = normalizeSourceLanguage(
            typeof attributes.language === 'string' ? attributes.language : null,
          );
          return language ? { 'data-language': language } : {};
        },
      },
    };
  },
  addNodeView() {
    const renderMermaidNodeView = ReactNodeViewRenderer(CodeBlockNodeView, {
      // A span keeps the editable code content valid inside the node view's
      // <code> element while the diagram preview remains non-editable.
      // 使用 span 使可编辑代码内容在节点视图的 <code> 内保持合法，图示预览保持不可编辑。
      contentDOMElementTag: 'span',
      update: ({ newNode, updateProps }) => {
        if (!isMermaidCodeBlock(newNode)) return false;
        updateProps();
        return true;
      },
    });
    return props => {
      if (isMermaidCodeBlock(props.node)) return renderMermaidNodeView(props);
      return createCodeMirrorCodeBlockNodeView(props.node, props.view, props.getPos);
    };
  },
});

/**
 * High-priority Mod-A shortcut that selects only the current code block text.
 * 高优先级 Mod-A 快捷键：仅选中当前代码块内的文本。
 */
export const CodeBlockSelectAll = Extension.create({
  name: 'menghanCodeBlockSelectAll',
  priority: 1_100,

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => {
        // Returning false falls through to the whole-document select-all. / 返回 false 时回落到全文全选的默认行为。
        const range = getCurrentCodeBlockTextRange(this.editor.state.selection);
        if (!range) return false;
        this.editor.view.dispatch(this.editor.state.tr.setSelection(
          TextSelection.create(this.editor.state.doc, range.from, range.to),
        ));
        return true;
      },
    };
  },
});
