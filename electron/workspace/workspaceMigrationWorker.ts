/**
 * Worker thread that maps staged workspace-migration copies: remaps databases and metadata for the new location.
 * 工作区迁移的映射工作线程：为新位置重写暂存副本中的数据库与元数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import { MemoryScopeResolver } from '../knowledge/memory/memoryScope.ts';
import { QA_MEMORY_SCHEMA_VERSION } from '../knowledge/qa/qaMemoryDatabase.ts';
import { assertRestoredDatabase, migrateMetadataFile, migratePhysicalDatabase, type PhysicalRestoreContext } from '../backup/physicalRestore.ts';
import { loadSqliteVec } from '../loadSqliteVec.ts';
import type { MemoryScope } from '../knowledge/memory/memoryTypes.ts';

/** Worker input payload provided by the main process / 主进程提供的工作线程输入 */
interface Input {
  /** Staged copy root directory / 暂存副本根目录 */
  directory: string;
  /** Files to process, with their relative paths and database flag / 要处理的文件及其相对路径与数据库标记 */
  files: Array<{ relativePath: string; database: boolean }>;
  /** Memory scope of the source workspace / 源工作区的记忆范围 */
  sourceScope: MemoryScope;
  /** Absolute path of the new workspace location / 新工作区的绝对路径 */
  targetPath: string;
  /** Principal identifier of the target scope / 目标范围的主体标识 */
  principalId: string;
  /** Root path mappings for physical restore / 物理恢复的根路径映射 */
  roots: PhysicalRestoreContext['roots'];
  /** Library path mappings for physical restore / 物理恢复的资料库映射 */
  libraries: PhysicalRestoreContext['libraries'];
}

/**
 * Only the main process creates this worker. It maps staged copies and owns no userData, UI or live database handles.
 * 仅主进程创建此工作线程。它只处理暂存副本，不持有 userData、UI 或活动数据库句柄。
 *
 * @param input - Staged copy location and file manifest / 暂存副本位置与文件清单
 * @returns Resolves when all files are mapped and synced / 全部文件映射并同步完成后 resolve
 */
async function run(input: Input): Promise<void> {
  const target = new MemoryScopeResolver({ getActiveWorkspacePath: () => input.targetPath, listRegisteredWorkspacePaths: () => [input.targetPath], getPrincipalId: () => input.principalId }).resolveActive();
  const context: PhysicalRestoreContext = { sourceScope: input.sourceScope, target, roots: input.roots, libraries: input.libraries, warnings: new Set() };
  const signal = new AbortController().signal;
  for (const [index, file] of input.files.entries()) {
    const destination = assertInsideDirectory(path.join(input.directory, ...file.relativePath.split('/')), input.directory);
    parentPort?.postMessage({ completed: index, currentFile: file.relativePath });
    if (file.database) {
      const database = new Database(destination);
      try {
        // Version guards reject databases written by a newer app instead of corrupting them.
        // 版本守卫拒绝由更新版本应用写入的数据库，避免造成损坏。
        const version = Number(database.pragma('user_version', { simple: true }));
        if ((file.relativePath.endsWith('/qa-memory.db') && version > QA_MEMORY_SCHEMA_VERSION) || (file.relativePath.endsWith('/assistant-memory.db') && version > 7) || (file.relativePath.endsWith('/conversation-memory.db') && version > 1)) throw new Error('数据库来自较新版本，请升级应用后再迁移。');
        if (file.relativePath.endsWith('/index.db')) {
          const metadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_meta'").get();
          const schema = metadata ? database.prepare("SELECT value FROM system_meta WHERE key='schema_version'").get() as { value?: string } | undefined : undefined;
          if (Number(schema?.value ?? 0) > 6) throw new Error('数据库来自较新版本，请升级应用后再迁移。');
          loadSqliteVec(database);
        }
        migratePhysicalDatabase(database, context); assertRestoredDatabase(database); database.pragma('wal_checkpoint(TRUNCATE)');
      } finally { database.close(); }
    } else if (/(?:^|\/)\.menghan-meta\//u.test(file.relativePath) && /\.jsonl?$/u.test(file.relativePath)) {
      // A terminated worker can leave the helper's unfinished JSONL output; source name collisions are rejected before copying.
      // 被终止的工作线程可能残留未完成的 JSONL 输出；复制前已拒绝源文件名冲突。
      if (file.relativePath.endsWith('.jsonl')) await fs.promises.rm(`${destination}.restore-partial`, { force: true });
      await migrateMetadataFile(destination, context, signal);
    } else continue;
    // fsync each processed file so a crash cannot leave mapped content unsaved.
    // 对每个处理过的文件执行 fsync，防止崩溃后映射结果未落盘。
    const handle = await fs.promises.open(destination, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  }
  parentPort?.postMessage({ completed: input.files.length });
}

void run(workerData as Input).catch(error => { parentPort?.postMessage({ error: error instanceof Error ? error.message : '迁移处理线程失败。' }); process.exitCode = 1; });
