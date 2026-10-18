/**
 * Shared type contracts for the AI assistant turn pipeline: requests, attachments, citations, tool/model traces and results.
 * AI 助手轮次流水线的共享类型契约：请求、附件、引用、工具/模型轨迹与结果。
 */
import type { AiProviderKind } from '../ai/aiTypes.ts';
import type { MemoryUsedSnapshot } from '../memory/memoryTypes.ts';
import type { LearningPlan, OrganizationSuggestion } from '../library/libraryAiTypes.ts';
import type { LexicalMatchTrace } from '../index/lexicalMatchPolicy.ts';
import type { AssistantContextUsage } from '../model/tokenEstimator.ts';
import type { SummaryRunCheckpoint } from '../summary/summaryRunBudget.ts';
import type { ShadowScopeComparison } from './assistantShadowPlan.ts';
import type { SearchEvidenceKind, SearchQueryTermSource } from '../search/searchPlanTypes.ts';
import type { QaMemoryZoneTokens } from '../qa/qaMemoryTypes.ts';
import type { ContextProjectionDiagnostics } from '../context/contextRuntimeTypes.ts';
import { isWikiActionKind, type WikiActionKind } from '../../wiki/wikiQuickActions.ts';

/**
 * Re-exported evidence token statistics used by turn results and plan events.
 * 轮次结果与计划事件使用的证据 token 统计（再导出）。
 */
export type { AssistantEvidenceContextStats } from '../model/tokenEstimator.ts';

/**
 * Allowed assistant task intents: question answering, learning plan and organization.
 * 允许的 AI 助手任务意图：问答、学习计划与整理。
 */
export const assistantIntents = ['ask', 'learning-plan', 'organize'] as const;
/**
 * Union of the supported assistant task intents.
 * 受支持的 AI 助手任务意图联合类型。
 */
export type AssistantIntent = typeof assistantIntents[number];

/**
 * Allowed assistant scopes: free chat, current note, library search/structure and Wiki node.
 * 允许的 AI 助手作用域：自由问答、当前笔记、资料库检索/结构与 Wiki 节点。
 */
export const assistantScopes = ['chat', 'current-note', 'library-search', 'library-structure', 'wiki-node'] as const;
/**
 * Union of the supported assistant scopes.
 * 受支持的 AI 助手作用域联合类型。
 */
export type AssistantScope = typeof assistantScopes[number];

/**
 * Supported thinking intensities for assistant turns.
 * 助手轮次支持的思考强度。
 */
export const assistantThinkingModes = ['simple', 'advanced'] as const;
/**
 * Union of the supported thinking intensities.
 * 受支持的思考强度联合类型。
 */
export type AssistantThinkingMode = typeof assistantThinkingModes[number];

/**
 * Supported answer depth preferences for assistant turns.
 * 助手轮次支持的回答深度偏好。
 */
export const assistantAnswerDepths = ['auto', 'concise', 'detailed'] as const;
/**
 * Union of the supported answer depth preferences.
 * 受支持的回答深度偏好联合类型。
 */
export type AssistantAnswerDepth = typeof assistantAnswerDepths[number];

/**
 * Kinds of retrieval context sources a turn may query.
 * 轮次可检索的上下文来源类型。
 */
export const assistantContextSourceKinds = ['note-library', 'knowledge-base'] as const;
/**
 * Union of the supported context source kinds.
 * 受支持的上下文来源类型联合。
 */
export type AssistantContextSourceKind = typeof assistantContextSourceKinds[number];

/**
 * One retrieval context source registered for a turn.
 * 轮次注册的单个检索上下文来源。
 */
export interface AssistantContextSource {
  kind: AssistantContextSourceKind;
  /** Root path of the backing library / 对应资料库的根路径 */
  libraryPath: string;
  /** Optional display label / 可选的展示名称 */
  label?: string;
}

/**
 * Discriminated union of multimodal attachment kinds (multimodal plan section 5.1):
 * - image: collected via clipboard/drag/file dialog, carries a base64 dataUrl that lives only for the current request; the main process never writes it to disk.
 * - document: PDF / DOCX documents parsed by the main process and then injected through AttachmentContextProvider.
 * - text: plain-text attachments such as Markdown / TXT / CSV / JSON, read directly by the main process.
 * All three carry a stable attachmentId used by the renderer for deduplication and removal.
 * 多模态附件判别联合（多模态开发方案 section 5.1）：
 * - image：剪贴板/拖拽/文件对话框采集的图片，携带 base64 dataUrl，仅存活于本轮请求；主进程不落盘。
 * - document：PDF / DOCX 文档；主进程解析后注入 AttachmentContextProvider。
 * - text：现有 Markdown / TXT / CSV / JSON 等纯文本附件；主进程直接读取。
 * 三种类型都携带稳定的 attachmentId，前端按 id 去重与移除。
 */
export const assistantAttachmentKinds = ['image', 'document', 'text'] as const;
/**
 * Union of the supported attachment kinds.
 * 受支持的附件类型联合。
 */
export type AssistantAttachmentKind = typeof assistantAttachmentKinds[number];

/**
 * Allowed MIME types for image attachments.
 * 图片附件允许的 MIME 类型。
 */
export const assistantImageMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/**
 * Union of the allowed image MIME types.
 * 允许的图片 MIME 类型联合。
 */
export type AssistantImageMimeType = typeof assistantImageMimeTypes[number];

/**
 * Image attachment carrying an in-memory base64 data URL.
 * 图片附件，携带内存中的 base64 data URL。
 */
export interface AssistantImageAttachment {
  kind: 'image';
  attachmentId: string;
  name: string;
  mimeType: AssistantImageMimeType;
  /** Raw byte size before base64 encoding / base64 编码前的原始字节数 */
  sizeBytes: number;
  /**
   * base64 dataUrl，仅存活于本轮请求；历史轮次不保留。
   * base64 dataUrl kept alive only for the current request; not retained in history turns.
   */
  dataUrl: string;
}

/**
 * Document attachment (PDF / DOCX) referencing a local file parsed by the main process.
 * 文档附件（PDF / DOCX），引用由主进程解析的本地文件。
 */
export interface AssistantDocumentAttachment {
  kind: 'document';
  attachmentId: string;
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Plain-text attachment (Markdown / TXT / CSV / JSON etc.) referencing a local file.
 * 纯文本附件（Markdown / TXT / CSV / JSON 等），引用本地文件。
 */
export interface AssistantTextAttachment {
  kind: 'text';
  attachmentId: string;
  path: string;
  name: string;
  sizeBytes: number;
}

/**
 * Union of all multimodal attachment shapes accepted by a turn request.
 * 轮次请求接受的全部多模态附件形态联合。
 */
export type AssistantAttachment =
  | AssistantImageAttachment
  | AssistantDocumentAttachment
  | AssistantTextAttachment;

/**
 * Max raw bytes per image before base64 encoding.
 * 单张图片原始字节上限（未 base64 编码前）。
 */
export const maxAssistantImageBytes = 5_000_000;
/**
 * Max total raw bytes of all images in one turn.
 * 单轮所有图片原始字节合计上限。
 */
export const maxAssistantImageTotalBytes = 20_000_000;
/**
 * Max bytes per document attachment (relaxed to 20 MB for PDF / DOCX).
 * 单个文档附件字节上限（PDF / DOCX 放宽到 20 MB）。
 */
export const maxAssistantDocumentBytes = 20_000_000;
/**
 * Max attachment count per turn (images + documents + texts combined).
 * 单轮附件总数上限（图片 + 文档 + 文本合计）。
 */
export const maxAssistantAttachmentCount = 6;
/**
 * Max bytes per text attachment (kept at the historical 2 MB).
 * 单个文本附件字节上限（保持历史 2 MB）。
 */
export const maxAssistantAttachmentBytes = 2_000_000;
/**
 * Max total bytes of all text attachments in one turn (kept at the historical 5 MB).
 * 单轮所有文本附件合计字节上限（保持历史 5 MB）。
 */
export const maxAssistantAttachmentTotalBytes = 5_000_000;

/**
 * Image extension allowlist (lowercase, with leading dot).
 * 图片附件扩展名白名单（小写、包含点）。
 */
export const assistantImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/**
 * Document extension allowlist; these go through the parse pipeline.
 * 文档附件扩展名白名单（需走解析流水线）。
 */
export const assistantDocumentExtensions = new Set(['.pdf', '.docx']);
/**
 * Text extension allowlist; these are read directly.
 * 文本附件扩展名白名单（直接读取）。
 */
export const assistantTextExtensions = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log']);

/**
 * Maps an image file extension to its MIME type, or null when unsupported.
 * 将图片文件扩展名映射为 MIME 类型；不支持时返回 null。
 *
 * @param extension - File extension including the leading dot / 含点的文件扩展名
 * @returns The matching image MIME type or null / 匹配的图片 MIME 类型或 null
 */
export function resolveImageMimeTypeFromExtension(extension: string): AssistantImageMimeType | null {
  const normalized = extension.toLowerCase();
  if (normalized === '.png') return 'image/png';
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg';
  if (normalized === '.webp') return 'image/webp';
  if (normalized === '.gif') return 'image/gif';
  return null;
}

/**
 * Maps a document file extension to a MIME type, falling back to application/octet-stream.
 * 将文档文件扩展名映射为 MIME 类型；未知扩展名回退到 application/octet-stream。
 *
 * @param extension - File extension including the leading dot / 含点的文件扩展名
 * @returns The MIME type of the document / 文档对应的 MIME 类型
 */
export function resolveDocumentMimeTypeFromExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === '.pdf') return 'application/pdf';
  if (normalized === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (normalized === '.doc') return 'application/msword';
  return 'application/octet-stream';
}

/**
 * One conversation-history message supplied with a turn request.
 * 随轮次请求提供的单条会话历史消息。
 */
export interface AssistantConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Wiki node Q&A scope target (plan section 4.2): locks retrieval to a section subtree of one document and carries the quick-action kind for the turn. Only present when scope === 'wiki-node'.
 * Wiki 节点问答作用域目标（方案 section 4.2）：把检索范围锁定到某个文档的某个章节子树，
 * 并携带本轮快捷动作类型。仅 scope === 'wiki-node' 时存在。
 */
export interface AssistantWikiTarget {
  libraryPath: string;
  documentId: string;
  /**
   * 形如 wiki:<documentId>:<structureNodeId>。
   * Shaped like wiki:<documentId>:<structureNodeId>.
   */
  nodeId: string;
  actionKind: WikiActionKind;
}

/**
 * One proposed child of a Wiki draft: a title and a summary that becomes the derived node's markdown.
 * Wiki 草稿的建议子节点：标题与概述，概述将作为派生节点的 markdown 正文。
 */
export interface AssistantWikiDraftChild {
  title: string;
  summary: string;
}

/**
 * Wiki quick-action draft payload after the final answer (plan section 5): markdown is the full final answer; proposedChildren is produced by a small structured call only for the `split-children` action and is empty for all other actions. Delivered with the result of the `complete` event and mapped to a `draft-ready` WikiEvent in the renderer.
 * Wiki 快捷动作终答后的草稿载荷（方案 section 5）：markdown 为终答全文，
 * proposedChildren 仅 `split-children` 动作经结构化小调用产出，其余动作为空数组。
 * 随 `complete` 事件的 result 下发，渲染进程映射为 `draft-ready` WikiEvent。
 */
export interface AssistantWikiDraft {
  /**
   * Draft title (defaults to the current node title).
   * 草稿标题（默认取当前节点标题）。
   */
  title: string;
  /**
   * Full final answer text, used as the draft body for "keep in current node".
   * 终答全文，作为「保留在当前节点」的草稿正文。
   */
  markdown: string;
  /**
   * Proposed child nodes (title + summary); the summary becomes the derived node's markdown.
   * 建议子节点（标题 + 概述）；概述将作为派生节点 markdown。
   */
  proposedChildren: AssistantWikiDraftChild[];
}

/**
 * Validated request that launches one assistant turn.
 * 启动一次助手轮次的、已通过校验的请求。
 */
export interface AssistantTurnRequest {
  requestId: string;
  intent: AssistantIntent;
  scope: AssistantScope;
  userText: string;
  currentNotePath?: string;
  /**
   * Current-note and dedicated knowledge-base conversations may opt into a persisted session.
   * 当前笔记与专属知识库会话可选择启用持久化会话。
   */
  sessionId?: string;
  contextSources?: AssistantContextSource[];
  attachments?: AssistantAttachment[];
  conversation: AssistantConversationMessage[];
  modelProfileId?: string;
  thinkingMode?: AssistantThinkingMode;
  answerDepth?: AssistantAnswerDepth;
  skillIds?: string[];
  /**
   * Per-turn web-search switch (web search design section 8); when 'off', web tools are not registered even if enabled globally.
   * 本轮联网搜索开关（联网搜索设计方案 section 8）；'off' 时即使全局已启用也不注册联网工具。
   */
  webSearch?: 'on' | 'off';
  summaryCheckpoint?: SummaryRunCheckpoint;
  /**
   * Wiki node Q&A target; present only when scope === 'wiki-node' (plan section 4.2).
   * Wiki 节点问答目标；仅 scope === 'wiki-node' 时存在（方案 section 4.2）。
   */
  wikiTarget?: AssistantWikiTarget;
}

/**
 * One cited retrieval source attached to a turn answer.
 * 轮次回答所附的单条检索引用来源。
 */
export interface AssistantTurnSource {
  path: string;
  /**
   * 知识库来源对应的真实引用号；不再依赖数组下标推断。
   * Real reference number of a knowledge-base source; never inferred from array position.
   */
  reference?: number;
  /**
   * 知识库来源的稳定文档 id；展示标题不得承载该定位信息。
   * Stable document id of a knowledge-base source; display titles must not carry this location.
   */
  documentId?: string;
  /**
   * 知识库父块序号；仅用于引用定位和独立的位置展示。
   * Parent-block ordinal of a knowledge-base source; used only for citation location and separate position display.
   */
  parentOrdinal?: number;
  title: string;
  snippet: string;
  score: number;
  /** Retrieval methods that produced this source / 产生该来源的检索方法 */
  methods: Array<'keyword' | 'semantic'>;
  /** Origin of the source: local note, knowledge base or attachment / 来源类型：本地笔记、知识库或附件 */
  sourceType?: 'note' | 'knowledge-base' | 'attachment';
  /** Lexical match trace for debugging retrieval / 检索调试用的词法匹配轨迹 */
  matchTrace?: LexicalMatchTrace[];
}

/**
 * Context strategies available for current-note turns.
 * 当前笔记轮次可用的上下文策略。
 */
export const currentNoteContextModes = ['direct-full', 'memory-reuse', 'react-search', 'structured-summary'] as const;
/**
 * Union of the supported current-note context modes.
 * 受支持的当前笔记上下文模式联合类型。
 */
export type CurrentNoteContextMode = typeof currentNoteContextModes[number];

/**
 * Reasons a ReAct agent loop stops: success or one of several budget/guard limits.
 * ReAct 代理循环的停止原因：成功或各类预算/护栏限制。
 */
export const agentStopReasons = [
  'answered',
  'max-decision-rounds',
  'max-model-calls',
  'max-tool-calls',
  'no-progress',
  'repeated-action',
  'empty-searches',
  'invalid-action',
  'context-budget',
  'timeout',
  'cancelled',
  'snapshot-stale',
] as const;
/**
 * Union of the supported agent stop reasons.
 * 受支持的代理停止原因联合类型。
 */
export type AgentStopReason = typeof agentStopReasons[number];

/**
 * Local-only location metadata for one evidence citation. Absolute paths must never enter model prompts.
 * 单条证据引用的仅本地位置元数据。绝对路径绝不能进入模型提示词。
 */
export interface AssistantEvidenceCitation {
  evidenceId: string;
  notePath: string;
  /**
   * Present for cross-note citations; omitted by current-note citations.
   * 跨笔记引用时提供；当前笔记引用省略。
   */
  libraryId?: string;
  noteId?: string;
  contentHash: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  /** Hash of the quoted text used for staleness checks / 引文哈希，用于失效检测 */
  quoteHash: string;
  /** Short excerpt for display / 展示用短摘录 */
  preview: string;
}

/**
 * Outcome of validating a citation against the current note content: valid or stale with a message.
 * 对照当前笔记内容校验引用的结果：有效，或带消息的失效。
 */
export type AssistantCitationValidation =
  | { status: 'valid' }
  | { status: 'stale'; message: string };

/**
 * Renderer-facing evidence for the dedicated material knowledge-base RAG route. Its reference number is the exact `[N]` label that appeared in the prompt, and `content` is the exact parent-block text sent to the model.
 * 面向渲染进程的专属资料知识库 RAG 证据。reference 为提示词中出现的真实 `[N]` 标号，
 * content 为发送给模型的父块原文。
 */
export interface AssistantKnowledgeBaseCitation {
  reference: number;
  /**
   * 稳定资料文档 id；仅主进程用于回答完成后的文档亲和度记账。
   * Stable material document id; used only by the main process for post-answer document affinity accounting.
   */
  documentId?: string;
  documentName: string;
  parentOrdinal: number;
  content: string;
  /**
   * 来源章节路径（根到当前章节标题数组）；仅 Wiki 节点问答注入，用于引用展开到章节路径（方案 section 4.6）。
   * Source section path (root to current heading array); injected only by Wiki node Q&A for expanding citations to section paths (plan section 4.6).
   */
  nodePath?: string[];
  /**
   * Wiki 真实来源节点；仅当前文档内的已解析节点可下发，用于引用定位。
   * Real Wiki source node; only resolved nodes within the current document are sent, used for citation location.
   */
  nodeId?: string;
}

/**
 * How Wiki retrieval scope may expand: locked to the node, node first, or document first.
 * Wiki 检索作用域的扩展方式：锁定节点、节点优先或文档优先。
 */
export type AssistantWikiScopeMode = 'node-locked' | 'node-first' | 'document-first';
/**
 * Current retrieval range within a Wiki document.
 * Wiki 文档内的当前检索范围。
 */
export type AssistantWikiScopeRange = 'anchor' | 'subtree' | 'document';
/**
 * Reason the Wiki scope loop stopped.
 * Wiki 作用域循环的停止原因。
 */
export type AssistantWikiScopeStopReason = 'evidence-sufficient' | 'cycle-limit' | 'no-new-query' | 'budget-exhausted' | 'cancelled';
/**
 * Reason the Wiki search escalated beyond the local node scope.
 * Wiki 检索越过本地节点作用域的升级原因。
 */
export type AssistantWikiScopeEscalationReason = 'explicit-document-scope' | 'explicit-section-reference' | 'local-no-hit' | 'local-evidence-incomplete';

/**
 * Live, publishable scope progress attached to Wiki search tool events.
 * Wiki 搜索工具事件附带的实时、可公开范围进度。
 */
export interface AssistantWikiScopeProgress {
  phase: 'searching' | 'completed';
  scopeMode: AssistantWikiScopeMode;
  /** Range currently being searched (anchor is only the initial scope) / 当前检索范围（anchor 仅为初始作用域） */
  activeRange: Exclude<AssistantWikiScopeRange, 'anchor'>;
  /** Current retrieval cycle index / 当前检索轮次序号 */
  currentCycle: number;
  /** Hard cycle limit for this run / 本次运行的轮次硬上限 */
  maxRetrievalCycles: 5;
  documentScopeEntered: boolean;
  localSearchCount: number;
  documentSearchCount: number;
  escalationReason?: AssistantWikiScopeEscalationReason;
  /** New evidence items found in the latest cycle / 最近一轮新增的证据条数 */
  newEvidenceCount?: number;
}

/**
 * One Wiki section visited during scoped retrieval.
 * 作用域检索过程中访问过的一个 Wiki 章节。
 */
export interface AssistantWikiSearchedSection {
  nodePath: string[];
  nodeId?: string;
}

/**
 * Final scope and cycle outcome of a Wiki answer; contains only displayable, navigable in-document information.
 * Wiki 终答的范围与循环结果；只含当前文档内可展示、可导航的信息。
 */
export interface AssistantWikiScopeResult {
  scopeMode: AssistantWikiScopeMode;
  initialScope: AssistantWikiScopeRange;
  finalScope: AssistantWikiScopeRange;
  retrievalCyclesUsed: number;
  maxRetrievalCycles: 5;
  localSearchCount: number;
  documentSearchCount: number;
  /** Whether retrieval outside the initial scope was used / 是否使用了初始作用域之外的检索 */
  usedOtherSections: boolean;
  searchedSections: AssistantWikiSearchedSection[];
  stopReason: AssistantWikiScopeStopReason;
  escalationReason?: AssistantWikiScopeEscalationReason;
}

/**
 * Web evidence citation projection (web search design section 7.2); shares the incrementing reference sequence with knowledge-base citations.
 * 联网证据引用投影（联网搜索设计方案 section 7.2）；与知识库引用共享递增序列。
 */
export interface AssistantWebCitation {
  reference: number;
  title: string;
  url: string;
  /**
   * 厂商适配器 id，如 'zhipu'。
   * Vendor adapter id, e.g. 'zhipu'.
   */
  source: string;
  /**
   * 是否已经 web_fetch 全文核对；false 时仅为摘要级证据。
   * Whether the page was full-text verified via web_fetch; false means summary-level evidence only.
   */
  pageVerified: boolean;
  content: string;
}

/**
 * Validates the renderer-facing citation shape before the main process reads a note; rejects malformed ids, hashes and line ranges.
 * 在主进程读取笔记前校验面向渲染进程的引用结构；拒绝非法标识、哈希与行区间。
 *
 * @param value - Untrusted citation payload from the renderer / 来自渲染进程的不可信引用载荷
 * @returns The normalized citation / 规范化后的引用对象
 */
export function validateAssistantEvidenceCitation(value: unknown): AssistantEvidenceCitation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 引用格式无效。');
  const input = value as Record<string, unknown>;
  const evidenceId = readString(input.evidenceId, '引用标识', 128);
  const notePath = readString(input.notePath, '引用笔记路径', 4_000);
  const libraryId = input.libraryId === undefined ? undefined : readString(input.libraryId, '引用库标识', 128);
  const noteId = input.noteId === undefined ? undefined : readString(input.noteId, '引用笔记标识', 128);
  const contentHash = readString(input.contentHash, '引用内容哈希', 64);
  const quoteHash = readString(input.quoteHash, '引用原文哈希', 64);
  const preview = readString(input.preview, '引用预览', 240);
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,127}$/u.test(evidenceId)
    || (libraryId !== undefined && !/^library-[a-f0-9]{24}$/u.test(libraryId))
    || (noteId !== undefined && !/^note-[a-f0-9]{24}$/u.test(noteId))
    || !/^[a-f0-9]{64}$/u.test(contentHash)
    || !/^[a-f0-9]{64}$/u.test(quoteHash)
    || typeof input.lineFrom !== 'number' || typeof input.lineTo !== 'number'
    || !Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo)
    || input.lineFrom < 1 || input.lineTo < input.lineFrom) {
    throw new Error('AI 引用格式无效。');
  }
  if (!Array.isArray(input.headingPath) || input.headingPath.length > 8
    || input.headingPath.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 300)) {
    throw new Error('AI 引用标题路径无效。');
  }
  return {
    evidenceId,
    notePath,
    ...(libraryId ? { libraryId } : {}),
    ...(noteId ? { noteId } : {}),
    contentHash,
    headingPath: [...input.headingPath],
    lineFrom: input.lineFrom,
    lineTo: input.lineTo,
    quoteHash,
    preview,
  };
}

/**
 * Aggregated tool usage statistics for one current-note turn.
 * 单次当前笔记轮次的工具使用统计。
 */
export interface CurrentNoteToolStats {
  calls: number;
  searchedBlocks: number;
  readCharacters: number;
  elapsedMs: number;
}

/**
 * Main-process-only evidence inventory contract for Stage 2+ materialization.
 * 仅主进程使用的证据清单契约，供 Stage 2+ 物化使用。
 */
export interface EvidencePromptManifest {
  snapshotId: string;
  contentHash: string;
  /** Evidence ids retrieved by search tools / 搜索工具取回的证据 id */
  searchRetrievedEvidenceIds: string[];
  /** Evidence ids retrieved within this turn / 本轮内取回的证据 id */
  turnRetrievedEvidenceIds: string[];
  rawEvidenceIds: string[];
  /** Source evidence ids consumed by compression / 压缩过程消费的来源证据 id */
  compressedSourceEvidenceIds: string[];
  /** Compression artifact ids / 压缩产物 id */
  compressionArtifactIds: string[];
  /** Evidence ids still represented after compression / 压缩后仍被表示的证据 id */
  representedEvidenceIds: string[];
  /** Evidence ids not represented after compression / 压缩后未被表示的证据 id */
  missingEvidenceIds: string[];
  rawTokens: number;
  compressedSourceTokens: number;
  compressedOutputTokens: number;
  finalEvidenceTokens: number;
  evidenceBudgetTokens: number;
  /**
   * Structural ID coverage, not a semantic-loss score.
   * 结构化 ID 覆盖率，而非语义损失分数。
   */
  representationCoverage: number;
  compressionRounds: number;
  compressionBatchCount: number;
}

/**
 * Bounded excerpt of tool result content for the local audit rail.
 * 供本地审计轨道展示的、有界的工具结果摘录。
 */
export interface CurrentNotePublicToolContentPreview {
  kind: 'candidate' | 'evidence';
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  /**
   * Bounded original-text excerpt shown only in the local audit rail.
   * 有界的原文摘录，仅在本地审计轨道展示。
   */
  text: string;
  /** Whether the excerpt was truncated / 摘录是否被截断 */
  truncated: boolean;
}

/**
 * Structured safe projection of a tool result (shown only on the local debug rail). Truncation limits are enforced by the tool; it never contains secrets, absolute paths or model reasoning.
 * 工具返回结果的结构化安全投影（仅本地调试轨道展示）。
 * 截断上限由工具侧执行；不含密钥、绝对路径与模型推理内容。
 */
export interface AssistantPublicToolResultView {
  /**
   * Reference number registered in the ledger (e.g. '[1]'); omitted for unregistered results.
   * 台账登记的引用号（如 '[1]'）；未登记的结果缺省。
   */
  reference?: string;
  title?: string;
  /**
   * Human-readable location of results such as knowledge-base blocks; never carries absolute paths.
   * 知识库块等结果的可读位置，不承载绝对路径。
   */
  location?: string;
  /**
   * Retrieval relevance score; provided only when the tool really returned one.
   * 检索相关度；仅在工具真实返回时提供。
   */
  score?: number;
  /**
   * Retrieval methods behind a knowledge-base hit.
   * 知识库检索命中所使用的方法。
   */
  methods?: Array<'keyword' | 'semantic'>;
  /**
   * The result was already returned in this session; this observation did not re-expand its body.
   * 当前会话中已返回过该结果，本次工具观察未重复展开正文。
   */
  seen?: boolean;
  url?: string;
  /**
   * Summary-level excerpt (web_search); truncated to a bound.
   * 摘要级摘录（web_search）；有上限截断。
   */
  snippet?: string;
  publishedAt?: string;
  /**
   * Vendor adapter id that produced the result.
   * 产出该结果的厂商适配器 id。
   */
  source?: string;
  /**
   * True when web_fetch full-text verification succeeded; false for summary-level evidence.
   * web_fetch 全文核对成功为 true；摘要级证据为 false。
   */
  pageVerified?: boolean;
  /**
   * Body excerpt (after successful web_fetch); truncated to a bound.
   * 正文摘录（web_fetch 成功）；有上限截断。
   */
  excerpt?: string;
}

/**
 * One section candidate produced by library navigation search.
 * 资料库导航检索产生的单个章节候选。
 */
export interface LibrarySectionNavigationCandidate {
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  score: number;
  matchedTerms: string[];
}

/**
 * Renderer-safe navigation state. These candidates are not Ledger evidence.
 * 面向渲染进程的安全导航状态。这些候选不是台账证据。
 */
export interface LibrarySectionNavigationObservation {
  queryTermCount: number;
  evaluatedSectionCount: number;
  ambiguous: boolean;
  fallbackUsed: boolean;
  candidates: LibrarySectionNavigationCandidate[];
}

/**
 * Public progress only. Debug fields are bounded and intended for the local renderer. They may include short excerpts explicitly returned by read/search tools, but never model reasoning, absolute paths or provider request details.
 * 仅含公开进度。调试字段有界，面向本地渲染进程；可包含 read/search 工具显式返回的短摘录，
 * 但绝不包含模型推理、绝对路径或厂商请求细节。
 */
export interface CurrentNotePublicToolEvent {
  tool:
    | 'read_current_note'
    | 'search_note_library'
    | 'search_knowledge_base'
    | 'rerank_knowledge_evidence'
    | 'read_attachments'
    | 'search_attachment'
    | 'read_attachment_range'
    | 'get_note_map'
    | 'search_note'
    | 'read_note_range'
    | 'read_note_section'
    | 'expand_evidence'
    | 'get_library_note_map'
    | 'search_library_note_blocks'
    | 'read_library_note_range'
    | 'read_library_note_section'
    | 'expand_library_evidence'
    | 'read_library_adjacent_section'
    | 'rewrite_question'
    | 'knowledge_agent_search'
    | 'knowledge_agent_grep'
    | 'knowledge_agent_deep_read'
    | 'knowledge_agent_doc_info'
    | 'knowledge_agent_skill'
    | 'knowledge_agent_graph_search'
    | 'knowledge_agent_graph_global_search'
    | 'knowledge_agent_web_search'
    | 'knowledge_agent_web_fetch'
    | 'assistant_web_search'
    | 'assistant_web_fetch'
    /**
     * Public error trace when the model calls an unregistered tool; must not masquerade as a real tool.
     * 模型调用未注册工具时的公开错误轨迹，不应伪装为某个真实工具。
     */
    | 'assistant_tool_error'
    | 'search_conversations';
  state: 'started' | 'completed' | 'rejected';
  message: string;
  /**
   * ReAct decision round that produced this tool call; preprocessing tools omit it.
   * 产生该工具调用的 ReAct 决策轮次；预处理工具省略该字段。
   */
  round?: number;
  /**
   * Safe, human-readable request parameters shown in the local debug rail.
   * 本地调试轨道展示的安全、可读请求参数。
   */
  inputSummary?: string;
  /**
   * Safe, human-readable result summary shown in the local debug rail.
   * 本地调试轨道展示的安全、可读结果摘要。
   */
  outputSummary?: string;
  /**
   * Bounded, renderer-safe excerpts from the tool result.
   * 来自工具结果的有界、渲染安全摘录。
   */
  contentPreviews?: CurrentNotePublicToolContentPreview[];
  /**
   * Structured projection of tool results (web search/fetch etc.), displayed item by item in the debug rail.
   * 工具返回结果的结构化投影（联网搜索/抓取等），调试轨道逐条展示。
   */
  publicResults?: AssistantPublicToolResultView[];
  /**
   * Stage 5 navigation-only projection. It never carries evidence IDs or source text.
   * Stage 5 仅导航投影；绝不携带证据 ID 或原文。
   */
  sectionNavigation?: LibrarySectionNavigationObservation;
  /**
   * Live scope and cycle progress of Wiki node retrieval; unset on other assistant routes.
   * Wiki 节点问答检索的实时范围与周期；其他助手链路不设置。
   */
  wikiScopeProgress?: AssistantWikiScopeProgress;
  elapsedMs?: number;
}

/**
 * Bounded, renderer-safe copy of real provider input/output text.
 * 真实厂商输入/输出文本的有界、渲染安全副本。
 */
export interface AssistantPublicModelText {
  /**
   * Bounded, renderer-safe text copied from the real provider input/output.
   * 从真实厂商输入/输出复制的、有界且渲染安全的文本。
   */
  text: string;
  /**
   * Character count before redaction and bounded projection.
   * 脱敏与有界投影前的字符数。
   */
  originalCharacters: number;
  /** Whether the text was truncated / 文本是否被截断 */
  truncated: boolean;
}

/**
 * One kind of input-reduction action taken before a model call.
 * 模型调用前执行的单类输入压缩动作。
 */
export interface AssistantModelInputCompressionAction {
  kind: 'tool-result-budget' | 'history-consolidation' | 'atomic-history-trim';
  /** Number of items affected / 受影响条目数 */
  affectedItems: number;
  affectedGroups?: number;
  /** Reduction method: model-assisted or raw archive / 压缩方式：模型辅助或原始归档 */
  method?: 'llm' | 'raw-archive';
}

/**
 * Renderer-safe receipt proving that the real provider input was reduced before a model call. It contains counts only and must never carry prompt content.
 * 渲染安全的回执，证明模型调用前真实厂商输入已被压缩。仅含计数，绝不携带提示词内容。
 */
export interface AssistantModelInputCompression {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  releasedTokens: number;
  actions: AssistantModelInputCompressionAction[];
}

/**
 * Session-only public trace for a real ReAct model call. It deliberately omits provider transport details, credentials, absolute paths and hidden reasoning.
 * 仅会话内保留的真实 ReAct 模型调用公开轨迹；刻意省略厂商传输细节、凭据、绝对路径与隐藏推理。
 */
export interface AssistantPublicModelEvent {
  callId: string;
  /** ReAct decision round of this call / 本次调用所属的 ReAct 决策轮次 */
  round: number;
  callKind: 'decide' | 'synthesize';
  state: 'started' | 'completed' | 'rejected';
  input: AssistantPublicModelText;
  /**
   * Present only when the provider received a genuinely reduced context.
   * 仅当厂商确实收到压缩后的上下文时提供。
   */
  inputCompression?: AssistantModelInputCompression;
  output?: AssistantPublicModelText;
  /** Stable error code when the call failed / 调用失败时的稳定错误码 */
  errorCode?: string;
  elapsedMs?: number;
}

/**
 * Lifecycle statuses of a search plan.
 * 搜索计划的生命周期状态。
 */
export const assistantPlanStatuses = ['active', 'completed', 'partial', 'not-found', 'failed', 'cancelled', 'stale', 'interrupted'] as const;
/**
 * Union of the supported search plan statuses.
 * 受支持的搜索计划状态联合类型。
 */
export type AssistantPlanStatus = typeof assistantPlanStatuses[number];

/**
 * Lifecycle statuses of a single search plan goal.
 * 单个搜索计划目标的生命周期状态。
 */
export const assistantPlanGoalStatuses = ['pending', 'searching', 'partial', 'covered', 'conflicted', 'not-found'] as const;
/**
 * Union of the supported search plan goal statuses.
 * 受支持的搜索计划目标状态联合类型。
 */
export type AssistantPlanGoalStatus = typeof assistantPlanGoalStatuses[number];

/**
 * Renderer-safe projection of one plan goal.
 * 单个计划目标的渲染安全投影。
 */
export interface CurrentNotePublicPlanGoal {
  label: string;
  status: AssistantPlanGoalStatus;
  evidenceCount: number;
}

/**
 * One query term with its origin for the public plan projection.
 * 公开计划投影中的单个查询词及其来源。
 */
export interface CurrentNotePublicQueryTerm {
  term: string;
  source: SearchQueryTermSource;
}

/**
 * Renderer-safe projection of one search-plan goal with its requirements and query terms.
 * 单个搜索计划目标的渲染安全投影，含约束与查询词。
 */
export interface CurrentNotePublicSearchPlanGoal extends CurrentNotePublicPlanGoal {
  evidenceKind: SearchEvidenceKind;
  requirements: Array<{ label: string; minEvidence: number }>;
  queryTermCount: number;
  queryTerms: CurrentNotePublicQueryTerm[];
}

/**
 * Renderer-safe SearchPlan projection; it intentionally omits IDs, paths and evidence text.
 * 渲染安全的 SearchPlan 投影；刻意省略 ID、路径与证据正文。
 */
export interface CurrentNotePublicSearchPlan {
  version: number;
  originalQuestion: string;
  status: AssistantPlanStatus;
  activeGoalLabel?: string;
  goals: CurrentNotePublicSearchPlanGoal[];
}

/**
 * Public progress event for plan creation and updates during a turn.
 * 轮次中计划创建与更新的公开进度事件。
 */
export interface CurrentNotePublicPlanEvent {
  phase: 'started' | 'updated' | 'finished';
  status: AssistantPlanStatus;
  goals: CurrentNotePublicPlanGoal[];
  /**
   * The validated Planner response for this turn. It is emitted only when the plan starts, after local path redaction; later progress events remain compact state updates.
   * 本轮经校验的 Planner 输出；仅在计划开始时下发（已做本地路径脱敏），后续进度事件保持紧凑状态更新。
   */
  plannerOutputJson?: string;
  /**
   * Validated, renderer-safe SearchPlan details for the local audit rail.
   * 经校验、渲染安全的 SearchPlan 详情，供本地审计轨道使用。
   */
  searchPlan?: CurrentNotePublicSearchPlan;
  /**
   * The last validated lexical query actually sent to a search tool.
   * 最后一次实际发给搜索工具的、经校验的词法查询。
   */
  finalQueryTerms?: string[];
  /**
   * Numeric, estimate-labelled evidence telemetry; never carries text, paths or provider payloads.
   * 标注为估算值的数值型证据遥测；绝不携带文本、路径或厂商载荷。
   */
  evidenceContextStats?: import('../model/tokenEstimator.ts').AssistantEvidenceContextStats;
}

/**
 * Agent loop statistics for one current-note turn.
 * 单次当前笔记轮次的代理循环统计。
 */
export interface CurrentNoteAgentStats {
  decisionRounds: number;
  modelCalls: number;
  stopReason: AgentStopReason;
}

/**
 * Provider cache-usage report for a turn, when available.
 * 轮次的厂商缓存使用报告（若有）。
 */
export interface CurrentNoteCacheUsage {
  /** Cached input tokens reported by the provider / 厂商报告的缓存输入 token */
  cachedInputTokens?: number;
  /** Whether the provider reported cache usage at all / 厂商是否实际报告了缓存使用 */
  providerReported: boolean;
}

/**
 * Coverage report of quick/complete summary generation for a turn.
 * 轮次快速/完整摘要生成的覆盖报告。
 */
export interface CurrentNoteSummaryCoverage {
  mode: 'summary-quick' | 'summary-complete';
  completed: number;
  total: number;
  reused: number;
  generated: number;
}

/**
 * Renderer-safe projection of the main-process current-note scope. The internal origin, confidence and target aspects stay on the main-process side; only labels needed for the existing plan/trace UI cross the IPC boundary.
 * 主进程当前笔记作用域的渲染安全投影。内部来源、置信度与目标切面留在主进程侧，
 * 只有计划/轨迹 UI 需要的标签才跨 IPC 边界。
 */
export interface CurrentNotePublicSearchScope {
  mode: 'focused' | 'topic-wide';
  coveragePolicy: 'sufficient' | 'aspect-complete' | 'occurrence-complete';
}

/**
 * Renderer-safe, ledger-derived coverage counts and reason.
 * 渲染安全的、源自台账的覆盖计数与原因。
 */
export interface CurrentNotePublicSearchCoverage {
  discoveredHeadingCount: number;
  readHeadingCount: number;
  status: 'complete' | 'partial' | 'insufficient';
  reason: string;
}

/**
 * Telemetry of the shadow-plan comparison run for a turn.
 * 轮次影子计划对比运行的遥测数据。
 */
export interface AssistantShadowPlanTelemetry {
  /** Whether the shadow plan ran or why it was skipped / 影子计划是否运行或跳过原因 */
  status: 'ran' | 'shadowSkipped' | 'shadowFailure';
  reason?: 'model-budget' | 'wall-time' | 'cancelled' | 'stale' | 'context-overflow';
  promptTokens?: number;
  scopeComparison?: ShadowScopeComparison;
}

/**
 * Knowledge-base ReAct Agent shadow comparison telemetry (plan P2): runs in parallel with the legacy route in shadow mode, recording detailed traces without producing an answer; used to compare evidence coverage, rounds and latency.
 * 知识库 ReAct Agent 影子对比遥测（方案 P2）：shadow 模式下与旧链路并行跑，
 * 只落详细轨迹不出回答；用于对比证据覆盖、轮次与耗时。
 */
export interface AssistantKnowledgeShadowTelemetry {
  status: 'ran' | 'skipped' | 'failure';
  skipReason?: 'transport-unavailable' | 'cancelled';
  error?: string;
  elapsedMs?: number;
  stopReason?: string;
  stopDetail?: string;
  /**
   * Think轮数 / 模型调用次数 / 工具调用次数。
   * Think rounds / model calls / tool calls.
   */
  rounds?: number;
  modelCalls?: number;
  /**
   * L1 摘要维护调用次数；不占 ReAct modelCalls。
   * Number of L1 summary maintenance calls; not counted in ReAct modelCalls.
   */
  maintenanceModelCalls?: number;
  toolCalls?: number;
  /**
   * 台账证据父块数（证据覆盖口径）。
   * Evidence parent-chunk count in the ledger (evidence-coverage metric).
   */
  evidenceParentChunks?: number;
  /**
   * 记忆信封实际注入 token（0/缺省表示未注入）。
   * Tokens actually injected by the memory envelope (0/absent means not injected).
   */
  memoryEnvelopeTokens?: number;
  /**
   * 轮内固化执行次数（P2）；0/缺省表示未触发。
   * In-turn consolidation runs (P2); 0/absent means never triggered.
   */
  consolidations?: number;
  /**
   * 终答实际引用到的父块数。
   * Parent chunks actually cited in the final answer.
   */
  citedParentChunks?: number;
  completeness?: 'complete' | 'partial' | 'not-found';
}

/**
 * Audit record of a knowledge-base question rewrite (stored with resultJson in qa-memory.db).
 * 知识库问答问题改写落痕记录（随 resultJson 存入 qa-memory.db）。
 */
export interface QaQueryRewriteRecord {
  /** Whether the rewrite was skipped / 是否跳过了改写 */
  skipped: boolean;
  /**
   * 排除原因：no-history / self-contained。
   * Skip reason: no-history / self-contained.
   */
  reason?: string;
  /**
   * 命中的放行信号。
   * Matched allow-through signals.
   */
  matchedSignals?: string[];
  /**
   * 改写后问题（护栏回退时为原文）。
   * Rewritten question (falls back to the original when a guard trips).
   */
  rewrite?: string;
  /** Whether the question should be split into sub-questions / 是否拆分为子问题 */
  shouldSplit?: boolean;
  subQuestions?: string[];
  /**
   * 图意图门控（GraphRAG 方案 section 4.3）：global/local/none。
   * Graph intent gate (GraphRAG plan section 4.3): global/local/none.
   */
  graphIntent?: 'global' | 'local' | 'none';
  /**
   * 模型原始输出。
   * Raw model output.
   */
  rawOutput?: string;
  model?: string;
  elapsedMs: number;
  /**
   * anti-divergence 等护栏触发。
   * Guard that tripped, e.g. anti-divergence.
   */
  guardTriggered?: string;
  /** Failure details when the rewrite errored / 改写出错时的失败详情 */
  failed?: { code: string; message: string; rawOutput?: string };
}

/**
 * Final outcome of an assistant turn: an answer with optional citations/traces, a learning plan, or an organization suggestion.
 * 助手轮次的最终产物：带可选引用/轨迹的回答、学习计划，或整理建议。
 */
export type AssistantTurnResult =
  | {
    type: 'answer';
    answer: string;
    provider: AiProviderKind;
    model: string;
    sourceNotes: AssistantTurnSource[];
    retrievalMode: 'hybrid' | 'semantic' | 'keyword' | 'none';
    /**
     * The user-facing outcome of the one-shot assistant route classifier.
     * 一次性路由分类器的用户可见结果。
     */
    interactionRoute?: 'chat' | 'clarify' | 'react';
    contextUsage?: AssistantContextUsage;
    retrievalWarning?: string;
    /**
     * P0 contracts only; the legacy path deliberately leaves these undefined.
     * 仅 P0 契约使用；旧链路刻意保持未定义。
     */
    contextMode?: CurrentNoteContextMode;
    evidence?: AssistantEvidenceCitation[];
    /**
     * Dedicated material RAG only; these are expanded in place rather than navigated to a note.
     * 专属资料知识库 RAG 专用；这些引用就地展开而非导航到笔记。
     */
    knowledgeBaseCitations?: AssistantKnowledgeBaseCitation[];
    /**
     * 联网证据引用（联网搜索设计方案 section 7.2）；仅知识库 Agent 启用联网且命中网页证据时存在。
     * Web evidence citations (web search design section 7.2); present only when the knowledge-base Agent has web enabled and found web evidence.
     */
    webCitations?: AssistantWebCitation[];
    completeness?: 'complete' | 'partial' | 'not-found';
    toolStats?: CurrentNoteToolStats;
    agentStats?: CurrentNoteAgentStats;
    /**
     * Public tool progress only; safe to render and persist for an execution trace.
     * 仅含公开工具进度；可安全渲染并持久化为执行轨迹。
     */
    toolEvents?: CurrentNotePublicToolEvent[];
    /**
     * Public SearchPlan progress plus the validated, path-redacted Planner JSON when available.
     * 公开 SearchPlan 进度，加上经校验且路径脱敏的 Planner JSON（若有）。
     */
    planEvents?: CurrentNotePublicPlanEvent[];
    /**
     * Session-only ReAct model input/output trace; assistant memory does not persist it.
     * 仅会话内保留的 ReAct 模型输入/输出轨迹；助手记忆不持久化此数据。
     */
    modelEvents?: AssistantPublicModelEvent[];
    /**
     * Main-process generated evidence telemetry; it is not model-authored.
     * 主进程生成的证据遥测；非模型产出。
     */
    evidenceContextStats?: import('../model/tokenEstimator.ts').AssistantEvidenceContextStats;
    executionElapsedMs?: number;
    /**
     * 模型深度思考原文（有上限）；仅当用户开启高级思考且模型返回思考内容时存在。
     * Raw model thinking text (bounded); present only when the user enabled advanced thinking and the model returned thinking content.
     */
    thinkingText?: string;
    /**
     * 思考阶段耗时（毫秒）。
     * Thinking phase duration in milliseconds.
     */
    thinkingElapsedMs?: number;
    /**
     * P5 only: quick and complete summaries report their real coverage separately.
     * 仅 P5：快速与完整摘要分别报告真实覆盖情况。
     */
    summaryCoverage?: CurrentNoteSummaryCoverage;
    /**
     * P6: safe projection of the main-process scope and Coverage Ledger.
     * P6：主进程作用域与覆盖台账的安全投影。
     */
    searchScope?: CurrentNotePublicSearchScope;
    searchCoverage?: CurrentNotePublicSearchCoverage;
    summaryCheckpoint?: SummaryRunCheckpoint;
    shadowPlan?: AssistantShadowPlanTelemetry;
    prefixFingerprint?: string;
    cacheUsage?: CurrentNoteCacheUsage;
    isStale?: boolean;
    /**
     * 问答区独立记忆链路：本轮各分区实际 token，供调试轨展示。
     * QA-zone independent memory route: actual per-zone tokens this turn, shown on the debug rail.
     */
    qaMemoryZones?: QaMemoryZoneTokens;
    /**
     * 问答区独立记忆链路：本轮所属会话（主进程自动建会话时回传给渲染进程）。
     * QA-zone independent memory route: session id for this turn (sent back to the renderer when the main process auto-creates a session).
     */
    qaSessionId?: string;
    /**
     * Durable explicit-save result; assistant wording is never a save acknowledgement.
     * 持久化的显式保存结果；助手措辞绝不是保存确认。
     */
    memorySave?: import('../memory/memoryTypes.ts').MemorySaveReceipt;
    /**
     * 知识库问答问题改写记录（设计 docs/Trellora-2.0-知识库问题改写设计.md）。
     * Knowledge-base question rewrite audit record (see docs/Trellora-2.0-知识库问题改写设计.md).
     */
    queryRewrite?: QaQueryRewriteRecord;
    /**
     * Phase 7: prompt-text-free context projection diagnostics safe for renderer and local persistence.
     * Phase 7：不含提示词文本的上下文投影诊断，可安全渲染与本地持久化。
     */
    contextDiagnostics?: ContextProjectionDiagnostics;
    /**
     * Wiki 节点快捷动作草稿载荷（方案 section 5）；仅 scope === 'wiki-node' 时存在。
     * Wiki node quick-action draft payload (plan section 5); present only when scope === 'wiki-node'.
     */
    wikiDraft?: AssistantWikiDraft;
    /**
     * Wiki 节点问答的最终范围、循环上限与来源章节投影（范围优化方案 section 7.2）。
     * Final scope, cycle limits and source-section projection of Wiki node Q&A (scope optimization plan section 7.2).
     */
    wikiScopeResult?: AssistantWikiScopeResult;
  }
  | { type: 'learning-plan'; plan: LearningPlan }
  | { type: 'organize'; suggestion: OrganizationSuggestion };

/**
 * Streamed events emitted while an assistant turn runs, ending with `complete`, `error` or `cancelled`.
 * 助手轮次执行期间推送的事件流，以 `complete`、`error` 或 `cancelled` 结束。
 */
export type AssistantTurnEvent =
  | { requestId: string; type: 'started'; intent: AssistantIntent; scopeLabel: string }
  | { requestId: string; type: 'route'; interactionRoute: 'chat' | 'clarify' | 'react' }
  | { requestId: string; type: 'status'; message: string }
  | { requestId: string; type: 'tool'; event: CurrentNotePublicToolEvent }
  | { requestId: string; type: 'plan'; event: CurrentNotePublicPlanEvent }
  | { requestId: string; type: 'model'; event: AssistantPublicModelEvent }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'delta-reset' }
  | { requestId: string; type: 'thinking-delta'; text: string }
  | { requestId: string; type: 'context-diagnostics'; diagnostics: ContextProjectionDiagnostics }
  | { requestId: string; type: 'complete'; result: AssistantTurnResult }
  | { requestId: string; type: 'suggestions'; questions: string[] }
  | { requestId: string; type: 'profile-updated'; updatedItemCount: number; completedAt: string }
  /**
   * M5 durable receipt; UI presentation is intentionally deferred to M8.
   * M5 持久化回执；UI 展示刻意推迟到 M8。
   */
  | { requestId: string; type: 'memory-used'; items: MemoryUsedSnapshot[] }
  | { requestId: string; type: 'memory-saved'; receipt: import('../memory/memoryTypes.ts').MemorySaveReceipt }
  | { requestId: string; type: 'error'; message: string }
  | { requestId: string; type: 'cancelled' };

/** Pattern every request id must match. / 所有请求标识必须匹配的格式。 */
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
/** Scopes each intent is allowed to use. / 各任务意图允许使用的作用域。 */
const intentScopes: Record<AssistantIntent, AssistantScope[]> = {
  ask: ['chat', 'current-note', 'library-search', 'wiki-node'],
  'learning-plan': ['library-search'],
  organize: ['library-structure'],
};

/**
 * Validates and normalizes an untrusted turn request, enforcing field allowlists, intent/scope compatibility and attachment limits.
 * 校验并规范化不可信的轮次请求：强制字段白名单、意图/作用域兼容性与附件上限。
 *
 * @param value - Untrusted request payload from the renderer / 来自渲染进程的不可信请求载荷
 * @returns The normalized turn request / 规范化后的轮次请求
 */
export function validateAssistantTurnRequest(value: unknown): AssistantTurnRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 助手请求格式无效。');
  const input = value as Record<string, unknown>;
  const requestId = readString(input.requestId, '请求标识', 128);
  if (!requestIdPattern.test(requestId)) throw new Error('请求标识格式无效。');
  if (typeof input.intent !== 'string' || !assistantIntents.includes(input.intent as AssistantIntent)) throw new Error('不支持的 AI 助手任务。');
  if (typeof input.scope !== 'string' || !assistantScopes.includes(input.scope as AssistantScope)) throw new Error('AI 助手范围无效。');
  const intent = input.intent as AssistantIntent;
  const scope = input.scope as AssistantScope;
  if (!intentScopes[intent].includes(scope)) throw new Error('当前任务不能使用该笔记范围。');
  // Prompt/tool overrides must never arrive from the renderer. / 提示词与工具覆盖字段绝不能来自渲染进程。
  if (input.model !== undefined || input.systemPrompt !== undefined || input.sources !== undefined || input.markdown !== undefined || input.mcp !== undefined || input.tools !== undefined) {
    throw new Error('AI 助手请求包含不允许的字段。');
  }
  const userText = readString(input.userText, '问题或目标', 2_000);
  if (!userText.trim()) throw new Error('请输入问题或目标。');
  const currentNotePath = input.currentNotePath === undefined ? undefined : readString(input.currentNotePath, '当前笔记路径', 4_000);
  if (scope === 'current-note' && !currentNotePath?.trim()) throw new Error('请先选择当前笔记。');
  if (scope !== 'current-note' && currentNotePath) throw new Error('当前任务不接受当前笔记路径。');
  const wikiTarget = input.wikiTarget === undefined ? undefined : readWikiTarget(input.wikiTarget);
  if (scope === 'wiki-node' && !wikiTarget) throw new Error('请先选择 Wiki 节点。');
  if (scope !== 'wiki-node' && wikiTarget) throw new Error('当前任务不接受 Wiki 节点目标。');
  const sessionId = input.sessionId === undefined ? undefined : readId(input.sessionId, '会话标识');
  const contextSources = input.contextSources === undefined ? [] : readContextSources(input.contextSources);
  const attachments = input.attachments === undefined ? [] : readAttachments(input.attachments);
  if (scope === 'chat' && contextSources.length) throw new Error('普通 AI 问答不接受资料库来源。');
  const hasDedicatedKnowledgeBaseSession = scope === 'library-search'
    && contextSources.length === 1
    && contextSources[0].kind === 'knowledge-base';
  // sessionId is accepted only for current-note, chat or a dedicated knowledge-base library-search session. / sessionId 仅被当前笔记、自由问答或专属知识库检索会话接受。
  if (scope !== 'current-note' && sessionId && !hasDedicatedKnowledgeBaseSession && scope !== 'chat') throw new Error('当前任务不接受 AI 会话标识。');
  const conversation = readConversation(input.conversation);
  const modelProfileId = input.modelProfileId === undefined ? undefined : readId(input.modelProfileId, '模型档案');
  // Normalize optional enums; an explicitly provided invalid value must fail rather than fall back. / 规范化可选枚举；显式传入的非法值必须报错而不是静默回退。
  const thinkingMode = input.thinkingMode === undefined
    ? undefined
    : assistantThinkingModes.includes(input.thinkingMode as AssistantThinkingMode)
      ? input.thinkingMode as AssistantThinkingMode
      : undefined;
  if (input.thinkingMode !== undefined && thinkingMode === undefined) throw new Error('思考强度无效。');
  const answerDepth = input.answerDepth === undefined
    ? 'auto'
    : assistantAnswerDepths.includes(input.answerDepth as AssistantAnswerDepth)
      ? input.answerDepth as AssistantAnswerDepth
      : undefined;
  if (!answerDepth) throw new Error('回答深度无效。');
  const skillIds = input.skillIds === undefined ? [] : readIds(input.skillIds, 'AI 助手技能', 3);
  const webSearch = input.webSearch === undefined
    ? undefined
    : input.webSearch === 'on' || input.webSearch === 'off'
      ? input.webSearch
      : undefined;
  if (input.webSearch !== undefined && webSearch === undefined) throw new Error('联网搜索开关无效。');
  const summaryCheckpoint = input.summaryCheckpoint === undefined ? undefined : readSummaryCheckpoint(input.summaryCheckpoint);
  return {
    requestId,
    intent,
    scope,
    userText,
    ...(currentNotePath ? { currentNotePath } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(contextSources.length ? { contextSources } : {}),
    ...(attachments.length ? { attachments } : {}),
    conversation,
    ...(modelProfileId ? { modelProfileId } : {}),
    ...(thinkingMode ? { thinkingMode } : {}),
    answerDepth,
    ...(skillIds.length ? { skillIds } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(summaryCheckpoint ? { summaryCheckpoint } : {}),
    ...(wikiTarget ? { wikiTarget } : {}),
  };
}

/**
 * Validates a summary resume checkpoint, including optional reduce-level state.
 * 校验摘要续跑 checkpoint，含可选的归并层级状态。
 */
function readSummaryCheckpoint(value: unknown): SummaryRunCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('摘要续跑 checkpoint 格式无效。');
  const input = value as Record<string, unknown>;
  const read = (candidate: unknown, label: string, maxLength: number): string => {
    if (typeof candidate !== 'string' || candidate.length > maxLength) throw new Error(`${label}格式无效。`);
    return candidate;
  };
  const mode = input.mode === 'summary-quick' || input.mode === 'summary-complete' ? input.mode : undefined;
  if (input.schemaVersion !== 1 || !mode) throw new Error('摘要续跑 checkpoint 版本或模式无效。');
  if (!Array.isArray(input.completedSectionIds) || input.completedSectionIds.length > 128) throw new Error('摘要续跑章节进度无效。');
  const completedSectionIds = input.completedSectionIds.map((id) => read(id, '摘要章节标识', 160));
  const checkpoint: SummaryRunCheckpoint = {
    schemaVersion: 1,
    mode,
    snapshotId: read(input.snapshotId, '摘要快照标识', 160),
    contentHash: read(input.contentHash, '摘要内容哈希', 128),
    libraryId: read(input.libraryId, '摘要资料库标识', 160),
    relativePath: read(input.relativePath, '摘要笔记路径', 4_000),
    providerFingerprint: read(input.providerFingerprint, '摘要模型指纹', 320),
    model: read(input.model, '摘要模型', 160),
    completedSectionIds,
  };
  if (input.reduceLevel !== undefined || input.reduceBatchIndex !== undefined) {
    const reduceLevel = typeof input.reduceLevel === 'number' ? input.reduceLevel : undefined;
    const reduceBatchIndex = typeof input.reduceBatchIndex === 'number' ? input.reduceBatchIndex : undefined;
    if (reduceLevel === undefined || reduceBatchIndex === undefined || !Number.isInteger(reduceLevel) || !Number.isInteger(reduceBatchIndex) || reduceLevel < 0 || reduceLevel > 6 || reduceBatchIndex < 0 || reduceBatchIndex > 128) throw new Error('摘要归并 checkpoint 层级无效。');
    checkpoint.reduceLevel = reduceLevel;
    checkpoint.reduceBatchIndex = reduceBatchIndex;
  }
  if (input.reduceItems !== undefined) checkpoint.reduceItems = readSummaryReduceItems(input.reduceItems);
  if (input.reduceCompletedItems !== undefined) checkpoint.reduceCompletedItems = readSummaryReduceItems(input.reduceCompletedItems);
  return checkpoint;
}

/**
 * Validates the reduce-item list of a summary checkpoint.
 * 校验摘要 checkpoint 中的归并条目列表。
 */
function readSummaryReduceItems(value: unknown): NonNullable<SummaryRunCheckpoint['reduceItems']> {
  if (!Array.isArray(value) || value.length > 128) throw new Error('摘要归并 checkpoint 内容无效。');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('摘要归并 checkpoint 项无效。');
    const item = entry as Record<string, unknown>;
    if (!Array.isArray(item.headingPath) || item.headingPath.length > 8 || item.headingPath.some((part) => typeof part !== 'string' || part.length > 300)) throw new Error('摘要标题路径无效。');
    if (typeof item.summary !== 'string' || item.summary.length > 4_000 || !Array.isArray(item.keyPoints) || item.keyPoints.length > 24 || item.keyPoints.some((point) => typeof point !== 'string' || point.length > 800)) throw new Error('摘要归并文本无效。');
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length > 64) throw new Error('摘要归并来源无效。');
    return {
      headingPath: [...item.headingPath] as string[],
      summary: item.summary,
      keyPoints: [...item.keyPoints] as string[],
      sourceRefs: item.sourceRefs.map((sourceRef) => {
        if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) throw new Error('摘要归并来源格式无效。');
        const ref = sourceRef as Record<string, unknown>;
        if (typeof ref.blockId !== 'string' || ref.blockId.length > 160 || typeof ref.textHash !== 'string' || ref.textHash.length > 128 || !Number.isInteger(ref.lineFrom) || !Number.isInteger(ref.lineTo)) throw new Error('摘要归并来源格式无效。');
        return { blockId: ref.blockId, lineFrom: ref.lineFrom as number, lineTo: ref.lineTo as number, textHash: ref.textHash };
      }),
    };
  });
}

/**
 * Validates a Wiki node target payload.
 * 校验 Wiki 节点目标载荷。
 */
function readWikiTarget(value: unknown): AssistantWikiTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Wiki 节点目标格式无效。');
  const input = value as Record<string, unknown>;
  const libraryPath = readString(input.libraryPath, 'Wiki 资料库路径', 4_000);
  if (!libraryPath.trim()) throw new Error('Wiki 资料库路径无效。');
  const documentId = readString(input.documentId, 'Wiki 文档标识', 160);
  if (!documentId.trim()) throw new Error('Wiki 文档标识无效。');
  const nodeId = readString(input.nodeId, 'Wiki 节点标识', 320);
  if (!nodeId.trim()) throw new Error('Wiki 节点标识无效。');
  if (!isWikiActionKind(input.actionKind)) throw new Error('Wiki 快捷动作无效。');
  return { libraryPath, documentId, nodeId, actionKind: input.actionKind };
}

/**
 * Validates the context-source list of a turn request.
 * 校验轮次请求的上下文来源列表。
 */
function readContextSources(value: unknown): AssistantContextSource[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('AI 助手查询范围格式无效。');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('AI 助手查询范围格式无效。');
    const input = entry as Record<string, unknown>;
    if (typeof input.kind !== 'string' || !assistantContextSourceKinds.includes(input.kind as AssistantContextSourceKind)) throw new Error('AI 助手查询范围类型无效。');
    const libraryPath = readString(input.libraryPath, '查询范围路径', 4_000);
    const label = input.label === undefined ? undefined : readString(input.label, '查询范围名称', 160);
    return { kind: input.kind as AssistantContextSourceKind, libraryPath, ...(label?.trim() ? { label: label.trim() } : {}) };
  });
}

/**
 * Validates the attachment list, enforcing per-kind size/count limits and unique ids.
 * 校验附件列表，强制各类大小/数量上限与唯一标识。
 */
function readAttachments(value: unknown): AssistantAttachment[] {
  if (!Array.isArray(value) || value.length > maxAssistantAttachmentCount) {
    throw new Error(`AI 附件数量不能超过 ${maxAssistantAttachmentCount} 个。`);
  }
  let imageTotalBytes = 0;
  let textTotalBytes = 0;
  const seenIds = new Set<string>();
  return value.map((entry): AssistantAttachment => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('AI 附件格式无效。');
    const input = entry as Record<string, unknown>;
    const attachmentId = readId(input.attachmentId, 'AI 附件');
    if (seenIds.has(attachmentId)) throw new Error('AI 附件标识重复。');
    seenIds.add(attachmentId);
    const name = readString(input.name, 'AI 附件名称', 255);
    if (input.kind === 'image') {
      const mimeType = input.mimeType;
      if (typeof mimeType !== 'string' || !assistantImageMimeTypes.includes(mimeType as AssistantImageMimeType)) {
        throw new Error('图片附件 MIME 类型无效。');
      }
      if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxAssistantImageBytes) {
        throw new Error(`图片附件“${name}”大小无效（上限 ${Math.floor(maxAssistantImageBytes / 1_000_000)} MB）。`);
      }
      imageTotalBytes += input.sizeBytes;
      if (imageTotalBytes > maxAssistantImageTotalBytes) {
        throw new Error(`图片附件总大小不能超过 ${Math.floor(maxAssistantImageTotalBytes / 1_000_000)} MB。`);
      }
      const dataUrl = readString(input.dataUrl, '图片附件数据', 32_000_000);
      if (!dataUrl.startsWith(`data:${mimeType};base64,`)) throw new Error('图片附件 dataUrl 格式无效。');
      return {
        kind: 'image',
        attachmentId,
        name,
        mimeType: mimeType as AssistantImageMimeType,
        sizeBytes: input.sizeBytes,
        dataUrl,
      };
    }
    if (input.kind === 'document') {
      const attachmentPath = readString(input.path, 'AI 附件路径', 4_000);
      const extension = attachmentPath.slice(attachmentPath.lastIndexOf('.')).toLowerCase();
      if (!assistantDocumentExtensions.has(extension)) throw new Error(`文档附件“${name}”扩展名不支持：${extension || '未知'}。`);
      if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxAssistantDocumentBytes) {
        throw new Error(`文档附件“${name}”大小无效（上限 ${Math.floor(maxAssistantDocumentBytes / 1_000_000)} MB）。`);
      }
      const mimeType = readString(input.mimeType, '文档附件 MIME', 160);
      return {
        kind: 'document',
        attachmentId,
        path: attachmentPath,
        name,
        mimeType,
        sizeBytes: input.sizeBytes,
      };
    }
    if (input.kind === 'text') {
      const attachmentPath = readString(input.path, 'AI 附件路径', 4_000);
      const extension = attachmentPath.slice(attachmentPath.lastIndexOf('.')).toLowerCase();
      if (!assistantTextExtensions.has(extension)) throw new Error(`文本附件“${name}”扩展名不支持：${extension || '未知'}。`);
      if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > maxAssistantAttachmentBytes) {
        throw new Error(`文本附件“${name}”大小无效（上限 ${Math.floor(maxAssistantAttachmentBytes / 1_000_000)} MB）。`);
      }
      textTotalBytes += input.sizeBytes;
      if (textTotalBytes > maxAssistantAttachmentTotalBytes) throw new Error('文本附件总大小不能超过 5 MB。');
      return {
        kind: 'text',
        attachmentId,
        path: attachmentPath,
        name,
        sizeBytes: input.sizeBytes,
      };
    }
    throw new Error('AI 附件类型无效。');
  });
}

/**
 * Validates conversation history, tail-truncating over-long messages and enforcing the total budget.
 * 校验会话历史：超长消息保留尾部截断，并强制总预算。
 */
function readConversation(value: unknown): AssistantConversationMessage[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error('会话上下文格式无效。');
  let total = 0;
  const result: AssistantConversationMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('会话上下文格式无效。');
    const message = entry as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') throw new Error('会话角色无效。');
    if (typeof message.content !== 'string') throw new Error('会话内容格式无效。');
    // History is only auxiliary context: tail-truncate over-long messages so a long self-produced answer cannot block the next question. / 历史消息只是辅助上下文：单条超长时保留尾部截断，避免应用自身产生的长回答阻断新一轮提问。
    const content = message.content.slice(Math.max(0, message.content.length - 2_000)).trim();
    if (!content) continue;
    total += content.length;
    if (total > 4_000) throw new Error('会话上下文不能超过 4000 字符。');
    result.push({ role: message.role, content });
  }
  return result;
}

/** Reads and bounds-checks a string field. / 读取字符串字段并校验长度。 */
function readString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  if (value.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return value;
}

/** Reads an id field matching the allowed alphanumeric-hyphen pattern. / 读取符合字母数字连字符格式的标识字段。 */
function readId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{7,96}$/.test(value)) throw new Error(`${label}标识无效。`);
  return value;
}

/** Reads a deduplicated list of bounded id fields. / 读取去重后的标识列表（有数量上限）。 */
function readIds(value: unknown, label: string, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxLength) throw new Error(`${label}格式无效。`);
  return Array.from(new Set(value.map((entry) => readId(entry, label))));
}
