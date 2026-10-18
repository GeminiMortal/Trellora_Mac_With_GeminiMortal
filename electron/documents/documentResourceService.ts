/**
 * Local resource management for external document editing: path authorization, draft image staging, preview grants and publish with rollback.
 * 外部文档编辑的本地资源管理：路径授权、草稿图片暂存、预览授权与带回滚的发布。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertInsideDirectory, resolveRealAncestors, sanitizeEntryName } from '../files/pathGuards.ts';
import { collectDocumentReferences, rewriteDocumentReferences } from '../../shared/documentResourceManifest.ts';
import { DocumentError } from './textCodec.ts';

/**
 * Custom protocol scheme used to serve authorized local images to the renderer.
 * 用于向渲染进程提供已授权本地图片的自定义协议方案。
 */
export const DOCUMENT_RESOURCE_SCHEME = 'trellora-resource';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024, MAX_RESOURCE_BYTES = 20 * 1024 * 1024, MAX_RESOURCES = 200;
const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/**
 * Reference to a draft-stage image asset (trellora-draft: scheme).
 * 暂存阶段的图片资源引用（trellora-draft: 方案）。
 */
export interface DraftAsset { reference: string; fileName: string }
/**
 * Result of publishing local resources: rewritten content, URL replacements and a rollback callback.
 * 发布本地资源的结果：已重写的内容、URL 替换与回滚回调。
 */
export interface ResourcePublication { content: string; replacements: Record<string, string>; rollback: () => Promise<void> }
interface Context { displayPath: string; content: string; draftRevision: number }
interface State { roots: string[]; drafts: DraftAsset[] }

/**
 * Grants are restricted to read-only resources actually referenced in the content; publish rollback only deletes files that were exclusively created in this operation.
 * 授权仅适用于被正文引用的只读资源；发布回滚仅删除本次独占创建的文件。
 */
export class DocumentResourceService {
  private readonly states = new Map<string, State>();
  private readonly grants = new Map<string, { sessionId: string; revision: number; filePath: string; root: string }>();
  /**
   * Creates the resource service with a private draft asset root, session context resolver and protected-root list.
   * 创建资源服务，需提供私有草稿资源根目录、会话上下文解析器和受保护根目录列表。
   *
   * @param options.privateRoot - Directory for staging draft images / 暂存草稿图片的目录
   * @param options.context - Returns the session context for an id / 按标识返回会话上下文
   * @param options.protectedRoots - Returns directories that must not be authorized / 返回不可授权的受保护目录
   */
  constructor(private readonly options: { privateRoot: string; context: (id: string) => Context | undefined; protectedRoots: () => string[] }) {}
  /**
   * Returns a cloned snapshot of the draft image assets for a session.
   * 返回会话草稿图片资源的克隆快照。
   *
   * @param id - Document session id / 文档会话标识
   * @returns Draft asset list / 草稿资源列表
   */
  assets(id: string): DraftAsset[] { return structuredClone(this.state(id).drafts); }
  /**
   * Restores draft asset records (used when recovering a saved session).
   * 恢复草稿资源记录（用于恢复已保存会话时）。
   *
   * @param id - Document session id / 文档会话标识
   * @param drafts - Draft assets to adopt / 要采纳的草稿资源
   */
  adopt(id: string, drafts: DraftAsset[]): void {
    if (!Array.isArray(drafts) || drafts.length > MAX_RESOURCES || drafts.some(asset => !asset || !/^trellora-draft:[a-f0-9-]{36}\.(png|jpg|jpeg|gif|webp)$/.test(asset.reference) || asset.fileName !== asset.reference.slice(15))) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '恢复草稿的图片记录无效。');
    this.state(id).drafts = structuredClone(drafts);
  }
  /**
   * Authorizes a directory as a local resource root for this session (cannot overlap protected roots).
   * 将目录授权为本会话的本地资源根目录（不能与受保护根目录重叠）。
   *
   * @param id - Document session id / 文档会话标识
   * @param directory - Absolute directory path to authorize / 要授权的绝对目录路径
   */
  grantRoot(id: string, directory: string): void {
    if (!this.options.context(id)) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    const root = resolveRealAncestors(path.resolve(directory));
    for (const protectedRoot of this.options.protectedRoots()) if (inside(root, resolveRealAncestors(protectedRoot))) throw new DocumentError('DOCUMENT_PROTECTED', '不能授权应用私有数据或资料库目录。');
    this.state(id).roots.push(root);
  }
  private async resolve(id: string, href: string): Promise<{ filePath: string; root: string; fragment: string }> {
    const context = this.options.context(id); if (!context) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    const state = this.state(id);
    if (href.startsWith('trellora-draft:')) {
      const asset = state.drafts.find(value => value.reference === href);
      if (!asset) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '草稿图片未获授权。');
      return { filePath: assertInsideDirectory(path.join(this.options.privateRoot, asset.fileName), this.options.privateRoot), root: this.options.privateRoot, fragment: '' };
    }
    const [source, ...fragments] = href.split('#'); let decoded: string;
    try { decoded = decodeURIComponent(source).replace(/\\([ ()])/g, '$1'); } catch { throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '本地资源地址编码无效。'); }
    if (decoded.includes('\0') || /^(?!file:)[a-z][a-z\d+.-]*:/i.test(decoded) && !/^[a-z]:[\\/]/i.test(decoded)) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '本地资源地址无效。');
    const base = path.dirname(context.displayPath), candidate = /^file:/i.test(decoded) ? fileURLToPath(decoded) : path.resolve(base, decoded);
    const automatic = !path.isAbsolute(decoded) && !/^file:/i.test(decoded) && inside(candidate, base);
    const root = [ ...(automatic ? [base] : []), ...state.roots ].find(directory => inside(candidate, directory) && inside(resolveRealAncestors(candidate), resolveRealAncestors(directory)));
    if (!root) throw new DocumentError('DOCUMENT_RESOURCE_DENIED', `本地资源需要选择目录授权：${href}`);
    const filePath = resolveRealAncestors(candidate);
    for (const protectedRoot of this.options.protectedRoots()) if (inside(filePath, resolveRealAncestors(protectedRoot))) throw new DocumentError('DOCUMENT_PROTECTED', '本地资源位于应用受保护目录。');
    const stat = await fs.stat(filePath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DocumentError('DOCUMENT_RESOURCE_MISSING', `本地资源不存在：${href}`); throw error; });
    if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', `本地资源不是文件或超过 20 MiB：${href}`);
    return { filePath, root: resolveRealAncestors(root), fragment: fragments.length ? `#${fragments.join('#')}` : '' };
  }
  /**
   * Resolves a non-image link referenced in the document to a local file path, returning an enqueue-ready path.
   * 将文档中引用的非图片链接解析为本地文件路径，返回可直接排队的路径。
   *
   * @param id - Document session id / 文档会话标识
   * @param href - Link href from the document / 文档中的链接 href
   * @returns Absolute file path / 绝对文件路径
   */
  async openLink(id: string, href: string): Promise<string> {
    const context = this.options.context(id), decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    const reference = context && collectDocumentReferences(context.content).references.find(reference => !reference.image && decode(reference.href) === decode(href));
    if (!reference) throw new DocumentError('DOCUMENT_RESOURCE_DENIED', '链接不属于当前文档。');
    return (await this.resolve(id, reference.href)).filePath;
  }
  /**
   * Previews all image references in the document, issuing one-time access grants and reporting issues.
   * 预览文档中的所有图片引用，签发一次性访问授权并报告问题。
   *
   * @param id - Document session id / 文档会话标识
   * @returns Authorized URLs, issues found, and the draft revision / 已授权 URL、发现的问题与草稿版本
   */
  async preview(id: string): Promise<{ urls: Record<string, string>; issues: string[]; draftRevision: number }> {
    const context = this.options.context(id); if (!context) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    for (const [token, grant] of this.grants) if (grant.sessionId === id) this.grants.delete(token);
    const manifest = collectDocumentReferences(context.content), issues = [...manifest.unsupported], urls: Record<string, string> = {};
    if (manifest.references.length > MAX_RESOURCES) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '单篇文档最多处理 200 个本地资源引用。');
    for (const reference of manifest.references) {
      if (!reference.image || urls[reference.href]) continue;
      try {
        const resource = await this.resolve(id, reference.href); if (!mime[path.extname(resource.filePath).toLowerCase()]) throw new Error('图片格式只支持 PNG、JPG、GIF、WebP。');
        const token = randomUUID(); this.grants.set(token, { sessionId: id, revision: context.draftRevision, filePath: resource.filePath, root: resource.root }); urls[reference.href] = `${DOCUMENT_RESOURCE_SCHEME}://resource/${token}`;
      } catch (error) { issues.push(`${reference.href}：${(error as Error).message}`); }
    }
    return { urls, issues, draftRevision: context.draftRevision };
  }
  /**
   * Reads an authorized resource by its one-time grant URL.
   * 通过一次性授权 URL 读取已授权的资源。
   *
   * @param rawUrl - The trellora-resource:// URL with grant token / 含授权令牌的 trellora-resource:// URL
   * @param method - HTTP method, must be 'GET' / HTTP 方法，必须为 'GET'
   * @returns Resource bytes and MIME type / 资源字节与 MIME 类型
   */
  async read(rawUrl: string, method = 'GET'): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = new URL(rawUrl), token = url.pathname.slice(1), grant = this.grants.get(token);
    if (method !== 'GET' || url.protocol !== `${DOCUMENT_RESOURCE_SCHEME}:` || url.hostname !== 'resource' || url.search || url.hash || url.username || url.password || url.port || !grant) throw new Error('资源授权无效。');
    const context = this.options.context(grant.sessionId);
    if (!context || context.draftRevision !== grant.revision || !inside(resolveRealAncestors(grant.filePath), grant.root)) throw new Error('资源授权已失效。');
    const mimeType = mime[path.extname(grant.filePath).toLowerCase()]; if (!mimeType) throw new Error('图片类型无效。');
    const bytes = await boundedRead(grant.filePath, MAX_IMAGE_BYTES); return { bytes: new Uint8Array(bytes), mimeType };
  }
  /**
   * Stores image bytes as a draft asset and returns a trellora-draft: reference for insertion into the document.
   * 将图片字节存储为草稿资源，并返回 trellora-draft: 引用以便插入文档。
   *
   * @param id - Document session id / 文档会话标识
   * @param bytes - Image file bytes / 图片文件字节
   * @param extension - Image file extension (e.g. '.png') / 图片文件扩展名（如 '.png'）
   * @returns Markdown-ready path and generated file name / 可用于 Markdown 的路径与生成的文件名
   */
  async addImage(id: string, bytes: Uint8Array, extension: string): Promise<{ markdownPath: string; fileName: string }> {
    if (!this.options.context(id)) throw new DocumentError('DOCUMENT_SESSION_INVALID', '文档会话已失效。');
    const ext = extension.toLowerCase(); if (!mime[ext] || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', '图片格式不支持或超过 10 MiB。');
    if (this.state(id).drafts.length >= MAX_RESOURCES) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '单篇文档最多暂存 200 张图片。');
    await fs.mkdir(this.options.privateRoot, { recursive: true });
    const fileName = `${randomUUID()}${ext}`, reference = `trellora-draft:${fileName}`, filePath = assertInsideDirectory(path.join(this.options.privateRoot, fileName), this.options.privateRoot);
    const handle = await fs.open(filePath, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    this.state(id).drafts.push({ reference, fileName }); return { markdownPath: reference, fileName };
  }
  /**
   * Reads an image from an authorized local path and stores it as a draft asset.
   * 从已授权的本地路径读取图片并存储为草稿资源。
   *
   * @param id - Document session id / 文档会话标识
   * @param source - Local file path or trellora-draft: reference / 本地文件路径或 trellora-draft: 引用
   * @returns Markdown-ready path and generated file name / 可用于 Markdown 的路径与生成的文件名
   */
  async imageFromPath(id: string, source: string): Promise<{ markdownPath: string; fileName: string }> {
    const resolved = await this.resolve(id, source); return this.addImage(id, new Uint8Array(await boundedRead(resolved.filePath, MAX_IMAGE_BYTES)), path.extname(resolved.filePath));
  }
  /**
   * Publishes local resources by copying them to the target directory, rewriting references, and providing a rollback callback.
   * 发布本地资源：将资源复制到目标目录、重写引用，并提供回滚回调。
   *
   * @param id - Document session id / 文档会话标识
   * @param content - Document content to rewrite / 要重写的文档内容
   * @param target - Target save path / 目标保存路径
   * @param copyAll - Whether to copy all referenced resources (true for save-as/move) / 是否复制所有引用资源（另存/移动时为 true）
   * @returns Publication result with rewritten content, replacements and rollback / 含重写内容、替换和回滚的发布结果
   */
  async publish(id: string, content: string, target: string, copyAll: boolean): Promise<ResourcePublication> {
    const manifest = collectDocumentReferences(content), replacements: Record<string, string> = {}, created: { path: string; identity?: { ino: number; size: number; mtimeMs: number; ctimeMs: number } }[] = [];
    if (copyAll && manifest.unsupported.length) throw new DocumentError('DOCUMENT_RESOURCE_INVALID', `无法可靠迁移这些本地引用：${manifest.unsupported.join('；')}`);
    if (manifest.references.length > MAX_RESOURCES) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '单篇文档最多处理 200 个本地资源引用。');
    const directory = path.join(path.dirname(target), `${path.parse(target).name}.assets`); let directoryCreated = false;
    const rollback = async () => {
      let committedBody: Buffer | undefined;
      try { committedBody = await boundedRead(target, 20 * 1024 * 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      for (const file of created) {
        // Keep the file if it was externally modified or the committed body still references it.
        // 外部程序已改动产物或目标正文已引用它时，保留该文件。
        // The UUID prefix is recognizable in UTF-8/GBK/GB18030 and UTF-16 LE/BE bodies; avoid encoding-driven false-deletes.
        // UUID 在 UTF-8/GBK/GB18030 与 UTF-16 LE/BE 正文中都能识别；不因编码删掉引用中的资源。
        const marker = path.basename(file.path).slice(0, 36), utf16 = Buffer.from(marker, 'utf16le');
        if (committedBody && [Buffer.from(marker), utf16, Buffer.from(utf16).swap16()].some(bytes => committedBody.includes(bytes))) continue;
        const stat = await fs.stat(file.path).catch(() => undefined), prior = file.identity;
        if (stat && prior && stat.ino === prior.ino && stat.size === prior.size && stat.mtimeMs === prior.mtimeMs && stat.ctimeMs === prior.ctimeMs) await fs.unlink(assertInsideDirectory(file.path, directory)).catch(() => undefined);
      }
      if (directoryCreated) await fs.rmdir(directory).catch(() => undefined);
    };
    try {
      // All resources are pre-validated before writing; frozen bytes read in are never swapped for newer external versions.
      // 全部预检后再写入；读入的冻结资源字节不在后续提交中换成外部新版本。
      const copies: { href: string; filePath: string; fragment: string; bytes: Buffer }[] = []; let totalBytes = 0;
      for (const reference of manifest.references) {
        if (replacements[reference.href] || copies.some(item => item.href === reference.href)) continue;
        if (!copyAll && !reference.href.startsWith('trellora-draft:')) continue;
        const resource = await this.resolve(id, reference.href);
        const bytes = await boundedRead(resource.filePath, reference.image ? MAX_IMAGE_BYTES : MAX_RESOURCE_BYTES);
        totalBytes += bytes.length; if (totalBytes > 64 * 1024 * 1024) throw new DocumentError('DOCUMENT_RESOURCE_LIMIT', '本次资源总大小超过 64 MiB，请减少引用后重试。');
        copies.push({ href: reference.href, ...resource, bytes });
      }
      for (const item of copies) {
        assertInsideDirectory(directory, path.dirname(target)); try { await fs.mkdir(directory); directoryCreated = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const fileName = `${randomUUID()}-${sanitizeEntryName(path.basename(item.filePath))}`, destination = assertInsideDirectory(path.join(directory, fileName), directory);
        const handle = await fs.open(destination, 'wx'), owned: (typeof created)[number] = { path: destination }; created.push(owned);
        try { await handle.writeFile(item.bytes); await handle.sync(); } finally { owned.identity = await handle.stat().catch(() => undefined); await handle.close(); }
        replacements[item.href] = `${path.basename(directory)}/${fileName}${item.fragment}`;
      }
      return { content: rewriteDocumentReferences(content, replacements), replacements, rollback };
    } catch (error) { await rollback(); throw error; }
  }
  /**
   * Releases all grants and state for a session, optionally deleting draft assets not used elsewhere.
   * 释放会话的所有授权与状态，可选删除未被其他会话使用的草稿资源。
   *
   * @param id - Document session id / 文档会话标识
   * @param keepDrafts - Whether to preserve draft assets on disk / 是否保留磁盘上的草稿资源
   */
  async release(id: string, keepDrafts = false): Promise<void> {
    const assets = this.states.get(id)?.drafts ?? []; this.states.delete(id);
    for (const [token, grant] of this.grants) if (grant.sessionId === id) this.grants.delete(token);
    if (!keepDrafts) for (const asset of assets) if (![...this.states.values()].some(state => state.drafts.some(value => value.fileName === asset.fileName))) await fs.unlink(assertInsideDirectory(path.join(this.options.privateRoot, asset.fileName), this.options.privateRoot)).catch(() => undefined);
  }
}
function inside(candidate: string, root: string): boolean { const relative = path.relative(root, candidate); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function boundedRead(filePath: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try { const before = await handle.stat(); if (!before.isFile() || before.size > limit) throw new Error('资源超过大小限制。'); const bytes = Buffer.alloc(before.size + 1); const { bytesRead } = await handle.read(bytes); const after = await handle.stat(), named = await fs.stat(filePath); if (bytesRead > limit || bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== named.ino || after.ctimeMs !== named.ctimeMs) throw new Error('资源在读取期间发生变化，请重试。'); return bytes.subarray(0, bytesRead); } finally { await handle.close(); }
}
