/**
 * Outline extraction from rendered Markdown and tree flattening for the outline sidebar.
 * 从渲染后 Markdown 提取大纲，并为大纲侧栏做树形扁平化。
 */
import type { HeadingEntry } from '../../electron';
import {
    createHeadingAnchorIds,
    normalizeHeadingText,
    type HeadingTextSource,
} from './headingAnchors.ts';

/**
 * A rendered heading element reduced to its tag and text. / 渲染标题元素的标签与文本简化表示。 */
export interface RenderedHeadingSource extends HeadingTextSource {
    /** Uppercase tag name such as "H2" / 大写标签名，如 "H2" */
    tagName: string;
}

/**
 * A node in the hierarchical outline tree. / 层级大纲树中的节点。 */
export interface OutlineTreeNode {
    /** Stable React/key identity / 稳定的 React key 标识 */
    key: string;
    /** Heading data for this node / 本节点的标题数据 */
    heading: HeadingEntry;
    /** Nested child nodes / 嵌套子节点 */
    children: OutlineTreeNode[];
}

/**
 * One flattened row ready for rendering in the outline list. / 大纲列表中可渲染的单行扁平化数据。 */
export interface VisibleOutlineRow {
    /** Stable row identity / 稳定的行标识 */
    key: string;
    /** Heading data for this row / 本行的标题数据 */
    heading: HeadingEntry;
    /** Nesting depth starting at 0 / 从 0 开始的嵌套深度 */
    depth: number;
    /** Whether the node has child headings / 节点是否有子标题 */
    hasChildren: boolean;
    /** Whether the node's children are hidden / 节点的子级是否被折叠 */
    isCollapsed: boolean;
}

/**
 * Extracts outline headings from rendered DOM, skipping code blocks.
 * 从渲染 DOM 提取大纲标题，跳过代码块内的标题。
 *
 * @param root - Container to scan / 待扫描的容器
 * @returns Heading entries in document order / 按文档顺序排列的标题条目
 */
export function extractRenderedHeadings(root: ParentNode): HeadingEntry[] {
    const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
    const visibleHeadings = [...headings].filter((heading) => !heading.closest('pre, code'));
    return createHeadingEntriesFromElements(visibleHeadings);
}

/**
 * Builds heading entries with unique anchor ids from heading-like elements.
 * 从标题类元素构建带唯一锚点 id 的标题条目。
 *
 * @param elements - Elements with heading tag names and text / 具有标题标签名和文本的元素
 * @returns Heading entries with text, excluding empty headings / 含文本的标题条目；空标题被排除
 */
export function createHeadingEntriesFromElements(elements: ArrayLike<RenderedHeadingSource>): HeadingEntry[] {
    const headings = Array.from(elements).map((element) => {
        const level = Number(element.tagName.match(/[1-6]$/)?.[0] ?? 1) as HeadingEntry['level'];
        const text = normalizeHeadingText(element);
        return { level, text };
    });
    const ids = createHeadingAnchorIds(headings.map((heading) => heading.text));

    return headings
        .map((heading, index) => ({
            id: ids[index],
            level: heading.level,
            text: heading.text,
            line: index + 1,
            index,
        }))
        .filter((heading) => heading.text.length > 0);
}

/**
 * Builds a stable identity key for a heading entry. / 为标题条目构造稳定标识键。
 *
 * @param heading - Heading entry / 标题条目
 * @returns Key combining index and id / 由序号与 id 组合的键
 */
export function getOutlineHeadingKey(heading: HeadingEntry): string {
    return `${heading.index}:${heading.id}`;
}

/**
 * Nests flat headings into a tree based on heading levels.
 * 按标题层级将扁平标题嵌套成树。
 *
 * @param headings - Headings in document order / 按文档顺序排列的标题
 * @returns Root outline nodes / 大纲根节点列表
 */
export function buildOutlineTree(headings: HeadingEntry[]): OutlineTreeNode[] {
    const roots: OutlineTreeNode[] = [];
    const ancestors: OutlineTreeNode[] = [];

    for (const heading of headings) {
        // Pop deeper-or-equal ancestors so each node attaches to its nearest shallower parent. / 弹出更深或同级的祖先，使每个节点挂到最近的更浅父节点下。
        while (ancestors.length > 0 && ancestors[ancestors.length - 1].heading.level >= heading.level) {
            ancestors.pop();
        }

        const node: OutlineTreeNode = {
            key: getOutlineHeadingKey(heading),
            heading,
            children: [],
        };
        const parent = ancestors[ancestors.length - 1];
        if (parent) parent.children.push(node);
        else roots.push(node);
        ancestors.push(node);
    }

    return roots;
}

/**
 * Collects keys of nodes that have children and can be collapsed.
 * 收集具有子节点、可被折叠的节点键。
 *
 * @param nodes - Outline tree roots / 大纲树根节点
 * @returns Keys of collapsible nodes / 可折叠节点的键列表
 */
export function collectCollapsibleOutlineKeys(nodes: OutlineTreeNode[]): string[] {
    const result: string[] = [];
    const visit = (node: OutlineTreeNode) => {
        if (node.children.length > 0) result.push(node.key);
        node.children.forEach(visit);
    };
    nodes.forEach(visit);
    return result;
}

/**
 * Flattens the outline tree into visible rows, honoring collapsed nodes.
 * 将大纲树扁平化为可见行，并遵循折叠状态。
 *
 * @param nodes - Outline tree roots / 大纲树根节点
 * @param collapsedKeys - Keys of nodes whose children are hidden / 子级被隐藏的节点键集合
 * @returns Visible rows in depth-first order / 深度优先顺序的可见行
 */
export function flattenVisibleOutlineTree(nodes: OutlineTreeNode[], collapsedKeys: ReadonlySet<string>): VisibleOutlineRow[] {
    const result: VisibleOutlineRow[] = [];
    const visit = (node: OutlineTreeNode, depth: number) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = hasChildren && collapsedKeys.has(node.key);
        result.push({
            key: node.key,
            heading: node.heading,
            depth,
            hasChildren,
            isCollapsed,
        });
        // Collapsed subtrees are skipped so their rows stay hidden. / 跳过折叠子树，使其行保持隐藏。
        if (!isCollapsed) node.children.forEach((child) => visit(child, depth + 1));
    };
    nodes.forEach((node) => visit(node, 0));
    return result;
}
