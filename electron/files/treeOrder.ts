/**
 * Persistent manual ordering of note library tree entries, stored in the library's metadata directory.
 * 笔记库目录树条目的持久化手动排序，保存在笔记库元数据目录中。
 */
import fs from 'fs';
import path from 'path';
import { assertExistingDirectory, assertInsideDirectory } from './pathGuards.ts';

/**
 * Serialized tree-order document version 1.
 * 序列化的目录树排序文档（版本 1）。
 */
export interface TreeOrderState {
  /** Format version, currently always 1 / 格式版本，当前恒为 1 */
  version: 1;
  /** Ordered child names per directory key / 每个目录键对应的有序子项名称 */
  directories: Record<string, string[]>;
}

/**
 * Minimal shape of a tree entry that can be sorted.
 * 可参与排序的目录树条目的最小结构。
 */
export interface OrderedTreeEntry {
  /** Entry file name / 条目文件名 */
  name: string;
  /** Whether the entry is a directory / 该条目是否为目录 */
  isDirectory: boolean;
}

const metaDirectoryName = '.menghan-meta';
const treeOrderFileName = 'tree-order.json';

/**
 * Get the library's metadata directory path, guarded to stay inside the library.
 * 获取笔记库元数据目录路径，并校验其不越出笔记库。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @returns Absolute path of the metadata directory / 元数据目录的绝对路径
 */
export function getLibraryMetaDirectory(libraryPath: string): string {
  return assertInsideDirectory(path.join(path.resolve(libraryPath), metaDirectoryName), libraryPath);
}

/**
 * Get the path of the tree-order file for a library.
 * 获取笔记库的目录树排序文件路径。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @returns Absolute path of tree-order.json / tree-order.json 的绝对路径
 */
export function getTreeOrderPath(libraryPath: string): string {
  return path.join(getLibraryMetaDirectory(libraryPath), treeOrderFileName);
}

/**
 * Load the saved tree order, falling back to an empty order on any problem.
 * 读取已保存的目录树排序；任何异常时回退为空排序。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @returns Validated tree-order state / 校验后的目录树排序状态
 */
export function loadTreeOrder(libraryPath: string): TreeOrderState {
  const orderPath = getTreeOrderPath(libraryPath);
  if (!fs.existsSync(orderPath)) return createEmptyTreeOrder();

  try {
    // Unknown or corrupted files degrade to the default order instead of breaking the tree.
    // 未知或损坏的文件降级为默认排序，避免目录树不可用。
    const parsed = JSON.parse(fs.readFileSync(orderPath, 'utf8')) as Partial<TreeOrderState>;
    if (parsed.version !== 1 || !parsed.directories || typeof parsed.directories !== 'object') {
      return createEmptyTreeOrder();
    }

    return {
      version: 1,
      directories: Object.fromEntries(
        Object.entries(parsed.directories)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, value.filter((item): item is string => typeof item === 'string')]),
      ),
    };
  } catch {
    return createEmptyTreeOrder();
  }
}

/**
 * Write the tree-order document to the library metadata directory.
 * 将目录树排序文档写入笔记库元数据目录。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @param order - Tree-order state to persist / 要持久化的目录树排序状态
 * @returns Nothing / 无返回值
 */
export function writeTreeOrder(libraryPath: string, order: TreeOrderState): void {
  const metaDirectory = getLibraryMetaDirectory(libraryPath);
  fs.mkdirSync(metaDirectory, { recursive: true });
  fs.writeFileSync(getTreeOrderPath(libraryPath), `${JSON.stringify(order, null, 2)}\n`, 'utf8');
}

/**
 * Save an explicit ordering of the children of one directory.
 * 保存某个目录子项的显式排序。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @param parentDirectoryPath - Directory whose children are being ordered / 被排序子项所在的目录
 * @param orderedChildPaths - Full child paths in the desired order / 按期望顺序排列的子项完整路径
 * @returns True when saved / 保存成功时为 true
 */
export function saveDirectoryOrder(libraryPath: string, parentDirectoryPath: string, orderedChildPaths: string[]): boolean {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = assertInsideDirectory(parentDirectoryPath, library);
  assertExistingDirectory(parentDirectory);

  const orderedNames = orderedChildPaths.map((childPath) => {
    const resolvedChildPath = assertInsideDirectory(childPath, library);
    if (path.dirname(resolvedChildPath) !== parentDirectory) {
      throw new Error('所有排序项目都必须位于目标文件夹内。');
    }
    return path.basename(resolvedChildPath);
  });

  const order = loadTreeOrder(library);
  order.directories[getDirectoryOrderKey(library, parentDirectory)] = orderedNames;
  writeTreeOrder(library, order);
  return true;
}

/**
 * Sort tree entries by the saved order, falling back to directories-first name ordering.
 * 按已保存的顺序排序目录树条目；无自定义顺序时按“目录优先 + 名称”排序。
 *
 * @param entries - Entries to sort / 要排序的条目
 * @param libraryPath - Library root path / 笔记库根路径
 * @param parentDirectoryPath - Parent directory of the entries / 条目所在的父目录
 * @param order - Saved tree-order state / 已保存的目录树排序状态
 * @returns A new sorted array / 新的已排序数组
 */
export function sortEntriesByTreeOrder<T extends OrderedTreeEntry>(
  entries: T[],
  libraryPath: string,
  parentDirectoryPath: string,
  order: TreeOrderState,
): T[] {
  const orderKey = getDirectoryOrderKey(libraryPath, parentDirectoryPath);
  const orderedNames = order.directories[orderKey] ?? [];
  const positions = new Map(orderedNames.map((name, index) => [name, index]));

  return [...entries].sort((a, b) => {
    const aPosition = positions.get(a.name);
    const bPosition = positions.get(b.name);

    // Entries without a saved position sink below manually ordered ones.
    // 没有保存位置的条目排在手动排序条目之后。
    if (aPosition !== undefined || bPosition !== undefined) {
      if (aPosition === undefined) return 1;
      if (bPosition === undefined) return -1;
      return aPosition - bPosition;
    }

    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

/**
 * Remove a deleted entry's name from every saved directory order.
 * 从所有已保存的目录顺序中移除已删除条目的名称。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @param entryPath - Path of the entry being removed / 被移除条目的路径
 * @returns Nothing / 无返回值
 */
export function removeEntryFromSavedOrders(libraryPath: string, entryPath: string): void {
  const library = assertExistingDirectory(libraryPath);
  const entryName = path.basename(entryPath);
  const order = loadTreeOrder(library);
  let changed = false;

  for (const [directoryKey, names] of Object.entries(order.directories)) {
    const nextNames = names.filter((name) => name !== entryName);
    if (nextNames.length !== names.length) {
      order.directories[directoryKey] = nextNames;
      changed = true;
    }
  }

  if (changed) writeTreeOrder(library, order);
}

/**
 * Append an entry to the end of its directory's saved order.
 * 将条目追加到其目录已保存顺序的末尾。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @param parentDirectoryPath - Parent directory of the entry / 条目所在的父目录
 * @param entryPath - Path of the entry being appended / 被追加条目的路径
 * @returns Nothing / 无返回值
 */
export function appendEntryToDirectoryOrder(libraryPath: string, parentDirectoryPath: string, entryPath: string): void {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = assertInsideDirectory(parentDirectoryPath, library);
  const entryName = path.basename(entryPath);
  const order = loadTreeOrder(library);
  const orderKey = getDirectoryOrderKey(library, parentDirectory);
  const existing = order.directories[orderKey] ?? [];
  order.directories[orderKey] = [...existing.filter((name) => name !== entryName), entryName];
  writeTreeOrder(library, order);
}

/**
 * Insert an entry immediately before or after a sibling in the saved order.
 * 将条目插入到已保存顺序中兄弟条目的紧邻位置（前或后）。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @param parentDirectoryPath - Parent directory of both entries / 两个条目共同的父目录
 * @param entryPath - Path of the entry being placed / 被放置条目的路径
 * @param siblingPath - Reference sibling path / 参照的兄弟条目路径
 * @param placement - Place before or after the sibling / 放在兄弟条目之前还是之后
 * @returns Nothing / 无返回值
 */
export function placeEntryInDirectoryOrder(
  libraryPath: string,
  parentDirectoryPath: string,
  entryPath: string,
  siblingPath: string,
  placement: 'before' | 'after',
): void {
  const library = assertExistingDirectory(libraryPath);
  const parentDirectory = assertInsideDirectory(parentDirectoryPath, library);
  assertExistingDirectory(parentDirectory);
  const resolvedEntry = assertInsideDirectory(entryPath, library);
  const resolvedSibling = assertInsideDirectory(siblingPath, library);
  if (path.dirname(resolvedEntry) !== parentDirectory || path.dirname(resolvedSibling) !== parentDirectory) {
    throw new Error('排序项目必须位于同一个文件夹内。');
  }

  const order = loadTreeOrder(library);
  const entries = fs.readdirSync(parentDirectory, { withFileTypes: true })
    .filter((entry) => entry.name !== metaDirectoryName)
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  const orderedPaths = sortEntriesByTreeOrder(entries, library, parentDirectory, order)
    .map((entry) => path.join(parentDirectory, entry.name))
    .filter((childPath) => childPath !== resolvedEntry);
  const siblingIndex = orderedPaths.indexOf(resolvedSibling);
  if (siblingIndex === -1) throw new Error('相邻项目不存在。');
  orderedPaths.splice(placement === 'after' ? siblingIndex + 1 : siblingIndex, 0, resolvedEntry);
  saveDirectoryOrder(library, parentDirectory, orderedPaths);
}

/**
 * Build the stable map key for a directory: its slash-separated path relative to the library root.
 * 构建目录的稳定映射键：相对笔记库根目录、以斜杠分隔的路径。
 *
 * @param libraryPath - Library root path / 笔记库根路径
 * @param directoryPath - Directory inside the library / 笔记库内的目录
 * @returns Normalized relative key ('' for the root) / 规范化的相对键（根目录为 ''）
 */
export function getDirectoryOrderKey(libraryPath: string, directoryPath: string): string {
  const relativePath = path.relative(path.resolve(libraryPath), path.resolve(directoryPath)).replace(/\\/g, '/');
  return relativePath === '' ? '' : relativePath;
}

/**
 * Create a fresh empty tree-order document.
 * 创建一份全新的空目录树排序文档。
 *
 * @returns Empty tree-order state / 空的目录树排序状态
 */
function createEmptyTreeOrder(): TreeOrderState {
  return {
    version: 1,
    directories: {},
  };
}
