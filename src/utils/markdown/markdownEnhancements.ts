/**
 * DOM enhancements applied after Markdown rendering: table wrapping, code
 * highlighting, copy actions, and Mermaid diagram rendering.
 * Markdown 渲染后的 DOM 增强：表格包裹、代码高亮、复制按钮与 Mermaid 图表渲染。
 */

import mermaid from 'mermaid';
import { common, createLowlight } from 'lowlight';
import { copyPlainText } from '../editor/clipboard.ts';
import { enhanceHeadingAnchors } from '../note/headingAnchors.ts';
import type { ResolvedTheme } from '../ui/theme.ts';

/**
 * Options controlling how a rendered Markdown container is enhanced.
 * 控制已渲染 Markdown 容器如何增强的选项。
 */
export interface MarkdownEnhancementOptions {
  resolvedTheme: ResolvedTheme;
  showCodeCopyActions?: boolean;
  renderMermaid?: boolean;
  interactive?: boolean;
  signal?: AbortSignal;
  yieldControl?: (signal?: AbortSignal) => Promise<void>;
}

/**
 * Performance and safety limits for Markdown DOM enhancements.
 * Markdown DOM 增强的性能与安全上限。
 */
export const markdownEnhancementLimits = {
  maxCodeBlockCharacters: 100_000,
  totalHighlightCharacters: 300_000,
  enhancementBatchSize: 10,
  mermaidConcurrency: 2,
  maxMermaidPngDimension: 4_096,
  maxMermaidPngPixels: 16_000_000,
} as const;

let nextMermaidDiagramId = 0;
const syntaxHighlighter = createLowlight(common);
const languageAliases: Record<string, string> = {
  c: 'c',
  'c++': 'cpp',
  cs: 'csharp',
  html: 'xml',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  txt: 'plaintext',
  yml: 'yaml',
};

/**
 * Minimal shape of a lowlight highlight AST node.
 * lowlight 高亮 AST 节点的最小结构。
 */
interface HighlightNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HighlightNode[];
}

/**
 * Apply the DOM-only enhancements shared by the live preview and HTML export.
 * 应用实时预览与 HTML 导出共用的纯 DOM 增强。
 *
 * @param container - Rendered Markdown root element / 已渲染的 Markdown 根元素
 * @param options - Enhancement options including theme and cancellation / 包含主题与取消信号的增强选项
 * @returns Resolves when all enhancements finish or the signal aborts / 全部增强完成或信号中止后 resolve
 */
export async function enhanceMarkdownContainer(
  container: HTMLElement,
  options: MarkdownEnhancementOptions,
): Promise<void> {
  if (options.signal?.aborted) return;
  const yieldControl = options.yieldControl ?? yieldMarkdownEnhancementTask;

  enhanceHeadingAnchors(container);
  await wrapMarkdownTables(container, yieldControl, options.signal);
  if (options.signal?.aborted) return;

  const codeBlocks = [...container.querySelectorAll<HTMLElement>('pre code')];
  const regularCodeBlocks = codeBlocks.filter((block) => options.renderMermaid === false || !block.classList.contains('language-mermaid'));
  let highlightedCharacters = 0;
  let highlightBudgetExhausted = false;

  for (let index = 0; index < regularCodeBlocks.length; index += 1) {
    if (options.signal?.aborted) return;
    const block = regularCodeBlocks[index];
    const remainingBudget = highlightBudgetExhausted
      ? 0
      : markdownEnhancementLimits.totalHighlightCharacters - highlightedCharacters;
    highlightedCharacters += highlightCodeBlock(
      block,
      remainingBudget,
    );
    if (block.dataset.highlightSkipped === 'budget') highlightBudgetExhausted = true;
    if (options.showCodeCopyActions) addCodeTools(block);

    if ((index + 1) % markdownEnhancementLimits.enhancementBatchSize === 0) {
      await yieldControl(options.signal);
    }
  }

  if (options.signal?.aborted) return;
  const mermaidBlocks = options.renderMermaid === false ? [] : codeBlocks.filter((block) => block.classList.contains('language-mermaid'));
  if (mermaidBlocks.length === 0) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: options.resolvedTheme === 'dark' ? 'dark' : 'default',
  });

  await renderMermaidBlocks(container, mermaidBlocks, {
    interactive: options.interactive ?? false,
    signal: options.signal,
    yieldControl,
  });
}

const codeLanguageLabels: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  go: 'Go',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  php: 'PHP',
  plaintext: '纯文本',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  shell: 'Shell',
  sql: 'SQL',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
};

/**
 * Append a language label and a copy button to a code block's `<pre>` wrapper.
 * 为代码块的 `<pre>` 包裹元素追加语言标签与复制按钮。
 */
function addCodeTools(block: HTMLElement): void {
  const pre = block.closest('pre');
  if (!pre || pre.querySelector(':scope > .markdown-code-copy-button')) return;

  const language = block.dataset.highlightedLanguage ?? 'plaintext';
  const languageLabel = document.createElement('span');
  languageLabel.className = 'markdown-code-language-label';
  languageLabel.textContent = codeLanguageLabels[language] ?? language.toUpperCase();
  languageLabel.setAttribute('aria-label', `代码语言：${languageLabel.textContent}`);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'markdown-code-copy-button';
  button.dataset.state = 'idle';
  button.setAttribute('aria-label', '复制代码');
  button.setAttribute('aria-live', 'polite');
  button.title = '复制代码';
  button.textContent = '复制代码';

  let resetTimer: number | undefined;
  button.addEventListener('click', () => {
    const source = getCodeBlockCopyText(block.textContent ?? '');
    void copyPlainText(source).then((copied) => {
      window.clearTimeout(resetTimer);
      button.dataset.state = copied ? 'success' : 'error';
      button.textContent = copied ? '已复制' : '复制失败';
      button.title = button.textContent;
      button.setAttribute('aria-label', button.textContent);
      resetTimer = window.setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.state = 'idle';
        button.textContent = '复制代码';
        button.title = '复制代码';
        button.setAttribute('aria-label', '复制代码');
      }, 1_800);
    });
  });

  pre.classList.add('has-code-copy-action');
  pre.appendChild(languageLabel);
  pre.appendChild(button);
}

/**
 * Drop a single trailing newline so copied code matches what users expect.
 * 去掉单个结尾换行，使复制的代码符合用户预期。
 */
function getCodeBlockCopyText(source: string): string {
  return source.replace(/\r?\n$/, '');
}

/**
 * Highlight one code block with lowlight, enforcing size and total-budget limits.
 * 使用 lowlight 高亮单个代码块，并强制执行单块大小与总预算限制。
 *
 * @param block - The `<code>` element to highlight / 待高亮的 `<code>` 元素
 * @param remainingBudget - Remaining characters allowed for highlighting / 剩余可用于高亮的字符预算
 * @returns Number of source characters processed / 处理的源字符数
 */
function highlightCodeBlock(block: HTMLElement, remainingBudget: number): number {
  const source = block.textContent ?? '';
  if (!source) {
    block.dataset.highlightedLanguage = 'plaintext';
    return 0;
  }
  if (source.length > markdownEnhancementLimits.maxCodeBlockCharacters) {
    block.dataset.highlightedLanguage = 'plaintext';
    block.dataset.highlightSkipped = 'size';
    return 0;
  }
  if (source.length > remainingBudget) {
    block.dataset.highlightedLanguage = 'plaintext';
    block.dataset.highlightSkipped = 'budget';
    return 0;
  }

  const declaredLanguage = [...block.classList]
    .find((className) => className.startsWith('language-'))
    ?.slice('language-'.length)
    .toLowerCase();
  const language = declaredLanguage ? languageAliases[declaredLanguage] ?? declaredLanguage : null;

  try {
    const hasRegisteredLanguage = Boolean(language && syntaxHighlighter.registered(language));
    const highlighted = hasRegisteredLanguage && language
      ? syntaxHighlighter.highlight(language, source)
      : syntaxHighlighter.highlightAuto(source);
    const fragment = document.createDocumentFragment();
    appendHighlightNodes(fragment, highlighted.children as HighlightNode[]);
    // Reject highlight output that altered the source text to avoid data loss. / 拒绝改变了源文本的高亮输出，避免内容丢失。
    if (fragment.textContent !== source) {
      block.dataset.highlightedLanguage = 'plaintext';
      return source.length;
    }
    block.replaceChildren(fragment);
    block.classList.add('hljs');
    block.dataset.highlightedLanguage = hasRegisteredLanguage
      ? language ?? 'plaintext'
      : highlighted.data?.language ?? 'plaintext';
  } catch {
    block.dataset.highlightedLanguage = 'plaintext';
  }
  return source.length;
}

/**
 * Recursively convert lowlight AST nodes into DOM text nodes and spans.
 * 将 lowlight AST 节点递归转换为 DOM 文本节点与 span 元素。
 */
function appendHighlightNodes(parent: Node, nodes: HighlightNode[]): void {
  nodes.forEach((node) => {
    if (node.type === 'text') {
      parent.appendChild(document.createTextNode(node.value ?? ''));
      return;
    }
    if (node.type !== 'element') return;

    const span = document.createElement('span');
    const classNames = Array.isArray(node.properties?.className)
      ? node.properties.className
      : [node.properties?.className];
    // Keep only well-formed hljs-* classes to avoid injecting arbitrary class names. / 仅保留合法的 hljs-* 类名，避免注入任意类名。
    classNames
      .filter((className): className is string => typeof className === 'string' && /^hljs-[\w-]+$/.test(className))
      .forEach((className) => span.classList.add(className));
    appendHighlightNodes(span, node.children ?? []);
    parent.appendChild(span);
  });
}

/**
 * Wrap each table in a horizontally scrollable region for narrow layouts.
 * 将每个表格包裹在可横向滚动的区域内，以适配窄屏布局。
 */
async function wrapMarkdownTables(
  container: HTMLElement,
  yieldControl: NonNullable<MarkdownEnhancementOptions['yieldControl']>,
  signal?: AbortSignal,
): Promise<void> {
  const tables = [...container.querySelectorAll<HTMLTableElement>('table')];
  for (let index = 0; index < tables.length; index += 1) {
    if (signal?.aborted) return;
    const table = tables[index];
    if (!table.parentElement?.classList.contains('markdown-table-scroll')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table-scroll';
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', '可横向滚动的表格');
      wrapper.tabIndex = 0;
      table.before(wrapper);
      wrapper.appendChild(table);
    }
    if ((index + 1) % markdownEnhancementLimits.enhancementBatchSize === 0) {
      await yieldControl(signal);
    }
  }
}

/**
 * Options shared by the Mermaid block render workers.
 * Mermaid 块渲染 worker 共用的选项。
 */
interface MermaidRenderOptions {
  interactive: boolean;
  signal?: AbortSignal;
  yieldControl: NonNullable<MarkdownEnhancementOptions['yieldControl']>;
}

/**
 * Render Mermaid blocks with bounded concurrency and cooperative yielding.
 * 以受限并发与协作式让出的方式渲染 Mermaid 代码块。
 */
async function renderMermaidBlocks(
  container: HTMLElement,
  blocks: HTMLElement[],
  options: MermaidRenderOptions,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(markdownEnhancementLimits.mermaidConcurrency, blocks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!options.signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= blocks.length) return;
      await renderMermaidBlock(container, blocks[index], options);
      await options.yieldControl(options.signal);
    }
  });
  await Promise.all(workers);
}

/**
 * Render a single Mermaid block into an SVG preview, or an error panel on failure.
 * 将单个 Mermaid 代码块渲染为 SVG 预览；失败时渲染错误面板。
 */
async function renderMermaidBlock(
  container: HTMLElement,
  block: HTMLElement,
  options: MermaidRenderOptions,
): Promise<void> {
  const source = block.textContent ?? '';
  const pre = block.closest('pre');
  if (!pre) return;

  try {
    const id = `menghan-mermaid-${++nextMermaidDiagramId}`;
    const { svg, bindFunctions } = await mermaid.render(id, source);
    if (options.signal?.aborted || !container.contains(pre)) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-preview';
    const canvas = document.createElement('div');
    canvas.className = 'mermaid-preview-canvas';
    canvas.innerHTML = svg;
    wrapper.appendChild(canvas);
    pre.replaceWith(wrapper);
    bindFunctions?.(canvas);

    const renderedSvg = canvas.querySelector<SVGSVGElement>('svg');
    if (renderedSvg) {
      applyMermaidScale(renderedSvg, 1, true);
      if (options.interactive) wrapper.prepend(createMermaidToolbar(renderedSvg));
    }
  } catch {
    if (options.signal?.aborted || !container.contains(pre)) return;
    pre.replaceWith(createMermaidError(source));
  }
}

/**
 * Build the zoom/copy/export toolbar shown above interactive Mermaid diagrams.
 * 构建交互式 Mermaid 图表上方的缩放/复制/导出工具栏。
 */
function createMermaidToolbar(svg: SVGSVGElement): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Mermaid 图表工具');
  toolbar.dataset.markdownExportExclude = 'true';
  let scale = 1;
  let fitToWidth = true;

  const status = document.createElement('span');
  status.className = 'mermaid-toolbar-status';
  status.setAttribute('aria-live', 'polite');
  const scaleLabel = document.createElement('output');
  scaleLabel.className = 'mermaid-toolbar-scale';
  scaleLabel.textContent = '适应';
  scaleLabel.setAttribute('aria-live', 'polite');

  const updateScale = (delta: number) => {
    fitToWidth = false;
    scale = Math.min(4, Math.max(0.25, scale + delta));
    applyMermaidScale(svg, scale, false);
    scaleLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  toolbar.append(
    createMermaidToolButton('−', '缩小图表', 'zoom-out', () => updateScale(-0.25)),
    scaleLabel,
    createMermaidToolButton('+', '放大图表', 'zoom-in', () => updateScale(0.25)),
    createMermaidToolButton('↔', '适应宽度', 'fit', () => {
      fitToWidth = true;
      scale = 1;
      applyMermaidScale(svg, scale, fitToWidth);
      scaleLabel.textContent = '适应';
    }),
  );

  const spacer = document.createElement('span');
  spacer.className = 'mermaid-toolbar-spacer';
  toolbar.append(spacer, status);
  toolbar.append(
    createMermaidToolButton('SVG', '复制 SVG', 'copy-svg', () => {
      try {
        void copyPlainText(serializeMermaidSvg(svg)).then((copied) => {
          status.textContent = copied ? 'SVG 已复制' : '复制失败';
        });
      } catch {
        status.textContent = '复制失败';
      }
    }),
    createMermaidToolButton('PNG', '导出 PNG', 'export-png', () => {
      status.textContent = '正在生成 PNG';
      void exportMermaidPng(svg).then(
        () => { status.textContent = 'PNG 已导出'; },
        () => { status.textContent = 'PNG 导出失败'; },
      );
    }),
  );
  return toolbar;
}

/**
 * Create a labeled toolbar button with an accessible name and click handler.
 * 创建带可访问名称与点击处理器的工具栏按钮。
 */
function createMermaidToolButton(
  label: string,
  accessibleLabel: string,
  action: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mermaid-toolbar-button';
  button.dataset.action = action;
  button.setAttribute('aria-label', accessibleLabel);
  button.title = accessibleLabel;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Apply zoom or fit-to-width sizing to a rendered Mermaid SVG.
 * 对已渲染的 Mermaid SVG 应用缩放或适应宽度。
 */
function applyMermaidScale(svg: SVGSVGElement, scale: number, fitToWidth: boolean): void {
  svg.style.width = fitToWidth ? '100%' : `${Math.round(scale * 100)}%`;
  svg.style.maxWidth = fitToWidth ? '100%' : 'none';
  svg.style.height = 'auto';
  svg.dataset.fitToWidth = fitToWidth ? 'true' : 'false';
  svg.dataset.scale = String(scale);
}

/**
 * Build a fallback panel showing the failure message and collapsible Mermaid source.
 * 构建失败回退面板，显示错误信息与可折叠的 Mermaid 源码。
 */
function createMermaidError(source: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'mermaid-preview mermaid-error';
  const message = document.createElement('p');
  message.className = 'mermaid-error-message';
  message.textContent = 'Mermaid 渲染失败，请检查图表语法。';

  const sourceDetails = document.createElement('details');
  sourceDetails.className = 'mermaid-source-details';
  const summary = document.createElement('summary');
  summary.textContent = '查看 Mermaid 源码';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  sourceDetails.append(summary, pre);
  wrapper.append(message, sourceDetails);
  return wrapper;
}

/**
 * Serialize a Mermaid SVG to a standalone string with an explicit xmlns.
 * 将 Mermaid SVG 序列化为带显式 xmlns 的独立字符串。
 */
function serializeMermaidSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const Serializer = svg.ownerDocument.defaultView?.XMLSerializer;
  if (!Serializer) throw new Error('当前环境不支持 SVG 序列化。');
  return new Serializer().serializeToString(clone);
}

/**
 * Rasterize a Mermaid SVG to PNG and trigger a browser download.
 * 将 Mermaid SVG 光栅化为 PNG 并触发浏览器下载。
 */
async function exportMermaidPng(svg: SVGSVGElement): Promise<void> {
  const view = svg.ownerDocument.defaultView;
  if (!view?.URL?.createObjectURL) throw new Error('当前环境不支持 PNG 导出。');
  const serialized = serializeMermaidSvg(svg);
  const sourceUrl = view.URL.createObjectURL(new view.Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const image = await loadImage(view, sourceUrl);
    const size = resolveMermaidPngSize(svg, image.naturalWidth, image.naturalHeight);
    const canvas = svg.ownerDocument.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 PNG 画布。');
    context.drawImage(image, 0, 0, size.width, size.height);
    const png = await canvasToBlob(canvas);
    downloadBlob(svg.ownerDocument, png, 'mermaid-diagram.png');
  } finally {
    view.URL.revokeObjectURL(sourceUrl);
  }
}

/**
 * Load an image source into an HTMLImageElement, rejecting on decode errors.
 * 将图片地址加载为 HTMLImageElement，解码失败时 reject。
 */
function loadImage(view: Window, source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = view.document.createElement('img');
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SVG 无法转换为 PNG。'));
    image.src = source;
  });
}

/**
 * Compute a PNG size from the SVG viewBox, clamped by dimension and pixel limits.
 * 基于 SVG viewBox 计算 PNG 尺寸，并按边长与像素上限进行钳制。
 */
function resolveMermaidPngSize(
  svg: SVGSVGElement,
  imageWidth: number,
  imageHeight: number,
): { width: number; height: number } {
  const viewBox = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[ ,]+/)
    .map(Number);
  const sourceWidth = Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : imageWidth || 1_200;
  const sourceHeight = Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : imageHeight || 800;
  const dimensionScale = Math.min(
    2,
    markdownEnhancementLimits.maxMermaidPngDimension / Math.max(sourceWidth, sourceHeight),
  );
  const pixelScale = Math.sqrt(
    markdownEnhancementLimits.maxMermaidPngPixels / Math.max(1, sourceWidth * sourceHeight),
  );
  const scale = Math.max(0.01, Math.min(dimensionScale, pixelScale));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/**
 * Encode a canvas as a PNG blob via a Promise wrapper.
 * 通过 Promise 封装将画布编码为 PNG blob。
 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败。'));
    }, 'image/png');
  });
}

/**
 * Trigger a one-shot anchor download of a blob, then release its object URL.
 * 通过一次性 <a> 下载触发 blob 保存，随后释放其 object URL。
 */
function downloadBlob(document: Document, blob: Blob, fileName: string): void {
  const view = document.defaultView;
  if (!view?.URL?.createObjectURL) throw new Error('当前环境不支持文件导出。');
  const url = view.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
}

/**
 * Yield to the browser between enhancement batches via requestIdleCallback (or a timeout fallback).
 * 在增强批次之间通过 requestIdleCallback（或超时回退）让出浏览器控制权。
 */
async function yieldMarkdownEnhancementTask(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const schedulerWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;
    const finish = () => {
      if (idleHandle !== undefined) schedulerWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    signal?.addEventListener('abort', finish, { once: true });
    if (schedulerWindow.requestIdleCallback) {
      idleHandle = schedulerWindow.requestIdleCallback(finish, { timeout: 32 });
    } else {
      timeoutHandle = window.setTimeout(finish, 0);
    }
  });
}
