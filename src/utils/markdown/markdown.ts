/**
 * Markdown parsing and HTML conversion helpers for the note editor and preview.
 * 笔记编辑器与预览使用的 Markdown 解析及 HTML 转换工具。
 */

import { Marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { toEditorImageUrl } from '../../../shared/editorImageProtocol.ts';
import { createRelaxedStrongExtension, createWikiLinkExtension, prepareMarkdownDocument } from './markdownExtensions.ts';
import { createMathMarkdownExtension } from './markdownMath.ts';

const htmlNotePattern = /^<(article|blockquote|div|h[1-6]|ol|p|pre|table|ul)\b/i;
const searchMarkPattern = /<mark[^>]*>([\s\S]*?)<\/mark>/gi;
const orderedListStartAttributePattern = /\sstart\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const blockElementPattern = /^\s*<(address|article|aside|blockquote|div|dl|figure|h[1-6]|hr|ol|p|pre|table|ul)\b/i;
const preservedBlankLineToken = 'MENGHAN_PRESERVED_BLANK_LINE_7D3A';
const preservedBlankLineHtml = '<p data-menghan-blank-line="true"></p>';

/**
 * Asset paths used to resolve relative images while rendering Markdown.
 * 渲染 Markdown 时用于解析相对图片路径的资源上下文。
 */
export interface MarkdownAssetContext {
    currentPath?: string | null;
    libraryPath?: string | null;
    externalAssetUrls?: Record<string, string>;
}

/**
 * Interaction mode controlling whether task-list checkboxes are editable.
 * 交互模式，决定任务列表复选框是否可编辑。
 */
export type TaskListInteractionMode = 'editor' | 'readonly';

/**
 * Rendering context combining asset paths and task-list interaction mode.
 * 组合资源路径与任务列表交互模式的渲染上下文。
 */
export interface MarkdownRenderContext extends MarkdownAssetContext {
  taskListMode?: TaskListInteractionMode;
}

/**
 * Kind of Markdown block that can be anchored to a source line.
 * 可锚定到源代码行的 Markdown 块类型。
 */
export type MarkdownLineAnchorKind =
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'listItem'
  | 'code'
  | 'thematicBreak'
  | 'tableRow';

/**
 * Source-line anchor describing one rendered Markdown block.
 * 描述单个已渲染 Markdown 块的源行锚点。
 */
export interface MarkdownLineAnchor {
  line: number;
  kind: MarkdownLineAnchorKind;
  text: string;
}

/**
 * A DOM element matched to a Markdown source line.
 * 与 Markdown 源行匹配的 DOM 元素。
 */
export interface MarkdownLineTarget {
  line: number;
  element: HTMLElement;
}

/**
 * Detect whether the content looks like a raw HTML note rather than Markdown.
 * 判断内容是否更像原始 HTML 笔记而非 Markdown。
 *
 * @param content - Note source text / 笔记源文本
 * @returns True when the content starts with a block-level HTML tag / 以块级 HTML 标签开头时返回 true
 */
export function isProbablyHtmlNote(content: string): boolean {
  return htmlNotePattern.test(content.trim());
}

/**
 * Remove search-highlight `<mark>` wrappers while keeping their inner text.
 * 移除搜索高亮 `<mark>` 包裹标签，同时保留其内部文本。
 *
 * @param html - HTML containing search marks / 含搜索标记的 HTML
 * @returns HTML with mark tags stripped / 去除 mark 标签后的 HTML
 */
export function stripSearchMarks(html: string): string {
  return html.replace(searchMarkPattern, '$1');
}

/**
 * Convert Markdown to HTML using the app's Marked extensions (wiki links, math, relaxed bold).
 * 使用应用的 Marked 扩展（Wiki 链接、公式、宽松加粗）将 Markdown 转换为 HTML。
 *
 * @param markdown - Markdown source / Markdown 源文本
 * @param renderContext - Optional asset and task-list context / 可选的资源与任务列表上下文
 * @returns Rendered HTML string / 渲染得到的 HTML 字符串
 */
export function markdownToHtml(markdown: string, renderContext?: MarkdownRenderContext): string {
  const parser = new Marked(
    createWikiLinkExtension(),
    createRelaxedStrongExtension(),
    createMathMarkdownExtension((token) => {
      const block = token.type === 'markdownMathBlock';
      const tag = block ? 'div' : 'span';
      return `<${tag} data-type="${block ? 'formulaBlock' : 'inlineFormula'}" data-math-source="${escapeHtml(token.text)}" data-math-markdown="${escapeHtml(token.raw)}" data-math-delimiter="${escapeHtml(token.delimiter)}" data-math-display="${token.displayMode}"><code>${escapeHtml(token.text)}</code></${tag}>${block ? '\n' : ''}`;
    }),
  );
  return markdownToHtmlWithParser(
    markdown,
    (preparedMarkdown) => parser.parse(preparedMarkdown, {
      async: false,
      breaks: false,
      gfm: true,
    }) as string,
    renderContext,
  );
}

/**
 * Run a custom Markdown parser and apply the shared HTML normalization pipeline.
 * 运行自定义 Markdown 解析器，并应用统一的 HTML 规范化流水线。
 *
 * @param markdown - Markdown source / Markdown 源文本
 * @param parser - Callback turning prepared Markdown into HTML / 将预处理后的 Markdown 转为 HTML 的回调
 * @param renderContext - Optional asset and task-list context / 可选的资源与任务列表上下文
 * @returns Normalized HTML string / 规范化后的 HTML 字符串
 */
export function markdownToHtmlWithParser(
  markdown: string,
  parser: (preparedMarkdown: string) => string,
  renderContext?: MarkdownRenderContext,
): string {
  const html = parser(preserveExtraBlankLines(normalizeLegacyTableCellCodeBlocks(markdown)));
  const taskListMode = renderContext?.taskListMode ?? 'editor';
  return normalizeImageSources(
    normalizeOrderedListStarts(normalizeTaskListMarkup(html, taskListMode)),
    renderContext,
  );
}

/**
 * Convert note content (Markdown or raw HTML) into editable HTML for the editor.
 * 将笔记内容（Markdown 或原始 HTML）转换为编辑器可编辑的 HTML。
 *
 * @param content - Raw note content / 原始笔记内容
 * @param assetContext - Optional asset paths for image resolution / 可选的图片解析资源路径
 * @returns Editor-ready HTML, or an empty string for empty bodies / 编辑器可用的 HTML；正文为空时返回空字符串
 */
export function contentToEditorHtml(content: string, assetContext?: MarkdownAssetContext): string {
  const body = prepareMarkdownDocument(content, 'strip').markdown;
  if (body === '') return '';
  return isProbablyHtmlNote(body)
    ? normalizeImageSources(normalizeOrderedListStarts(body), assetContext)
    : markdownToHtml(body, { ...assetContext, taskListMode: 'editor' });
}

/**
 * Convert editor HTML back to Markdown, reusing the original frontmatter bytes.
 * Keep validated source metadata outside the editable body and preserve its exact bytes.
 * 将编辑器 HTML 转换回 Markdown，复用原始 frontmatter 字节；已校验的源元数据保留在可编辑正文之外且字节不变。
 *
 * @param html - Editor HTML / 编辑器 HTML
 * @param originalMarkdown - Original note source used for the metadata header / 用于元数据头的原始笔记源文本
 * @returns Markdown with the preserved metadata header and converted body / 保留元数据头并转换正文后的 Markdown
 */
export function htmlToMarkdown(html: string, originalMarkdown = ''): string {
  const cleanHtml = normalizeOrderedListStarts(stripSearchMarks(html));
  const turndown = createTurndownService();
  const body = restorePreservedBlankLines(normalizeMarkdownSpacing(turndown.turndown(cleanHtml)));
  const originalBody = prepareMarkdownDocument(originalMarkdown, 'strip').markdown;
  const header = originalMarkdown.slice(0, originalMarkdown.length - originalBody.length);
  const separator = header && body && !header.endsWith('\n') ? '\n' : '';
  return header + separator + body;
}

/**
 * Browsers and pasted HTML can carry an empty or non-numeric ordered-list
 * start attribute. Letting it reach Tiptap/Turndown turns every marker into
 * `NaN.`. Removing only invalid start attributes preserves valid custom starts.
 * 浏览器与粘贴的 HTML 可能带有空的或非数字的有序列表 start 属性；若放行到
 * Tiptap/Turndown 会把每个标记变成 `NaN.`。仅移除无效 start 属性即可保留合法的自定义起始序号。
 *
 * @param html - HTML containing ordered lists / 含有序列表的 HTML
 * @returns HTML with only valid start attributes retained / 仅保留合法 start 属性的 HTML
 */
export function normalizeOrderedListStarts(html: string): string {
  return html.replace(/<ol\b([^>]*)>/gi, (tag, attributes: string) => {
    const normalizedAttributes = attributes.replace(
      orderedListStartAttributePattern,
      (attribute, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
        const rawStart = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim();
        return /^[+-]?\d+$/.test(rawStart) ? attribute : '';
      },
    );

    return `<ol${normalizedAttributes}>`;
  });
}

/**
 * Build the Turndown service with app-specific rules for formulas, wiki links,
 * Tiptap tables, task items, fenced code and preserved blank lines.
 * 构建 Turndown 服务，并注册公式、Wiki 链接、Tiptap 表格、任务项、围栏代码与空行保留等应用专属规则。
 */
function createTurndownService(): TurndownService {
  const turndown = new TurndownService({
    blankReplacement: (_content, node) => (
      node.nodeName === 'P' && isEmptyEditorParagraph(node as HTMLElement)
        ? `\n\n${preservedBlankLineToken}\n\n`
        : ''
    ),
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    fence: '```',
    headingStyle: 'atx',
    hr: '---',
    strongDelimiter: '**',
  });

  turndown.use(gfm);

  // Literal text from plain paste must survive Markdown parsing, including HTML tags/entities. / 纯文本粘贴的字面内容必须在 Markdown 解析后原样保留，包括 HTML 标签/实体。
  // This applies to text nodes only; code, formulas and explicit HTML/table rules keep their syntax. / 仅作用于文本节点，代码、公式及显式 HTML/表格规则保留原有语法。
  const escapeMarkdownText = turndown.escape.bind(turndown);
  turndown.escape = (text) => escapeMarkdownText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // Backslash breaks survive whitespace cleanup; table cells use their own <br> serializer. / 反斜杠换行可在空白清理后保留；表格单元格使用自己的 <br> 序列化方式。
  turndown.addRule('explicitLineBreak', {
    filter: 'br',
    replacement: (_content, node) => (
      (node as HTMLElement).closest('td, th') ? '  \n' : '\\' + '\n'
    ),
  });

  turndown.addRule('formula', {
    filter: (node) => (
      ['formulaBlock', 'inlineFormula'].includes((node as HTMLElement).getAttribute?.('data-type') ?? '')
    ),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const source = element.querySelector(':scope > code')?.textContent ?? element.textContent ?? '';
      const block = element.getAttribute('data-type') === 'formulaBlock';
      const original = element.getAttribute('data-math-markdown');
      const delimiter = element.getAttribute('data-math-delimiter') || (block ? '$$' : '$');
      const closing = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
      const math = original && source === element.getAttribute('data-math-source')
        ? original
        : `${delimiter}${block ? '\n' : ''}${source}${block ? '\n' : ''}${closing}`;
      return block ? `\n\n${math}\n\n` : math;
    },
  });

  turndown.addRule('tiptapTable', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) => serializeMarkdownTable(node as HTMLTableElement, turndown),
  });

  turndown.addRule('tiptapTaskItem', {
    filter: (node) => (
      node.nodeName === 'LI'
      && (node as HTMLElement).getAttribute('data-type') === 'taskItem'
    ),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const checked = element.getAttribute('data-checked') === 'true'
        || element.querySelector('input[type="checkbox"]')?.hasAttribute('checked')
        || (element.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked
        || false;
      const body = element.querySelector(':scope > div') ?? element;
      const bodyMarkdown = turndown
        .turndown(body.innerHTML)
        .trim()
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n/g, '\n  ');

      return `\n- [${checked ? 'x' : ' '}] ${bodyMarkdown}\n`;
    },
  });

  turndown.addRule('fencedCodeBlockWithLanguage', {
    filter: (node) => (
      node.nodeName === 'PRE'
      && node.firstChild?.nodeName === 'CODE'
    ),
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const code = pre.firstElementChild as HTMLElement | null;
      const rawCode = code?.textContent ?? '';
      const language = getCodeBlockLanguage(pre, code);
      const normalizedCode = rawCode.replace(/\n$/, '');

      return `\n\n\`\`\`${language}\n${normalizedCode}\n\`\`\`\n\n`;
    },
  });

  turndown.addRule('wikiLink', {
    filter: (node) => (
      node.nodeName === 'A'
      && Boolean((node as HTMLElement).getAttribute('data-wiki-link'))
    ),
    replacement: (content, node) => {
      const element = node as HTMLElement;
      const target = element.getAttribute('data-wiki-link')?.trim() ?? '';
      const alias = element.getAttribute('data-wiki-alias')?.trim() || content.trim();
      if (!target) return content;
      if (alias && alias !== target) return `[[${target}|${alias}]]`;
      return `[[${target}]]`;
    },
  });

  turndown.addRule('menghanImage', {
    filter: (node) => (
      node.nodeName === 'IMG'
      && Boolean((node as HTMLElement).getAttribute('data-menghan-relative'))
    ),
    replacement: (_content, node) => {
      const element = node as HTMLImageElement;
      const alt = element.getAttribute('alt') ?? '';
      const relativePath = element.getAttribute('data-menghan-relative') ?? element.getAttribute('src') ?? '';
      return relativePath ? `![${alt}](${relativePath})` : '';
    },
  });

  return turndown;
}

/**
 * Escape text for safe interpolation into HTML element content.
 * 转义文本以便安全地插入 HTML 元素内容。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tiptap serializes tables as `table > colgroup + tbody` and wraps cell
 * content in paragraphs. turndown-plugin-gfm does not recognize that shape,
 * so it keeps the complete table as HTML. Serialize simple tables ourselves;
 * keep merged/nested tables as HTML because GFM cannot represent them without
 * losing row/column span information.
 * Tiptap 将表格序列化为 `table > colgroup + tbody` 且单元格内容包裹在段落中；
 * turndown-plugin-gfm 无法识别该结构而会整表保留为 HTML。因此简单表格由我们自行
 * 序列化；合并/嵌套表格保留为 HTML，因为 GFM 无法在不丢失跨行跨列信息的情况下表达它们。
 *
 * @param table - HTML table element / HTML 表格元素
 * @param turndown - Turndown instance used for cell content / 用于单元格内容的 Turndown 实例
 * @returns GFM table Markdown, or raw HTML for complex tables / GFM 表格 Markdown；复杂表格返回原始 HTML
 */
function serializeMarkdownTable(table: HTMLTableElement, turndown: TurndownService): string {
  const rows = Array.from(table.rows);
  const cells = rows.flatMap((row) => Array.from(row.cells));
  const isSimpleTable = rows.length > 0
    && cells.length > 0
    && cells.every((cell) => cell.rowSpan === 1 && cell.colSpan === 1 && !cell.querySelector('table'));
  if (!isSimpleTable) return `\n\n${table.outerHTML}\n\n`;

  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  const markdownRows = rows.map((row) => {
    const rowCells = Array.from(row.cells).map((cell) => serializeMarkdownTableCell(cell, turndown));
    while (rowCells.length < columnCount) rowCells.push('');
    return `| ${rowCells.join(' | ')} |`;
  });
  const headerCells = Array.from(rows[0].cells);
  const delimiter = `| ${Array.from({ length: columnCount }, (_, index) => markdownTableDelimiter(headerCells[index])).join(' | ')} |`;

  // GFM requires a header row. Headerless pasted/legacy tables therefore use / GFM 要求表头行，因此无表头的粘贴/旧表格
  // their first row as the header instead of falling back to raw HTML. / 用其第一行作为表头，而不是退回原始 HTML。
  return `\n\n${[markdownRows[0], delimiter, ...markdownRows.slice(1)].join('\n')}\n\n`;
}

/**
 * Serialize one table cell into single-line GFM Markdown with escaped pipes.
 * 将单个表格单元格序列化为单行 GFM Markdown，并转义竖线。
 *
 * @param cell - HTML table cell / HTML 表格单元格
 * @param turndown - Turndown instance used for cell content / 用于单元格内容的 Turndown 实例
 * @returns Escaped single-line cell Markdown / 转义后的单行单元格 Markdown
 */
function serializeMarkdownTableCell(cell: HTMLTableCellElement, turndown: TurndownService): string {
  if (isEmptyTableCell(cell)) return '';

  const markdown = unwrapTableCellCodeBlock(turndown
    .turndown(cell.innerHTML)
    .trim()
  );

  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n+\s*/g, '<br>')
    .replace(/(^|[^\\])\|/g, '$1\\|');
}

/**
 * Detect a cell whose only content is empty paragraphs or empty code blocks.
 * 判断单元格是否仅包含空段落或空代码块。
 */
function isEmptyTableCell(cell: HTMLTableCellElement): boolean {
  const children = Array.from(cell.children);
  if (children.length === 0) return !(cell.textContent ?? '').length;

  return children.every((child) => (
    (child.nodeName === 'P' && isEmptyEditorParagraph(child as HTMLElement))
    || (child.nodeName === 'PRE' && !(child.textContent ?? '').length)
  ));
}

/**
 * GFM tables cannot contain block-level fenced code. Flatten a code block
 * which occupies an entire table cell before converting its remaining line
 * breaks to HTML breaks.
 * GFM 表格不能包含块级围栏代码；先展平占据整个单元格的代码块，再把剩余换行转换为 HTML 换行。
 *
 * @param markdown - Cell content Markdown / 单元格内容 Markdown
 * @returns Flattened cell content / 展平后的单元格内容
 */
function unwrapTableCellCodeBlock(markdown: string): string {
  const match = markdown.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  return match ? match[1].trim() : markdown;
}

/**
 * Older table serialization converted a fenced block in a cell into
 * `\`\`\`<br>...<br>\`\`\``. Treat that exact legacy form as normal table-cell
 * content while rendering, without modifying the note source on disk.
 * 旧版表格序列化会把单元格内的围栏代码块转换为 `\`\`\`<br>...<br>\`\`\``；渲染时
 * 将该特定旧格式视为普通单元格内容处理，且不修改磁盘上的笔记源文件。
 *
 * @param markdown - Markdown source possibly containing legacy table cells / 可能含旧式表格单元格的 Markdown 源文本
 * @returns Markdown with legacy cell code fences unwrapped / 展开旧式单元格代码围栏后的 Markdown
 */
function normalizeLegacyTableCellCodeBlocks(markdown: string): string {
  return markdown
    .split(/(\r?\n)/)
    .map((segment) => (
      /^\s*\|.*\|\s*$/.test(segment)
        ? segment.replace(
          /(^|\|)(\s*)```(?:<br\s*\/?>)+([\s\S]*?)(?:<br\s*\/?>)+```(\s*)(?=\||$)/gi,
          (_match, boundary: string, leadingSpace: string, content: string, trailingSpace: string) => (
            `${boundary}${leadingSpace}${content.trim()}${trailingSpace}`
          ),
        )
        : segment
    ))
    .join('');
}

/**
 * Map a header cell's text alignment to a GFM table delimiter cell.
 * 将表头单元格的文本对齐方式映射为 GFM 表格分隔单元格。
 */
function markdownTableDelimiter(cell: HTMLTableCellElement | undefined): string {
  const alignment = (cell?.getAttribute('align') ?? cell?.style.textAlign ?? '').trim().toLowerCase();
  if (alignment === 'left') return ':---';
  if (alignment === 'center') return ':---:';
  if (alignment === 'right') return '---:';
  return '---';
}

/**
 * Resolve a code block's language from data attributes or `language-*` classes.
 * 从 data 属性或 `language-*` 类名解析代码块的语言。
 */
function getCodeBlockLanguage(pre: HTMLElement, code: HTMLElement | null): string {
  const explicitLanguage = pre.getAttribute('data-language')
    ?? code?.getAttribute('data-language')
    ?? '';
  if (explicitLanguage) return explicitLanguage;

  const className = `${pre.getAttribute('class') ?? ''} ${code?.getAttribute('class') ?? ''}`;
  const match = className.match(/(?:^|\s)language-([\w-]+)/);
  return match?.[1] ?? '';
}

/**
 * Normalize task-list `<li><input>` markup into Tiptap task items and lists.
 * 将任务列表的 `<li><input>` 标记规范化为 Tiptap 任务项与任务列表。
 *
 * @param html - Rendered HTML containing task checkboxes / 含任务复选框的已渲染 HTML
 * @param mode - Interaction mode for the checkboxes / 复选框的交互模式
 * @returns HTML with normalized task-list markup / 任务列表标记规范化后的 HTML
 */
export function normalizeTaskListMarkup(html: string, mode: TaskListInteractionMode): string {
  const withTaskItems = html.replace(
    /<li><input([^>]*)>\s*([\s\S]*?)<\/li>/g,
    (_match, inputAttributes: string, body: string) => {
      const checked = /\bchecked(?:=|[\s>]|$)/i.test(inputAttributes);
      const normalizedBody = blockElementPattern.test(body) ? body.trim() : `<p>${body.trim()}</p>`;
      const accessibleLabel = checked ? '已完成任务' : '未完成任务';
      const readonlyAttributes = mode === 'readonly' ? ' disabled="disabled"' : '';
      return `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}"><label><input type="checkbox" aria-label="${accessibleLabel}"${readonlyAttributes}${checked ? ' checked="checked"' : ''}></label><div>${normalizedBody}</div></li>`;
    },
  );

  return withTaskItems.replace(
    /<ul>\s*((?:<li data-type="taskItem"[\s\S]*?<\/li>\s*)+)<\/ul>/g,
    `<ul data-type="taskList" data-task-mode="${mode}">$1</ul>`,
  );
}

/**
 * Collapse trailing whitespace, consecutive blank lines, and normalize the final newline.
 * 折叠行尾空白与连续空行，并规范化结尾换行。
 */
function normalizeMarkdownSpacing(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}

/**
 * Minimal shape of a remark AST node with source positions.
 * 带源位置信息的 remark AST 节点的最小结构。
 */
interface PositionedMarkdownNode {
  type?: string;
  value?: string;
  alt?: string;
  children?: PositionedMarkdownNode[];
  position?: {
    start?: { line?: number; offset?: number };
    end?: { line?: number; offset?: number };
  };
}

/**
 * Return source-line anchors for the Markdown blocks that have a visible
 * counterpart in Tiptap. Parent and child nodes may intentionally share a
 * line (for example a list item and its first paragraph); the renderer maps
 * both and keeps only the first visible marker for that source line.
 * 返回在 Tiptap 中有可见对应物的 Markdown 块的源行锚点。父子节点可能有意共享同一行
 *（例如列表项与其第一段）；渲染时两者都会映射，但每个源行只保留第一个可见标记。
 *
 * @param markdown - Full note source including frontmatter / 含 frontmatter 的完整笔记源文本
 * @returns Anchors with full-source line numbers / 带完整源行号的锚点列表
 */
export function getMarkdownLineAnchors(markdown: string): MarkdownLineAnchor[] {
  const body = prepareMarkdownDocument(markdown, 'strip').markdown;
  if (!body.trim() || isProbablyHtmlNote(body)) return [];

  // Metadata has no rendered nodes; body anchors still point to full-source line numbers. / 元数据没有渲染节点；正文锚点仍指向完整源文件的行号。
  const lineOffset = markdown.slice(0, markdown.length - body.length).split('\n').length - 1;
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as PositionedMarkdownNode;
  const anchors: MarkdownLineAnchor[] = [];

  const collect = (node: PositionedMarkdownNode) => {
    const kind = toMarkdownLineAnchorKind(node.type);
    const line = node.position?.start?.line;
    if (kind && typeof line === 'number') {
      anchors.push({
        line: line + lineOffset,
        kind,
        text: markdownNodeText(node),
      });
    }
    node.children?.forEach(collect);
  };

  tree.children?.forEach(collect);
  return anchors;
}

const markdownLineAnchorSelectors: Record<MarkdownLineAnchorKind, string> = {
  heading: 'h1, h2, h3, h4, h5, h6',
  paragraph: 'p',
  blockquote: 'blockquote',
  listItem: 'li',
  code: 'pre',
  thematicBreak: 'hr',
  tableRow: 'tr',
};

/**
 * Match Markdown line anchors to visible DOM elements under the render root.
 * 将 Markdown 行锚点与渲染根节点下的可见 DOM 元素进行匹配。
 *
 * @param markdown - Full note source / 完整笔记源文本
 * @param root - Rendered DOM root / 已渲染的 DOM 根节点
 * @returns Targets mapping source lines to elements / 源行到元素的目标映射列表
 */
export function mapMarkdownLineTargets(markdown: string, root: ParentNode): MarkdownLineTarget[] {
  const anchors = getMarkdownLineAnchors(markdown);
  const pools = new Map<MarkdownLineAnchorKind, { candidates: HTMLElement[]; cursor: number }>();
  const seenLines = new Set<number>();
  const targets: MarkdownLineTarget[] = [];

  for (const anchor of anchors) {
    let pool = pools.get(anchor.kind);
    if (!pool) {
      const candidates = [...root.querySelectorAll<HTMLElement>(markdownLineAnchorSelectors[anchor.kind])]
        .filter((candidate) => anchor.kind !== 'paragraph' || !candidate.closest('td, th'));
      pool = { candidates, cursor: 0 };
      pools.set(anchor.kind, pool);
    }

    const candidateIndex = findMarkdownLineCandidate(pool.candidates, pool.cursor, anchor.text);
    if (candidateIndex === -1) continue;
    const candidate = pool.candidates[candidateIndex];
    pool.cursor = candidateIndex + 1;
    if (seenLines.has(anchor.line)) continue;
    targets.push({ line: anchor.line, element: candidate });
    seenLines.add(anchor.line);
  }

  return targets;
}

/**
 * Find the DOM element nearest to a target source line for scroll/selection.
 * 查找最接近目标源行的 DOM 元素，用于滚动或选中定位。
 *
 * @param markdown - Full note source / 完整笔记源文本
 * @param root - Rendered DOM root / 已渲染的 DOM 根节点
 * @param targetLine - Desired source line number / 目标源行号
 * @returns Nearest matching element, if any / 最近的匹配元素（如有）
 */
export function findMarkdownLineTarget(
  markdown: string,
  root: ParentNode,
  targetLine: number,
): HTMLElement | undefined {
  let nearestBefore: MarkdownLineTarget | undefined;
  for (const target of mapMarkdownLineTargets(markdown, root)) {
    if (target.line === targetLine) return target.element;
    if (target.line > targetLine) return nearestBefore?.element ?? target.element;
    nearestBefore = target;
  }
  return nearestBefore?.element;
}

/**
 * Normalize text for tolerant Markdown/DOM matching in Chinese locale.
 * 按中文区域设置规范化文本，用于宽松的 Markdown/DOM 匹配。
 *
 * @param value - Raw text / 原始文本
 * @returns Whitespace-collapsed, lowercased text / 空白折叠并小写化的文本
 */
export function normalizeMarkdownSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-Hans-CN');
}

/**
 * Locate the next DOM candidate matching an anchor's text, falling back to the start index.
 * 查找与锚点文本匹配的下一个 DOM 候选元素；无匹配时退回起始索引。
 */
function findMarkdownLineCandidate(candidates: HTMLElement[], startIndex: number, anchorText: string): number {
  if (startIndex >= candidates.length) return -1;
  const normalizedAnchor = normalizeMarkdownSearchText(anchorText);
  if (!normalizedAnchor) return startIndex;
  const anchorProbe = normalizedAnchor.slice(0, 96);

  for (let index = startIndex; index < candidates.length; index += 1) {
    const candidateText = normalizeMarkdownSearchText(
      candidates[index].innerText ?? candidates[index].textContent ?? '',
    );
    // Compare bounded probes both ways so minor rendering differences still match. / 双向比较截断后的探测文本，使轻微渲染差异仍能匹配。
    if (candidateText.includes(anchorProbe) || anchorProbe.includes(candidateText.slice(0, 72))) {
      return index;
    }
  }

  return startIndex;
}

/**
 * Map a remark node type to a supported anchor kind, or null when unsupported.
 * 将 remark 节点类型映射为受支持的锚点类型；不支持时返回 null。
 */
function toMarkdownLineAnchorKind(type: string | undefined): MarkdownLineAnchorKind | null {
  switch (type) {
    case 'heading':
    case 'paragraph':
    case 'blockquote':
    case 'listItem':
    case 'code':
    case 'thematicBreak':
    case 'tableRow':
      return type;
    default:
      return null;
  }
}

/**
 * Flatten a node's own text and descendant text into a single normalized string.
 * 将节点自身文本与后代文本展平为单个规范化字符串。
 */
function markdownNodeText(node: PositionedMarkdownNode): string {
  const ownText = node.value ?? node.alt ?? '';
  const childText = node.children?.map(markdownNodeText).filter(Boolean).join(' ') ?? '';
  return `${ownText} ${childText}`.replace(/\s+/g, ' ').trim();
}

/**
 * Insert placeholder paragraphs for blank lines the parser would otherwise drop,
 * so intentional spacing survives the HTML round-trip.
 * 为解析器会丢弃的空行插入占位段落，使有意留白能在 HTML 往返转换中保留。
 */
function preserveExtraBlankLines(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as { children?: PositionedMarkdownNode[] };
  const children = tree.children ?? [];
  if (children.length === 0) {
    const blankLineCount = markdown.split('\n').length - 1;
    return Array.from({ length: blankLineCount }, () => preservedBlankLineHtml).join('\n\n');
  }

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const firstStartOffset = children[0].position?.start?.offset;
  if (typeof firstStartOffset === 'number' && firstStartOffset > 0) {
    const leadingBlankLineCount = markdown.slice(0, firstStartOffset).split('\n').length - 1;
    if (leadingBlankLineCount > 0) {
      replacements.push({
        start: 0,
        end: firstStartOffset,
        value: `${Array.from({ length: leadingBlankLineCount }, () => preservedBlankLineHtml).join('\n\n')}\n\n`,
      });
    }
  }

  for (let index = 1; index < children.length; index += 1) {
    const previousEnd = children[index - 1].position?.end;
    const currentStart = children[index].position?.start;
    if (
      typeof previousEnd?.offset !== 'number'
      || typeof previousEnd.line !== 'number'
      || typeof currentStart?.offset !== 'number'
      || typeof currentStart.line !== 'number'
    ) continue;

    const extraBlankLineCount = currentStart.line - previousEnd.line - 2;
    if (extraBlankLineCount <= 0) continue;
    const placeholders = Array.from({ length: extraBlankLineCount }, () => preservedBlankLineHtml).join('\n\n');
    replacements.push({
      start: previousEnd.offset,
      end: currentStart.offset,
      value: `\n\n${placeholders}\n\n`,
    });
  }

  const lastEndOffset = children.at(-1)?.position?.end?.offset;
  if (typeof lastEndOffset === 'number' && lastEndOffset < markdown.length) {
    const trailingNewlineCount = markdown.slice(lastEndOffset).split('\n').length - 1;
    const trailingBlankLineCount = Math.max(0, trailingNewlineCount - 1);
    if (trailingBlankLineCount > 0) {
      replacements.push({
        start: lastEndOffset,
        end: markdown.length,
        value: `\n\n${Array.from({ length: trailingBlankLineCount }, () => preservedBlankLineHtml).join('\n\n')}\n`,
      });
    }
  }

  return replacements
    .reverse()
    .reduce((result, replacement) => (
      `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`
    ), markdown);
}

/**
 * Convert preserved blank-line placeholders back to real newlines, keeping one
 * separator newline around interior gaps.
 * 将保留的空行占位符还原为真实换行，并在内部空隙周围保留一个分隔换行。
 */
function restorePreservedBlankLines(markdown: string): string {
  if (!markdown.includes(preservedBlankLineToken)) return markdown;

  const tokenPattern = new RegExp(
    `\\n*${preservedBlankLineToken}(?:\\n+${preservedBlankLineToken})*\\n*`,
    'g',
  );
  return markdown.replace(tokenPattern, (match, offset: number, source: string) => {
    const count = match.split(preservedBlankLineToken).length - 1;
    const hasContentBefore = source.slice(0, offset).trim().length > 0;
    const hasContentAfter = source.slice(offset + match.length).trim().length > 0;
    // Interior gaps need surrounding newlines; leading/trailing gaps need only the count. / 内部空隙需要外围换行；首尾空隙只需占位计数对应的换行。
    const newlineCount = hasContentBefore && hasContentAfter
      ? count + 2
      : hasContentBefore
        ? count + 1
        : count;
    return '\n'.repeat(newlineCount);
  });
}

/**
 * Detect an editor paragraph that holds no text, only `<br>` or empty spans.
 * 判断编辑器段落是否不含文本，仅有 `<br>` 或空 span。
 */
function isEmptyEditorParagraph(element: HTMLElement): boolean {
  if (element.textContent?.length) return false;
  return Array.from(element.children).every((child) => (
    child.nodeName === 'BR'
    || (child.nodeName === 'SPAN' && !(child.textContent ?? '').length)
  ));
}

/**
 * Rewrite image `src` attributes to editor-loadable URLs, recording the original
 * relative path in `data-menghan-relative` for round-tripping back to Markdown.
 * 将图片 `src` 属性改写为编辑器可加载的 URL，并把原始相对路径记录在
 * `data-menghan-relative` 中，以便往返转换回 Markdown。
 */
function normalizeImageSources(html: string, assetContext?: MarkdownAssetContext): string {
  if (assetContext?.externalAssetUrls) {
    const template = document.createElement('template'); template.innerHTML = html;
    const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    template.content.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
      const src = img.getAttribute('src')!;
      const entry = Object.entries(assetContext.externalAssetUrls!).find(([href]) => href === src || decode(href) === decode(src));
      if (entry) { img.setAttribute('src', entry[1]); img.setAttribute('data-menghan-relative', entry[0]); }
    });
    return template.innerHTML;
  }
  if (!assetContext?.currentPath && !assetContext?.libraryPath) return html;

  return html.replace(/<img\b([^>]*?)\s+src="([^"]+)"([^>]*)>/gi, (match, before: string, src: string, after: string) => {
    if (!isRelativeImageSource(src)) return match;

    const absolutePath = resolveMarkdownImagePath(src, assetContext);
    if (!absolutePath) return match;

    const imageUrl = toEditorImageUrl(absolutePath);
    const relativeAttribute = ` data-menghan-relative="${escapeHtmlAttribute(src)}"`;
    const hasRelativeAttribute = /\sdata-menghan-relative=/i.test(match);
    return `<img${before} src="${imageUrl}"${hasRelativeAttribute ? '' : relativeAttribute}${after}>`;
  });
}

/**
 * Test whether an image source is a relative path (no scheme, drive letter, or leading slash).
 * 判断图片地址是否为相对路径（不含协议、盘符或前导斜杠）。
 */
function isRelativeImageSource(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src)
    && !src.startsWith('/')
    && !/^[a-z]:[\\/]/i.test(src);
}

/**
 * Resolve a relative image path against the note directory or the library root for `attachments/`.
 * 将相对图片路径解析到笔记目录；`attachments/` 开头的路径解析到资料库根目录。
 */
function resolveMarkdownImagePath(src: string, assetContext: MarkdownAssetContext): string | null {
  const normalizedSrc = src.replace(/\\/g, '/');
  // `attachments/` paths are library-relative; everything else is note-relative. / `attachments/` 路径相对资料库；其余路径相对当前笔记。
  const basePath = normalizedSrc.startsWith('attachments/')
    ? assetContext.libraryPath
    : getDirectoryName(assetContext.currentPath ?? '');
  if (!basePath) return null;

  return normalizePath(`${basePath.replace(/\\/g, '/')}/${normalizedSrc}`);
}

/**
 * Return the directory portion of a file path, or null when there is no separator.
 * 返回文件路径的目录部分；无路径分隔符时返回 null。
 */
function getDirectoryName(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const index = normalizedPath.lastIndexOf('/');
  return index === -1 ? null : normalizedPath.slice(0, index);
}

/**
 * Collapse `.`/`..` segments in POSIX paths.
 * 折叠 `.`/`..` 路径段。
 */
function normalizePath(filePath: string): string {
  const isWindowsAbsolute = /^[a-z]:\//i.test(filePath);
  const segments: string[] = [];
  for (const part of filePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  const normalized = segments.join('/');
  return isWindowsAbsolute ? normalized : `/${normalized}`;
}

/**
 * Escape a value for safe use inside a double-quoted HTML attribute.
 * 转义取值以便安全用于双引号 HTML 属性中。
 */
function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

/**
 * Escape `&`, `<` and `>` for safe HTML text interpolation.
 * 转义 `&`、`<` 与 `>`，以便安全插入 HTML 文本。
 */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
