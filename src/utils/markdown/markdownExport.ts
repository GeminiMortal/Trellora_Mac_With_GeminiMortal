/**
 * Self-contained HTML/PDF export for Markdown notes with inlined images and KaTeX fonts.
 * 面向 Markdown 笔记的自包含 HTML/PDF 导出，内联图片与 KaTeX 字体。
 */

import katexStyles from 'katex/dist/katex.min.css?raw';
import katexAmsRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?markdown-export-inline';
import katexCaligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?markdown-export-inline';
import katexCaligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?markdown-export-inline';
import katexFrakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?markdown-export-inline';
import katexFrakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?markdown-export-inline';
import katexMainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?markdown-export-inline';
import katexMainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?markdown-export-inline';
import katexMainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?markdown-export-inline';
import katexMainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?markdown-export-inline';
import katexMathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?markdown-export-inline';
import katexMathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?markdown-export-inline';
import katexSansSerifBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?markdown-export-inline';
import katexSansSerifItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?markdown-export-inline';
import katexSansSerifRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?markdown-export-inline';
import katexScriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?markdown-export-inline';
import katexSize1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?markdown-export-inline';
import katexSize2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?markdown-export-inline';
import katexSize3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?markdown-export-inline';
import katexSize4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?markdown-export-inline';
import katexTypewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?markdown-export-inline';
import { enhanceMarkdownContainer } from './markdownEnhancements.ts';
import { createStandaloneHtml, renderPreviewHtml } from '../ui/preview.ts';
import type { MarkdownAssetContext } from './markdown.ts';
import type { ResolvedTheme } from '../ui/theme.ts';

/**
 * An image resolved to an inline data URL with its decoded size.
 * 已解析为内联 data URL 并附带解码后大小的图片。
 */
export interface MarkdownExportImage {
  dataUrl: string;
  byteLength: number;
}

/**
 * Options for rendering a Markdown note to standalone HTML or PDF-ready HTML.
 * 将 Markdown 笔记渲染为独立 HTML 或 PDF 就绪 HTML 的选项。
 */
export interface MarkdownExportOptions extends MarkdownAssetContext {
  title: string;
  markdown: string;
  resolvedTheme: ResolvedTheme;
  output?: 'html' | 'pdf';
  resolveImageDataUrl: (source: string) => Promise<MarkdownExportImage>;
}

/**
 * Size limits guarding against oversized export output.
 * 防止导出结果过大的尺寸上限。
 */
export const markdownExportLimits = {
  maxImageBytes: 10 * 1024 * 1024,
  maxTotalImageBytes: 25 * 1024 * 1024,
  maxHtmlBytes: 40 * 1024 * 1024,
} as const;

const supportedInlineImagePattern = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;
const localImagePattern = /^menghan-image:\/\//i;
const remoteImagePattern = /^https?:\/\//i;

const katexFontUrls: Record<string, string> = {
  'KaTeX_AMS-Regular.woff2': katexAmsRegular,
  'KaTeX_Caligraphic-Bold.woff2': katexCaligraphicBold,
  'KaTeX_Caligraphic-Regular.woff2': katexCaligraphicRegular,
  'KaTeX_Fraktur-Bold.woff2': katexFrakturBold,
  'KaTeX_Fraktur-Regular.woff2': katexFrakturRegular,
  'KaTeX_Main-Bold.woff2': katexMainBold,
  'KaTeX_Main-BoldItalic.woff2': katexMainBoldItalic,
  'KaTeX_Main-Italic.woff2': katexMainItalic,
  'KaTeX_Main-Regular.woff2': katexMainRegular,
  'KaTeX_Math-BoldItalic.woff2': katexMathBoldItalic,
  'KaTeX_Math-Italic.woff2': katexMathItalic,
  'KaTeX_SansSerif-Bold.woff2': katexSansSerifBold,
  'KaTeX_SansSerif-Italic.woff2': katexSansSerifItalic,
  'KaTeX_SansSerif-Regular.woff2': katexSansSerifRegular,
  'KaTeX_Script-Regular.woff2': katexScriptRegular,
  'KaTeX_Size1-Regular.woff2': katexSize1Regular,
  'KaTeX_Size2-Regular.woff2': katexSize2Regular,
  'KaTeX_Size3-Regular.woff2': katexSize3Regular,
  'KaTeX_Size4-Regular.woff2': katexSize4Regular,
  'KaTeX_Typewriter-Regular.woff2': katexTypewriterRegular,
};

/**
 * Render a Markdown note into a self-contained standalone HTML document.
 * 将 Markdown 笔记渲染为自包含的独立 HTML 文档。
 *
 * @param options - Export options including title, source and image resolver / 导出选项，包含标题、源文本与图片解析器
 * @returns Standalone HTML string ready for saving or PDF printing / 可保存或打印为 PDF 的独立 HTML 字符串
 */
export async function renderMarkdownExport(options: MarkdownExportOptions): Promise<string> {
  const theme = options.output === 'pdf' ? 'light' : options.resolvedTheme;
  const exportRoot = document.createElement('main');
  exportRoot.className = 'markdown-export-content markdown-rendered-content';
  exportRoot.innerHTML = renderPreviewHtml(options.markdown, {
    currentPath: options.currentPath,
    libraryPath: options.libraryPath,
    frontmatter: 'strip',
  });

  await enhanceMarkdownContainer(exportRoot, {
    resolvedTheme: theme,
    showCodeCopyActions: false,
    interactive: false,
  });
  await inlineExportImages(exportRoot, options.resolveImageDataUrl);
  stripApplicationOnlyMarkup(exportRoot);

  const html = createStandaloneHtml(options.title, exportRoot.innerHTML, {
    resolvedTheme: theme,
    styles: `${createExportStyles(theme)}\n${createSelfContainedKatexStyles()}${options.output === 'pdf' ? `\n${createPdfStyles()}` : ''}`,
  });
  assertMarkdownExportHtmlSize(html);
  return html;
}

/**
 * Throw when the export HTML exceeds the configured size limit.
 * 当导出 HTML 超过配置的大小上限时抛出错误。
 *
 * @param html - Assembled export HTML / 组装完成的导出 HTML
 * @throws When the encoded size exceeds `markdownExportLimits.maxHtmlBytes` / 编码后大小超过 `markdownExportLimits.maxHtmlBytes` 时抛出
 */
export function assertMarkdownExportHtmlSize(html: string): void {
  const htmlBytes = byteLength(html);
  if (htmlBytes > markdownExportLimits.maxHtmlBytes) {
    throw new Error(`导出文件约 ${formatMegabytes(htmlBytes)} MB，超过 40 MB 上限。请压缩图片或拆分笔记后重试。`);
  }
}

/**
 * All exported image references must be self-contained under the export CSP.
 * 在导出 CSP 下，所有导出的图片引用必须是自包含的。
 *
 * @param root - Export DOM root containing images / 含图片的导出 DOM 根节点
 * @param resolveImageDataUrl - Resolver converting sources to data URLs / 将图片地址转换为 data URL 的解析器
 * @returns Resolves when every image is inlined and size-checked / 全部图片内联并完成大小校验后 resolve
 */
async function inlineExportImages(
  root: HTMLElement,
  resolveImageDataUrl: MarkdownExportOptions['resolveImageDataUrl'],
): Promise<void> {
  const cache = new Map<string, MarkdownExportImage>();
  let totalImageBytes = 0;

  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const source = image.getAttribute('src')?.trim() ?? '';
    if (!source) continue;
    image.removeAttribute('srcset');
    image.removeAttribute('loading');

    if (source.startsWith('data:')) {
      if (!supportedInlineImagePattern.test(source)) {
        throw new Error('导出包含不支持的内嵌图片类型，仅支持 PNG、JPEG、GIF 和 WebP。');
      }
      const imageBytes = dataUrlByteLength(source);
      assertImageSize(imageBytes);
      totalImageBytes += imageBytes;
      assertTotalImageSize(totalImageBytes);
      continue;
    }

    if (!localImagePattern.test(source) && !remoteImagePattern.test(source)) throw new Error('导出包含不支持的图片地址。');

    let resolved = cache.get(source);
    if (!resolved) {
      try { resolved = await resolveImageDataUrl(source); }
      catch (error) { throw new Error(`导出图片读取失败：${source.split('?')[0]}。${error instanceof Error ? error.message : String(error)}`); }
      if (!supportedInlineImagePattern.test(resolved.dataUrl)) {
        throw new Error('图片读取结果无效，未生成安全的图片 data URL。');
      }
      assertImageSize(resolved.byteLength);
      cache.set(source, resolved);
    }
    totalImageBytes += resolved.byteLength;
    assertTotalImageSize(totalImageBytes);
    image.src = resolved.dataUrl;
  }
}

/**
 * Validate a single image's decoded size against the per-image limit.
 * 按单张图片上限校验图片的解码后大小。
 */
function assertImageSize(imageBytes: number): void {
  if (!Number.isSafeInteger(imageBytes) || imageBytes < 0) {
    throw new Error('本地图片大小信息无效，已停止导出。');
  }
  if (imageBytes > markdownExportLimits.maxImageBytes) {
    throw new Error(`单张图片约 ${formatMegabytes(imageBytes)} MB，超过 10 MB 上限。请压缩图片后重试。`);
  }
}

/**
 * Validate cumulative image bytes against the total export limit.
 * 按导出总量上限校验累计图片字节数。
 */
function assertTotalImageSize(totalImageBytes: number): void {
  if (totalImageBytes > markdownExportLimits.maxTotalImageBytes) {
    throw new Error(`导出图片合计约 ${formatMegabytes(totalImageBytes)} MB，超过 25 MB 上限。请压缩图片或拆分笔记后重试。`);
  }
}

/**
 * Remove app-only UI chrome and data attributes that should not ship in exports.
 * 移除不应随导出发布、仅应用内部使用的 UI 元素与 data 属性。
 */
function stripApplicationOnlyMarkup(root: HTMLElement): void {
  root.querySelectorAll('.markdown-code-copy-button, .markdown-code-language-label, .markdown-heading-anchor, .mermaid-toolbar')
    .forEach((element) => element.remove());
  root.querySelectorAll('pre.has-code-copy-action').forEach((element) => element.classList.remove('has-code-copy-action'));

  root.querySelectorAll<HTMLElement>('ul[data-type="taskList"]').forEach((list) => list.classList.add('task-list'));
  root.querySelectorAll<HTMLElement>('li[data-type="taskItem"]').forEach((item) => {
    item.classList.add('task-item');
    if (item.dataset.checked === 'true') item.classList.add('task-item-checked');
  });

  const applicationAttributes = [
    'data-checked',
    'data-highlight-skipped',
    'data-highlighted-language',
    'data-fit-to-width',
    'data-markdown-export-exclude',
    'data-menghan-blank-line',
    'data-menghan-relative',
    'data-navigation-disabled',
    'data-task-mode',
    'data-type',
    'data-scale',
    'data-wiki-alias',
    'data-wiki-link',
  ];
  root.querySelectorAll<HTMLElement>('*').forEach((element) => {
    applicationAttributes.forEach((attribute) => element.removeAttribute(attribute));
    if (element.getAttribute('tabindex') === '-1' && /^H[1-6]$/.test(element.tagName)) {
      element.removeAttribute('tabindex');
    }
  });
}

/**
 * Rewrite KaTeX CSS font URLs to inlined data URLs, dropping legacy woff/ttf fallbacks.
 * 将 KaTeX CSS 中的字体 URL 重写为内联 data URL，并丢弃旧的 woff/ttf 回退。
 */
function createSelfContainedKatexStyles(): string {
  const withoutLegacyFonts = katexStyles.replace(
    /,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g,
    '',
  );
  // Only inlined woff2 data URLs are allowed; missing fonts fail the export loudly. / 仅允许内联 woff2 data URL；字体缺失时立即让导出失败。
  return withoutLegacyFonts.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_match, fontName: string) => {
    const fontUrl = katexFontUrls[fontName];
    if (!fontUrl?.startsWith('data:')) throw new Error(`KaTeX 字体资源缺失：${fontName}`);
    return `url("${fontUrl}")`;
  });
}

/**
 * Build the theme-aware base stylesheet for exported documents.
 * 构建导出文档的主题相关基础样式表。
 */
function createExportStyles(theme: ResolvedTheme): string {
  const dark = theme === 'dark';
  return `
:root { color-scheme: ${dark ? 'dark' : 'light'}; --text: ${dark ? '#e8e8e8' : '#242424'}; --muted: ${dark ? '#a7abb3' : '#60646c'}; --border: ${dark ? '#3c4048' : '#d9dce1'}; --surface: ${dark ? '#1f2228' : '#f6f7f8'}; --code-bg: ${dark ? '#17191d' : '#f1f3f5'}; --link: ${dark ? '#75a7ff' : '#1769aa'}; }
* { box-sizing: border-box; }
body { margin: 0; background: ${dark ? '#141619' : '#ffffff'}; color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; line-height: 1.72; }
.markdown-export-content { width: min(860px, calc(100% - 48px)); margin: 40px auto 64px; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { margin: 1.45em 0 0.55em; line-height: 1.3; }
h1 { padding-bottom: 0.25em; border-bottom: 1px solid var(--border); font-size: 2em; }
h2 { padding-bottom: 0.2em; border-bottom: 1px solid var(--border); font-size: 1.5em; }
a { color: var(--link); text-underline-offset: 0.15em; }
p, ul, ol, blockquote, pre, table { margin: 0.85em 0; }
img, svg { max-width: 100%; height: auto; }
.markdown-table-scroll { width: 100%; max-width: 100%; margin: 0.85em 0; overflow-x: auto; }
.markdown-table-scroll > table { width: max-content; min-width: 100%; max-width: none; margin: 0; border-collapse: collapse; }
th, td { padding: 8px 10px; border: 1px solid var(--border); text-align: left; }
th { background: var(--surface); }
blockquote { margin-left: 0; padding: 0.1em 0 0.1em 1em; border-left: 4px solid var(--border); color: var(--muted); }
pre { overflow-x: auto; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--code-bg); }
code { font-family: Consolas, "Cascadia Code", Menlo, monospace; }
:not(pre) > code { padding: 0.1em 0.32em; border-radius: 4px; background: var(--surface); }
pre code { display: block; white-space: pre; }
.task-list { padding-left: 0; list-style: none; }
.task-item { display: flex; align-items: flex-start; gap: 9px; margin: 6px 0; }
.task-item > label { flex: 0 0 22px; }
.task-item > div { flex: 1 1 auto; min-width: 0; }
.task-item-checked > div { color: var(--muted); text-decoration: line-through; }
.callout { margin: 1em 0; padding: 10px 12px; border: 1px solid var(--border); border-left: 4px solid var(--link); border-radius: 6px; background: var(--surface); }
.callout-title { margin-bottom: 4px; color: var(--muted); font-size: 0.78em; font-weight: 700; }
.callout-warning, .callout-danger { border-left-color: #d64545; }
.callout-tip { border-left-color: #16855b; }
.footnotes { margin-top: 2.5em; font-size: 0.92em; color: var(--muted); }
.mermaid-preview { margin: 1em 0; overflow: hidden; border: 1px solid var(--border); background: var(--surface); }
.mermaid-preview-canvas { overflow-x: auto; padding: 12px; text-align: center; }
.mermaid-preview-canvas svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.mermaid-error { padding: 12px; border-left: 4px solid #d64545; color: #d64545; text-align: left; }
.mermaid-error-message { margin: 0; white-space: pre-wrap; }
.mermaid-source-details { margin-top: 10px; color: var(--muted); }
.mermaid-source-details summary { cursor: pointer; font-weight: 600; }
.hljs-comment, .hljs-quote { color: ${dark ? '#8b949e' : '#6a737d'}; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-subst, .hljs-meta { color: ${dark ? '#ff7b72' : '#a626a4'}; }
.hljs-string, .hljs-doctag, .hljs-regexp, .hljs-addition { color: ${dark ? '#a5d6ff' : '#0b7500'}; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable, .hljs-symbol, .hljs-bullet, .hljs-link { color: ${dark ? '#79c0ff' : '#986801'}; }
.hljs-title, .hljs-section, .hljs-selector-id, .hljs-selector-class { color: ${dark ? '#d2a8ff' : '#4078f2'}; }
.hljs-type, .hljs-class .hljs-title, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: ${dark ? '#ffa657' : '#c18401'}; }
.hljs-attr, .hljs-attribute, .hljs-name, .hljs-tag, .hljs-property, .hljs-selector-attr, .hljs-selector-pseudo { color: ${dark ? '#7ee787' : '#0184bc'}; }
.hljs-deletion { color: #d64545; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
@media (max-width: 640px) { .markdown-export-content { width: min(100% - 28px, 860px); margin-top: 24px; } }
@media print { body { background: #fff; color: #111; } .markdown-export-content { width: auto; margin: 0; } a { color: inherit; } }
`;
}

/**
 * A4 printing allows long code to paginate and turns horizontally scrolling tables into in-page wrapping layouts.
 * A4 打印允许长代码分页，并将横向滚动表格转换为页面内换行布局。
 */
function createPdfStyles(): string {
  return `
@page { size: A4; }
@media print {
  body { font-size: 11pt; line-height: 1.65; }
  .markdown-export-content { width: auto; max-width: none; margin: 0; overflow: visible; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid-page; }
  p, li { orphans: 3; widows: 3; }
  .markdown-table-scroll { overflow: visible; }
  .markdown-table-scroll > table { width: 100%; min-width: 0; max-width: 100%; table-layout: fixed; }
  th, td { padding: 6pt; overflow-wrap: anywhere; word-break: break-word; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  pre { overflow: visible; font-size: 9pt; }
  pre code { white-space: pre-wrap; overflow-wrap: anywhere; }
  img, .mermaid-preview, .katex-display { break-inside: avoid; }
  .mermaid-preview, .mermaid-preview-canvas { overflow: visible; }
  .mermaid-preview-canvas svg { max-height: 220mm; }
  .katex-display { overflow: visible; }
}
`;
}

/**
 * Estimate the decoded byte length of a base64 data URL without allocating a buffer.
 * 估算 base64 data URL 的解码字节长度，无需分配缓冲区。
 */
function dataUrlByteLength(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s/g, '');
  // Base64 padding chars represent fewer than 3 bytes each. / base64 填充字符每个代表不足 3 字节。
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

/**
 * Return the UTF-8 byte length of a string.
 * 返回字符串的 UTF-8 字节长度。
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Format a byte count as megabytes with one decimal place.
 * 将字节数格式化为保留一位小数的兆字节数。
 */
function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
