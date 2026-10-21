/**
 * Memory IPC handlers — extracted from main.ts.
 * 记忆相关 IPC 处理器——从 main.ts 提取。
 */

import fs from 'node:fs';
import { dialog } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { AssistantMemoryRepository } from '../knowledge/assistant/assistantMemoryRepository.ts';
import type { AssistantMemoryMode, AssistantSessionScope } from '../knowledge/assistant/assistantMemoryTypes.ts';
import type { MemoryExtractionModelResolution } from '../knowledge/memory/memoryExtractionService.ts';
import type { MemoryExtractionService } from '../knowledge/memory/memoryExtractionService.ts';
import type { MemoryWriteService } from '../knowledge/memory/memoryWriteService.ts';
import type { MemoryRecallService } from '../knowledge/memory/memoryRecallService.ts';
import type { MemoryAffinityService } from '../knowledge/memory/memoryAffinityService.ts';
import type { MemoryConsolidationService } from '../knowledge/memory/memoryConsolidationService.ts';
import type { MemoryTopicService } from '../knowledge/memory/memoryTopicService.ts';
import type { QaMemoryOrchestrator } from '../knowledge/qa/qaMemoryOrchestrator.ts';
import type { QaSessionScope } from '../knowledge/qa/qaMemoryTypes.ts';
import type { ManualMemoryInput, MemoryItemPatch, MemoryItemListQuery, MemoryItemPageQuery, MemoryPageQuery, MemoryProposalReview, WorkspaceMemoryConfig } from '../knowledge/memory/memoryTypes.ts';
import type { AssistantSessionScopeRegistry } from '../knowledge/assistant/assistantSessionScope.ts';
import type { BrowserWindow } from 'electron';

/** Dependencies injected from main.ts. / 从 main.ts 注入的依赖。 */
export interface MemoryIpcDependencies {
  registerAppHandler(channel: string, handler: (...args: any[]) => any): void;
  assertInternalRenderer(event: IpcMainInvokeEvent): void;
  resolveActiveLongTermMemoryScope(): { scope: { workspaceId: string; principalId: string }; workspacePath: string };
  getMemoryWriteService(): MemoryWriteService;
  getMemoryExtractionService(): MemoryExtractionService;
  getMemoryRecallService(): MemoryRecallService;
  getMemoryAffinityService(): MemoryAffinityService;
  getMemoryConsolidationService(storagePath?: string): MemoryConsolidationService;
  getMemoryTopicService(): MemoryTopicService;
  getQaMemoryOrchestrator(): QaMemoryOrchestrator;
  getAssistantMemoryRepository(libraryPath: string): AssistantMemoryRepository;
  requireCurrentLibraryPath(): string;
  parseManualMemoryInput(value: unknown): ManualMemoryInput;
  parseMemoryItemPatch(value: unknown): MemoryItemPatch;
  parseMemoryProposalReview(value: unknown): MemoryProposalReview | undefined;
  resolveMemoryExtractionModel(seed: any, config: any): Promise<MemoryExtractionModelResolution>;
  reviewConsolidationWithModel(generate: any, model: any, items: any, control: any): Promise<any>;
  generateAiJsonWithOptions(request: any): Promise<any>;
  createAssistantSessionId(): string;
  assistantSessionScopeRegistry: AssistantSessionScopeRegistry;
  getCurrentNoteSnapshotForAssistantMemory(libraryPath: string, notePath: string): any;
  validateAssistantCitationAgainstSnapshot(citation: any, snapshot: any): any;
  getMemoryCutoverReport(): any;
  qaMemoryDatabase: any;
  isMemoryExtractionRouteEnabled(route: string, agentId: string): boolean;
  MEMORY_CONSTANTS: { management: { listDefaultLimit: number } };
  mainWindow: BrowserWindow | null;
  resolveManualMemoryConsolidationModel(scope: any): Promise<MemoryExtractionModelResolution>;
  getAssistantMemoryMode(repository: AssistantMemoryRepository): AssistantMemoryMode;
  getAssistantMemoryIpcContext(event: IpcMainInvokeEvent, notePath: unknown): { libraryPath: string; snapshot: any; repository: AssistantMemoryRepository };
  getAuthorizedAssistantMemoryScope(event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown): { libraryPath: string; snapshot: any; repository: AssistantMemoryRepository; scope: AssistantSessionScope };
}

/** Register all memory-related IPC handlers. / 注册所有记忆相关 IPC 处理器。 */
export function registerMemoryHandlers(d: MemoryIpcDependencies): void {
  d.registerAppHandler('qa-memory:create-session', (event: IpcMainInvokeEvent, scope: unknown = 'chat', libraryPath?: unknown) => {
    d.assertInternalRenderer(event);
    if (scope !== 'chat' && scope !== 'knowledge-base') throw new Error('问答会话模式无效。');
    const sessionScope = scope as QaSessionScope;
    const normalizedLibraryPath = typeof libraryPath === 'string' ? libraryPath.trim() : '';
    if (sessionScope === 'knowledge-base' && !normalizedLibraryPath) throw new Error('请先选择知识库。');
    return d.getQaMemoryOrchestrator().repository.createSession(sessionScope, normalizedLibraryPath ? { libraryPath: normalizedLibraryPath } : {});
  });
  d.registerAppHandler('memory:get-cutover-report', (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    return d.getMemoryCutoverReport();
  });
  d.registerAppHandler('qa-memory:list-sessions', (event: IpcMainInvokeEvent, cursor?: unknown) => {
    d.assertInternalRenderer(event);
    return d.getQaMemoryOrchestrator().repository.listSessions({
      cursor: typeof cursor === 'number' ? cursor : undefined,
      pageSize: 10,
    });
  });
  d.registerAppHandler('qa-memory:get-session', (event: IpcMainInvokeEvent, sessionId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string') throw new Error('问答记忆会话标识无效。');
    return d.getQaMemoryOrchestrator().repository.getSession(sessionId);
  });
  d.registerAppHandler('qa-memory:rename-session', (event: IpcMainInvokeEvent, sessionId: unknown, title: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string' || typeof title !== 'string') throw new Error('问答记忆会话重命名参数无效。');
    return d.getQaMemoryOrchestrator().repository.renameSession(sessionId, title);
  });
  d.registerAppHandler('qa-memory:set-pinned', (event: IpcMainInvokeEvent, sessionId: unknown, pinned: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string' || typeof pinned !== 'boolean') throw new Error('问答记忆会话置顶参数无效。');
    return d.getQaMemoryOrchestrator().repository.setPinned(sessionId, pinned);
  });
  d.registerAppHandler('qa-memory:delete-session', (event: IpcMainInvokeEvent, sessionId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string') throw new Error('问答记忆会话标识无效。');
    const orchestrator = d.getQaMemoryOrchestrator();
    orchestrator.cancelSession(sessionId);
    orchestrator.repository.deleteSession(sessionId);
    return true;
  });
  d.registerAppHandler('memory:get-overview', (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const service = d.getMemoryWriteService();
    return {
      workspaceConfig: service.getWorkspaceConfig(scope),
      subject: service.getSubject(scope),
      availability: service.getAvailability(scope),
      extractionRuntime: d.getMemoryExtractionService().getRuntimeStatus(scope),
      itemCounts: service.getItemCounts(scope),
    };
  });
  d.registerAppHandler('memory:save-workspace-config', (event: IpcMainInvokeEvent, patch: unknown) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const config = d.getMemoryWriteService().updateWorkspaceConfig(scope, patch as Partial<WorkspaceMemoryConfig>);
    d.getMemoryExtractionService().refreshConfiguration(scope);
    return config;
  });
  d.registerAppHandler('memory:set-principal-enabled', (event: IpcMainInvokeEvent, enabled: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof enabled !== 'boolean') throw new Error('长期记忆开关参数无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const result = d.getMemoryWriteService().setPrincipalEnabled(scope, enabled);
    d.getMemoryExtractionService().refreshConfiguration(scope);
    return result;
  });
  d.registerAppHandler('memory:list-items', (event: IpcMainInvokeEvent, query?: unknown) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const normalizedQuery = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryItemListQuery : {};
    return d.getMemoryWriteService().list(scope, normalizedQuery);
  });
  d.registerAppHandler('memory:list-topics', (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryTopicService().list(scope);
  });
  d.registerAppHandler('memory:list-item-page', (event: IpcMainInvokeEvent, query?: unknown) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const normalized = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryItemPageQuery : {};
    return d.getMemoryWriteService().listPage(scope, normalized);
  });
  d.registerAppHandler('memory:list-topic-page', (event: IpcMainInvokeEvent, query?: unknown) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const normalized = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryPageQuery : {};
    return d.getMemoryTopicService().listPage(scope, normalized);
  });
  d.registerAppHandler('memory:list-document-page', (event: IpcMainInvokeEvent, query?: unknown) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const normalized = query && typeof query === 'object' && !Array.isArray(query) ? query as MemoryPageQuery : {};
    return d.getMemoryAffinityService().listPage(scope, normalized);
  });
  d.registerAppHandler('memory:promote-topic', (event: IpcMainInvokeEvent, topicId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof topicId !== 'string' || !topicId.trim()) throw new Error('主题标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryTopicService().promote(scope, topicId);
  });
  d.registerAppHandler('memory:delete-topic', (event: IpcMainInvokeEvent, topicId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof topicId !== 'string' || !topicId.trim()) throw new Error('主题标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    d.getMemoryTopicService().delete(scope, topicId);
    return true;
  });
  d.registerAppHandler('memory:list-documents', (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryAffinityService().list(scope);
  });
  d.registerAppHandler('memory:delete-document', (event: IpcMainInvokeEvent, documentId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('文档标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryAffinityService().delete(scope, documentId);
  });
  d.registerAppHandler('memory:get-used-for-turn', (event: IpcMainInvokeEvent, turnId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof turnId !== 'string' || !turnId.trim()) throw new Error('回答标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryRecallService().listUsedMemories(scope, turnId);
  });
  d.registerAppHandler('memory:get-citation-source', (event: IpcMainInvokeEvent, turnId: unknown, itemId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof turnId !== 'string' || !turnId.trim() || typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆引用标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryRecallService().getCitationSource(scope, turnId, itemId);
  });
  d.registerAppHandler('memory:create-item', (event: IpcMainInvokeEvent, input: unknown) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryWriteService().createManual(scope, d.parseManualMemoryInput(input));
  });
  d.registerAppHandler('memory:update-item', (event: IpcMainInvokeEvent, itemId: unknown, patch: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryWriteService().updateManual(scope, itemId, d.parseMemoryItemPatch(patch));
  });
  d.registerAppHandler('memory:delete-item', (event: IpcMainInvokeEvent, itemId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    d.getMemoryWriteService().delete(scope, itemId);
    return true;
  });
  d.registerAppHandler('memory:confirm-item', (event: IpcMainInvokeEvent, itemId: unknown, review: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryWriteService().confirm(scope, itemId, d.parseMemoryProposalReview(review));
  });
  d.registerAppHandler('memory:get-proposal-context', (event: IpcMainInvokeEvent, itemId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
    return d.getMemoryWriteService().getProposalContext(d.resolveActiveLongTermMemoryScope().scope, itemId);
  });
  d.registerAppHandler('memory:get-turn-status', (event: IpcMainInvokeEvent, turnIds: unknown) => {
    d.assertInternalRenderer(event);
    if (!Array.isArray(turnIds) || turnIds.length > d.MEMORY_CONSTANTS.management.listDefaultLimit || turnIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('回答标识列表无效。');
    const { scope, workspacePath } = d.resolveActiveLongTermMemoryScope();
    return new (d as any).MemoryTurnStatusService(d.qaMemoryDatabase, workspacePath, d.isMemoryExtractionRouteEnabled).get(scope, turnIds);
  });
  d.registerAppHandler('memory:approve-consolidation', (event: IpcMainInvokeEvent, id: unknown, fingerprint: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof id !== 'string' || !id.trim() || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('整理预览参数无效。');
    const { scope, workspacePath } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryConsolidationService(workspacePath).approvePreview(scope, id, fingerprint);
  });
  d.registerAppHandler('memory:reject-item', (event: IpcMainInvokeEvent, itemId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('记忆条目标识无效。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryWriteService().reject(scope, itemId);
  });
  d.registerAppHandler('memory:clear', (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return d.getMemoryWriteService().clear(scope);
  });
  d.registerAppHandler('memory:export', async (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    if (!d.mainWindow) throw new Error('应用窗口不可用。');
    const { scope } = d.resolveActiveLongTermMemoryScope();
    const exported = d.getMemoryWriteService().export(scope);
    const target = await dialog.showSaveDialog(d.mainWindow, {
      title: '导出长期记忆',
      defaultPath: `Trellora-长期记忆-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (target.canceled || !target.filePath) return { canceled: true, exportedItems: 0 };
    fs.writeFileSync(target.filePath, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
    return { canceled: false, exportedItems: exported.items.length };
  });
  d.registerAppHandler('memory:import', async (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    if (!d.mainWindow) throw new Error('应用窗口不可用。');
    const selected = await dialog.showOpenDialog(d.mainWindow, {
      title: '导入长期记忆备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) {
      return { canceled: true, importedItems: 0, unchangedItems: 0, skippedItems: 0 };
    }
    const parsed = JSON.parse(fs.readFileSync(selected.filePaths[0], 'utf8')) as unknown;
    const { scope } = d.resolveActiveLongTermMemoryScope();
    return { canceled: false, ...d.getMemoryWriteService().import(scope, parsed) };
  });
  d.registerAppHandler('memory:consolidate', async (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    const { scope, workspacePath } = d.resolveActiveLongTermMemoryScope();
    const service = d.getMemoryConsolidationService(workspacePath);
    let model: MemoryExtractionModelResolution | undefined;
    return service.consolidate(scope, 'manual', async (items: any, control: any) => {
      model ??= await d.resolveManualMemoryConsolidationModel(scope);
      if (!model.ready) throw new Error(`MODEL_UNAVAILABLE:${model.code}`);
      return d.reviewConsolidationWithModel(d.generateAiJsonWithOptions, model, items, control);
    });
  });

  d.registerAppHandler('assistant-memory:get-settings', (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    const libraryPath = d.requireCurrentLibraryPath();
    return d.getAssistantMemoryRepository(libraryPath).getSettings();
  });
  d.registerAppHandler('assistant-memory:set-settings', (event: IpcMainInvokeEvent, mode: unknown) => {
    d.assertInternalRenderer(event);
    if (mode !== 'persistent' && mode !== 'session-only' && mode !== 'disabled') throw new Error('AI 会话记忆模式无效。');
    const libraryPath = d.requireCurrentLibraryPath();
    return d.getAssistantMemoryRepository(libraryPath).setSettings(mode);
  });
  d.registerAppHandler('assistant-memory:create-session', (event: IpcMainInvokeEvent, notePath: unknown) => {
    d.assertInternalRenderer(event);
    const { snapshot, repository } = d.getAssistantMemoryIpcContext(event, notePath);
    if (d.getAssistantMemoryMode(repository) !== 'persistent') {
      const createdAt = new Date().toISOString();
      return { sessionId: d.createAssistantSessionId(), title: '仅本次对话', status: 'active' as const, turnCount: 0, createdAt, updatedAt: createdAt };
    }
    const session = repository.createSession({
      libraryId: snapshot.libraryId,
      relativePath: snapshot.relativePath,
      contentHash: snapshot.contentHash,
      title: '新对话',
    });
    const scope = repository.resolveScope({
      libraryId: snapshot.libraryId,
      relativePath: snapshot.relativePath,
      contentHash: snapshot.contentHash,
      sessionId: session.sessionId,
    });
    d.assistantSessionScopeRegistry.authorize(scope, event.sender.id);
    return session;
  });
  d.registerAppHandler('assistant-memory:list-sessions', (event: IpcMainInvokeEvent, notePath: unknown, page?: unknown) => {
    d.assertInternalRenderer(event);
    const { snapshot, repository } = d.getAssistantMemoryIpcContext(event, notePath);
    if (d.getAssistantMemoryMode(repository) !== 'persistent') return { items: [] };
    return repository.listSessions({
      libraryId: snapshot.libraryId,
      relativePath: snapshot.relativePath,
      contentHash: snapshot.contentHash,
      ...(typeof page === 'number' ? { page } : {}),
    });
  });
  d.registerAppHandler('assistant-memory:get-session', (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown, page?: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string') throw new Error('AI 会话标识无效。');
    const { repository, scope } = d.getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
    return repository.getSession(scope, typeof page === 'number' ? page : undefined);
  });
  d.registerAppHandler('assistant-memory:archive-session', (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string') throw new Error('AI 会话标识无效。');
    const { repository, scope } = d.getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
    return repository.archiveSession(scope);
  });
  d.registerAppHandler('assistant-memory:delete-session', (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string') throw new Error('AI 会话标识无效。');
    const { repository, scope } = d.getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
    repository.deleteSession(scope);
    return true;
  });
  d.registerAppHandler('assistant-memory:clear-note', (event: IpcMainInvokeEvent, notePath: unknown) => {
    d.assertInternalRenderer(event);
    const { snapshot, repository } = d.getAssistantMemoryIpcContext(event, notePath);
    return repository.clearNote({ libraryId: snapshot.libraryId, relativePath: snapshot.relativePath, contentHash: snapshot.contentHash });
  });
  d.registerAppHandler('assistant-memory:export-session', async (event: IpcMainInvokeEvent, notePath: unknown, sessionId: unknown, format: unknown) => {
    d.assertInternalRenderer(event);
    if (typeof sessionId !== 'string' || (format !== 'markdown' && format !== 'json')) throw new Error('AI 会话导出参数无效。');
    const { repository, scope } = d.getAuthorizedAssistantMemoryScope(event, notePath, sessionId);
    const exported = repository.exportSession(scope, format);
    if (!d.mainWindow) throw new Error('应用窗口不可用。');
    const target = await dialog.showSaveDialog(d.mainWindow, {
      title: '导出 AI 会话',
      defaultPath: exported.suggestedFileName,
      filters: [format === 'json' ? { name: 'JSON 文件', extensions: ['json'] } : { name: 'Markdown 文件', extensions: ['md'] }],
    });
    if (target.canceled || !target.filePath) return false;
    fs.writeFileSync(target.filePath, exported.content, 'utf8');
    return true;
  });
  d.registerAppHandler('assistant-memory:backup', async (event: IpcMainInvokeEvent) => {
    d.assertInternalRenderer(event);
    const libraryPath = d.requireCurrentLibraryPath();
    if (!d.mainWindow) throw new Error('应用窗口不可用。');
    const target = await dialog.showSaveDialog(d.mainWindow, {
      title: '备份 AI 会话记忆库',
      defaultPath: 'assistant-memory-backup.db',
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
    });
    if (target.canceled || !target.filePath) return false;
    await d.getAssistantMemoryRepository(libraryPath).backup(target.filePath);
    return true;
  });
}