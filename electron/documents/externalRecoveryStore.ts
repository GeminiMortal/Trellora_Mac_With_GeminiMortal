/** External recovery store: persists unsaved document drafts to disk for crash/quit recovery. / 外部恢复存储：将未保存的文档草稿持久化到磁盘，用于崩溃/退出恢复。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentFormat, DocumentDiskVersion, DocumentRecent, DocumentRecovery } from '../../shared/documentSession.ts';
import { EXTERNAL_TEXT_MAX_BYTES } from '../../shared/documentSession.ts';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import type { DraftAsset } from './documentResourceService.ts';

/** Extended recovery record with persistence state and content fields / 带持久化状态与内容字段的扩展恢复记录 */
export interface RecoveryRecord extends DocumentRecovery { version: 1; content: string; format: DocumentFormat; diskVersion: DocumentDiskVersion; draftAssets?: DraftAsset[]; state: 'dirty' | 'clean' | 'discarded' | 'transferred' }
/** 私有缓存按会话身份保存；终态先落盘，迟到请求不能复活已放弃的草稿。 */
export class ExternalRecoveryStore {
  private readonly terminated = new Set<string>();
  constructor(readonly root: string) {}
  private recordPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('恢复标识无效。');
    return assertInsideDirectory(path.join(this.root, `${id}.json`), this.root);
  }
  private async publish(target: string, bytes: Buffer): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    assertInsideDirectory(target, this.root);
    const temporary = path.join(this.root, `.recovery-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      assertInsideDirectory(target, this.root); await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async write(record: RecoveryRecord): Promise<void> { await this.publish(this.recordPath(record.recoveryId), Buffer.from(JSON.stringify(record))); }
  async read(id: string): Promise<RecoveryRecord> {
    if (this.terminated.has(id)) throw new Error('草稿已处理或恢复记录无效。');
    const filePath = this.recordPath(id);
    if ((await fs.stat(filePath)).size > EXTERNAL_TEXT_MAX_BYTES * 6 + 16_384) throw new Error('恢复记录过大。');
    const record = JSON.parse(await fs.readFile(filePath, 'utf8')) as RecoveryRecord;
    if (record.version !== 1 || record.recoveryId !== id || record.state !== 'dirty' || typeof record.content !== 'string' || typeof record.displayPath !== 'string') throw new Error('草稿已处理或恢复记录无效。');
    if (!Number.isSafeInteger(record.draftRevision) || record.draftRevision < 0 || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || !record.format || !['utf8', 'utf16le', 'utf16be', 'gbk', 'gb18030'].includes(record.format.encoding) || !['none', 'utf8', 'utf16le', 'utf16be'].includes(record.format.bom) || (record.format.bom !== 'none' && record.format.bom !== record.format.encoding) || !['none', 'lf', 'crlf', 'cr', 'mixed'].includes(record.format.lineEnding) || !record.diskVersion || !/^[a-f0-9]{64}$/.test(record.diskVersion.diskHash) || record.diskHash !== record.diskVersion.diskHash || !Number.isFinite(record.diskVersion.mtimeMs) || !Number.isSafeInteger(record.diskVersion.byteLength) || record.diskVersion.byteLength < 0 || record.diskVersion.byteLength > EXTERNAL_TEXT_MAX_BYTES) throw new Error('恢复记录格式或磁盘版本无效。');
    return record;
  }
  /**
   * Lists valid dirty recovery records sorted by update time (newest first).
   * 列出有效的 dirty 恢复记录，按更新时间倒序排列。
   *
   * @returns Recovery summaries for the restore list / 供恢复列表使用的恢复摘要
   */
  async list(): Promise<DocumentRecovery[]> {
    let names: string[];
    try { names = await fs.readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const entries = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => {
      try { const r = await this.read(name.slice(0, -5)); return { recoveryId: r.recoveryId, displayPath: r.displayPath, updatedAt: r.updatedAt, draftRevision: r.draftRevision, diskHash: r.diskHash }; } catch { return null; }
    }));
    return entries.filter((r): r is DocumentRecovery => Boolean(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /**
   * Closing may degrade to deleting the old cache; when both persistence paths fail, the current process still refuses to restore the finished session.
   * 关闭可降级为删除旧缓存；两种落盘方式都失败时，当前进程仍禁止恢复已结束的会话。
   *
   * @param record - Recovery record to terminate / 要终结的恢复记录
   * @param state - Terminal state to persist / 要落盘的终态
   * @param tolerateUnavailable - Allow degradation when the store is unavailable / 存储不可用时允许降级
   * @returns Whether the record was cleaned from disk / 记录是否已从磁盘清理
   */
  async terminate(record: RecoveryRecord, state: 'clean' | 'discarded' | 'transferred', tolerateUnavailable = false): Promise<boolean> {
    let marked = false;
    try { await this.write({ ...record, state, content: '' }); marked = true; }
    catch (error) { if (!tolerateUnavailable) throw error; }
    if (tolerateUnavailable) this.terminated.add(record.recoveryId);
    try { await fs.rm(this.recordPath(record.recoveryId), { force: true }); return true; }
    catch { return marked; }
  }
  /**
   * Stores a pre-save history copy of a file under its content key.
   * 按内容键保存文件的保存前历史副本。
   *
   * @param fileKey - Hash key identifying the target file / 标识目标文件的哈希键
   * @param bytes - Original file bytes before the save / 保存前的原始文件字节
   */
  async backup(fileKey: string, bytes: Buffer): Promise<void> {
    const directory = assertInsideDirectory(path.join(this.root, 'versions', fileKey), this.root);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${Date.now()}-${randomUUID()}.bin`), handle = await fs.open(target, 'wx');
    try { try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { await fs.rm(target, { force: true }); throw error; }
  }
  /**
   * Trims history backups to the newest three copies per file key.
   * 将每个文件键的历史备份裁剪为最新三份。
   *
   * @param fileKey - Hash key identifying the target file / 标识目标文件的哈希键
   */
  async prune(fileKey: string): Promise<void> {
    const directory = assertInsideDirectory(path.join(this.root, 'versions', fileKey), this.root);
    const names = (await fs.readdir(directory)).filter(n => n.endsWith('.bin')).sort().reverse();
    await Promise.all(names.slice(3).map(name => fs.unlink(assertInsideDirectory(path.join(directory, name), directory))));
  }
  /**
   * Reads the recently opened external file list (up to 20 entries).
   * 读取最近打开的外部文件列表（最多 20 条）。
   *
   * @returns Valid recent entries / 有效的最近记录
   */
  async recent(): Promise<DocumentRecent[]> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(assertInsideDirectory(path.join(this.root, 'recent.json'), this.root), 'utf8'));
      return Array.isArray(value) ? value.filter((item): item is DocumentRecent => item && typeof item.displayPath === 'string' && path.isAbsolute(item.displayPath) && typeof item.openedAt === 'string').slice(0, 20) : [];
    } catch { return []; }
  }
  /**
   * Records a display path as recently opened, deduplicating and capping the list.
   * 将显示路径记录为最近打开，去重并限制列表长度。
   *
   * @param displayPath - Absolute path of the opened file / 打开文件的绝对路径
   */
  async remember(displayPath: string): Promise<void> {
    const old = await this.recent();
    await this.publish(path.join(this.root, 'recent.json'), Buffer.from(JSON.stringify([{ displayPath, openedAt: new Date().toISOString() }, ...old.filter(r => r.displayPath !== displayPath)].slice(0, 20))));
  }
}
