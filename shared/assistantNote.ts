/**
 * Shared types and helpers for creating assistant-generated notes in a library.
 * 在资料库中创建助手生成笔记的共享类型与辅助函数。
 */

/**
 * Provenance of a note created from an assistant reply.
 * 由助手回复创建的笔记的来源信息。
 */
export interface AssistantNoteSource {
  /** Always 'assistant' for assistant-generated notes. / 助手生成的笔记恒为 'assistant'。 */
  kind: 'assistant';
  /** Chat session that produced the note. / 产生该笔记的聊天会话。 */
  sessionId?: string;
  /** Chat message that produced the note. / 产生该笔记的聊天消息。 */
  messageId?: string;
  /** Scope key the note belongs to. / 笔记所属的范围键。 */
  scope?: string;
  /** Human-readable scope label. / 可读的范围标签。 */
  scopeLabel?: string;
  /** ISO timestamp of note creation. / 笔记创建时的 ISO 时间戳。 */
  createdAt?: string;
}

/**
 * Request to create a note from assistant content inside a library.
 * 在资料库中根据助手内容创建笔记的请求。
 */
export interface CreateAssistantNoteRequest {
  /** Absolute path of the target library. / 目标资料库的绝对路径。 */
  libraryPath: string;
  /** Optional note title; the main process allocates one when omitted. / 可选笔记标题；省略时由主进程分配。 */
  title?: string;
  /** Markdown content of the note. / 笔记的 Markdown 内容。 */
  content: string;
  /** Optional provenance metadata. / 可选来源元数据。 */
  source?: AssistantNoteSource;
}

/**
 * Result of a successful assistant note creation.
 * 成功创建助手笔记后的结果。
 */
export interface CreateAssistantNoteResult {
  /** Absolute path of the library containing the note. / 包含该笔记的资料库绝对路径。 */
  libraryPath: string;
  /** Absolute path of the created note file. / 创建的笔记文件绝对路径。 */
  path: string;
  /** Final title of the note. / 笔记的最终标题。 */
  title: string;
}

/**
 * Validate a note title as a macOS-safe file name; empty titles are allocated by the main process and explicit titles must be valid macOS filenames.
 * 将笔记标题校验为 macOS 安全的文件名；空标题由主进程分配，显式标题必须是合法的 macOS 文件名。
 *
 * @param value - Raw title candidate / 原始标题候选
 * @returns Trimmed title without a trailing .md suffix, or an empty string / 去除首尾空白与 .md 后缀后的标题；空字符串表示由主进程分配
 * @throws Error when the title is not a valid macOS file name / 标题不是合法 macOS 文件名时抛出异常
 */
export function normalizeAssistantNoteTitle(value: string): string {
  const title = value.trim().replace(/\.md$/iu, '').trim();
  if (!title) return '';
  // Reject illegal filename characters, reserved device names, trailing dots/spaces, and overlong titles.
  // 拒绝非法文件名字符、保留设备名、结尾点/空格及过长标题。
  if (title.length > 150 || /[<>:"/\\|?*\u0000-\u001f]/u.test(title)
    || /[. ]$/u.test(title) || title === '.' || title === '..'
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(title)) {
    throw new Error('标题不能包含文件名非法字符、保留名称，且不能超过 150 个字符。');
  }
  return title;
}
