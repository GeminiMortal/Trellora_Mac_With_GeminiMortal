/**
 * Exports notes to Markdown, HTML, or PDF with destination guards and sandboxed PDF rendering.
 * 将笔记导出为 Markdown、HTML 或 PDF，包含目标路径保护与沙箱化 PDF 渲染。
 */
import { app, BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NoteExportRequest } from './noteExport.ts';

const maxContentBytes = 40 * 1024 * 1024;
const pdfTimeoutMs = 45_000;
const activeExports = new Set<number>();
const exportCsp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; object-src 'none'; frame-src 'none';";

/**
 * All three formats share the save dialog, cancellation, and source-file protection; only PDF starts a separate print window.
 * 三种格式共用保存对话框、取消和原文件保护；只有 PDF 启动独立打印窗口。
 *
 * @param parent - Parent window for the save dialog / 保存对话框的父窗口
 * @param request - Export request describing format, content, and source / 描述格式、内容与源文件的导出请求
 * @returns Whether a file was written / 是否写出了文件
 */
export async function exportNoteFile(parent: BrowserWindow, request: NoteExportRequest): Promise<boolean> {
  // Reject malformed or oversized requests and serialize exports per window to avoid clobbering.
  // 拒绝格式错误或过大的请求，并按窗口串行化导出以避免相互覆盖。
  if (!request || !['md', 'html', 'pdf'].includes(request.format)
    || typeof request.defaultName !== 'string' || typeof request.content !== 'string' || typeof request.sourcePath !== 'string') throw new Error('笔记导出参数无效。');
  if (Buffer.byteLength(request.content, 'utf8') > maxContentBytes) throw new Error('导出内容超过 40 MB 上限，请压缩图片或拆分笔记后重试。');
  if (activeExports.has(parent.id)) throw new Error('已有笔记正在导出，请稍后重试。');
  activeExports.add(parent.id);
  try {
    const stem = [...request.defaultName.replace(/[<>:"/\\|?*]/g, '')].filter(char => char.charCodeAt(0) >= 32).join('').trim().replace(/[. ]+$/g, '') || 'note';
    const result = await dialog.showSaveDialog(parent, {
      title: `导出 ${request.format === 'md' ? 'Markdown' : request.format.toUpperCase()}`,
      defaultPath: `${stem}.${request.format}`,
      filters: [{ name: request.format === 'md' ? 'Markdown' : request.format.toUpperCase(), extensions: [request.format] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return false;
    const target = path.extname(result.filePath).toLowerCase() === `.${request.format}` ? result.filePath : `${result.filePath}.${request.format}`;
    await assertExportDestination(target, request.sourcePath);
    const bytes = request.format === 'pdf' ? await renderNotePdf(request.content, parent) : Buffer.from(request.content, 'utf8');
    if (parent.isDestroyed()) throw new Error('笔记窗口已关闭，导出已取消。');
    await writeExportFile(target, bytes, request.sourcePath);
    return true;
  } finally { activeExports.delete(parent.id); }
}

/**
 * Literal paths, real paths, and file identity must all differ from the current source note, including symlinks and hard links.
 * 字面路径、真实路径和文件身份都不能指向当前原笔记，包括符号链接和硬链接。
 *
 * @param target - Candidate export destination / 候选导出目标路径
 * @param source - Path of the note being exported / 被导出笔记的源路径
 * @returns Promise that rejects when the destination aliases the source / 目标与源文件别名冲突时 reject
 */
export async function assertExportDestination(target: string, source: string): Promise<void> {
  const samePath = (left: string, right: string) => path.relative(path.resolve(left), path.resolve(right)) === '';
  if (samePath(target, source)) throw new Error('导出不能覆盖当前原笔记，请选择其他文件名或目录。');
  const resolve = (file: string) => fs.realpath(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return path.resolve(file); });
  const [realTarget, realSource] = await Promise.all([resolve(target), resolve(source)]);
  if (samePath(realTarget, realSource)) throw new Error('导出位置指向当前原笔记，请选择其他文件。');
  // dev+ino equality catches hard links that path comparison cannot see.
  // dev+ino 比较可发现路径比较无法识别的硬链接。
  const stat = (file: string) => fs.stat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  const [targetStat, sourceStat] = await Promise.all([stat(target), stat(source)]);
  if (targetStat && sourceStat && targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) throw new Error('导出位置与原笔记是同一个文件，请选择其他文件。');
}

/**
 * Writes and fsyncs a same-directory temporary file before replacing, so a failed write keeps any previous export intact.
 * 完整写入并同步同目录临时文件后再替换，写入失败保留原有导出文件。
 *
 * @param target - Destination file path / 目标文件路径
 * @param bytes - File content to write / 要写入的文件内容
 * @param source - Original note path used for overwrite protection / 用于防覆盖保护的原笔记路径
 * @returns Promise that resolves after the atomic replace / 原子替换完成后 resolve
 */
export async function writeExportFile(target: string, bytes: Buffer, source: string): Promise<void> {
  await assertExportDestination(target, source);
  const temporary = path.join(path.dirname(target), `.trellora-export-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx');
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    // Re-check the destination just before rename to close the TOCTOU window.
    // 在重命名前再次校验目标，收窄 TOCTOU 时间窗口。
    await assertExportDestination(target, source);
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/**
 * Loads self-contained HTML in a separate sandboxed window and prints the full document with Chromium, closing the window and temp files at the end.
 * 独立沙箱窗口只加载自包含 HTML；就绪后使用 Chromium 打印完整文档，最终关闭窗口和临时文件。
 *
 * @param html - Complete HTML document to print / 要打印的完整 HTML 文档
 * @param parent - Optional parent window whose close aborts the export / 可选父窗口，其关闭会中止导出
 * @returns The generated PDF bytes / 生成的 PDF 字节内容
 */
export async function renderNotePdf(html: string, parent?: BrowserWindow): Promise<Buffer> {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > maxContentBytes || !/^<!doctype html>/i.test(html) || !/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('PDF 导出 HTML 无效。');
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'trellora-pdf-export-'));
  const documentPath = path.join(directory, 'document.html');
  let printWindow: BrowserWindow | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (printWindow && !printWindow.isDestroyed()) printWindow.destroy(); };
  try {
    // The forced CSP overrides any declaration in the content; the export page may not read local files or reach the network.
    // 强制 CSP 优先于内容中的声明，不允许导出页面读取本地文件或访问网络。
    await fs.writeFile(documentPath, html.replace(/<head(?:\s[^>]*)?>/i, `$&<meta http-equiv="Content-Security-Policy" content="${exportCsp}">`), 'utf8');
    printWindow = new BrowserWindow({
      show: false, width: 900, height: 1100,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: `note-pdf-export-${randomUUID()}` },
    });
    const contents = printWindow.webContents;
    const documentUrl = pathToFileURL(documentPath).href;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (url !== documentUrl) event.preventDefault(); });
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== documentUrl && !details.url.startsWith('data:') }));
    parent?.once('closed', cancel);
    const generation = (async () => {
      await printWindow!.loadFile(documentPath);
      const ready = await contents.executeJavaScript(`(async () => {
        document.body.getBoundingClientRect();
        await document.fonts.ready;
        try { await Promise.all([...document.images].map(image => image.decode())); }
        catch { return false; }
        return [...document.images].every(image => image.complete && image.naturalWidth > 0);
      })()`);
      if (!ready) throw new Error('PDF 中有图片无法加载，请检查图片引用后重试。');
      return contents.printToPDF({ pageSize: 'A4', printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true,
        margins: { top: 0.63, bottom: 0.63, left: 0.63, right: 0.63 }, generateTaggedPDF: true, generateDocumentOutline: true });
    })();
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PDF 导出超时，请压缩图片或拆分笔记后重试。')), pdfTimeoutMs); });
    return await Promise.race([generation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeListener('closed', cancel);
    cancel();
    await fs.unlink(documentPath).catch(() => undefined);
    await fs.rmdir(directory).catch(() => undefined);
  }
}
