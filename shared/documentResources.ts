/**
 * Detection of local document resource references (images, links, embeds) in Markdown content.
 * 检测 Markdown 内容中的本地文档资源引用（图片、链接、嵌入）。
 */

import { marked } from 'marked';

/**
 * Whether a Markdown link target points to a remote or safe inline resource rather than a local file.
 * Markdown 链接目标是否指向远程或安全的内联资源，而非本地文件。
 */
const remote = (href: string) => /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpeg|gif|webp);base64,|#)/i.test(href.trim());

/**
 * Detect whether the content references local document resources under EF-1 rules; real Markdown tokens are parsed while HTML and wiki links are handled conservatively.
 * 按 EF-1 规则检测内容是否引用本地文档资源；解析真实 Markdown token，HTML 和 Wiki 引用保守处理。
 *
 * @param content - Markdown content to inspect / 要检查的 Markdown 内容
 * @returns True when a local reference is present, or when parsing fails / 存在本地引用时返回 true；解析失败时也返回 true
 */
export function hasDocumentLocalReferences(content: string): boolean {
  let local = false;
  try {
    marked.walkTokens(marked.lexer(content), token => {
      // Mermaid blocks can embed images via syntax the lexer classifies as code.
      // Mermaid 代码块可通过语法嵌入图片，词法分析将其归为代码。
      if (token.type === 'code' && token.lang?.toLowerCase() === 'mermaid' && /(?:\bimg\s*[:=]|\bimage\s*[:=]|<img\b|url\s*\()/i.test(token.text)) local = true;
      if ((token.type === 'image' || token.type === 'link') && !remote(token.href)) local = true;
      if (token.type === 'html' && /<(?:img|a|video|audio|source|iframe|object)\b/i.test(token.text)) local = true;
      if (token.type === 'html' && /(?:url\s*\(|@import|\b(?:src|href|srcset|poster|background|data|xlink:href)\s*=)/i.test(token.text)) local = true;
      // Wiki-style [[...]] links are outside the standard Markdown model and always treated as local.
      // Wiki 风格的 [[...]] 链接不属于标准 Markdown 模型，一律按本地引用处理。
      if (token.type !== 'code' && token.type !== 'codespan' && /\[\[[^\]]+\]\]/.test(token.raw)) local = true;
    });
    // Fail closed: an unparseable document is treated as containing local references.
    // 失败保守：无法解析的文档按包含本地引用处理。
  } catch { return true; }
  return local;
}
