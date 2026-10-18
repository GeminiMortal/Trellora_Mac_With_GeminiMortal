/**
 * Parsing helpers for relative Markdown link hrefs within a note library.
 * 笔记资料库内相对 Markdown 链接 href 的解析工具。
 */

/**
 * A resolved relative Markdown link, split into a path and an optional heading fragment.
 * 已解析的相对 Markdown 链接，拆分为路径与可选的标题片段。
 */
export interface MarkdownRelativeLinkTarget {
  path: string;
  fragment?: string;
}

/**
 * Parse a relative `.md`/`.markdown` link href, stripping query strings and
 * rejecting absolute, root-absolute, anchor-only, or non-Markdown hrefs.
 * 解析相对 `.md`/`.markdown` 链接 href，去除查询字符串，并拒绝
 * 绝对地址、根绝对地址、纯锚点或非 Markdown href。
 *
 * @param href - Raw href attribute value / 原始 href 属性值
 * @returns Parsed path and fragment, or null when not a relative Markdown link / 解析后的路径与片段；非相对 Markdown 链接时返回 null
 */
export function parseRelativeMarkdownLinkHref(href: string): MarkdownRelativeLinkTarget | null {
  const trimmedHref = href.trim();
  if (!trimmedHref || trimmedHref.startsWith('#') || trimmedHref.startsWith('/') || trimmedHref.startsWith('\\')) {
    return null;
  }
  // Reject absolute URIs (e.g. http:, mailto:, menghan:). / 拒绝绝对 URI（如 http:、mailto:、menghan:）。
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedHref)) return null;

  const hashIndex = trimmedHref.indexOf('#');
  const hrefWithoutFragment = hashIndex >= 0 ? trimmedHref.slice(0, hashIndex) : trimmedHref;
  const rawFragment = hashIndex >= 0 ? trimmedHref.slice(hashIndex + 1) : '';
  const queryIndex = hrefWithoutFragment.indexOf('?');
  const rawPath = queryIndex >= 0 ? hrefWithoutFragment.slice(0, queryIndex) : hrefWithoutFragment;
  if (!/\.(?:md|markdown)$/i.test(rawPath)) return null;

  try {
    const decodedPath = decodeURIComponent(rawPath).replace(/\\/g, '/');
    if (!decodedPath || decodedPath.includes('\0') || decodedPath.startsWith('/') || /^[a-z]:\//i.test(decodedPath)) {
      return null;
    }
    const fragment = rawFragment ? decodeURIComponent(rawFragment) : undefined;
    return fragment ? { path: decodedPath, fragment } : { path: decodedPath };
  } catch {
    return null;
  }
}
