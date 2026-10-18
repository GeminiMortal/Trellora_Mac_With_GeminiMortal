/**
 * Creation of AI assistant notes with collision-free naming and atomic writes into a note library.
 * AI 助手笔记的创建：无冲突命名，并以原子写入方式落入笔记库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeAssistantNoteTitle, type AssistantNoteSource, type CreateAssistantNoteResult } from '../../shared/assistantNote.ts';
import { atomicTextWrite } from '../atomicTextWrite.ts';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import { parseNoteFrontmatter, stringifyNoteFrontmatter } from '../../shared/frontmatter.ts';

/**
 * Caller holds the library structure queue. Preserve Markdown bytes and never replace an existing note.
 * 调用方需持有笔记库结构队列。保留 Markdown 字节，且绝不覆盖已有笔记。
 *
 * @param libraryPath - Library root to create the note in / 创建笔记所在笔记库的根目录
 * @param rawTitle - Raw title supplied by the assistant / 助手提供的原始标题
 * @param rawContent - Raw Markdown content / 原始 Markdown 内容
 * @param source - Optional provenance recorded in frontmatter / 可选的来源信息，写入 frontmatter
 * @returns Created note path and title / 已创建笔记的路径与标题
 */
export async function createAssistantNote(libraryPath: string, rawTitle: string, rawContent: string, source?: AssistantNoteSource): Promise<CreateAssistantNoteResult> {
  const content = source ? withAssistantSourceFrontmatter(rawContent, source) : rawContent;
  const title = normalizeAssistantNoteTitle(rawTitle);
  const names = await collectNoteNames(libraryPath);
  const metaDirectory = assertInsideDirectory(path.join(libraryPath, '.menghan-meta'), libraryPath);
  const sequencePath = assertInsideDirectory(path.join(metaDirectory, 'ai-note-sequence.json'), libraryPath);
  let sequence = 0;
  if (!title) {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(sequencePath, 'utf8'));
      if (!saved || typeof saved !== 'object' || !('lastUntitledIndex' in saved)
        || !Number.isSafeInteger(saved.lastUntitledIndex) || Number(saved.lastUntitledIndex) < 0) {
        throw new Error('未命名笔记的编号记录无效，请检查笔记库元数据。');
      }
      sequence = Number(saved.lastUntitledIndex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      const match = /^未命名\[(\d+)\]\.md$/u.exec(name);
      if (match && Number.isSafeInteger(Number(match[1]))) sequence = Math.max(sequence, Number(match[1]));
    }
    await fs.mkdir(metaDirectory, { recursive: true });
  }
  let suffix = 0;
  if (title) {
    for (const name of names) {
      const prefix = `${title.toLocaleLowerCase()}[`;
      if (!name.startsWith(prefix) || !name.endsWith('].md')) continue;
      const value = Number(name.slice(prefix.length, -4));
      if (Number.isSafeInteger(value) && value > 0) suffix = Math.max(suffix, value);
    }
  }
  for (;;) {
    let candidateTitle: string;
    if (!title) {
      if (!Number.isSafeInteger(sequence + 1)) throw new Error('未命名笔记编号已超出可用范围。');
      sequence++;
      // Reserve before creating: deletion, restart, or a failed write must not reuse an allocated number.
      // 创建前先预留编号：删除、重启或写入失败都不得复用已分配的编号。
      await atomicTextWrite(sequencePath, JSON.stringify({ version: 1, lastUntitledIndex: sequence }), async () => {
        assertInsideDirectory(sequencePath, libraryPath);
      });
      candidateTitle = `未命名[${sequence}]`;
    } else {
      candidateTitle = names.has(`${title}.md`.toLocaleLowerCase()) ? `${title}[${++suffix}]` : title;
    }
    const fileName = `${candidateTitle}.md`;
    if (names.has(fileName.toLocaleLowerCase())) continue;
    const notePath = assertInsideDirectory(path.join(libraryPath, fileName), libraryPath);
    let handle;
    try {
      handle = await fs.open(notePath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      names.add(fileName.toLocaleLowerCase());
      continue;
    }
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.unlink(notePath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return { libraryPath, path: notePath, title: candidateTitle };
  }
}

/**
 * Include nested notes when allocating names, without traversing links or application metadata.
 * 分配名称时纳入嵌套笔记，但不跟踪链接，也不遍历应用元数据。
 *
 * @param directory - Directory to scan / 要扫描的目录
 * @param names - Accumulator of lower-cased note file names / 累积的小写笔记文件名集合
 * @returns All discovered lower-cased note file names / 发现的全部小写笔记文件名
 */
async function collectNoteNames(directory: string, names = new Set<string>()): Promise<Set<string>> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === '.menghan-meta' || entry.name === '.git') continue;
    if (entry.isDirectory()) await collectNoteNames(path.join(directory, entry.name), names);
    else if (entry.isFile() && /\.md$/iu.test(entry.name)) names.add(entry.name.toLocaleLowerCase());
  }
  return names;
}

const SOURCE_FIELD_LIMIT = 256;

/**
 * Write the AI answer's provenance (session/message/scope) into frontmatter, preserving existing frontmatter fields.
 * 把 AI 回答的来源（会话/消息/范围）写入 frontmatter，保留正文原有 frontmatter 字段。
 *
 * @param content - Note Markdown content / 笔记 Markdown 内容
 * @param source - Provenance to record / 要记录的来源信息
 * @returns Content with assistant_source frontmatter added / 添加了 assistant_source frontmatter 的内容
 */
function withAssistantSourceFrontmatter(content: string, source: AssistantNoteSource): string {
  const sanitized: Record<string, string> = {};
  // Each provenance field is trimmed and capped so oversized values cannot bloat frontmatter.
  // 每个来源字段都会裁剪并截断，避免超大值撑爆 frontmatter。
  const bounded = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, SOURCE_FIELD_LIMIT) : undefined;
  };
  const fields: Array<[string, unknown]> = [
    ['sessionId', source.sessionId],
    ['messageId', source.messageId],
    ['scope', source.scope],
    ['scopeLabel', source.scopeLabel],
    ['createdAt', source.createdAt],
  ];
  for (const [key, value] of fields) {
    const text = bounded(value);
    if (text) sanitized[key] = text;
  }
  if (!Object.keys(sanitized).length) return content;
  const parsed = parseNoteFrontmatter(content);
  return stringifyNoteFrontmatter(parsed.content, { ...parsed.data, assistant_source: { kind: 'assistant', ...sanitized } });
}
