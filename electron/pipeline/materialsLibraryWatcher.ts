/**
 * Watches library "documents" folders and resyncs the materials manifest on change.
 * 监听资料库 documents 目录，文件变化时重新同步资料清单。
 */
import fs from 'node:fs';
import path from 'node:path';
import { syncMaterialsManifest, type MaterialsDocument } from '../library/materialsLibrary.ts';

/**
 * Options for constructing a MaterialsLibraryWatcher.
 * 构造 MaterialsLibraryWatcher 的选项。
 */
export interface MaterialsLibraryWatcherOptions {
  /** Invoked with the library path and refreshed documents after a debounced change. / 防抖变化触发后回调资料库路径与刷新后的文档列表。 */
  onFilesChanged: (libraryPath: string, documents: MaterialsDocument[]) => void;
  /** Optional sink for watcher diagnostics. / 可选的监听诊断日志出口。 */
  onLog?: (message: string) => void;
  /** Debounce window in milliseconds before resyncing (clamped to 1–30s). / 变化后重新同步前的防抖窗口（毫秒，限制在 1–30 秒）。 */
  debounceMs?: number;
}

interface WatchedLibrary {
  watcher: fs.FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_DEBOUNCE_MS = 3_000;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.docx', '.html', '.htm']);

/**
 * Filesystem watcher that keeps a library's materials manifest in sync.
 * 保持资料库资料清单与文件系统同步的监听器。
 */
export class MaterialsLibraryWatcher {
  private readonly watched = new Map<string, WatchedLibrary>();
  private readonly debounceMs: number;
  private readonly onFilesChanged: (libraryPath: string, documents: MaterialsDocument[]) => void;
  private readonly onLog: (message: string) => void;

  /**
   * Creates a watcher with debounced change delivery.
   * 创建带防抖投递变更回调的监听器。
   *
   * @param options - Watcher callbacks and debounce settings / 监听回调与防抖配置
   */
  constructor(options: MaterialsLibraryWatcherOptions) {
    this.debounceMs = Math.max(1_000, Math.min(30_000, options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
    this.onFilesChanged = options.onFilesChanged;
    this.onLog = options.onLog ?? (() => {});
  }

  /**
   * Starts watching a library's documents directory (idempotent per resolved path).
   * 开始监听资料库的 documents 目录（按解析后路径幂等）。
   *
   * @param libraryPath - Absolute path of the library root / 资料库根目录绝对路径
   */
  watch(libraryPath: string): void {
    const resolved = path.resolve(libraryPath);
    if (this.watched.has(resolved)) return;
    const documentsDir = path.join(resolved, 'documents');
    try {
      if (!fs.existsSync(documentsDir)) {
        fs.mkdirSync(documentsDir, { recursive: true });
      }
    } catch {
      this.onLog(`[WATCHER] 创建资料库文档目录失败：${documentsDir}`);
      return;
    }
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // Debounce bursty filesystem events into a single manifest resync.
    // 将密集的文件系统事件防抖合并为一次清单重同步。
    const trigger = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        try {
          const documents = syncMaterialsManifest(resolved);
          this.onFilesChanged(resolved, documents);
        } catch (error) {
          this.onLog(`[WATCHER] 同步资料库清单失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }, this.debounceMs);
    };
    try {
      const watcher = fs.watch(documentsDir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        if (!DOCUMENT_EXTENSIONS.has(ext)) return;
        trigger();
      });
      watcher.on('error', (error) => {
        this.onLog(`[WATCHER] 资料库文件监听错误：${error instanceof Error ? error.message : String(error)}`);
      });
      this.watched.set(resolved, { watcher, debounceTimer });
      this.onLog(`[WATCHER] 开始监听资料库：${resolved}`);
    } catch (error) {
      this.onLog(`[WATCHER] 启动资料库监听失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stops watching a library and clears its pending debounce timer.
   * 停止监听某资料库并清除其待触发的防抖定时器。
   *
   * @param libraryPath - Absolute path of the library root / 资料库根目录绝对路径
   */
  unwatch(libraryPath: string): void {
    const resolved = path.resolve(libraryPath);
    const entry = this.watched.get(resolved);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
    this.watched.delete(resolved);
    this.onLog(`[WATCHER] 停止监听资料库：${resolved}`);
  }

  /**
   * Stops all watchers; safe to call multiple times.
   * 停止全部监听；可重复调用。
   */
  dispose(): void {
    for (const resolved of [...this.watched.keys()]) this.unwatch(resolved);
  }

  /**
   * Resolved library paths currently being watched.
   * 当前正在监听的已解析资料库路径列表。
   */
  get watchedPaths(): string[] {
    return [...this.watched.keys()];
  }
}
