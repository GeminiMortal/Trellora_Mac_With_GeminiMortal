/**
 * Registers note libraries in the app settings store and tracks the active library.
 * 在应用设置存储中注册笔记库，并跟踪当前激活的资料库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getFileTypeInfo } from '../files/fileTypes.ts';

/**
 * A single registered note library entry.
 * 单条已注册笔记库记录。
 */
export interface LibraryRegistration {
  /** Absolute path identifying the library / 标识资料库的绝对路径 */
  path: string;
  /** Display name shown in the UI / 界面显示名称 */
  alias: string;
  /** ISO timestamp of first registration / 首次注册的 ISO 时间戳 */
  addedAt: string;
  /** ISO timestamp of the most recent activation / 最近一次激活的 ISO 时间戳 */
  lastOpenedAt: string;
}

/**
 * A registered library enriched with on-disk status and file counts for display.
 * 已注册资料库加上磁盘状态与文件计数，用于展示。
 */
export interface LibrarySummary extends LibraryRegistration {
  /** Whether the library directory is still readable / 资料库目录是否仍可读 */
  exists: boolean;
  /** Whether this is the currently active library / 是否为当前激活的资料库 */
  isActive: boolean;
  /** Number of recognized note files / 识别到的笔记文件数量 */
  noteCount: number;
  /** Number of attachment files / 附件文件数量 */
  attachmentCount: number;
}

interface LibraryRegistryStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

const librariesKey = 'libraries';
const activeLibraryKey = 'activeLibraryPath';
const legacyLibraryKey = 'libraryPath';
const ignoredDirectories = new Set(['.git', '.menghan-backups', '.menghan-meta', 'node_modules', '_attachments']);

/**
 * Lists registered libraries, migrating any legacy single-library setting into the list.
 * 列出已注册的资料库，并将旧版单资料库设置迁移进列表。
 *
 * @param store - Key-value settings store / 键值设置存储
 * @returns All registered libraries / 全部已注册资料库
 */
export function listRegisteredLibraries(store: LibraryRegistryStore): LibraryRegistration[] {
  const stored = normalizeRegistrations(store.get(librariesKey));
  const legacyPath = normalizePath(store.get(legacyLibraryKey));
  if (!legacyPath || stored.some((library) => library.path === legacyPath)) return stored;

  const now = new Date().toISOString();
  // One-time migration: the legacy single library becomes a normal registration.
  // 一次性迁移：旧版单资料库转为普通注册记录。
  const migrated = [
    ...stored,
    {
      path: legacyPath,
      alias: path.basename(legacyPath) || '未命名笔记库',
      addedAt: now,
      lastOpenedAt: now,
    },
  ];
  store.set(librariesKey, migrated);
  store.set(activeLibraryKey, legacyPath);
  return migrated;
}

/**
 * Registers a library (or refreshes its metadata) and marks it active.
 * 注册资料库（或刷新其元数据）并将其标记为激活状态。
 *
 * @param store - Key-value settings store / 键值设置存储
 * @param libraryPath - Absolute path of the library / 资料库绝对路径
 * @param now - Timestamp used for registration bookkeeping / 用于注册记账的时间戳
 * @param alias - Optional display name overriding the folder name / 可选显示名，覆盖文件夹名
 * @returns The normalized absolute library path / 规范化后的资料库绝对路径
 */
export function registerAndActivateLibrary(
  store: LibraryRegistryStore,
  libraryPath: string,
  now = new Date(),
  alias?: string,
): string {
  const normalizedPath = path.resolve(libraryPath);
  const registrations = listRegisteredLibraries(store);
  const current = registrations.find((library) => library.path === normalizedPath);
  const timestamp = now.toISOString();
  const normalizedAlias = alias?.trim() || undefined;
  const next = current
    ? registrations.map((library) => library.path === normalizedPath
      ? { ...library, lastOpenedAt: timestamp, ...(normalizedAlias ? { alias: normalizedAlias } : {}) }
      : library)
    : [
      ...registrations,
      {
        path: normalizedPath,
        alias: normalizedAlias ?? (path.basename(normalizedPath) || '未命名笔记库'),
        addedAt: timestamp,
        lastOpenedAt: timestamp,
      },
    ];

  store.set(librariesKey, next);
  store.set(activeLibraryKey, normalizedPath);
  store.set(legacyLibraryKey, normalizedPath);
  return normalizedPath;
}

/**
 * Marks an already-registered library as active, rejecting unknown paths.
 * 将已注册的资料库标记为激活状态，拒绝未注册路径。
 *
 * @param store - Key-value settings store / 键值设置存储
 * @param libraryPath - Absolute path of the library to activate / 要激活的资料库绝对路径
 * @param now - Timestamp used for registration bookkeeping / 用于注册记账的时间戳
 * @returns The normalized absolute library path / 规范化后的资料库绝对路径
 */
export function activateRegisteredLibrary(
  store: LibraryRegistryStore,
  libraryPath: string,
  now = new Date(),
): string {
  const normalizedPath = path.resolve(libraryPath);
  const registrations = listRegisteredLibraries(store);
  if (!registrations.some((library) => library.path === normalizedPath)) {
    throw new Error('该笔记库尚未注册，请先添加笔记库。');
  }
  return registerAndActivateLibrary(store, normalizedPath, now);
}

/**
 * Removes a library registration and clears active pointers that referenced it.
 * 删除资料库注册记录，并清除指向它的激活指针。
 *
 * @param store - Key-value settings store / 键值设置存储
 * @param libraryPath - Absolute path of the library to remove / 要移除的资料库绝对路径
 * @returns The remaining registrations / 剩余的注册记录
 */
export function removeRegisteredLibrary(store: LibraryRegistryStore, libraryPath: string): LibraryRegistration[] {
  const normalizedPath = path.resolve(libraryPath);
  const next = listRegisteredLibraries(store).filter((library) => library.path !== normalizedPath);
  store.set(librariesKey, next);
  // Both the current and legacy active pointers are cleared if they pointed at the removed library.
  // 若当前或旧版激活指针指向被移除的资料库，则一并清除。
  if (normalizePath(store.get(activeLibraryKey)) === normalizedPath || normalizePath(store.get(legacyLibraryKey)) === normalizedPath) {
    store.delete(activeLibraryKey);
    store.delete(legacyLibraryKey);
  }
  return next;
}

/**
 * Builds display summaries with existence, active flag, and file counts for every registered library.
 * 为每个已注册资料库生成包含存在性、激活标记和文件计数的展示摘要。
 *
 * @param store - Key-value settings store / 键值设置存储
 * @param activePath - Path of the active library, or null / 当前激活资料库的路径，可为 null
 * @returns One summary per registered library / 每个已注册资料库一条摘要
 */
export function summarizeRegisteredLibraries(
  store: LibraryRegistryStore,
  activePath: string | null,
): LibrarySummary[] {
  const normalizedActivePath = activePath ? path.resolve(activePath) : null;
  return listRegisteredLibraries(store).map((library) => {
    const exists = isReadableDirectory(library.path);
    const isActive = normalizedActivePath === library.path;
    const counts = exists ? countLibraryFiles(library.path) : { noteCount: 0, attachmentCount: 0 };
    return {
      ...library,
      exists,
      isActive,
      ...counts,
    };
  });
}

function normalizeRegistrations(value: unknown): LibraryRegistration[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const libraryPath = normalizePath(record.path);
    if (!libraryPath || seen.has(libraryPath)) return [];
    seen.add(libraryPath);
    const now = new Date().toISOString();
    return [{
      path: libraryPath,
      alias: typeof record.alias === 'string' && record.alias.trim() ? record.alias.trim() : path.basename(libraryPath) || '未命名笔记库',
      addedAt: typeof record.addedAt === 'string' && record.addedAt ? record.addedAt : now,
      lastOpenedAt: typeof record.lastOpenedAt === 'string' && record.lastOpenedAt ? record.lastOpenedAt : now,
    }];
  });
}

function normalizePath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? path.resolve(value) : null;
}

function isReadableDirectory(libraryPath: string): boolean {
  try {
    if (!fs.statSync(libraryPath).isDirectory()) return false;
    fs.accessSync(libraryPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function countLibraryFiles(libraryPath: string): { noteCount: number; attachmentCount: number } {
  let noteCount = 0;
  const attachmentCount = 0;
  const walk = (directoryPath: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(path.join(directoryPath, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (getFileTypeInfo(entry.name)) noteCount += 1;
    }
  };
  walk(libraryPath);
  return { noteCount, attachmentCount };
}
