/**
 * Document IPC handlers — extracted from main.ts.
 * Handles 23 document-related IPC channels (documents:*).
 */

import { dialog } from 'electron';
import type { IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import path from 'node:path';
import type { DocumentAiService } from '../documents/documentAiService';
import type { OpenRequestRouter } from '../documents/openRequestRouter';
import type { DocumentSessionService } from '../documents/documentSessionService';
import type { DocumentAiRequest, DocumentAiApplyRequest } from '../../shared/documentAi';
import type { DocumentEncoding, DocumentDraftRequest, DocumentSaveRequest, DocumentSaveResult, DocumentCloseRequest, DocumentJoinRequest } from '../../shared/documentSession';
import type { MaintenanceBarrier } from '../backup/maintenance';
import type { WorkspaceMigrationService } from '../workspace/workspaceMigrationService';

export interface DocumentIpcDependencies {
  registerAppHandler: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
  assertNoteWindow: (event: IpcMainInvokeEvent | IpcMainEvent) => void;
  getDocumentSessionService: () => DocumentSessionService;
  documentOpenRouter: OpenRequestRouter;
  getDocumentAiService: () => DocumentAiService;
  documentAiService: DocumentAiService | null;
  mainWindow: Electron.BrowserWindow | null;
  maintenanceBarrier: MaintenanceBarrier;
  workspaceMigrationService: WorkspaceMigrationService | null;
  desktopText: (source: string, values?: Record<string, string | number>) => string;
}

export function registerDocumentHandlers(d: DocumentIpcDependencies): void {
  const { registerAppHandler, assertNoteWindow, getDocumentSessionService, documentOpenRouter, getDocumentAiService, documentAiService, mainWindow, maintenanceBarrier, workspaceMigrationService, desktopText } = d;

  registerAppHandler('documents:pick-file', async event => {
    assertNoteWindow(event);
    const result = await dialog.showOpenDialog(mainWindow!, { title: desktopText('打开独立文件'), properties: ['openFile'], filters: [{ name: 'Markdown / Text', extensions: ['md', 'markdown', 'txt', 'json', 'csv', 'yaml', 'yml', 'log'] }, { name: 'All Files', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    if (maintenanceBarrier.phase !== 'idle' || workspaceMigrationService?.busy) throw new Error('当前正在维护，请完成后重新打开文件。');
    return (await documentOpenRouter.submit([path.resolve(result.filePaths[0])]))[0];
  });

  registerAppHandler('documents:list-open-requests', async event => { assertNoteWindow(event); await documentOpenRouter.flush(); return getDocumentSessionService().listRequests(event.sender.id); });

  registerAppHandler('documents:open-failures', event => { assertNoteWindow(event); return documentOpenRouter.takeFailures(); });

  registerAppHandler('documents:drop-files', async (event, files: string[]) => {
    assertNoteWindow(event); if (!Array.isArray(files) || files.length > 200 || files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) throw new Error('拖放文件路径无效，请使用打开文件。');
    await documentOpenRouter.drop(files);
  });

  registerAppHandler('documents:open-request', (event, id: string, encoding?: DocumentEncoding) => { assertNoteWindow(event); return getDocumentSessionService().openRequest(event.sender.id, id, encoding); });

  registerAppHandler('documents:finish-open-request', (event, id: string) => { assertNoteWindow(event); return getDocumentSessionService().finishRequest(event.sender.id, id); });

  registerAppHandler('documents:update-draft', (event, request: DocumentDraftRequest) => { assertNoteWindow(event); return getDocumentSessionService().updateDraft(event.sender.id, request); });

  registerAppHandler('documents:resource-preview', (event, id: string) => { assertNoteWindow(event); return getDocumentSessionService().previewResources(event.sender.id, id); });

  registerAppHandler('documents:grant-resource-root', async (event, id: string) => {
    assertNoteWindow(event); const service = getDocumentSessionService(); service.displayPath(event.sender.id, id);
    const result = await dialog.showOpenDialog(mainWindow!, { title: desktopText('选择只读资源目录'), properties: ['openDirectory'] });
    if (result.canceled) return false; service.grantResourceRoot(event.sender.id, id, result.filePaths[0]); return true;
  });

  registerAppHandler('documents:open-link', async (event, id: string, href: string) => { assertNoteWindow(event); const service = getDocumentSessionService(); service.snapshot(event.sender.id, id); return (await documentOpenRouter.submit([await service.resources.openLink(id, href)]))[0]; });

  registerAppHandler('documents:add-image', (event, id: string, input: { bytes?: Uint8Array; extension?: string; sourcePath?: string }) => {
    assertNoteWindow(event); if (!input || (input.sourcePath ? typeof input.sourcePath !== 'string' : !(input.bytes instanceof Uint8Array) || typeof input.extension !== 'string')) throw new Error('图片参数无效。');
    return getDocumentSessionService().addDraftImage(event.sender.id, id, input);
  });

  registerAppHandler('documents:ai-run', (event, request: DocumentAiRequest) => { assertNoteWindow(event); return getDocumentAiService().run(event.sender.id, request); });

  registerAppHandler('documents:ai-apply', (event, request: DocumentAiApplyRequest) => { assertNoteWindow(event); return getDocumentAiService().apply(event.sender.id, request); });

  registerAppHandler('documents:ai-cancel', (event, requestId: string) => { assertNoteWindow(event); documentAiService?.cancel(event.sender.id, requestId); });

  registerAppHandler('documents:save', (event, request: DocumentSaveRequest) => { assertNoteWindow(event); return getDocumentSessionService().save(event.sender.id, request); });

  const documentSaveAsRequests = new Map<string, { fingerprint: string; task: Promise<DocumentSaveResult | null> }>();

  registerAppHandler('documents:save-as', (event, request: DocumentSaveRequest) => {
    assertNoteWindow(event);
    getDocumentSessionService().displayPath(event.sender.id, request?.documentSessionId);
    if (!request?.requestId || typeof request.requestId !== 'string') throw new Error('另存请求无效。');
    const key = `${event.sender.id}:${request.requestId}`, fingerprint = JSON.stringify(request), previous = documentSaveAsRequests.get(key);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('重试参数不能变化。'); return previous.task; }
    const task = (async () => {
    const result = await dialog.showSaveDialog(mainWindow!, { title: desktopText('独立文件另存为'), defaultPath: getDocumentSessionService().displayPath(event.sender.id, request?.documentSessionId), filters: [{ name: 'Text', extensions: ['md', 'txt', 'markdown'] }, { name: 'All Files', extensions: ['*'] }] });
    if (result.canceled || !result.filePath) return null;
    if (maintenanceBarrier.phase !== 'idle' || workspaceMigrationService?.busy) throw new Error('当前正在维护，请完成后重新另存。');
    const service = getDocumentSessionService(), target = path.resolve(result.filePath);
    const hash = await service.targetHash(event.sender.id, request.documentSessionId, target);
    if (hash !== null && target !== service.displayPath(event.sender.id, request.documentSessionId)) {
      const confirmation = await dialog.showMessageBox(mainWindow!, { type: 'question', title: desktopText('确认覆盖文件'), message: desktopText('目标文件已存在，是否覆盖？'), detail: target, buttons: [desktopText('覆盖'), desktopText('取消')], defaultId: 1, cancelId: 1, noLink: true });
      if (confirmation.response !== 0) return null;
    }
    if (maintenanceBarrier.phase !== 'idle' || workspaceMigrationService?.busy) throw new Error('当前正在维护，请完成后重新另存。');
    return service.saveAs(event.sender.id, request, target, hash);
    })();
    documentSaveAsRequests.set(key, { fingerprint, task });
    void task.catch(() => { documentSaveAsRequests.delete(key); });
    return task;
  });

  registerAppHandler('documents:refresh', (event, id: string, revision: number, encoding?: DocumentEncoding, discard = false) => { assertNoteWindow(event); return getDocumentSessionService().reopen(event.sender.id, id, revision, encoding, discard === true); });

  registerAppHandler('documents:close', async (event, request: DocumentCloseRequest) => { assertNoteWindow(event); const result = await getDocumentSessionService().close(event.sender.id, request); documentAiService?.release(request.documentSessionId); return result; });

  registerAppHandler('documents:join-library', (event, request: DocumentJoinRequest) => { assertNoteWindow(event); return getDocumentSessionService().join(event.sender.id, request); });

  registerAppHandler('documents:list-recovery', event => { assertNoteWindow(event); return getDocumentSessionService().recovery.list(); });

  registerAppHandler('documents:restore-draft', (event, id: string) => { assertNoteWindow(event); return getDocumentSessionService().restore(event.sender.id, id); });

  registerAppHandler('documents:list-recent', event => { assertNoteWindow(event); return getDocumentSessionService().recovery.recent(); });

  registerAppHandler('documents:open-recent', async (event, displayPath: string) => {
    assertNoteWindow(event); const service = getDocumentSessionService();
    if (!(await service.recovery.recent()).some(record => record.displayPath === displayPath)) throw new Error('最近文件记录已失效，请重新选择文件。');
    return (await documentOpenRouter.submit([displayPath]))[0];
  });
}