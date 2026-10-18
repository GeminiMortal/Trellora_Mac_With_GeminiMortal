/**
 * ProseMirror node view that hosts a CodeMirror editor for code blocks, syncing edits in both directions.
 * ProseMirror 节点视图：为代码块承载 CodeMirror 编辑器，并双向同步编辑内容。
 */
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { searchKeymap } from '@codemirror/search';
import { EditorState, StateEffect, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView as CodeMirrorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view';
import { csharp } from '@replit/codemirror-lang-csharp';
import { exitCode } from '@tiptap/pm/commands';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView as ProseMirrorEditorView, NodeView } from '@tiptap/pm/view';
import { CODE_LANGUAGE_OPTIONS, normalizeCodeLanguage } from '../../utils/ui/codeLanguages.ts';

/**
 * Normalize the node's language attribute to a known code language id.
 * 将节点的 language 属性规范化为已知的代码语言 id。
 *
 * @param node - Code block node / 代码块节点
 * @returns Normalized language id / 规范化后的语言 id
 */
function getCodeBlockLanguage(node: ProseMirrorNode): string {
  return normalizeCodeLanguage(typeof node.attrs.language === 'string' ? node.attrs.language : '');
}

/**
 * Whether the given node is a code block that should render as a Mermaid diagram.
 * 判断给定节点是否应渲染为 Mermaid 图表的代码块。
 *
 * @param node - Code block node to test / 待检测的代码块节点
 * @returns True when the node's language is mermaid / 节点语言为 mermaid 时返回 true
 */
export function isMermaidCodeBlock(node: ProseMirrorNode): boolean {
  return getCodeBlockLanguage(node) === 'mermaid';
}

/**
 * Lazy CodeMirror language extension factories keyed by normalized language id.
 * 以规范化语言 id 为键的懒加载 CodeMirror 语言扩展工厂表。
 */
const codeMirrorLanguageExtensions: Partial<Record<string, () => Extension>> = {
  bash: () => StreamLanguage.define(shell),
  cpp,
  csharp,
  css,
  go,
  html,
  java,
  javascript: () => javascript({ jsx: true }),
  json,
  markdown,
  python,
  rust,
  sql,
  typescript: () => javascript({ jsx: true, typescript: true }),
  xml,
  yaml,
};

/**
 * Look up the display label for a language id, falling back to the raw id.
 * 查询语言 id 的显示名称；找不到时回退为原始 id。
 *
 * @param language - Normalized language id / 规范化语言 id
 * @returns Human-readable label / 可读的显示名称
 */
function getCodeBlockLanguageLabel(language: string): string {
  return CODE_LANGUAGE_OPTIONS.find(option => option.value === language)?.label
    ?? language;
}

/**
 * Node view embedding a CodeMirror instance for one code block, with language-aware highlighting.
 * 为单个代码块嵌入 CodeMirror 实例的节点视图，支持按语言高亮。
 */
class CodeMirrorCodeBlockNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseMirrorNode;
  private readonly outerView: ProseMirrorEditorView;
  private readonly getPos: () => number;
  private readonly codeMirrorHost: HTMLElement;
  private readonly languageLabel: HTMLSpanElement;
  private readonly baseExtensions: Extension[];
  private codeMirror: CodeMirrorView;
  private updating = false;
  private destroyed = false;

  constructor(node: ProseMirrorNode, outerView: ProseMirrorEditorView, getPos: () => number) {
    this.node = node;
    this.outerView = outerView;
    this.getPos = getPos;
    const language = getCodeBlockLanguage(node);

    this.dom = document.createElement('div');
    this.dom.className = 'code-block-node-view';
    this.dom.dataset.codeBlock = 'true';
    if (language !== 'plaintext') this.dom.dataset.language = language;

    const header = document.createElement('div');
    header.className = 'code-block-node-view-header';
    header.setAttribute('aria-hidden', 'true');
    this.languageLabel = document.createElement('span');
    this.languageLabel.textContent = getCodeBlockLanguageLabel(language);
    header.append(this.languageLabel);

    this.codeMirrorHost = document.createElement('div');
    this.codeMirrorHost.className = 'code-block-codemirror';
    this.dom.append(header, this.codeMirrorHost);

    this.baseExtensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      history(),
      syntaxHighlighting(defaultHighlightStyle),
      keymap.of([
        ...this.codeMirrorKeymap(),
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...closeBracketsKeymap,
        ...searchKeymap,
      ]),
      CodeMirrorView.updateListener.of(update => this.forwardUpdate(update)),
      CodeMirrorView.domEventHandlers({
        focus: () => {
          this.forwardFocus();
          return false;
        },
      }),
    ];

    this.codeMirror = new CodeMirrorView({
      state: EditorState.create({ doc: node.textContent, extensions: this.baseExtensions }),
      parent: this.codeMirrorHost,
    });
    this.configureLanguage(language);
  }

  /**
   * Sync the CodeMirror document and language when the ProseMirror node changes.
   * 当 ProseMirror 节点变化时同步 CodeMirror 文档与语言。
   *
   * @param node - Updated node / 更新后的节点
   * @returns Whether this view can keep representing the node / 该视图能否继续表示此节点
   */
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    if (isMermaidCodeBlock(node)) return false;
    const previousLanguage = getCodeBlockLanguage(this.node);
    const language = getCodeBlockLanguage(node);
    this.node = node;

    if (!this.updating) this.replaceCodeMirrorDocument(node.textContent);
    if (language !== previousLanguage) {
      if (language === 'plaintext') delete this.dom.dataset.language;
      else this.dom.dataset.language = language;
      this.languageLabel.textContent = getCodeBlockLanguageLabel(language);
      this.configureLanguage(language);
    }
    return true;
  }

  /**
   * Keep events inside the CodeMirror host away from ProseMirror's own handling.
   * 将 CodeMirror 宿主内的事件挡在 ProseMirror 自身处理之外。
   *
   * @param event - Event to inspect / 待检查的事件
   * @returns Whether the event happened inside the CodeMirror host / 事件是否发生在 CodeMirror 宿主内
   */
  stopEvent(event: Event): boolean {
    return this.codeMirrorHost.contains(event.target as Node);
  }

  /**
   * Ignore all DOM mutations from the host so ProseMirror never rescans the CodeMirror DOM.
   * 忽略宿主的全部 DOM 变更，避免 ProseMirror 重扫 CodeMirror 的 DOM。
   *
   * @returns Always true / 恒为 true
   */
  ignoreMutation(): boolean {
    return true;
  }

  /**
   * Tear down the CodeMirror instance and mark the view destroyed.
   * 销毁 CodeMirror 实例并标记视图已销毁。
   *
   * @returns Nothing. / 无返回值。
   */
  destroy(): void {
    this.destroyed = true;
    this.codeMirror.destroy();
  }

  /**
   * Resolve the node's current document position, tolerating detached nodes.
   * 解析节点当前的文档位置，容忍节点已脱离文档的情况。
   *
   * @returns The node position, or null when unavailable / 节点位置；不可用时返回 null
   */
  private getCurrentPosition(): number | null {
    try {
      const position = this.getPos();
      return typeof position === 'number' ? position : null;
    } catch {
      return null;
    }
  }

  /**
   * Install the CodeMirror language extension for the given language id.
   * 为给定语言 id 安装 CodeMirror 语言扩展。
   *
   * @param language - Normalized language id / 规范化语言 id
   * @returns Nothing. / 无返回值。
   */
  private configureLanguage(language: string): void {
    const createExtension = codeMirrorLanguageExtensions[language];
    if (!createExtension) {
      this.reconfigure([]);
      return;
    }

    this.reconfigure([createExtension()]);
  }

  /**
   * Rebuild the CodeMirror extension set from base extensions plus language extensions.
   * 用基础扩展加语言扩展重建 CodeMirror 扩展集。
   *
   * @param languageExtensions - Language-specific extensions / 语言相关扩展
   * @returns Nothing. / 无返回值。
   */
  private reconfigure(languageExtensions: Extension[]): void {
    if (this.destroyed) return;
    this.codeMirror.dispatch({
      effects: StateEffect.reconfigure.of([...this.baseExtensions, ...languageExtensions]),
    });
  }

  /**
   * Replace the CodeMirror document with the minimal change between the old and new text.
   * 以最小变更把 CodeMirror 文档替换为新文本。
   *
   * @param nextText - Text coming from the ProseMirror node / 来自 ProseMirror 节点的新文本
   * @returns Nothing. / 无返回值。
   */
  private replaceCodeMirrorDocument(nextText: string): void {
    const currentText = this.codeMirror.state.doc.toString();
    if (currentText === nextText) return;
    // Trim the shared prefix and suffix so the caret and undo stay stable. / 裁掉公共前后缀，保持光标与撤销稳定。
    let from = 0;
    while (from < currentText.length && currentText[from] === nextText[from]) from += 1;
    let currentTo = currentText.length;
    let nextTo = nextText.length;
    while (currentTo > from && nextTo > from && currentText[currentTo - 1] === nextText[nextTo - 1]) {
      currentTo -= 1;
      nextTo -= 1;
    }

    this.updating = true;
    try {
      this.codeMirror.dispatch({ changes: { from, to: currentTo, insert: nextText.slice(from, nextTo) } });
    } finally {
      this.updating = false;
    }
  }

  /**
   * Replay CodeMirror doc changes into the outer ProseMirror document and mirror the selection.
   * 将 CodeMirror 的文档变更回放到外层 ProseMirror 文档，并镜像选区。
   *
   * @param update - CodeMirror view update / CodeMirror 视图更新
   * @returns Nothing. / 无返回值。
   */
  private forwardUpdate(update: ViewUpdate): void {
    if (this.updating || !update.docChanged) return;
    const position = this.getCurrentPosition();
    if (position === null) return;

    let offset = position + 1;
    const transaction = this.outerView.state.tr;
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      transaction.insertText(inserted.toString(), offset + fromA, offset + toA);
      // Shift later change offsets by the length delta already applied. / 用已应用的长度差平移后续变更的偏移。
      offset += (toB - fromB) - (toA - fromA);
    });

    const selection = update.state.selection.main;
    const from = position + 1 + selection.from;
    const to = position + 1 + selection.to;
    const outerSelection = this.outerView.state.selection;
    if (outerSelection.from !== from || outerSelection.to !== to) {
      transaction.setSelection(TextSelection.create(transaction.doc, from, to));
    }

    this.updating = true;
    try {
      this.outerView.dispatch(transaction);
    } finally {
      this.updating = false;
    }
  }

  /**
   * Mirror the CodeMirror selection into ProseMirror when the inner editor gains focus.
   * 内层编辑器获得焦点时，把 CodeMirror 选区镜像到 ProseMirror。
   *
   * @returns Nothing. / 无返回值。
   */
  private forwardFocus(): void {
    const position = this.getCurrentPosition();
    if (position === null) return;
    const selection = this.codeMirror.state.selection.main;
    const from = position + 1 + selection.from;
    const to = position + 1 + selection.to;
    const outerSelection = this.outerView.state.selection;
    if (outerSelection.from === from && outerSelection.to === to) return;
    this.outerView.dispatch(this.outerView.state.tr.setSelection(
      TextSelection.create(this.outerView.state.doc, from, to),
    ));
  }

  /**
   * Key bindings that hand arrow navigation and Mod-Enter back to the outer editor at the block edges.
   * 在代码块边界处把方向键导航与 Mod-Enter 交还外层编辑器的按键绑定。
   *
   * @returns CodeMirror key bindings / CodeMirror 按键绑定列表
   */
  private codeMirrorKeymap() {
    return [
      { key: 'ArrowUp', run: () => this.maybeEscape('line', -1) },
      { key: 'ArrowDown', run: () => this.maybeEscape('line', 1) },
      { key: 'ArrowLeft', run: () => this.maybeEscape('char', -1) },
      { key: 'ArrowRight', run: () => this.maybeEscape('char', 1) },
      { key: 'Mod-Enter', run: () => this.exitCodeBlock() },
    ];
  }

  /**
   * Move the selection outside the code block when an arrow key reaches the document edge inside it.
   * 当方向键在代码块内到达文档边界时，把选区移出代码块。
   *
   * @param unit - Escape granularity: line or char / 逃逸粒度：整行或单字符
   * @param direction - Movement direction / 移动方向
   * @returns Whether the selection escaped the block / 选区是否已逃出代码块
   */
  private maybeEscape(unit: 'line' | 'char', direction: -1 | 1): boolean {
    const selection = this.codeMirror.state.selection.main;
    if (!selection.empty) return false;
    // Escape only at the first/last line or the document edge; otherwise CodeMirror moves normally. / 仅在首/末行或文档边界时逃逸，否则由 CodeMirror 正常移动光标。
    if (unit === 'line') {
      const line = this.codeMirror.state.doc.lineAt(selection.head);
      if (direction < 0 ? line.number > 1 : line.number < this.codeMirror.state.doc.lines) return false;
    } else if (direction < 0 ? selection.head > 0 : selection.head < this.codeMirror.state.doc.length) {
      return false;
    }

    const position = this.getCurrentPosition();
    if (position === null) return false;
    const target = position + (direction < 0 ? 0 : this.node.nodeSize);
    const selectionOutside = Selection.near(this.outerView.state.doc.resolve(target), direction);
    this.outerView.dispatch(this.outerView.state.tr.setSelection(selectionOutside).scrollIntoView());
    this.outerView.focus();
    return true;
  }

  /**
   * Exit the code block via the ProseMirror exitCode command and refocus the outer editor.
   * 通过 ProseMirror 的 exitCode 命令退出代码块，并重新聚焦外层编辑器。
   *
   * @returns Whether the block was exited / 是否成功退出代码块
   */
  private exitCodeBlock(): boolean {
    const exited = exitCode(this.outerView.state, transaction => this.outerView.dispatch(transaction));
    if (exited) this.outerView.focus();
    return exited;
  }
}

/**
 * Factory used by the code block node to create a CodeMirror-backed node view.
 * 代码块节点使用的工厂函数，创建基于 CodeMirror 的节点视图。
 *
 * @param node - Code block node / 代码块节点
 * @param view - Outer ProseMirror editor view / 外层 ProseMirror 编辑器视图
 * @param getPos - Callback returning the node's document position / 返回节点文档位置的回调
 * @returns The created node view / 创建的节点视图
 */
export function createCodeMirrorCodeBlockNodeView(
  node: ProseMirrorNode,
  view: ProseMirrorEditorView,
  getPos: () => number,
): NodeView {
  return new CodeMirrorCodeBlockNodeView(node, view, getPos);
}
