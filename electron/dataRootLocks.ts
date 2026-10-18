/**
 * Cross-instance data-root leases that prevent two app instances from opening the same workspace or library.
 * 跨实例数据根租约：防止两个应用实例同时打开同一工作区或笔记库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertInsideDirectory, resolveRealAncestors } from './files/pathGuards.ts';

/** Recorded lock holder: process id, random token, and the roots it holds / 已记录的锁持有者：进程号、随机令牌与其持有的根目录 */
interface Owner { pid: number; token: string; roots: string[]; }
const lockName = '.trellora-use.lock';
// Path containment check: empty relative path (self) or a non-escaping relative path counts as inside.
// 路径包含判定：相对路径为空（自身）或不逃逸的相对路径视为在内部。
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
// liveness probe: any error other than ESRCH means the process still exists (e.g. EPERM).
// 存活探测：除 ESRCH 外的错误均表示进程仍存在（例如 EPERM）。
const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

/**
 * Directory creation is atomic; stale claims are reclaimed only after the recorded process exited.
 * 目录创建是原子的；仅在记录的进程退出后才回收陈旧占用。
 */
function claim(directory: string, owner: Owner): void {
  try { fs.mkdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = readOwner(directory);
    // A live owner blocks reclamation; a missing/foreign owner also refuses to take over.
    // 活跃持有者阻止回收；缺失或陌生持有者同样拒绝接管。
    if (!previous || live(previous.pid)) throw Object.assign(new Error('该工作区或笔记库正在被另一应用实例使用，请关闭该实例或选择其他目录。'), { code: 'DATA_ROOT_IN_USE' });
    release(directory, previous.token);
    fs.mkdirSync(directory);
  }
  try { fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx' }); }
  // On owner.json failure only the empty claim directory is removed; unknown owners' files are kept.
  // owner.json 写入失败时仅移除空的占用目录；未知持有者的文件一律保留。
  catch (error) { try { fs.rmdirSync(directory); } catch { /* Never delete an unknown owner's files. */ } throw error; }
}

function readOwner(directory: string): Owner | undefined {
  try {
    const file = path.join(directory, 'owner.json');
    // Reject symlinks and oversized files before parsing so untrusted paths cannot redirect the lock.
    // 解析前拒绝符号链接与超大文件，防止不可信路径重定向锁文件。
    if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16_384) return undefined;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as Owner;
    return Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && Array.isArray(owner.roots) ? owner : undefined;
  } catch { return undefined; }
}

function release(directory: string, token: string): void {
  // Token match required: a stale or foreign claim is never torn down by the wrong holder.
  // 必须令牌匹配：陈旧或陌生占用绝不会被错误持有者拆除。
  if (readOwner(directory)?.token !== token) return;
  fs.unlinkSync(path.join(directory, 'owner.json'));
  fs.rmdirSync(directory);
}

/**
 * Real-root leases work across userData directories and serialize overlapping roots in one user account.
 * 真实根租约可跨 userData 目录工作，并在同一用户账户内串行化重叠的根目录。
 */
export class DataRootLocks {
  private readonly owner: Owner = { pid: process.pid, token: randomUUID(), roots: [] };
  // Value null marks a reserved-but-not-created root; a string marks a claimed lock directory.
  // 值为 null 表示已预留但未创建的根；字符串表示已占用的锁目录。
  private readonly held = new Map<string, string | null>();
  private readonly registry = path.join(os.tmpdir(), 'trellora-data-root-leases');
  private readonly registration = path.join(this.registry, this.owner.token);

  /**
   * Reserve a future migration root without creating files in the empty destination.
   * 预留未来的迁移目标根目录，而不在空目标中创建任何文件。
   *
   * @param roots - Root directories to reserve / 要预留的根目录列表
   */
  reserve(roots: readonly string[]): void { this.acquire(roots, false); }

  /**
   * Drops a reservation previously taken by `reserve` for one root.
   * 释放 `reserve` 对某个根目录此前取得的预留。
   *
   * @param root - Reserved root to drop / 要释放的已预留根目录
   */
  releaseReservation(root: string): void {
    const resolved = resolveRealAncestors(root).toLowerCase();
    if (this.held.get(resolved) !== null) return;
    this.held.delete(resolved); this.owner.roots = [...this.held.keys()];
    if (fs.existsSync(this.registration)) fs.writeFileSync(path.join(this.registration, 'owner.json'), JSON.stringify(this.owner));
  }

  /**
   * Claims all given roots, rejecting overlaps with any other live instance and rolling back on failure.
   * 占用所有给定根目录：拒绝与其他活跃实例重叠，失败时回滚。
   *
   * @param roots - Root directories to claim / 要占用的根目录列表
   * @param createDirectories - Whether missing roots and their lock directories may be created / 是否允许创建缺失的根目录及其锁目录
   */
  acquire(roots: readonly string[], createDirectories = true): void {
    const targets = [...new Set(roots.map(root => resolveRealAncestors(root).toLowerCase()))].sort();
    fs.mkdirSync(this.registry, { recursive: true });
    const guard = path.join(this.registry, 'guard');
    // The guard serializes concurrent acquisitions across instances while the scan below runs.
    // guard 在下方扫描期间串行化跨实例的并发获取。
    claim(guard, this.owner);
    const acquired: string[] = [];
    try {
      for (const name of fs.readdirSync(this.registry)) {
        if (name === 'guard' || name === this.owner.token) continue;
        const other = readOwner(path.join(this.registry, name));
        if (other && !live(other.pid)) { release(path.join(this.registry, name), other.token); continue; }
        // Overlap is symmetric: either root containing the other counts as a conflict.
        // 重叠是对称的：任一根包含另一根即视为冲突。
        if (other && live(other.pid) && targets.some(root => other.roots.some(candidate => inside(root, candidate) || inside(candidate, root)))) {
          throw Object.assign(new Error('工作区或笔记库已被另一实例打开，请关闭该实例后再试。'), { code: 'DATA_ROOT_IN_USE' });
        }
      }
      for (const root of targets) {
        if (this.held.has(root) && (!createDirectories || this.held.get(root) !== null)) continue;
        if (!createDirectories) { this.held.set(root, null); acquired.push(root); continue; }
        fs.mkdirSync(root, { recursive: true });
        // Lock paths are asserted inside the root so a hostile name cannot escape the directory.
        // 锁路径断言位于根目录内部，防止恶意名称逃逸出目录。
        const metadata = assertInsideDirectory(path.join(root, '.menghan-meta'), root);
        fs.mkdirSync(metadata, { recursive: true });
        const directory = assertInsideDirectory(path.join(metadata, lockName), root);
        claim(directory, this.owner);
        this.held.set(root, directory);
        acquired.push(root);
      }
      this.owner.roots = [...this.held.keys()];
      if (fs.existsSync(this.registration)) fs.writeFileSync(path.join(this.registration, 'owner.json'), JSON.stringify(this.owner));
      else claim(this.registration, this.owner);
    } catch (error) {
      // Roll back only the roots acquired in this call so a partial failure leaves no stray locks.
      // 仅回滚本次调用获取的根目录，避免部分失败留下游离锁。
      for (const root of acquired) { const directory = this.held.get(root); if (directory) release(directory, this.owner.token); this.held.delete(root); }
      throw error;
    } finally { release(guard, this.owner.token); }
  }

  /**
   * Releases every held root and this instance's registration.
   * 释放全部已持有的根目录与本实例的注册信息。
   */
  releaseAll(): void {
    for (const directory of this.held.values()) if (directory) release(directory, this.owner.token);
    this.held.clear();
    release(this.registration, this.owner.token);
  }
}
