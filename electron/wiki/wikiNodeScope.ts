import type { WikiDocumentOutlineNode } from './wikiOutline.ts';

/**
 * Wiki node scope computation: maps outline nodes to chunk section ownership for scoped retrieval (spec §3.1).
 * Wiki 节点作用域计算（方案 §3.1）。
 *
 * Key fact: the trailing nodeId of a chunk's `sectionPath` is the structure-tree nodeId of the chapter that chunk
 * belongs to, sharing the same source as the outline node's `sourceHeadingId`. Therefore "subtree ownership" is
 * equivalent to: the trailing nodeId of the chunk's sectionPath ∈ the set of sourceHeadingIds of the node itself
 * and all of its descendant heading nodes.
 * 关键事实：chunk 的 `sectionPath` 末位 nodeId 即该 chunk 所属章节的结构树 nodeId，
 * 与 outline 节点的 `sourceHeadingId` 同源。因此"节点子树归属"等价于：
 * chunk 的 sectionPath 末位 nodeId ∈ 节点自身及其全部后代标题节点的 sourceHeadingId 集合。
 */

interface WikiNodeIndex {
  byId: Map<string, WikiDocumentOutlineNode>;
  childrenByParent: Map<string, WikiDocumentOutlineNode[]>;
}

function indexOutlineNodes(nodes: readonly WikiDocumentOutlineNode[]): WikiNodeIndex {
  const byId = new Map<string, WikiDocumentOutlineNode>();
  const childrenByParent = new Map<string, WikiDocumentOutlineNode[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  return { byId, childrenByParent };
}

/**
 * Find a node by id; returns undefined when missing (the caller raises an actionable Chinese error).
 * 按 id 查找节点；不存在返回 undefined（调用方给出中文可操作错误）。
 *
 * @param nodes - Outline nodes to search / 要搜索的大纲节点列表
 * @param nodeId - Target node id / 目标节点 id
 * @returns Matching node, or undefined when absent / 匹配的节点；不存在时为 undefined
 */
export function findWikiNode(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): WikiDocumentOutlineNode | undefined {
  return nodes.find((node) => node.id === nodeId);
}

/**
 * Whether the node is the root (parentId null); its scope is the whole document, so retrieval must not pass a sectionNodeIds filter.
 * 根节点（parentId 为 null）作用域为整篇文档，检索时不下发 sectionNodeIds 过滤。
 *
 * @param node - Node to test, may be undefined / 待判断节点，可为 undefined
 * @returns True when the node is the root node / 是否为根节点
 */
export function isWikiRootNode(node: WikiDocumentOutlineNode | undefined): boolean {
  return Boolean(node && node.parentId === null);
}

/**
 * Direct children of a node, sorted by order ascending.
 * 节点的直接子节点（按 order 升序）。
 *
 * @param nodes - Full outline node list / 完整大纲节点列表
 * @param nodeId - Parent node id / 父节点 id
 * @returns Sorted direct children / 排序后的直接子节点
 */
export function collectWikiChildNodes(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): WikiDocumentOutlineNode[] {
  const { childrenByParent } = indexOutlineNodes(nodes);
  return [...(childrenByParent.get(nodeId) ?? [])].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

/**
 * Collect every sourceHeadingId in the node subtree (including itself).
 * The set is passed as searchMaterialChunks' sectionNodeIds to scope retrieval to the chapter subtree.
 * For the root node all heading sourceHeadingIds of the document are returned; callers should instead skip
 * filtering for the root (see isWikiRootNode).
 * 收集节点子树（含自身）的全部 sourceHeadingId。
 * 该集合作为 searchMaterialChunks 的 sectionNodeIds，实现章节子树级作用域过滤。
 * 根节点返回整篇文档全部标题的 sourceHeadingId；调用方对根节点应改为不过滤（见 isWikiRootNode）。
 *
 * @param nodes - Full outline node list / 完整大纲节点列表
 * @param nodeId - Subtree root node id / 子树根节点 id
 * @returns sourceHeadingIds of the subtree; empty when the node is missing / 子树的 sourceHeadingId 集合；节点不存在时为空数组
 */
export function collectSubtreeHeadingIds(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): string[] {
  const { byId, childrenByParent } = indexOutlineNodes(nodes);
  const target = byId.get(nodeId);
  if (!target) return [];
  const headingIds: string[] = [];
  const seen = new Set<string>();
  const stack: WikiDocumentOutlineNode[] = [target];
  while (stack.length > 0) {
    const current = stack.pop() as WikiDocumentOutlineNode;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.sourceHeadingId) headingIds.push(current.sourceHeadingId);
    for (const child of childrenByParent.get(current.id) ?? []) stack.push(child);
  }
  return headingIds;
}

/**
 * Collect all nodes in the subtree (including itself), depth-first with siblings sorted by order ascending.
 * wiki_grep_node uses it to literally grep source text (including markdown) node by node within the chapter subtree.
 * 收集节点子树（含自身）的全部节点，按深度优先、同级 order 升序返回。
 * wiki_grep_node 用它在本章节子树内逐节点字面检索原文（含 markdown）。
 *
 * @param nodes - Full outline node list / 完整大纲节点列表
 * @param nodeId - Subtree root node id / 子树根节点 id
 * @returns Subtree nodes in document order / 文档顺序排列的子树节点
 */
export function collectWikiSubtreeNodes(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): WikiDocumentOutlineNode[] {
  const { byId, childrenByParent } = indexOutlineNodes(nodes);
  const target = byId.get(nodeId);
  if (!target) return [];
  const result: WikiDocumentOutlineNode[] = [];
  const seen = new Set<string>();
  const stack: WikiDocumentOutlineNode[] = [target];
  while (stack.length > 0) {
    const current = stack.pop() as WikiDocumentOutlineNode;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    result.push(current);
    const children = [...(childrenByParent.get(current.id) ?? [])].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    );
    // Push in reverse so popping yields document order (depth-first, siblings order ascending).
    // 逆序入栈，保证出栈为文档顺序（同级 order 升序的深度优先）。
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return result;
}

/**
 * Compute the sourceHeadingId set of "whole document − current subtree" (spec §4.3).
 * Used as wiki_search_document's sectionNodeIds: cross-chapter search only recalls chapters outside the current
 * node subtree, maintaining scope discipline. Derived nodes (kind:'derived') have no matching chunk and are
 * skipped; excludeHeadingIds is the current subtree set.
 * Callers must handle the root node first (when sectionNodeIds is undefined the whole document is the current
 * scope, so cross-chapter search does not apply).
 * 计算「整篇文档 − 当前子树」的 sourceHeadingId 集合（方案 §4.3）。
 * 作为 wiki_search_document 的 sectionNodeIds：跨章节检索只召回当前节点子树之外的章节，
 * 维持作用域纪律。派生节点（kind:'derived'）无对应 chunk，跳过；excludeHeadingIds 为当前子树集合。
 * 调用方需先处理根节点（sectionNodeIds 为 undefined 时整篇即当前作用域，无跨章节可言）。
 *
 * @param nodes - Full outline node list / 完整大纲节点列表
 * @param excludeHeadingIds - sourceHeadingIds of the current subtree to exclude / 要排除的当前子树 sourceHeadingId 集合
 * @returns sourceHeadingIds outside the subtree / 子树之外的 sourceHeadingId 集合
 */
export function collectCrossNodeHeadingIds(
  nodes: readonly WikiDocumentOutlineNode[],
  excludeHeadingIds: readonly string[] | undefined,
): string[] {
  const exclude = new Set(excludeHeadingIds ?? []);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind === 'derived') continue;
    const headingId = node.sourceHeadingId;
    if (!headingId || exclude.has(headingId) || seen.has(headingId)) continue;
    seen.add(headingId);
    result.push(headingId);
  }
  return result;
}

/**
 * Whether nodeId equals ancestorId or is a descendant of it (inclusive of self).
 * wiki_read_node uses it to limit deep reading to the current node subtree, maintaining scope discipline.
 * 判断 nodeId 是否等于 ancestorId 或是其后代（含自身）。
 * wiki_read_node 用它把深读范围限定在当前节点子树内，维持作用域纪律。
 *
 * @param nodes - Full outline node list / 完整大纲节点列表
 * @param nodeId - Node to test / 待判断节点 id
 * @param ancestorId - Candidate ancestor node id / 候选祖先节点 id
 * @returns True when nodeId is ancestorId or lies in its subtree / nodeId 是否为 ancestorId 本身或其后代
 */
export function isWikiNodeDescendantOf(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
  ancestorId: string,
): boolean {
  const { byId } = indexOutlineNodes(nodes);
  let current = byId.get(nodeId);
  let guard = 0;
  // Guard bound: walks parents until found or cycle risk exhausted; prevents infinite loops on corrupted outlines.
  // 守卫上界：沿父链查找直至命中或耗尽，防止损坏大纲中的父级环导致死循环。
  while (current && guard < nodes.length + 1) {
    if (current.id === ancestorId) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return false;
}

/**
 * Breadcrumb titles of a node (root → target node title chain), used by runtime_context and citation display.
 * 节点面包屑（根 → 目标节点的标题链），用于 runtime_context 与引用来源展示。
 *
 * @param nodes - Full outline node list / 完整大纲节点列表
 * @param nodeId - Target node id / 目标节点 id
 * @returns Titles from root to the node / 自根至该节点的标题链
 */
export function getWikiNodeBreadcrumb(
  nodes: readonly WikiDocumentOutlineNode[],
  nodeId: string,
): string[] {
  const { byId } = indexOutlineNodes(nodes);
  const path: string[] = [];
  let current = byId.get(nodeId);
  let guard = 0;
  // Guard bound: walks parents until the root or cycle risk exhausted; prevents infinite loops on corrupted outlines.
  // 守卫上界：沿父链回溯直至根或耗尽，防止损坏大纲中的父级环导致死循环。
  while (current && guard < nodes.length + 1) {
    path.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return path;
}

/**
 * Breadcrumb joined with " › "; an empty path yields an empty string.
 * 以 " › " 连接的面包屑字符串；空路径返回空串。
 *
 * @param breadcrumb - Breadcrumb titles / 面包屑标题列表
 * @returns Joined path string / 拼接后的路径字符串
 */
export function formatWikiNodePath(breadcrumb: readonly string[]): string {
  return breadcrumb.join(' › ');
}
