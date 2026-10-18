/**
 * Markdown preview rendering with sanitization and standalone HTML export.
 * Markdown 预览渲染，包含净化与独立 HTML 导出。
 */
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { markdownToHtmlWithParser, type MarkdownAssetContext } from '../markdown/markdown.ts';
import {
  createPreviewMarkdownExtension,
  createRelaxedStrongExtension,
  createWikiLinkExtension,
  prepareMarkdownDocument,
  type MarkdownDiagnostic,
  type MarkdownFrontmatterMode,
} from '../markdown/markdownExtensions.ts';
import { createMathMarkdownExtension, renderMathHtml } from '../markdown/markdownMath.ts';

// URI schemes and relative forms allowed after sanitization. / 净化后允许的 URI 协议与相对形式。
const allowedPreviewUriPattern = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|menghan-image|trellora-resource):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

/**
 * Rendering context for markdown preview, extending asset resolution settings.
 * Markdown 预览渲染上下文，在资源解析设置基础上扩展。
 */
export interface MarkdownPreviewRenderContext extends MarkdownAssetContext {
  frontmatter?: MarkdownFrontmatterMode;
}

/**
 * Sanitized preview HTML together with frontmatter diagnostics.
 * 净化后的预览 HTML 与 frontmatter 诊断信息。
 */
export interface MarkdownPreviewRenderResult {
  html: string;
  diagnostics: MarkdownDiagnostic[];
}

/**
 * Renders markdown to sanitized preview HTML, discarding diagnostics.
 * 将 Markdown 渲染为净化后的预览 HTML，忽略诊断信息。
 *
 * @param markdown - Markdown source / Markdown 源文
 * @param renderContext - Optional asset and frontmatter context / 可选的资源与 frontmatter 上下文
 * @returns Sanitized HTML string / 净化后的 HTML 字符串
 */
export function renderPreviewHtml(markdown: string, renderContext?: MarkdownPreviewRenderContext): string {
  return renderPreviewHtmlWithDiagnostics(markdown, renderContext).html;
}

/**
 * Renders markdown to sanitized HTML and reports frontmatter diagnostics.
 * 将 Markdown 渲染为净化后的 HTML，并报告 frontmatter 诊断信息。
 *
 * @param markdown - Markdown source / Markdown 源文
 * @param renderContext - Optional asset and frontmatter context / 可选的资源与 frontmatter 上下文
 * @returns Sanitized HTML and the diagnostics list / 净化后的 HTML 与诊断列表
 */
export function renderPreviewHtmlWithDiagnostics(
  markdown: string,
  renderContext?: MarkdownPreviewRenderContext,
): MarkdownPreviewRenderResult {
  const preparedDocument = prepareMarkdownDocument(markdown, renderContext?.frontmatter);
  const marked = new Marked(
    createWikiLinkExtension(),
    createPreviewMarkdownExtension(),
    createRelaxedStrongExtension(),
    createMathMarkdownExtension((token) => renderMathHtml(token.text, token.displayMode)),
  );

  const katexHtml = markdownToHtmlWithParser(
    preparedDocument.markdown,
    (preparedMarkdown) => marked.parse(preparedMarkdown, { async: false }) as string,
    { ...renderContext, taskListMode: 'readonly' },
  );

  return {
    html: DOMPurify.sanitize(katexHtml, {
      ADD_ATTR: ['data-wiki-link', 'data-wiki-alias', 'data-menghan-relative', 'target'],
      ALLOWED_URI_REGEXP: allowedPreviewUriPattern,
    }),
    diagnostics: preparedDocument.diagnostics,
  };
}

/**
 * Wraps body HTML into a self-contained document for export or printing.
 * 将正文 HTML 包装为独立文档，用于导出或打印。
 *
 * @param title - Document title / 文档标题
 * @param bodyHtml - Sanitized body HTML / 已净化的正文 HTML
 * @param options - Theme and stylesheet overrides / 主题与样式覆盖项
 * @returns Complete HTML document / 完整 HTML 文档
 */
export function createStandaloneHtml(
  title: string,
  bodyHtml: string,
  options?: { resolvedTheme?: 'light' | 'dark'; styles?: string },
): string {
  const resolvedTheme = options?.resolvedTheme ?? 'light';
  const styles = options?.styles ?? `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 24px; line-height: 1.7; color: #242424; }
    pre { background: #0f172a; color: #e5e7eb; padding: 14px 16px; border-radius: 6px; overflow-x: auto; }
    code { font-family: Consolas, Menlo, monospace; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px 10px; }
    blockquote { border-left: 4px solid #ddd; margin-left: 0; padding-left: 14px; color: #555; }
    .callout { border: 1px solid #ddd; border-left-width: 4px; border-radius: 6px; padding: 10px 12px; margin: 1em 0; background: #f8fafc; }
    .callout-title { font-weight: 700; margin-bottom: 4px; }
    img { max-width: 100%; }
  `;
  return `<!doctype html>
<html lang="zh-CN" data-theme="${resolvedTheme}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;" />
  <title>${escapeHtmlText(title)}</title>
  <style>${styles}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Escapes text for safe interpolation into HTML text nodes.
 * 转义文本以便安全插入 HTML 文本节点。
 */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
