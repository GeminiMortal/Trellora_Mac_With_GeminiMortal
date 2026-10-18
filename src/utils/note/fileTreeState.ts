/**
 * Helpers for computing and reconciling folder collapse state in the file tree.
 * 文件树文件夹折叠状态的计算与校正辅助函数。
 */
import type { FileNode } from '../../electron';

/**
 * Collects every directory path in the tree, depth-first.
 * 深度优先收集树中全部目录路径。
 *
 * @param nodes - File tree nodes to scan / 待扫描的文件树节点
 * @returns Directory paths including nested ones / 目录路径（含嵌套目录）
 */
export function collectDirectoryPaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => node.isDirectory
    ? [node.path, ...collectDirectoryPaths(node.children ?? [])]
    : []);
}

/**
 * Returns the folder paths from the root down to the target's parent.
 * 返回从根到目标父目录的文件夹路径链。
 *
 * @param nodes - File tree nodes to search / 待搜索的文件树节点
 * @param targetPath - Path of the node whose ancestors are needed / 需要祖先链的节点路径
 * @returns Ancestor folder paths, empty if the target is a root / 祖先文件夹路径；目标为根时为空
 */
export function getAncestorFolderPaths(nodes: FileNode[], targetPath: string): string[] {
  for (const node of nodes) {
    if (node.path === targetPath) return [];
    if (!node.isDirectory) continue;
    const nested = getAncestorFolderPaths(node.children ?? [], targetPath);
    if (nested.length > 0 || containsPath(node.children ?? [], targetPath)) return [node.path, ...nested];
  }
  return [];
}

/**
 * Drops collapsed-folder entries that no longer exist in the tree.
 * 丢弃树中已不存在的折叠目录项。
 *
 * @param nodes - Current file tree nodes / 当前文件树节点
 * @param collapsedFolderPaths - Remembered collapsed folder paths / 记录的折叠目录路径
 * @returns Collapsed paths that are still valid / 仍然有效的折叠路径
 */
export function reconcileCollapsedFolderPaths(nodes: FileNode[], collapsedFolderPaths: Iterable<string>): string[] {
  const valid = new Set(collectDirectoryPaths(nodes));
  return [...new Set(collapsedFolderPaths)].filter((folderPath) => valid.has(folderPath));
}

/**
 * Collapses every folder in the tree.
 * 折叠树中的全部文件夹。
 *
 * @param nodes - File tree nodes / 文件树节点
 * @returns All directory paths to collapse / 全部待折叠的目录路径
 */
export function collapseAllFolders(nodes: FileNode[]): string[] {
  return collectDirectoryPaths(nodes);
}

/**
 * Collapses every folder except the ancestors of the current path.
 * 折叠除当前路径祖先外的全部文件夹。
 *
 * @param nodes - File tree nodes / 文件树节点
 * @param currentPath - Path to keep expanded, or null / 需保持展开的路径；可为 null
 * @returns Directory paths to collapse / 待折叠的目录路径
 */
export function collapseExceptCurrentPath(nodes: FileNode[], currentPath: string | null): string[] {
  const ancestors = new Set(currentPath ? getAncestorFolderPaths(nodes, currentPath) : []);
  return collectDirectoryPaths(nodes).filter((folderPath) => !ancestors.has(folderPath));
}

/**
 * Checks whether a path exists anywhere in the subtree.
 * 检查路径是否存在于子树任意位置。
 */
function containsPath(nodes: FileNode[], targetPath: string): boolean {
  return nodes.some((node) => node.path === targetPath || (node.isDirectory && containsPath(node.children ?? [], targetPath)));
}
