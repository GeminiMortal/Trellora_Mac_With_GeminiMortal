/**
 * Markdown utilities for selection expansion: transport-envelope stripping, rendered-text extraction, and format-loss detection.
 * 选区扩写的 Markdown 工具：去除传输包装、提取渲染文本、检测格式丢失。
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

/**
 * Minimal Markdown AST node shape used by the helpers below.
 * 下列辅助函数使用的最小 Markdown AST 节点结构。
 */
interface MarkdownNode {
  /** Node type from the remark parser. / 来自 remark 解析器的节点类型。 */
  type: string;
  /** Literal value for text-like nodes. / 文本类节点的字面值。 */
  value?: string;
  /** Heading level for heading nodes. / 标题节点的标题级别。 */
  depth?: number;
  /** Whether a list node is ordered. / 列表节点是否为有序列表。 */
  ordered?: boolean;
  /** Child nodes. / 子节点列表。 */
  children?: MarkdownNode[];
}

/**
 * Shared remark parser with GFM support.
 * 启用 GFM 的共享 remark 解析器。
 */
const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Remove the transport envelope while preserving the document's Markdown and code.
 * 去除外层传输包装，同时保留文档的 Markdown 与代码。
 *
 * @param value - Raw model output possibly wrapped in a final-answer envelope / 可能带有最终回答包装的原始模型输出
 * @returns Unwrapped Markdown text / 去除包装后的 Markdown 文本
 */
export function normalizeExpansionMarkdown(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim()
    .replace(/^<final_answer>\s*([\s\S]*?)\s*<\/final_answer>$/u, '$1').trim();
}

/**
 * Extract the rendered plain text of a Markdown document; length is measured on the rendered text so Markdown markers and link destinations do not pad it.
 * 提取 Markdown 文档渲染后的纯文本；长度按渲染文本度量，Markdown 标记与链接目标不计入长度。
 *
 * @param value - Markdown text to render / 要渲染的 Markdown 文本
 * @returns Rendered plain text with structural separators / 带结构分隔符的渲染纯文本
 */
export function expansionMarkdownText(value: string): string {
  const text = (node: MarkdownNode): string => {
    // Images contribute their alt text; other leaf nodes contribute their literal value.
    // 图片节点贡献其替代文本；其他叶子节点贡献其字面值。
    if (node.type === 'image') return node.value ?? '';
    if (node.value !== undefined) return node.value;
    // Block containers join children with newlines to keep structural boundaries visible to length checks.
    // 块级容器以换行连接子节点，使结构边界对长度检查可见。
    const separator = ['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow'].includes(node.type) ? '\n' : '';
    return (node.children ?? []).map(text).join(separator);
  };
  return text(parser.parse(normalizeExpansionMarkdown(value)) as MarkdownNode);
}

/**
 * Report Markdown format kinds present in the source but lost in the candidate; a formatted source must not silently become an unformatted summary.
 * 报告源文本中存在但候选文本中丢失的 Markdown 格式类别；带格式的源文本不应悄悄变成无格式的摘要。
 *
 * @param source - Original Markdown / 原始 Markdown
 * @param candidate - Expanded candidate Markdown / 扩写后的候选 Markdown
 * @returns Format kind names whose counts dropped / 数量下降的格式类别名称列表
 */
export function expansionMarkdownFormatLosses(source: string, candidate: string): string[] {
  // Count each notable format kind so the comparison is per-kind, not per-node identity.
  // 统计每种显著格式类别，使比较按类别进行而非按节点身份。
  const formats = (value: string): Map<string, number> => {
    const counts = new Map<string, number>();
    const walk = (node: MarkdownNode): void => {
      const kind = node.type === 'heading' ? `heading-${node.depth}`
        : node.type === 'list' ? node.ordered ? 'ordered-list' : 'bullet-list'
          : ['listItem', 'blockquote', 'code', 'inlineCode', 'strong', 'emphasis', 'delete', 'link', 'table', 'break'].includes(node.type) ? node.type : undefined;
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      node.children?.forEach(walk);
    };
    walk(parser.parse(value) as MarkdownNode);
    return counts;
  };
  const actual = formats(candidate);
  return [...formats(source)].filter(([kind, count]) => (actual.get(kind) ?? 0) < count).map(([kind]) => kind);
}

/**
 * Whether the Markdown contains raw HTML nodes.
 * Markdown 中是否包含原始 HTML 节点。
 *
 * @param value - Markdown text to inspect / 要检查的 Markdown 文本
 * @returns True when any raw HTML node is present / 存在任意原始 HTML 节点时返回 true
 */
export function hasExpansionRawHtml(value: string): boolean {
  const containsHtml = (node: MarkdownNode): boolean => node.type === 'html' || Boolean(node.children?.some(containsHtml));
  return containsHtml(parser.parse(value) as MarkdownNode);
}
