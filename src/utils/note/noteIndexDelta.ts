/**
 * Incremental application of note-index changes onto the renderer file tree.
 * 将笔记索引变更增量应用到渲染进程文件树。
 */
import type { FileNode } from '../../electron';
import type { NoteIndexChanged } from '../../../shared/noteSave.ts';

/**
 * Copy only tree branches touched by a delta; retain the rest of the renderer tree.
 * 仅复制增量触及的树分支，保留渲染树的其余部分。
 *
 * @param files - Current renderer file tree / 当前渲染进程文件树
 * @param delta - Index change set from the main process / 来自主进程的索引变更集
 * @returns A new tree with the delta applied / 应用增量后的新树
 */
export function applyNoteIndexDelta(files: FileNode[], delta: NoteIndexChanged): FileNode[] {
  // Normalize separators, trailing slash, and case for stable cross-platform path matching. / 统一分隔符、尾斜杠与大小写，保证跨平台路径匹配稳定。
  const key = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  let next = files;
  const remove = (nodes: FileNode[], target: string): FileNode[] => nodes.filter((node) => key(node.path) !== key(target))
    .map((node) => node.children ? { ...node, children: remove(node.children, target) } : node);
  for (const change of delta.changes) if (change.kind === 'unlink' || change.kind === 'unlinkDir') next = remove(next, change.path);
  for (const addition of delta.nodes) {
    const node: FileNode = { ...addition, kind: addition.kind as FileNode['kind'], ...(addition.isDirectory ? { children: [] } : {}) };
    const parent = key(addition.path).split('/').slice(0, -1).join('/');
    const insert = (nodes: FileNode[], directory: string): FileNode[] => {
      if (key(directory) === parent) {
        const exists = nodes.some((entry) => key(entry.path) === key(node.path));
        // Merge into an existing entry to keep its already-loaded children. / 与已有条目合并，保留其已加载的子节点。
        return exists ? nodes.map((entry) => key(entry.path) === key(node.path) ? { ...entry, ...node, ...(entry.children ? { children: entry.children } : {}) } : entry)
          // Directories first, then zh-Hans-CN name collation. / 目录优先，其后按 zh-Hans-CN 名称排序。
          : [...nodes, node].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
      }
      return nodes.map((entry) => entry.children ? { ...entry, children: insert(entry.children, entry.path) } : entry);
    };
    next = insert(next, delta.libraryPath);
  }
  for (const [directory, paths] of Object.entries(delta.orders ?? {})) {
    const positions = new Map(paths.map((value, index) => [key(value), index]));
    const reorder = (nodes: FileNode[], parent: string): FileNode[] => key(parent) === key(directory)
      // Entries missing from the order list keep their relative order after known ones. / 不在顺序表中的条目排在已知项之后并保持相对顺序。
      ? [...nodes].sort((a, b) => (positions.get(key(a.path)) ?? Infinity) - (positions.get(key(b.path)) ?? Infinity))
      : nodes.map((entry) => entry.children ? { ...entry, children: reorder(entry.children, entry.path) } : entry);
    next = reorder(next, delta.libraryPath);
  }
  return next;
}
