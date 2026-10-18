/**
 * Collection and byte-range rewriting of local Markdown/HTML document references without reserializing user Markdown.
 * 在不重新序列化用户 Markdown 的前提下，收集并按字节范围改写本地 Markdown/HTML 文档引用。
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

/**
 * One local resource reference located in the document source.
 * 在文档源码中定位到的一个本地资源引用。
 */
export interface DocumentReference {
  /** Raw href target of the reference. / 引用的原始 href 目标。 */
  href: string;
  /** Whether the reference is an image rather than a link. / 引用是图片而非链接。 */
  image: boolean;
  /** Start byte offset of the URL within the document. / URL 在文档中的起始字节偏移。 */
  start: number;
  /** End byte offset of the URL within the document. / URL 在文档中的结束字节偏移。 */
  end: number;
  /** Whether the reference lives inside an HTML block. / 引用是否位于 HTML 块内。 */
  html: boolean;
}

/**
 * Minimal Markdown AST node shape used while locating references.
 * 定位引用时使用的最小 Markdown AST 节点结构。
 */
interface Node {
  /** Node type from the remark parser. / 来自 remark 解析器的节点类型。 */
  type: string;
  /** URL of link/image nodes. / 链接/图片节点的 URL。 */
  url?: string;
  /** Literal value of text-like nodes. / 文本类节点的字面值。 */
  value?: string;
  /** Language tag of code nodes. / 代码节点的语言标签。 */
  lang?: string;
  /** Label identifier of reference/definition nodes. / 引用/定义节点的标签标识。 */
  identifier?: string;
  /** Child nodes. / 子节点列表。 */
  children?: Node[];
  /** Source position offsets. / 源码位置偏移。 */
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Whether a reference target points to a remote or safe inline resource rather than a local file.
 * 引用目标是否指向远程或安全的内联资源，而非本地文件。
 */
export const isDocumentRemoteReference = (href: string) => /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpeg|gif|webp);base64,|#)/i.test(href.trim());

/**
 * Collect local resource references from Markdown and HTML tokens via AST location; only URL byte ranges are targeted for replacement and user Markdown is never reserialized.
 * 通过 AST 定位收集 Markdown 与 HTML token 中的本地资源引用及定义；仅替换 URL 字节范围，不重新序列化用户 Markdown。
 *
 * @param content - Markdown document source / Markdown 文档源码
 * @returns Located references and unsupported constructs / 已定位的引用与不支持的构造
 */
export function collectDocumentReferences(content: string): { references: DocumentReference[]; unsupported: string[] } {
  const root = unified().use(remarkParse).use(remarkGfm).parse(content) as Node;
  const references: DocumentReference[] = [], unsupported: string[] = [], definitions = new Map<string, Node>(), used = new Map<string, boolean>();
  const walk = (node: Node, visit: (node: Node) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
  // First pass: index definitions and which labels are used as images or links.
  // 第一遍：索引定义，并记录标签被用作图片还是链接。
  walk(root, node => {
    if (node.type === 'definition') definitions.set(node.identifier!.toUpperCase(), node);
    if (node.type === 'imageReference' || node.type === 'linkReference') used.set(node.identifier!.toUpperCase(), (used.get(node.identifier!.toUpperCase()) ?? false) || node.type === 'imageReference');
  });
  // Locate the URL's byte range inside the raw source slice of a link, image, or definition.
  // 在链接、图片或定义的原始源码切片内定位 URL 的字节范围。
  const add = (node: Node, image: boolean, definition = false) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined || !node.url || isDocumentRemoteReference(node.url)) return;
    const raw = content.slice(start, end);
    // 标准定义的冒号或行内链接的闭方括号只定位语法起点，资源来自 AST 的 URL。
    // The definition colon or the inline link's closing bracket only marks the syntax start; the resource comes from the AST URL.
    let inlinePrefix: number | undefined, depthOfLabel = 0;
    for (let i = raw.startsWith('!') ? 1 : 0; i < raw.length; i++) {
      if (raw[i] === '\\') { i++; continue; }
      if (raw[i] === '[') depthOfLabel++;
      if (raw[i] === ']' && --depthOfLabel === 0) { if (raw[i + 1] === '(') inlinePrefix = i + 2; break; }
    }
    const prefix = definition ? /^\s{0,3}\[[\s\S]*?\]:\s*/.exec(raw)?.[0].length : inlinePrefix;
    if (prefix === undefined || (!definition && prefix < 2)) { unsupported.push(raw); return; }
    // Skip whitespace and optional angle brackets before the URL itself.
    // 跳过空白和 URL 前可选的尖括号。
    let offset = prefix; while (/\s/.test(raw[offset] ?? '') && offset < raw.length) offset++;
    const angle = raw[offset] === '<'; if (angle) offset++;
    // The URL ends at the closing angle bracket, whitespace, or an unbalanced closing paren.
    // URL 在闭尖括号、空白或不成对的右圆括号处结束。
    let stop = offset, depth = 0;
    for (; stop < raw.length; stop++) {
      const ch = raw[stop]; if (ch === '\\') { stop++; continue; }
      if (angle ? ch === '>' : /\s/.test(ch) || (ch === ')' && depth === 0)) break;
      if (ch === '(') depth++; if (ch === ')') depth--;
    }
    references.push({ href: node.url, image, start: start + offset, end: start + stop, html: false });
  };
  walk(root, node => {
    if (node.type === 'image' || node.type === 'link') add(node, node.type === 'image');
    if (node.type === 'definition' && used.has(node.identifier!.toUpperCase())) add(node, used.get(node.identifier!.toUpperCase())!, true);
    // Mermaid blocks can embed images through syntax the parser classifies as code.
    // Mermaid 代码块可通过语法嵌入图片，解析器将其归为代码。
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid' && /(?:\bimg\s*[:=]|\bimage\s*[:=]|<img\b|url\s*\()/i.test(node.value ?? '')) unsupported.push('Mermaid 图片资源');
    if (node.type !== 'html') return;
    // HTML blocks are re-parsed with parse5 to get exact attribute value offsets.
    // HTML 块用 parse5 重新解析，以获得精确的属性值偏移。
    const base = node.position?.start.offset ?? 0, value = node.value ?? '';
    const fragment = parseFragment(value, { sourceCodeLocationInfo: true });
    const htmlWalk = (element: DefaultTreeAdapterMap['node']) => {
      if ('attrs' in element) {
        for (const attribute of element.attrs) {
          if (!attribute.value || isDocumentRemoteReference(attribute.value)) continue;
          const name = attribute.name;
          // Only img[src] and a[href] have replaceable URL ranges; other URL-bearing attributes are unsupported.
          // 仅 img[src] 与 a[href] 具有可替换的 URL 范围；其他携带 URL 的属性不支持。
          if ((element.tagName === 'img' && name === 'src') || (element.tagName === 'a' && name === 'href')) {
            const location = element.sourceCodeLocation?.attrs?.[name];
            if (!location) { unsupported.push(value); continue; }
            const raw = value.slice(location.startOffset, location.endOffset), match = /=\s*(["']?)([\s\S]*?)\1$/.exec(raw);
            if (!match) { unsupported.push(value); continue; }
            const offset = raw.indexOf('=') + 1 + (raw.slice(raw.indexOf('=') + 1).match(/^\s*/)?.[0].length ?? 0) + match[1].length;
            references.push({ href: attribute.value, image: element.tagName === 'img', start: base + location.startOffset + offset, end: base + location.startOffset + offset + match[2].length, html: true });
          } else if (['src', 'href', 'srcset', 'poster', 'data', 'background'].includes(name) || /(?:url\s*\(|@import)/i.test(attribute.value)) unsupported.push(`${element.tagName}: ${name}`);
        }
      }
      if ('childNodes' in element) element.childNodes.forEach(htmlWalk);
    };
    fragment.childNodes.forEach(htmlWalk);
  });
  // Used labels without a matching definition cannot be rewritten safely.
  // 使用了标签却没有匹配定义的引用无法安全改写。
  for (const identifier of used.keys()) if (!definitions.has(identifier)) unsupported.push(`未找到引用定义：${identifier}`);
  return { references, unsupported };
}

/**
 * Replace the URL byte ranges of matched references with new targets, escaping per context.
 * 将匹配引用的 URL 字节范围替换为新目标，并按上下文转义。
 *
 * @param content - Markdown document source / Markdown 文档源码
 * @param replacements - Map from old href to new href / 旧 href 到新 href 的映射
 * @returns Document source with replacements applied / 应用替换后的文档源码
 */
export function rewriteDocumentReferences(content: string, replacements: Record<string, string>): string {
  // Replace from the end so earlier offsets stay valid as the string shrinks or grows.
  // 从后往前替换，使字符串伸缩时前面的偏移仍然有效。
  const edits = collectDocumentReferences(content).references.filter(ref => replacements[ref.href] !== undefined).sort((a, b) => b.start - a.start);
  for (const ref of edits) {
    const value = replacements[ref.href];
    // HTML attribute values need entity escaping; Markdown URLs need percent-encoding of spaces and parens.
    // HTML 属性值需要实体转义；Markdown URL 需要对空格与圆括号做百分号编码。
    const escaped = ref.html ? value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') : value.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    content = content.slice(0, ref.start) + escaped + content.slice(ref.end);
  }
  return content;
}
