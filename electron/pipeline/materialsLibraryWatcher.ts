import fs from 'node:fs';
import path from 'node:path';
import { syncMaterialsManifest, type MaterialsDocument } from '../materialsLibrary';

export interface MaterialsLibraryWatcherOptions {
  onFilesChanged: (libraryPath: string, documents: MaterialsDocument[]) => void;
  onLog?: (message: string) => void;
  debounceMs?: number;
}

interface WatchedLibrary {
  watcher: fs.FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_DEBOUNCE_MS = 3_000;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.docx', '.html', '.htm']);

export class MaterialsLibraryWatcher {
  private readonly watched = new Map<string, WatchedLibrary>();
  private readonly debounceMs: number;
  private readonly onFilesChanged: (libraryPath: string, documents: MaterialsDocument[]) => void;
  private readonly onLog: (message: string) => void;

  constructor(options: MaterialsLibraryWatcherOptions) {
    this.debounceMs = Math.max(1_000, Math.min(30_000, options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
    this.onFilesChanged = options.onFilesChanged;
    this.onLog = options.onLog ?? (() => {});
  }

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

  unwatch(libraryPath: string): void {
    const resolved = path.resolve(libraryPath);
    const entry = this.watched.get(resolved);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
    this.watched.delete(resolved);
    this.onLog(`[WATCHER] 停止监听资料库：${resolved}`);
  }

  dispose(): void {
    for (const resolved of [...this.watched.keys()]) this.unwatch(resolved);
  }

  get watchedPaths(): string[] {
    return [...this.watched.keys()];
  }
}