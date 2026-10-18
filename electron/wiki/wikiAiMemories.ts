import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import { atomicWriteJson, safeSegment } from '../pipeline/pathLayout.ts';
import { getLibraryMetaDirectory } from '../files/treeOrder.ts';
import type { AssistantConversationMessage } from '../knowledge/assistant/assistantTurnTypes.ts';
import type { WikiDocumentOutline } from './wikiOutline.ts';

/**
 * Local persistence for Wiki node AI memories.
 * Wiki 节点 AI 记忆的本地持久化。
 *
 * Each chapter can keep multiple independent, continuously updated Q&A memories written to
 * `.menghan-meta/wiki/<docId>.ai-memories.json`. Like derived nodes it uses `contentHash` as the invalidation
 * key, so stale context is never fed back to the model after the source material changes. Source material files
 * are never read or modified.
 * 每个章节可保留多份独立、持续更新的问答记忆，写入
 * `.menghan-meta/wiki/<docId>.ai-memories.json`。它与派生节点一样以
 * `contentHash` 作为失效键，避免源资料变化后把旧上下文继续提供给模型。
 * 原始资料文件不会被读取或修改。
 */

const MAX_MEMORIES = 500;
const MAX_MEMORY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_TITLE_CHARS = 120;
const MAX_CONVERSATION_MESSAGES = 6;
const MAX_CONVERSATION_MESSAGE_CHARS = 2_000;
const MAX_CONVERSATION_TOTAL_CHARS = 4_000;

/**
 * IPC error codes for Wiki AI memory operations.
 * Wiki AI 记忆操作的 IPC 错误码。
 */
export type WikiAiMemoryErrorCode =
  | 'WIKI_MEMORY_INVALID'
  | 'WIKI_MEMORY_NODE_NOT_FOUND'
  | 'WIKI_MEMORY_NOT_FOUND'
  | 'WIKI_MEMORY_LIMIT'
  | 'WIKI_MEMORY_SAVE_FAILED'
  | 'WIKI_MEMORY_SOURCE_STALE';

/**
 * One persisted Wiki AI memory: an independent Q&A conversation attached to a chapter node.
 * 一条落库的 Wiki AI 记忆：挂在章节节点上的独立问答会话。
 */
export interface WikiAiMemory {
  id: string;
  nodeId: string;
  title: string;
  /** Pin state; pinned memories sort first. / 置顶状态；置顶记忆排在最前。 */
  pinned: boolean;
  /** Stored conversation turns of this memory. / 该记忆保存的对话轮次。 */
  conversation: AssistantConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

interface WikiAiMemoriesFile {
  schemaVersion: 1;
  documentId: string;
  contentHash: string;
  memories: WikiAiMemory[];
}

/**
 * Result listing all valid memories of the document, or a coded error.
 * 列出文档全部有效记忆的结果，或带错误码的失败。
 */
export type WikiAiMemoryListResult =
  | { ok: true; memories: WikiAiMemory[] }
  | { ok: false; error: WikiAiMemoryFailure };

/**
 * Result of a single-memory create/update/rename/pin operation.
 * 单条记忆的创建/更新/重命名/置顶操作结果。
 */
export type WikiAiMemoryResult =
  | { ok: true; memory: WikiAiMemory }
  | { ok: false; error: WikiAiMemoryFailure };

/**
 * Result of a memory delete operation: the deleted memory id or a coded error.
 * 记忆删除结果：被删除记忆 id 或带错误码的失败。
 */
export type WikiAiMemoryDeleteResult =
  | { ok: true; deletedMemoryId: string }
  | { ok: false; error: WikiAiMemoryFailure };

/**
 * Request payload to upsert a memory's conversation after a successful node Q&A turn.
 * 节点问答成功后写回记忆会话的 upsert 请求负载。
 */
export interface WikiAiMemoryUpsertRequest {
  documentId: string;
  nodeId: string;
  /**
   * When omitted, legacy data compatibility applies: the most recent memory of the chapter is updated; the new UI
   * always passes the current memory id.
   * 缺省时兼容旧数据：更新该章节最近一次记忆；新 UI 始终传入当前记忆标识。
   */
  memoryId?: string;
  conversation: AssistantConversationMessage[];
}

/**
 * Request payload to create a blank memory for a chapter.
 * 为章节创建空白记忆的请求负载。
 */
export interface WikiAiMemoryCreateRequest {
  documentId: string;
  nodeId: string;
}

/**
 * Request payload to rename a memory (content and node stay unchanged).
 * 重命名记忆的请求负载（内容与关联章节不变）。
 */
export interface WikiAiMemoryRenameRequest {
  documentId: string;
  memoryId: string;
  title: string;
}

/**
 * Request payload to pin/unpin a memory (metadata and list order only).
 * 置顶/取消置顶记忆的请求负载（仅元数据与列表顺序）。
 */
export interface WikiAiMemoryPinRequest {
  documentId: string;
  memoryId: string;
  pinned: boolean;
}

/**
 * Request payload to delete one memory.
 * 删除单条记忆的请求负载。
 */
export interface WikiAiMemoryDeleteRequest {
  documentId: string;
  memoryId: string;
}

interface WikiAiMemoryFailure {
  code: WikiAiMemoryErrorCode;
  message: string;
  diagnostic?: string;
}

const memoryWriteQueues = new Map<string, Promise<unknown>>();

/**
 * List all still-valid Wiki AI memories of the current document, sorted by most recent update.
 * 读取当前文档仍有效的所有 Wiki AI 记忆，按最近更新排序。
 *
 * @param libraryPath - Library root path / 资料库根路径
 * @param outline - Document outline providing documentId and contentHash / 提供 documentId 与 contentHash 的文档大纲
 * @returns Valid memories sorted with pinned first / 有效记忆列表（置顶优先）
 */
export function listWikiAiMemories(libraryPath: string, outline: WikiDocumentOutline): WikiAiMemory[] {
  return readWikiAiMemories(libraryPath, outline.documentId, outline.contentHash)
    .sort(compareWikiAiMemories);
}

/**
 * Create a blank new conversation memory for the current chapter; subsequent Q&A only updates this entry.
 * 为当前章节创建一份空白的新对话记忆，后续问答只会更新这一个条目。
 *
 * @param input.libraryPath - Library root path / 资料库根路径
 * @param input.outline - Derived-merged outline for validation / 用于校验的文档大纲
 * @param input.request - Creation request / 创建请求
 * @param input.now - Optional clock override for timestamps / 时间戳的可选时钟覆盖
 * @returns Created memory or coded error / 新建记忆或带错误码的失败
 */
export async function createWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryCreateRequest;
  now?: Date;
}): Promise<WikiAiMemoryResult> {
  const queueKey = aiMemoriesPath(input.libraryPath, input.outline.documentId);
  return enqueueMemoryWrite(queueKey, () => persistCreateWikiAiMemory(input));
}

/**
 * Write one successful node Q&A turn into the current session memory.
 * 将一次成功的节点问答写入当前会话记忆。
 *
 * @param input.libraryPath - Library root path / 资料库根路径
 * @param input.outline - Document outline for validation / 用于校验的文档大纲
 * @param input.request - Upsert request with the conversation turns / 携带对话轮次的 upsert 请求
 * @param input.now - Optional clock override for timestamps / 时间戳的可选时钟覆盖
 * @returns Updated/created memory or coded error / 更新或新建的记忆，或带错误码的失败
 */
export async function upsertWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryUpsertRequest;
  now?: Date;
}): Promise<WikiAiMemoryResult> {
  const queueKey = aiMemoriesPath(input.libraryPath, input.outline.documentId);
  return enqueueMemoryWrite(queueKey, () => persistUpsertWikiAiMemory(input));
}

/**
 * Rename a memory with a user-defined name; content and associated chapter stay unchanged.
 * 用户自定义记忆名称；内容和关联章节保持不变。
 *
 * @param input.libraryPath - Library root path / 资料库根路径
 * @param input.outline - Document outline for validation / 用于校验的文档大纲
 * @param input.request - Rename request / 重命名请求
 * @param input.now - Optional clock override for timestamps / 时间戳的可选时钟覆盖
 * @returns Renamed memory or coded error / 重命名后的记忆或带错误码的失败
 */
export async function renameWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryRenameRequest;
  now?: Date;
}): Promise<WikiAiMemoryResult> {
  const queueKey = aiMemoriesPath(input.libraryPath, input.outline.documentId);
  return enqueueMemoryWrite(queueKey, () => persistRenameWikiAiMemory(input));
}

/**
 * Like the main Q&A session: pinning only adjusts session metadata and list order, never the Q&A content.
 * 与主问答会话一致：置顶只调整会话元数据和列表顺序，不修改问答内容。
 *
 * @param input.libraryPath - Library root path / 资料库根路径
 * @param input.outline - Document outline for validation / 用于校验的文档大纲
 * @param input.request - Pin/unpin request / 置顶/取消置顶请求
 * @param input.now - Optional clock override for timestamps / 时间戳的可选时钟覆盖
 * @returns Updated memory or coded error / 更新后的记忆或带错误码的失败
 */
export async function setWikiAiMemoryPinned(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryPinRequest;
  now?: Date;
}): Promise<WikiAiMemoryResult> {
  const queueKey = aiMemoriesPath(input.libraryPath, input.outline.documentId);
  return enqueueMemoryWrite(queueKey, () => persistSetWikiAiMemoryPinned(input));
}

/**
 * Delete a single chapter memory without affecting the Wiki node, materials, or other chapters' memories.
 * 删除单条章节记忆，不影响 Wiki 节点、资料或其他章节的记忆。
 *
 * @param input.libraryPath - Library root path / 资料库根路径
 * @param input.outline - Document outline for validation / 用于校验的文档大纲
 * @param input.request - Delete request / 删除请求
 * @returns Deleted memory id or coded error / 被删除记忆 id 或带错误码的失败
 */
export async function deleteWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryDeleteRequest;
}): Promise<WikiAiMemoryDeleteResult> {
  const queueKey = aiMemoriesPath(input.libraryPath, input.outline.documentId);
  return enqueueMemoryWrite(queueKey, () => persistDeleteWikiAiMemory(input));
}

/**
 * Missing, corrupted, oversized, or content-hash-changed files are all treated as having no recoverable memories.
 * 文件缺失、损坏、超限或内容哈希变化时一律视为没有可恢复记忆。
 *
 * @param libraryPath - Library root path / 资料库根路径
 * @param documentId - Document id / 文档 id
 * @param contentHash - Document content hash gating validity / 控制有效性的文档内容哈希
 * @returns Validated memories, empty when invalid / 校验后的记忆；无效时为空数组
 */
export function readWikiAiMemories(libraryPath: string, documentId: string, contentHash: string): WikiAiMemory[] {
  const filePath = aiMemoriesPath(libraryPath, documentId);
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size > MAX_MEMORY_FILE_BYTES) return [];
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WikiAiMemoriesFile>;
    if (value.schemaVersion !== 1 || value.documentId !== documentId || value.contentHash !== contentHash || !Array.isArray(value.memories)) return [];
    const memories: WikiAiMemory[] = [];
    for (const candidate of value.memories) {
      const memory = normalizeMemory(candidate);
      if (memory) memories.push(memory);
    }
    return memories;
  } catch {
    return [];
  }
}

function persistUpsertWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryUpsertRequest;
  now?: Date;
}): WikiAiMemoryResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', 'Wiki 文档标识与当前记忆不一致。') };
  }
  const node = outline.nodes.find((candidate) => candidate.id === request.nodeId);
  if (!node) {
    return { ok: false, error: failure('WIKI_MEMORY_NODE_NOT_FOUND', '对应章节不存在或已随文档更新失效，请重新打开文档后再试。') };
  }
  const conversation = normalizeConversation(request.conversation);
  if (!conversation) {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', 'Wiki AI 记忆内容无效。') };
  }

  const existing = readWikiAiMemories(libraryPath, outline.documentId, outline.contentHash);
  const previous = request.memoryId
    ? existing.find((memory) => memory.id === request.memoryId)
    : existing
      .filter((memory) => memory.nodeId === request.nodeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
  if (request.memoryId && !previous) {
    return { ok: false, error: failure('WIKI_MEMORY_NOT_FOUND', '这条 Wiki AI 记忆不存在或已随文档更新失效。') };
  }
  if (previous && previous.nodeId !== request.nodeId) {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', '当前对话与章节不匹配，请重新打开章节后再试。') };
  }
  if (!previous && existing.length >= MAX_MEMORIES) {
    return { ok: false, error: failure('WIKI_MEMORY_LIMIT', `当前文档的 Wiki AI 记忆已达上限 ${MAX_MEMORIES} 条。`) };
  }
  const now = input.now?.toISOString() ?? new Date().toISOString();
  const memory: WikiAiMemory = previous
    ? { ...previous, conversation, updatedAt: now }
    : {
      id: createMemoryId(outline.documentId),
      nodeId: request.nodeId,
      title: normalizeDefaultTitle(node.title),
      pinned: false,
      conversation,
      createdAt: now,
      updatedAt: now,
    };
  const next = previous
    ? existing.map((candidate) => candidate.id === memory.id ? memory : candidate)
    : [...existing, memory];
  const writeError = writeMemoriesFile(libraryPath, outline.documentId, outline.contentHash, next);
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, memory };
}

function persistCreateWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryCreateRequest;
  now?: Date;
}): WikiAiMemoryResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', 'Wiki 文档标识与当前记忆不一致。') };
  }
  const node = outline.nodes.find((candidate) => candidate.id === request.nodeId);
  if (!node) {
    return { ok: false, error: failure('WIKI_MEMORY_NODE_NOT_FOUND', '对应章节不存在或已随文档更新失效，请重新打开文档后再试。') };
  }
  const existing = readWikiAiMemories(libraryPath, outline.documentId, outline.contentHash);
  if (existing.length >= MAX_MEMORIES) {
    return { ok: false, error: failure('WIKI_MEMORY_LIMIT', `当前文档的 Wiki AI 记忆已达上限 ${MAX_MEMORIES} 条。`) };
  }
  const now = input.now?.toISOString() ?? new Date().toISOString();
  const memory: WikiAiMemory = {
    id: createMemoryId(outline.documentId),
    nodeId: request.nodeId,
    title: normalizeNewConversationTitle(node.title),
    pinned: false,
    conversation: [],
    createdAt: now,
    updatedAt: now,
  };
  const writeError = writeMemoriesFile(libraryPath, outline.documentId, outline.contentHash, [...existing, memory]);
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, memory };
}

function persistSetWikiAiMemoryPinned(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryPinRequest;
  now?: Date;
}): WikiAiMemoryResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId || typeof request.pinned !== 'boolean') {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', 'Wiki AI 记忆置顶请求无效。') };
  }
  const existing = readWikiAiMemories(libraryPath, outline.documentId, outline.contentHash);
  const target = existing.find((memory) => memory.id === request.memoryId);
  if (!target) {
    return { ok: false, error: failure('WIKI_MEMORY_NOT_FOUND', '这条 Wiki AI 记忆不存在或已随文档更新失效。') };
  }
  const memory = {
    ...target,
    pinned: request.pinned,
    updatedAt: input.now?.toISOString() ?? new Date().toISOString(),
  };
  const writeError = writeMemoriesFile(
    libraryPath,
    outline.documentId,
    outline.contentHash,
    existing.map((candidate) => candidate.id === memory.id ? memory : candidate),
  );
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, memory };
}

function persistRenameWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryRenameRequest;
  now?: Date;
}): WikiAiMemoryResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', 'Wiki 文档标识与当前记忆不一致。') };
  }
  const title = normalizeTitle(request.title);
  if (!title) {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', `记忆名称不能为空且不能超过 ${MAX_MEMORY_TITLE_CHARS} 个字符。`) };
  }
  const existing = readWikiAiMemories(libraryPath, outline.documentId, outline.contentHash);
  const target = existing.find((memory) => memory.id === request.memoryId);
  if (!target) {
    return { ok: false, error: failure('WIKI_MEMORY_NOT_FOUND', '这条 Wiki AI 记忆不存在或已随文档更新失效。') };
  }
  const memory = { ...target, title, updatedAt: input.now?.toISOString() ?? new Date().toISOString() };
  const writeError = writeMemoriesFile(
    libraryPath,
    outline.documentId,
    outline.contentHash,
    existing.map((candidate) => candidate.id === memory.id ? memory : candidate),
  );
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, memory };
}

function persistDeleteWikiAiMemory(input: {
  libraryPath: string;
  outline: WikiDocumentOutline;
  request: WikiAiMemoryDeleteRequest;
}): WikiAiMemoryDeleteResult {
  const { libraryPath, outline, request } = input;
  if (request.documentId !== outline.documentId) {
    return { ok: false, error: failure('WIKI_MEMORY_INVALID', 'Wiki 文档标识与当前记忆不一致。') };
  }
  const existing = readWikiAiMemories(libraryPath, outline.documentId, outline.contentHash);
  if (!existing.some((memory) => memory.id === request.memoryId)) {
    return { ok: false, error: failure('WIKI_MEMORY_NOT_FOUND', '这条 Wiki AI 记忆不存在或已随文档更新失效。') };
  }
  const writeError = writeMemoriesFile(
    libraryPath,
    outline.documentId,
    outline.contentHash,
    existing.filter((memory) => memory.id !== request.memoryId),
  );
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, deletedMemoryId: request.memoryId };
}

/** Atomically write the memories file; returns a coded error payload on failure. / 原子写入记忆文件；失败返回带错误码的负载。 */
function writeMemoriesFile(
  libraryPath: string,
  documentId: string,
  contentHash: string,
  memories: WikiAiMemory[],
): WikiAiMemoryFailure | null {
  try {
    const filePath = aiMemoriesPath(libraryPath, documentId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteJson(filePath, { schemaVersion: 1, documentId, contentHash, memories } satisfies WikiAiMemoriesFile);
    return null;
  } catch (error) {
    return failure(
      'WIKI_MEMORY_SAVE_FAILED',
      'Wiki AI 记忆未保存，请检查知识库目录权限后重试。',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Validate one untrusted cache entry against shape and size limits; returns null when invalid. / 校验单条不可信缓存条目的形态与大小限制；无效返回 null。 */
function normalizeMemory(value: unknown): WikiAiMemory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id || record.id.length > 512) return null;
  if (typeof record.nodeId !== 'string' || !record.nodeId || record.nodeId.length > 512) return null;
  const title = normalizeTitle(record.title);
  const conversation = normalizeConversation(record.conversation);
  if (!title || !conversation || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return null;
  return {
    id: record.id,
    nodeId: record.nodeId,
    title,
    pinned: record.pinned === true,
    conversation,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Validate a stored conversation against message-count and char budgets; returns null when over budget. / 按消息数与字符预算校验会话；超预算返回 null。 */
function normalizeConversation(value: unknown): AssistantConversationMessage[] | null {
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_MESSAGES) return null;
  const messages: AssistantConversationMessage[] = [];
  let totalChars = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if ((record.role !== 'user' && record.role !== 'assistant') || typeof record.content !== 'string') return null;
    const content = record.content.trim();
    if (!content || content.length > MAX_CONVERSATION_MESSAGE_CHARS) return null;
    totalChars += content.length;
    if (totalChars > MAX_CONVERSATION_TOTAL_CHARS) return null;
    messages.push({ role: record.role, content });
  }
  return messages;
}

function normalizeDefaultTitle(nodeTitle: string): string {
  return normalizeTitle(nodeTitle) ?? '未命名章节记忆';
}

function normalizeNewConversationTitle(nodeTitle: string): string {
  const base = normalizeDefaultTitle(nodeTitle);
  return normalizeTitle(`${base} · 新对话`) ?? '新 Wiki AI 对话';
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title && title.length <= MAX_MEMORY_TITLE_CHARS ? title : null;
}

/** Resolve the memories file path, asserted inside the library root to block path escapes. / 计算记忆文件路径，并断言位于资料库根内以拦截路径逃逸。 */
function aiMemoriesPath(libraryPath: string, documentId: string): string {
  return assertInsideDirectory(
    path.join(getLibraryMetaDirectory(libraryPath), 'wiki', `${safeSegment(documentId)}.ai-memories.json`),
    libraryPath,
    'Wiki AI 记忆元数据路径无效。',
  );
}

function createMemoryId(documentId: string): string {
  return `wiki:${documentId}:memory:${crypto.randomUUID()}`;
}

function compareWikiAiMemories(left: WikiAiMemory, right: WikiAiMemory): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

function failure(code: WikiAiMemoryErrorCode, message: string, diagnostic?: string): WikiAiMemoryFailure {
  return { code, message, ...(diagnostic ? { diagnostic } : {}) };
}

/** Serialize writes per queue key so concurrent read-modify-write stays atomic across callers. / 按队列键串行化写入，使并发调用下的读-改-写保持原子。 */
async function enqueueMemoryWrite<T>(queueKey: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = memoryWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  memoryWriteQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (memoryWriteQueues.get(queueKey) === current) memoryWriteQueues.delete(queueKey);
  }
}
