/**
 * Display-name helpers for sidebar tree nodes.
 * 侧边栏树节点显示名称的辅助函数。
 */

/**
 * Minimal node shape needed to pick a display name.
 * 用于确定显示名称的最小节点结构。
 */
interface SidebarDisplayNode {
    name: string;
    isDirectory: boolean;
}

/**
 * Returns the sidebar label for a node, stripping extensions for files.
 * 返回节点的侧边栏标签，文件会去掉扩展名。
 *
 * @param node - Tree node to label / 要标注的树节点
 * @returns Display name / 显示名称
 */
export function getSidebarDisplayName(node: SidebarDisplayNode): string {
    if (node.isDirectory) return node.name;
    return getEditableEntryName(node.name);
}

/**
 * Strips the extension only from the last dot.
 * 只去掉最后一个点后的扩展名。
 *
 * @param fileName - File name to trim / 要处理的文件名
 * @returns Name without its extension / 去掉扩展名后的名称
 */
export function getEditableEntryName(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
}
