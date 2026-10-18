/**
 * Heading slug/id allocation and anchor navigation for rendered Markdown.
 * 渲染后 Markdown 的标题 slug/id 分配与锚点导航。
 */

/** CSS selector matching Markdown heading elements. / 匹配 Markdown 标题元素的 CSS 选择器。 */
export const markdownHeadingSelector = 'h1, h2, h3, h4, h5, h6';

/**
 * Minimal DOM surface needed to read a heading's text.
 * 读取标题文本所需的最小 DOM 接口。
 */
export interface HeadingTextSource {
  textContent: string | null;
  innerText?: string;
}

/**
 * One heading anchor registered for a rendered document.
 * 渲染文档中注册的单个标题锚点。
 */
export interface HeadingAnchorEntry {
  /** Unique anchor id / 唯一锚点 id */
  id: string;
  /** Normalized heading text / 规范化后的标题文本 */
  text: string;
  /** Zero-based heading position / 从 0 开始的标题序号 */
  index: number;
}

/**
 * Normalizes heading text by collapsing whitespace runs to single spaces.
 * 将标题文本中的连续空白折叠为单个空格。
 *
 * @param source - Element providing the raw text / 提供原始文本的元素
 * @returns Trimmed single-spaced text / 去首尾空白的单空格文本
 */
export function normalizeHeadingText(source: HeadingTextSource): string {
  return (source.innerText ?? source.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Converts heading text into a URL-safe slug, with a positional fallback.
 * 将标题文本转换为 URL 安全的 slug，空结果时按位置回退。
 *
 * @param text - Raw heading text / 原始标题文本
 * @param index - Zero-based heading position used for the fallback / 用于回退的从 0 开始的标题序号
 * @returns Slug string / slug 字符串
 */
export function slugifyHeading(text: string, index: number): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `heading-${index + 1}`;
}

/**
 * Allocate document-wide heading ids without collisions. Checking the final id
 * as well as the base slug also keeps inputs such as "Title", "Title" and
 * "Title-2" unique instead of assigning "title-2" twice.
 * 在文档范围内分配互不冲突的标题 id。同时校验最终 id 与基础 slug，
 * 使 "Title"、"Title"、"Title-2" 这类输入也不会重复得到 "title-2"。
 *
 * @param texts - Heading texts in document order / 按文档顺序排列的标题文本
 * @returns Unique id per heading / 每个标题的唯一 id
 */
export function createHeadingAnchorIds(texts: ArrayLike<string>): string[] {
  const usedIds = new Set<string>();

  return Array.from(texts, (text, index) => {
    const baseId = slugifyHeading(text, index);
    let candidate = baseId;
    let suffix = 2;
    // Reserve the base slug too, so later collisions cannot steal an earlier id. / 同时占用基础 slug，避免后续冲突抢走先前的 id。
    while (usedIds.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  });
}

/**
 * Assigns ids and permalink anchors to all rendered headings in place.
 * 为渲染出的全部标题就地分配 id 与永久链接锚点。
 *
 * @param root - Container to scan for headings / 扫描标题的容器
 * @returns Registered anchor entries / 已注册的锚点条目
 */
export function enhanceHeadingAnchors(root: ParentNode): HeadingAnchorEntry[] {
  const headings = [...root.querySelectorAll<HTMLElement>(markdownHeadingSelector)]
    .filter((heading) => !heading.closest('pre, code'));
  const texts = headings.map(normalizeHeadingText);
  const ids = createHeadingAnchorIds(texts);

  return headings.map((heading, index) => {
    const id = ids[index];
    const text = texts[index];
    heading.id = id;
    heading.setAttribute('tabindex', '-1');

    let permalink = heading.querySelector<HTMLAnchorElement>(':scope > .markdown-heading-anchor');
    if (!permalink) {
      permalink = document.createElement('a');
      permalink.className = 'markdown-heading-anchor';
      heading.appendChild(permalink);
    }
    permalink.setAttribute('href', `#${encodeURIComponent(id)}`);
    permalink.setAttribute('aria-label', `永久链接：${text || id}`);
    permalink.title = '跳转到此标题';

    return { id, text, index };
  });
}

/**
 * Decodes the fragment of a hash href into a heading id.
 * 将 hash href 的片段解码为标题 id。
 *
 * @param href - Hash href such as "#intro" / 形如 "#intro" 的 hash href
 * @returns Decoded heading id, or null when absent/invalid / 解码后的标题 id；缺失或非法时为 null
 */
export function decodeHeadingFragment(href: string): string | null {
  if (!href.startsWith('#') || href.length === 1) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
}

/**
 * Scrolls to the heading with the given id and replays the highlight animation.
 * 滚动到指定 id 的标题并重放高亮动画。
 *
 * @param root - Container to search for the heading / 搜索标题的容器
 * @param id - Heading anchor id / 标题锚点 id
 * @returns The target element, or null if not found / 目标元素；未找到时为 null
 */
export function scrollToHeadingAnchor(root: ParentNode, id: string): HTMLElement | null {
  const target = [...root.querySelectorAll<HTMLElement>(markdownHeadingSelector)]
    .find((heading) => heading.id === id) ?? null;
  if (!target) return null;

  target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  target.classList.remove('markdown-heading-target');
  // Force style recalculation so repeated jumps replay the highlight animation. / 强制样式重算，使重复跳转可重放高亮动画。
  void target.offsetWidth;
  target.classList.add('markdown-heading-target');
  return target;
}
