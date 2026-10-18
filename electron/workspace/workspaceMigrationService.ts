/**
 * Workspace migration service: journals, copies, verifies and atomically switches a workspace to a new directory.
 * 工作区迁移服务：以日志记录、复制、校验并原子切换工作区到新目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { WorkspaceMigrationLibrary, WorkspaceMigrationPreview, WorkspaceMigrationState, WorkspaceMigrationStatus } from '../../shared/workspaceMigration.ts';
import type { MemoryScope, TrustedMemoryScopeContext } from '../knowledge/memory/memoryTypes.ts';
import { assertInsideDirectory, resolveRealAncestors } from '../files/pathGuards.ts';
import { isApplicationDatabase, hashFile } from '../backup/snapshot.ts';
import { assertRestoredDatabase, type PhysicalRestoreContext } from '../backup/physicalRestore.ts';
import { validArchivePath } from '../backup/archive.ts';
import { loadSqliteVec } from '../loadSqliteVec.ts';
import { renameWithWindowsRetryAsync } from '../files/fileSystemRename.ts';

/** One inventoried source file / 清单中的一个源文件 */
interface SourceFile {
  /** Slash-separated path relative to the workspace root / 相对工作区根目录、以斜杠分隔的路径 */
  relativePath: string;
  /** Size including WAL where relevant / 含相关 WAL 的大小 */
  size: number;
  /** Stamp used to detect source changes / 用于检测源文件变化的戳记 */
  stamp: string;
  /** Whether the file is an application database / 是否为应用数据库 */
  database: boolean;
}

/** Complete inventory of a source workspace / 源工作区的完整清单 */
interface Inventory {
  /** Sorted file list / 已排序的文件列表 */
  files: SourceFile[];
  /** Sorted directory list / 已排序的目录列表 */
  directories: string[];
}

/** Per-file durable copy receipt / 每个文件的持久化复制回执 */
interface Receipt {
  /** Slash-separated relative path / 以斜杠分隔的相对路径 */
  relativePath: string;
  /** Source stamp at copy time / 复制时的源文件戳记 */
  stamp: string;
  /** Copied file size / 已复制文件大小 */
  size: number;
  /** SHA-256 of the copied file / 已复制文件的 SHA-256 */
  sha256: string;
}

/** Migration lifecycle phase names / 迁移生命周期阶段名 */
type JournalPhase = 'preview' | 'preparing' | 'copying' | 'mapping' | 'validated' | 'published' | 'committed' | 'completed' | 'abandoned';

/** Durable journal that makes a migration resumable across restarts / 使迁移可跨重启续跑的持久化日志 */
interface Journal {
  /** Journal format version / 日志格式版本 */
  version: 1;
  /** Operation identifier (UUID) / 操作标识（UUID） */
  id: string;
  /** Absolute source workspace path / 源工作区绝对路径 */
  sourcePath: string;
  /** Absolute target workspace path / 目标工作区绝对路径 */
  targetPath: string;
  /** Memory scope being migrated / 被迁移的记忆范围 */
  sourceScope: MemoryScope;
  /** Registered libraries inside the workspace / 工作区内已登记的资料库 */
  libraries: WorkspaceMigrationLibrary[];
  /** Current lifecycle phase / 当前生命周期阶段 */
  phase: JournalPhase;
  /** Source inventory at migration start / 迁移开始时的源清单 */
  inventory: Inventory;
  /** Hashes of validated copies / 已校验副本的哈希回执 */
  validatedFiles?: Receipt[];
  /** Config snapshot taken before commit, used for rollback / 提交前的配置快照，用于回滚 */
  previousConfig?: Record<string, unknown>;
}

/** Snapshot of the app context a migration runs in / 迁移所在应用上下文的快照 */
interface MigrationContext {
  /** Active workspace path / 当前工作区路径 */
  workspacePath: string;
  /** Active memory scope / 当前记忆范围 */
  scope: MemoryScope;
  /** Registered libraries / 已登记资料库 */
  libraries: WorkspaceMigrationLibrary[];
}

// Check containment on normalized relative segments, tolerating separators on every platform.
// 基于规范化相对片段检查包含性，兼容各平台的路径分隔符。
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
// Lock files, the migration journal and database sidecar files are never copied.
// 锁文件、迁移日志与数据库附属文件一律不复制。
const ignored = (relative: string) => /(?:^|\/)\.menghan-meta\/\.trellora-use\.lock(?:\/|$)/u.test(relative)
  || relative === '.trellora-migration.json'
  || (/-(?:wal|shm)$/u.test(relative) && isApplicationDatabase(relative.replace(/-(?:wal|shm)$/u, '')));
const stamp = (stat: fs.Stats) => [stat.size, stat.mtimeMs, stat.ctimeMs];

/**
 * File receipts are durable individually; no source file or live DB/WAL is moved.
 * 文件回执逐个持久化；不移动任何源文件或活动的数据库/WAL。
 */
export class WorkspaceMigrationService {
  private readonly journals = new Map<string, Journal>();
  private running?: Promise<WorkspaceMigrationStatus>;
  private controller?: AbortController;
  private status: WorkspaceMigrationStatus = { phase: 'idle', message: '', progress: 0, completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0, canCancel: false };

  /**
   * Create the service and load any persisted journals for recovery.
   * 创建服务实例，并加载已持久化的日志以便恢复。
   *
   * @param options - Environment ports: paths, config, commit/rollback and status reporting / 环境端口：路径、配置、提交/回滚与状态上报
   */
  constructor(private readonly options: {
    userDataPath: string;
    context: () => MigrationContext;
    config: () => Record<string, unknown>;
    resolveTarget: (workspacePath: string) => TrustedMemoryScopeContext;
    capture: <T>(signal: AbortSignal, action: () => Promise<T>) => Promise<T>;
    reserveTarget: (target: string) => void;
    releaseTarget: (target: string) => void;
    commit: (operationId: string, context: PhysicalRestoreContext) => Promise<void>;
    rollback: (config: Record<string, unknown>) => Promise<void>;
    activate: () => Promise<void>;
    onStatus: (status: WorkspaceMigrationStatus) => void;
  }) { this.load(); }

  /** Whether a migration is currently running / 当前是否有迁移正在运行 */
  get busy(): boolean { return Boolean(this.running); }
  /** Whether an unfinished journal awaits recovery or dismissal / 是否有未完成日志等待恢复或结束 */
  get recoveryPending(): boolean { return Boolean(this.pendingJournal()); }
  /**
   * Current status snapshot plus any pending journal preview for recovery UI.
   * 当前状态快照，以及供恢复界面使用的待处理迁移预览。
   *
   * @returns Combined migration state / 组合后的迁移状态
   */
  state(): WorkspaceMigrationState { return { status: { ...this.status }, pending: this.pendingJournal() ? this.previewOf(this.pendingJournal()!) : null }; }

  // Journal directories live under userData and are strictly named with a UUID.
  // 日志目录位于 userData 下，且严格使用 UUID 命名。
  private directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('迁移操作标识无效。');
    return assertInsideDirectory(path.join(this.options.userDataPath, 'workspace-migrations', id), this.options.userDataPath);
  }
  // The stage sits next to the target so the final rename stays on one volume.
  // 暂存目录放在目标旁边，使最终重命名在同一卷内完成。
  private stage(journal: Journal): string {
    return assertInsideDirectory(path.join(path.dirname(journal.targetPath), `.trellora-migration-${journal.id}`), path.dirname(journal.targetPath));
  }
  private previewOf(journal: Journal): WorkspaceMigrationPreview {
    return { operationId: journal.id, sourcePath: journal.sourcePath, targetPath: journal.targetPath, fileCount: journal.inventory.files.length, totalBytes: journal.inventory.files.reduce((sum, file) => sum + file.size, 0), libraries: journal.libraries };
  }
  private pendingJournal(): Journal | undefined {
    return [...this.journals.values()].find(journal => !['preview', 'completed', 'abandoned'].includes(journal.phase));
  }
  // Journals are written via a .partial file and rename so readers never see a torn document.
  // 日志先写入 .partial 文件再重命名，确保读取方不会看到半截文档。
  private write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.partial`, handle = fs.openSync(temporary, 'w');
    try { fs.writeFileSync(handle, JSON.stringify(value), 'utf8'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
  }
  private save(journal: Journal): void { this.write(path.join(this.directory(journal.id), 'journal.json'), journal); this.journals.set(journal.id, journal); }
  private load(): void {
    const root = path.join(this.options.userDataPath, 'workspace-migrations');
    if (!fs.existsSync(root)) return;
    for (const id of fs.readdirSync(root)) {
      try {
        const file = path.join(this.directory(id), 'journal.json');
        if (fs.statSync(file).size > 40 * 1024 * 1024) continue;
        const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
        if (journal.version !== 1 || journal.id !== id || !path.isAbsolute(journal.sourcePath) || !path.isAbsolute(journal.targetPath)
          || !['preview', 'preparing', 'copying', 'mapping', 'validated', 'published', 'committed', 'completed', 'abandoned'].includes(journal.phase)
          || !Array.isArray(journal.inventory?.files) || !Array.isArray(journal.inventory?.directories) || !Array.isArray(journal.libraries)) continue;
        this.assertSeparate(journal.sourcePath, journal.targetPath, journal.libraries);
        for (const entry of [...journal.inventory.files.map(item => item.relativePath), ...journal.inventory.directories]) validArchivePath(entry);
        this.journals.set(id, journal);
      } catch { /* A malformed journal never grants permission to publish or delete a directory. */ /* 损坏的日志绝不会授予发布或删除目录的权限。 */ }
    }
    const pending = this.pendingJournal();
    if (pending) this.publish(pending, 'interrupted', '上次迁移未完成，可以继续迁移或使用原位置。', 0, false);
  }
  // Source, app config and registered libraries must be disjoint from the target.
  // 源目录、应用配置与已登记资料库必须与目标目录互不包含。
  private assertSeparate(source: string, target: string, libraries: WorkspaceMigrationLibrary[]): void {
    const realTarget = resolveRealAncestors(target);
    for (const root of [source, this.options.userDataPath, ...libraries.map(item => item.path)].map(resolveRealAncestors)) {
      if (inside(root, realTarget) || inside(realTarget, root)) throw new Error('请选择工作区、已登记库和应用配置目录之外的独立空文件夹。');
    }
  }
  private assertEmpty(target: string): void {
    if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) throw new Error('目标文件夹必须为空，迁移不会覆盖已有文件。');
  }
  // Inventory rejects symlinks and special files so the copy step sees only regular files.
  // 清单阶段拒绝符号链接与特殊文件，保证复制阶段只处理普通文件。
  private async inventory(source: string, signal: AbortSignal): Promise<Inventory> {
    const files: SourceFile[] = [], directories: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        signal.throwIfAborted();
        const file = assertInsideDirectory(path.join(directory, entry.name), source), relativePath = path.relative(source, file).split(path.sep).join('/');
        if (ignored(relativePath)) continue;
        validArchivePath(relativePath);
        const stat = await fs.promises.lstat(file);
        if (stat.isSymbolicLink()) throw new Error('工作区包含符号链接或 junction，请使用实际文件目录后迁移。');
        if (stat.isDirectory()) { directories.push(relativePath); await walk(file); }
        else if (stat.isFile()) {
          const database = isApplicationDatabase(relativePath);
          const wal = database && fs.existsSync(`${file}-wal`) ? await fs.promises.stat(`${file}-wal`) : undefined;
          files.push({ relativePath, size: stat.size + (wal?.size ?? 0), stamp: JSON.stringify([stamp(stat), wal && wal.size > 0 ? stamp(wal) : null]), database });
        } else throw new Error('工作区包含无法迁移的特殊文件。');
        if (files.length > 50_000 || directories.length > 50_000) throw new Error('工作区文件或目录超过 50000 个，请先分库整理。');
      }
    };
    await walk(source);
    // Temporary names created by this service must not already exist as real user files.
    // 本服务使用的临时文件名不得与真实用户文件重名。
    const names = new Set(files.map(file => file.relativePath));
    for (const file of files) {
      if (names.has(`${file.relativePath}.migration-partial`) || (file.relativePath.endsWith('.jsonl') && names.has(`${file.relativePath}.restore-partial`))) throw new Error('工作区包含与迁移临时文件重名的文件，请先整理这些文件后再迁移。');
    }
    return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), directories: directories.sort() };
  }
  // Already-verified staged files are subtracted from the required free space.
  // 已校验的暂存文件会从所需剩余空间中扣除。
  private async checkSpace(journal: Journal): Promise<void> {
    const stat = await fs.promises.statfs(path.dirname(journal.targetPath));
    let required = this.previewOf(journal).totalBytes;
    for (const file of journal.inventory.files) {
      const receipt = this.readReceipt(journal, file), copied = path.join(this.stage(journal), ...file.relativePath.split('/'));
      if (receipt && fs.existsSync(copied) && fs.statSync(copied).size === receipt.size) required -= file.size;
    }
    if (stat.bavail * stat.bsize < required + 16 * 1024 * 1024) throw new Error('目标磁盘空间不足，请清理空间或选择其他位置。');
  }

  /**
   * Preview changes no workspace pointer; the source is inventoried again under the maintenance barrier.
   * 预览不会更改工作区指针；源目录会在维护屏障下重新盘点。
   *
   * @param targetPath - Requested empty target directory / 请求迁入的空目标目录
   * @returns Preview of the pending operation / 待执行迁移的预览信息
   */
  async preview(targetPath: string): Promise<WorkspaceMigrationPreview> {
    if (this.busy || this.recoveryPending) throw new Error('请先完成或结束当前迁移。');
    const context = this.options.context(), sourcePath = resolveRealAncestors(context.workspacePath);
    const target = resolveRealAncestors(targetPath);
    this.assertSeparate(sourcePath, target, context.libraries); this.assertEmpty(target);
    const journal: Journal = { version: 1, id: randomUUID(), sourcePath, targetPath: target, sourceScope: { ...context.scope }, libraries: context.libraries, phase: 'preview', inventory: await this.inventory(sourcePath, new AbortController().signal) };
    await this.checkSpace(journal); this.save(journal);
    return this.previewOf(journal);
  }

  /**
   * Start a previewed migration and resolve when the whole operation finishes or fails.
   * 启动已预览的迁移；整个操作完成或失败时 resolve。
   *
   * @param id - Operation identifier returned by preview / preview 返回的操作标识
   * @returns Final migration status / 最终迁移状态
   */
  start(id: string): Promise<WorkspaceMigrationStatus> {
    if (this.busy) return Promise.reject(new Error('迁移正在进行。'));
    const journal = this.journals.get(id);
    if (!journal || ['completed', 'abandoned'].includes(journal.phase)) return Promise.reject(new Error('迁移预览已失效，请重新选择目标。'));
    const pending = this.pendingJournal();
    if (pending && pending.id !== id) return Promise.reject(new Error('请先完成或结束当前迁移。'));
    // Persist intent before renderer flushing or background draining can hang. A preview alone is not a started migration.
    // 在渲染进程刷新或后台任务收尾可能卡住之前先持久化意图。仅预览不算已开始的迁移。
    if (journal.phase === 'preview') { journal.phase = 'preparing'; this.save(journal); }
    const controller = new AbortController(); this.controller = controller;
    this.publish(journal, 'preparing', '正在保存当前内容并等待后台任务结束。', 0, true);
    const task = this.execute(journal, controller.signal).finally(() => { this.running = undefined; this.controller = undefined; });
    this.running = task; return task;
  }

  /**
   * Request cancellation of the running migration.
   * 请求取消正在运行的迁移。
   *
   * @returns Nothing / 无返回值
   */
  cancel(): void { if (this.status.canCancel) this.controller?.abort(); }

  /**
   * Cancel and await the running migration so the app can exit cleanly.
   * 取消并等待正在运行的迁移结束，使应用能够干净退出。
   *
   * @returns Resolves when the running migration has settled / 正在运行的迁移结束后 resolve
   */
  async shutdown(): Promise<void> { this.cancel(); await this.running?.catch(() => undefined); }

  /**
   * Leaving the old workspace invalidates this operation; a later migration captures new edits.
   * 离开旧工作区会使本操作作废；之后的迁移会重新捕获新的修改。
   *
   * @param id - Operation identifier to abandon / 要作废的操作标识
   * @returns Nothing / 无返回值
   */
  async abandon(id: string): Promise<void> {
    if (this.busy) throw new Error('请先取消并等待当前迁移结束。');
    const journal = this.journals.get(id);
    if (!journal || journal.phase === 'completed') return;
    // A commit marker means ownership already flipped; rollback restores the previous config first.
    // 提交标记意味着所有权已切换；回滚会先恢复先前的配置。
    if (this.options.config().workspaceMigrationCommit === id) {
      if (!journal.previousConfig) throw new Error('原位置的配置回执缺失，请继续恢复迁移。');
      await this.options.rollback(journal.previousConfig);
    }
    journal.phase = 'abandoned'; this.save(journal);
    await this.removeStage(journal); this.options.releaseTarget(journal.targetPath);
    this.publish(journal, 'cancelled', '已继续使用原位置，原数据未改变。', 0, false);
  }
  private publish(journal: Journal, phase: WorkspaceMigrationStatus['phase'], message: string, progress: number, canCancel: boolean, patch: Partial<WorkspaceMigrationStatus> = {}): void {
    const preview = this.previewOf(journal);
    this.status = { operationId: journal.id, phase, message, progress, completedBytes: 0, totalBytes: preview.totalBytes, completedFiles: 0, totalFiles: preview.fileCount, sourcePath: journal.sourcePath, targetPath: journal.targetPath, canCancel, ...patch };
    this.options.onStatus({ ...this.status });
  }
  // Receipts are keyed by the hash of the relative path, so long paths stay addressable.
  // 回执以相对路径的哈希命名，保证超长路径仍可寻址。
  private receiptPath(journal: Journal, relativePath: string): string {
    return path.join(this.directory(journal.id), 'receipts', `${createHash('sha256').update(relativePath).digest('hex')}.json`);
  }
  // A receipt only counts when its stamp still matches the inventoried source file.
  // 只有回执戳记仍与清单中的源文件一致时才被采信。
  private readReceipt(journal: Journal, file: SourceFile): Receipt | undefined {
    try { const receipt = JSON.parse(fs.readFileSync(this.receiptPath(journal, file.relativePath), 'utf8')) as Receipt; return receipt.relativePath === file.relativePath && receipt.stamp === file.stamp ? receipt : undefined; } catch { return undefined; }
  }
  private async syncFile(file: string): Promise<void> { const handle = await fs.promises.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
  // Ownership marker proves a directory belongs to this operation before any deletion.
  // 归属标记用于在删除前证明目录属于本操作。
  private marker(directory: string, journal: Journal): boolean {
    try { return JSON.parse(fs.readFileSync(assertInsideDirectory(path.join(directory, '.trellora-migration.json'), directory), 'utf8')).operationId === journal.id; } catch { return false; }
  }
  private async removeStage(journal: Journal): Promise<void> {
    const stage = this.stage(journal);
    if (!fs.existsSync(stage)) return;
    if (!this.marker(stage, journal)) throw new Error('迁移临时目录归属无法确认，已保留目录。');
    await fs.promises.rm(assertInsideDirectory(stage, path.dirname(journal.targetPath)), { recursive: true, force: true });
  }
  private contextFor(journal: Journal): PhysicalRestoreContext {
    return { sourceScope: journal.sourceScope, target: this.options.resolveTarget(journal.targetPath), roots: [{ source: journal.sourcePath, target: journal.targetPath }], libraries: journal.libraries.filter(item => item.internal).map(item => ({ source: item.path, target: path.join(journal.targetPath, path.relative(journal.sourcePath, item.path)) })), warnings: new Set() };
  }

  /**
   * All copying, mapping and activation run with application writers stopped; only the final config commit changes ownership.
   * 复制、映射与激活全程停止应用写入；只有最后的配置提交才会改变归属。
   *
   * @param journal - Migration journal to execute / 要执行的迁移日志
   * @param signal - Cancellation signal / 取消信号
   * @returns Final status of this execution / 本次执行的最终状态
   */
  private async execute(journal: Journal, signal: AbortSignal): Promise<WorkspaceMigrationStatus> {
    try {
      await this.options.capture(signal, async () => {
        this.assertSeparate(journal.sourcePath, journal.targetPath, journal.libraries);
        this.options.reserveTarget(journal.targetPath);
        // A commit marker left by a crash means resume verification rather than copying again.
        // 崩溃残留的提交标记意味着应继续校验，而不是重新复制。
        const committed = this.options.config().workspaceMigrationCommit === journal.id;
        if (committed) {
          if (!this.marker(journal.targetPath, journal)) throw new Error('新位置的迁移回执缺失，请检查目标目录。');
          this.publish(journal, 'switching', '正在恢复新位置的数据关联。', 99, false);
          await this.verifyCommitted(journal, signal);
          await this.options.activate(); journal.phase = 'completed'; this.save(journal); return;
        }
        if (resolveRealAncestors(this.options.context().workspacePath) !== journal.sourcePath) throw new Error('当前工作区已经变化，请重新开始迁移。');
        signal.throwIfAborted();
        const current = await this.inventory(journal.sourcePath, signal);
        if (journal.phase === 'preview' || JSON.stringify(current) !== JSON.stringify(journal.inventory)) {
          if (this.marker(journal.targetPath, journal)) throw new Error('原目录已有新内容，请使用原位置并选择新的空文件夹重新迁移。');
          await this.removeStage(journal); journal.inventory = current; journal.validatedFiles = undefined; journal.phase = 'copying'; this.save(journal);
        }
        const stage = this.stage(journal), context = this.contextFor(journal);
        if (this.marker(journal.targetPath, journal)) journal.phase = 'published';
        if (journal.phase !== 'published') {
          this.assertEmpty(journal.targetPath); await this.checkSpace(journal);
          if (fs.existsSync(stage) && !this.marker(stage, journal)) throw new Error('迁移临时目录已被占用，请选择其他位置。');
          await fs.promises.mkdir(stage, { recursive: true }); this.write(path.join(stage, '.trellora-migration.json'), { operationId: journal.id, sourcePath: journal.sourcePath });
          for (const directory of journal.inventory.directories) await fs.promises.mkdir(assertInsideDirectory(path.join(stage, ...directory.split('/')), stage), { recursive: true });
          if (journal.phase !== 'validated') {
            journal.phase = 'copying'; this.save(journal);
            await this.copy(journal, stage, signal);
            if (JSON.stringify(await this.inventory(journal.sourcePath, signal)) !== JSON.stringify(journal.inventory)) throw new Error('迁移期间原目录被其他程序修改，请重试以迁移最新内容。');
            journal.phase = 'mapping'; this.save(journal);
            await this.map(journal, stage, context, signal);
            journal.validatedFiles = [];
            for (const file of journal.inventory.files) {
              signal.throwIfAborted(); const destination = assertInsideDirectory(path.join(stage, ...file.relativePath.split('/')), stage);
              journal.validatedFiles.push({ relativePath: file.relativePath, stamp: file.stamp, size: (await fs.promises.stat(destination)).size, sha256: await hashFile(destination, signal) });
            }
            journal.phase = 'validated'; this.save(journal);
          }
          await this.verify(journal, stage, signal);
          // Cancellation stops before publication. After this point, finish the atomic activation or retain a resumable journal.
          // 取消只在发布之前生效。越过此点后，要么完成原子激活，要么保留可续跑的日志。
          signal.throwIfAborted(); this.publish(journal, 'switching', '正在启用新位置，完成后即可继续使用。', 98, false);
          this.assertEmpty(journal.targetPath);
          if (fs.existsSync(journal.targetPath)) await fs.promises.rmdir(journal.targetPath);
          await renameWithWindowsRetryAsync(stage, journal.targetPath, () => { if (fs.existsSync(journal.targetPath)) throw new Error('目标目录已被其他程序占用，原位置仍可使用。'); }, { attempts: 21, delayMs: 250 });
          journal.phase = 'published'; this.save(journal);
        }
        await this.verify(journal, journal.targetPath, new AbortController().signal);
        journal.previousConfig = this.options.config(); this.save(journal);
        await this.options.commit(journal.id, context);
        journal.phase = 'committed'; this.save(journal);
        await this.options.activate(); journal.phase = 'completed'; this.save(journal);
      });
      this.publish(journal, 'completed', '迁移完成，已启用新位置。原目录保留为迁移前副本。', 100, false, { completedBytes: this.previewOf(journal).totalBytes, completedFiles: journal.inventory.files.length });
    } catch (error) {
      // The commit marker also covers a process crash between config publication and journal publication.
      // 提交标记同时覆盖配置发布与日志发布之间进程崩溃的情况。
      if (this.options.config().workspaceMigrationCommit === journal.id && journal.previousConfig) {
        try { await this.options.rollback(journal.previousConfig); journal.phase = 'published'; this.save(journal); } catch { /* Keep the committed journal; restart recovery owns the decision. */ /* 保留已提交的日志；由重启恢复流程决定后续。 */ }
      }
      const code = (error as NodeJS.ErrnoException).code;
      const message = signal.aborted ? '迁移已取消，原位置的数据仍然保留。' : code === 'ENOSPC' ? '磁盘空间不足，原数据仍在原位置，请清理空间后重试。' : ['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ? '目录被其他程序占用或没有写入权限。请关闭占用程序后重试，或继续使用原位置。' : error instanceof Error ? error.message : '迁移失败，原数据仍然保留，请重试。';
      this.publish(journal, signal.aborted ? 'cancelled' : 'failed', message, this.status.progress, false);
    }
    return { ...this.status };
  }
  // Databases are copied with SQLite backup APIs; files use a stream and hash check against the source.
  // 数据库用 SQLite 备份 API 复制；普通文件走流式复制并与源文件哈希比对。
  private async copy(journal: Journal, stage: string, signal: AbortSignal): Promise<void> {
    const total = this.previewOf(journal).totalBytes; let completedBytes = 0, completedFiles = 0, lastUpdate = 0;
    for (const file of journal.inventory.files) {
      signal.throwIfAborted();
      const source = assertInsideDirectory(path.join(journal.sourcePath, ...file.relativePath.split('/')), journal.sourcePath);
      const destination = assertInsideDirectory(path.join(stage, ...file.relativePath.split('/')), stage), partial = `${destination}.migration-partial`;
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.rm(partial, { force: true });
      // Valid receipts let a resumed migration skip files that are already identical.
      // 有效回执使续跑的迁移可跳过已完全一致的文件。
      const receipt = this.readReceipt(journal, file);
      if (!receipt || !fs.existsSync(destination) || (await fs.promises.stat(destination)).size !== receipt.size || await hashFile(destination, signal) !== receipt.sha256) {
        let copied = 0;
        // Progress is throttled to 10 updates per second to avoid flooding the renderer.
        // 进度上报限流到每秒 10 次，避免淹没渲染进程。
        const progress = () => {
          if (Date.now() - lastUpdate < 100) return; lastUpdate = Date.now();
          this.publish(journal, 'copying', '正在迁移文件和数据库。', total ? Math.min(85, (completedBytes + copied) / total * 85) : 0, true, { completedBytes: Math.min(total, completedBytes + copied), completedFiles, currentFile: file.relativePath });
        };
        if (file.database) {
          const database = new Database(source, { readonly: true, fileMustExist: true });
          try { await database.backup(partial, { progress: ({ totalPages, remainingPages }) => { signal.throwIfAborted(); copied = totalPages ? file.size * (totalPages - remainingPages) / totalPages : 0; progress(); return 200; } }); } finally { database.close(); }
        } else {
          const input = fs.createReadStream(source), output = fs.createWriteStream(partial, { flags: 'wx' });
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { copied += chunk.length; progress(); callback(null, chunk); } });
          await pipeline(input, meter, output, { signal });
          if (await hashFile(source, signal) !== await hashFile(partial, signal)) throw new Error('迁移期间源文件发生变化，请重试。');
        }
        await this.syncFile(partial);
        // A terminated mapping worker may leave a staged WAL. It belongs to the replaced copy only.
        // 被终止的映射工作线程可能残留暂存 WAL。它只属于被替换的副本。
        if (file.database) for (const suffix of ['-wal', '-shm']) await fs.promises.rm(`${destination}${suffix}`, { force: true });
        await fs.promises.rename(partial, destination);
        this.write(this.receiptPath(journal, file.relativePath), { relativePath: file.relativePath, stamp: file.stamp, size: (await fs.promises.stat(destination)).size, sha256: await hashFile(destination, signal) });
      }
      completedBytes += file.size; completedFiles++;
      this.publish(journal, 'copying', '正在迁移文件和数据库。', total ? completedBytes / total * 85 : 85, true, { completedBytes, completedFiles, currentFile: file.relativePath });
    }
  }
  // Mapping runs in a worker thread so a large metadata rewrite cannot block main-process bookkeeping.
  // 映射在工作线程中执行，避免大规模元数据改写阻塞主进程的簿记工作。
  private async map(journal: Journal, directory: string, context: PhysicalRestoreContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'workspaceMigrationWorker.js'), { workerData: { directory, files: journal.inventory.files, sourceScope: context.sourceScope, targetPath: context.target.workspacePath, principalId: context.target.scope.principalId, roots: context.roots, libraries: context.libraries } });
      let failure: Error | undefined;
      const abort = () => { failure = new Error('迁移已取消。'); void worker.terminate(); };
      signal.addEventListener('abort', abort, { once: true });
      worker.on('message', (message: { completed?: number; currentFile?: string; error?: string }) => {
        if (message.error) failure = new Error(message.error);
        else if (message.completed !== undefined) this.publish(journal, 'mapping', '正在关联笔记、会话和记忆。', 85 + message.completed / Math.max(1, journal.inventory.files.length) * 10, true, { completedFiles: message.completed, currentFile: message.currentFile });
      });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => { signal.removeEventListener('abort', abort); failure || code !== 0 ? reject(failure ?? new Error('迁移处理线程意外结束，可以重试。')) : resolve(); });
      if (signal.aborted) abort();
    });
  }
  // Post-commit verification re-checks databases structurally and other files by hash.
  // 提交后校验：结构性检查数据库，其余文件按哈希复核。
  private async verifyCommitted(journal: Journal, signal: AbortSignal): Promise<void> {
    if (!journal.validatedFiles || journal.validatedFiles.length !== journal.inventory.files.length) throw new Error('迁移校验回执不完整，原位置仍可使用。');
    for (const file of journal.validatedFiles) {
      signal.throwIfAborted(); validArchivePath(file.relativePath);
      const destination = assertInsideDirectory(path.join(journal.targetPath, ...file.relativePath.split('/')), journal.targetPath);
      if (isApplicationDatabase(file.relativePath)) {
        const database = new Database(destination, { readonly: true, fileMustExist: true });
        try { if (file.relativePath.endsWith('/index.db')) loadSqliteVec(database); assertRestoredDatabase(database); } finally { database.close(); }
      } else if (!/(?:^|\/)\.menghan-meta\//u.test(file.relativePath) && await hashFile(destination, signal) !== file.sha256) throw new Error('新位置的原文件校验失败，可返回原位置后重新迁移。');
    }
  }
  // Full hash verification against the receipts recorded before publication.
  // 按发布前记录的回执做完整的哈希校验。
  private async verify(journal: Journal, directory: string, signal: AbortSignal): Promise<void> {
    if (!journal.validatedFiles || journal.validatedFiles.length !== journal.inventory.files.length || !this.marker(directory, journal)) throw new Error('迁移校验回执不完整，原位置仍可使用。');
    let completed = 0;
    for (const file of journal.validatedFiles) {
      validArchivePath(file.relativePath); signal.throwIfAborted();
      const destination = assertInsideDirectory(path.join(directory, ...file.relativePath.split('/')), directory);
      if ((await fs.promises.stat(destination)).size !== file.size || await hashFile(destination, signal) !== file.sha256) throw new Error('迁移副本校验失败，请重试或使用原位置。');
      completed++;
      if (this.status.canCancel) this.publish(journal, 'validating', '正在校验迁移结果。', 95 + completed / Math.max(1, journal.validatedFiles.length) * 2, true, { completedFiles: completed });
    }
  }
}
