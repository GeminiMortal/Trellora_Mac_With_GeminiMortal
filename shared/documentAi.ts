/**
 * Shared protocol types for in-document AI actions (rewrite, translate, summary, question).
 * 文档内 AI 操作（改写、翻译、摘要、提问）的共享协议类型。
 */

/**
 * Kind of AI action requested on a document.
 * 对文档请求的 AI 操作类型。
 */
export type DocumentAiAction = 'rewrite' | 'translate' | 'summary' | 'question';

/**
 * A text selection inside the document draft addressed by character offsets.
 * 文档草稿中以字符偏移定位的文本选区。
 */
export interface DocumentAiSelection {
  /** Inclusive start offset of the selection. / 选区的起始偏移（含）。 */
  from: number;
  /** Exclusive end offset of the selection. / 选区的结束偏移（不含）。 */
  to: number;
  /** Selected plain text. / 选中的纯文本。 */
  text: string;
}

/**
 * Request to apply an AI result back to a document draft under revision control.
 * 在修订控制下将 AI 结果应用回文档草稿的请求。
 */
export interface DocumentAiApplyRequest {
  /** Id of the receipt authorizing this apply. / 授权本次应用的结果回执 id。 */
  receiptId: string;
  /** Target document session id. / 目标文档会话 id。 */
  documentSessionId: string;
  /** Draft revision the result was computed against. / 计算该结果时所基于的草稿修订号。 */
  draftRevision: number;
  /** Optional selection the result replaces; omitted means whole-document scope. / 结果替换的可选选区；省略表示整篇文档范围。 */
  selection?: DocumentAiSelection;
}

/**
 * Request to run an AI action on a document draft.
 * 对文档草稿执行一次 AI 操作的请求。
 */
export interface DocumentAiRequest {
  /** Document session the action runs against. / 操作所针对的文档会话。 */
  documentSessionId: string;
  /** Draft revision at request time. / 请求时的草稿修订号。 */
  draftRevision: number;
  /** Client-generated id used to correlate the response. / 客户端生成的请求 id，用于关联响应。 */
  requestId: string;
  /** Action to perform. / 要执行的操作。 */
  action: DocumentAiAction;
  /** Optional selection scope; omitted means whole document. / 可选选区范围；省略表示整篇文档。 */
  selection?: DocumentAiSelection;
  /** User question text, required for the question action. / 用户提问文本，question 操作必需。 */
  question?: string;
  /** Target language for the translate action. / translate 操作的目标语言。 */
  targetLanguage?: 'zh-CN' | 'en';
  /** Optional library path used to ground the answer. / 用于回答依据检索的可选资料库路径。 */
  libraryPath?: string;
}

/**
 * Result of a completed AI action, carryable back to the editor via a receipt.
 * 一次 AI 操作完成后的结果，可通过回执带回编辑器。
 */
export interface DocumentAiResult {
  /** Receipt id used to authorize applying this result. / 用于授权应用该结果的回执 id。 */
  receiptId: string;
  /** Document session the result belongs to. / 结果所属的文档会话。 */
  documentSessionId: string;
  /** Draft revision the result was computed against. / 计算该结果时所基于的草稿修订号。 */
  draftRevision: number;
  /** Content hash of the draft at computation time. / 计算时草稿的内容哈希。 */
  contentHash: string;
  /** Action that produced this result. / 产生该结果的操作。 */
  action: DocumentAiAction;
  /** Selection the result applies to, when scoped. / 结果作用的选区（如果限定范围）。 */
  selection?: DocumentAiSelection;
  /** Generated text. / 生成的文本。 */
  text: string;
  /** Whether the text targets the selection or the whole document. / 文本作用于选区还是整篇文档。 */
  scope: 'selection' | 'document';
  /** Library used as grounding evidence, when consulted. / 参考检索的资料库（如有）。 */
  supplementLibrary?: string;
  /** Rough input token count estimate for budgeting. / 用于预算的输入 token 粗略估计。 */
  inputTokensEstimate: number;
}
