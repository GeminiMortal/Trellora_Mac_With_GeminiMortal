/**
 * Persists per-library UI state (collapsed folders and pinned entries) under `.menghan-meta/ui-state.json`.
 * 将每个资料库的界面状态（折叠文件夹与置顶项）持久化到 `.menghan-meta/ui-state.json`。
 */
import fs from 'fs';
import path from 'path';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import { isSupportedTextFile } from '../files/fileTypes.ts';

/**
 * UI preferences remembered for a single note library.
 * 单个笔记库记住的界面偏好。
 */
export interface LibraryUiState {
  /** State format version; rejects unknown layouts on read / 状态格式版本；读取时拒绝未知布局 */
  schemaVersion: 1;
  /** Absolute paths of folders collapsed in the sidebar / 侧边栏中处于折叠状态的文件夹绝对路径 */
  collapsedFolderPaths: string[];
  /** Absolute paths of entries pinned by the user / 用户置顶的条目绝对路径 */
  pinnedEntryPaths: string[];
}

/**
 * Partial update for LibraryUiState, ignoring the schema version.
 * LibraryUiState 的部分更新，忽略 schema 版本字段。
 */
export type LibraryUiStatePatch = Partial<Omit<LibraryUiState, 'schemaVersion'>>;

const schemaVersion = 1 as const;
const metadataDirectoryName = '.menghan-meta';
const stateFileName = 'ui-state.json';

/**
 * Loads the stored UI state, sanitizing it against the current library contents.
 * 加载已存储的界面状态，并按当前资料库内容进行清洗。
 *
 * @param libraryPath - Absolute path of the note library / 笔记库的绝对路径
 * @returns The sanitized UI state / 清洗后的界面状态
 */
export function getLibraryUiState(libraryPath: string): LibraryUiState {
  const library = resolveLibrary(libraryPath);
  const stored = readStoredState(library);
  // With no stored state every folder starts collapsed; stale stored paths are dropped and persisted back.
  // 无存储状态时所有文件夹默认折叠；过期的存储路径会被丢弃并回写。
  const collapsedFolderPaths = stored
    ? sanitizeFolderPaths(library, stored.collapsedFolderPaths)
    : collectLibraryFolderPaths(library);
  const state: LibraryUiState = {
    schemaVersion,
    collapsedFolderPaths,
    pinnedEntryPaths: sanitizePinnedPaths(library, stored?.pinnedEntryPaths ?? []),
  };

  if (stored && (!arraysEqual(stored.collapsedFolderPaths, collapsedFolderPaths) || !arraysEqual(stored.pinnedEntryPaths, state.pinnedEntryPaths))) {
    writeLibraryUiState(library, state);
  }
  return state;
}

/**
 * Merges a partial UI-state patch into the stored state and persists the result.
 * 将界面状态补丁合并进已存储状态并持久化结果。
 *
 * @param libraryPath - Absolute path of the note library / 笔记库的绝对路径
 * @param patch - Fields to update; omitted fields keep their current values / 要更新的字段；未给出的字段保持当前值
 * @returns The merged and persisted UI state / 合并后并已持久化的界面状态
 */
export function saveLibraryUiState(libraryPath: string, patch: LibraryUiStatePatch): LibraryUiState {
  const library = resolveLibrary(libraryPath);
  const current = getLibraryUiState(library);
  const next: LibraryUiState = {
    ...current,
    schemaVersion,
    collapsedFolderPaths: patch.collapsedFolderPaths === undefined
      ? current.collapsedFolderPaths
      : sanitizeFolderPaths(library, patch.collapsedFolderPaths, true),
    pinnedEntryPaths: patch.pinnedEntryPaths === undefined
      ? current.pinnedEntryPaths
      : sanitizePinnedPaths(library, patch.pinnedEntryPaths, true),
  };
  writeLibraryUiState(library, next);
  return next;
}

/**
 * Rewrites stored paths after an entry is moved, keeping collapsed/pinned state attached to it.
 * 条目移动后重写已存储路径，使折叠/置顶状态跟随该条目。
 *
 * @param libraryPath - Absolute path of the note library / 笔记库的绝对路径
 * @param oldPath - Previous absolute path of the moved entry / 被移动条目的原绝对路径
 * @param newPath - New absolute path of the moved entry / 被移动条目的新绝对路径
 */
export function migrateLibraryUiStatePath(libraryPath: string, oldPath: string, newPath: string): void {
  const library = resolveLibrary(libraryPath);
  const resolvedOldPath = assertInsideDirectory(oldPath, library);
  const resolvedNewPath = assertInsideDirectory(newPath, library);
  const stored = readStoredState(library);
  if (!stored) return;
  // Only the moved path and its descendants are remapped; everything else stays put.
  // 仅重映射被移动路径及其子路径；其余路径保持不变。
  const migratePath = (folderPath: string) => {
    const relative = path.relative(resolvedOldPath, folderPath);
    const isSameOrDescendant = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    return isSameOrDescendant ? path.join(resolvedNewPath, relative) : folderPath;
  };
  writeLibraryUiState(library, {
    ...stored,
    schemaVersion,
    collapsedFolderPaths: sanitizeFolderPaths(library, stored.collapsedFolderPaths.map(migratePath)),
    pinnedEntryPaths: sanitizePinnedPaths(library, stored.pinnedEntryPaths.map(migratePath)),
  });
}

/**
 * Drops stale collapsed/pinned entries by re-saving only the still-valid collapsed folders.
 * 仅重新保存仍然有效的折叠文件夹，从而丢弃过期的折叠/置顶项。
 *
 * @param libraryPath - Absolute path of the note library / 笔记库的绝对路径
 * @returns The pruned UI state / 修剪后的界面状态
 */
export function pruneLibraryUiState(libraryPath: string): LibraryUiState {
  const library = resolveLibrary(libraryPath);
  const state = getLibraryUiState(library);
  return saveLibraryUiState(library, { collapsedFolderPaths: state.collapsedFolderPaths });
}

function resolveLibrary(libraryPath: string): string {
  const resolved = path.resolve(libraryPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('笔记库不存在。');
  }
  return resolved;
}

function readStoredState(libraryPath: string): LibraryUiState | null {
  const statePath = getStatePath(libraryPath);
  if (!fs.existsSync(statePath)) return null;
  try {
    const candidate = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<LibraryUiState>;
    if (candidate.schemaVersion !== schemaVersion || !Array.isArray(candidate.collapsedFolderPaths)) return null;
    return {
      schemaVersion,
      collapsedFolderPaths: candidate.collapsedFolderPaths.filter((entry): entry is string => typeof entry === 'string'),
      pinnedEntryPaths: Array.isArray(candidate.pinnedEntryPaths)
        ? candidate.pinnedEntryPaths.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function writeLibraryUiState(libraryPath: string, state: LibraryUiState): void {
  const metadataDirectory = path.join(libraryPath, metadataDirectoryName);
  fs.mkdirSync(metadataDirectory, { recursive: true });
  const statePath = getStatePath(libraryPath);
  const temporaryPath = `${statePath}.tmp`;
  // Write via a temp file and rename so readers never observe a half-written state file.
  // 通过临时文件写入后重命名，避免读取到写了一半的状态文件。
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, statePath);
}

function sanitizeFolderPaths(libraryPath: string, folderPaths: string[], strict = false): string[] {
  const metadataDirectory = path.join(libraryPath, metadataDirectoryName);
  const valid = new Set<string>();
  for (const candidate of folderPaths) {
    if (typeof candidate !== 'string') continue;
    let resolved: string;
    try {
      resolved = assertInsideDirectory(candidate, libraryPath, '界面状态路径必须位于当前笔记库内。');
    } catch {
      if (strict) throw new Error('界面状态路径必须位于当前笔记库内。');
      continue;
    }
    if (resolved === libraryPath || resolved === metadataDirectory) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    valid.add(resolved);
  }
  return [...valid].sort((left, right) => left.localeCompare(right));
}

/**
 * 只保留笔记库内仍存在的可见笔记或文件夹，兼容旧界面状态。
 * Keeps only visible notes or folders that still exist inside the library, staying compatible with legacy UI state.
 */
function sanitizePinnedPaths(libraryPath: string, entryPaths: string[], strict = false): string[] {
  if (!Array.isArray(entryPaths)) throw new Error('置顶列表格式无效。');
  const valid = new Set<string>();
  for (const candidate of entryPaths) {
    if (typeof candidate !== 'string') continue;
    let resolved: string;
    try {
      resolved = assertInsideDirectory(candidate, libraryPath, '置顶项目必须位于当前笔记库内。');
    } catch {
      if (strict) throw new Error('置顶项目必须位于当前笔记库内。');
      continue;
    }
    const relative = path.relative(libraryPath, resolved);
    // Metadata, backups, and VCS/dependency directories are never pinnable.
    // 元数据、备份以及版本控制/依赖目录永远不可置顶。
    if (!relative || relative.split(path.sep).some((part) => ['.menghan-meta', '.menghan-backups', '.git', 'node_modules'].includes(part))) continue;
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory() || (stat.isFile() && isSupportedTextFile(resolved))) valid.add(resolved);
  }
  return [...valid];
}

function collectLibraryFolderPaths(libraryPath: string): string[] {
  const result: string[] = [];
  const visit = (directoryPath: string) => {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === metadataDirectoryName || entry.name === '.menghan-backups' || entry.name === '.git' || entry.name === 'node_modules') continue;
      const childPath = path.join(directoryPath, entry.name);
      result.push(childPath);
      visit(childPath);
    }
  };
  visit(libraryPath);
  return result.sort((left, right) => left.localeCompare(right));
}

function getStatePath(libraryPath: string): string {
  return path.join(libraryPath, metadataDirectoryName, stateFileName);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
