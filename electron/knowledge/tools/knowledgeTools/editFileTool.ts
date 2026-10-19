/**
 * Tool: edit_file — safely modify markdown files in the knowledge library.
 * 工具：edit_file — 安全地修改资料库中的 Markdown 文件。
 *
 * Supports three operations: replace (find & replace), append (add to end),
 * and overwrite (full rewrite). All writes go through atomicTextWrite with
 * path guards to prevent escaping the library root.
 * 支持三种操作：replace（查找替换）、append（追加到末尾）、overwrite（整体改写）。
 * 所有写入通过 atomicTextWrite 完成，并使用路径守卫防止逃逸资料库根目录。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReActTool, ReActToolExecution } from '../../reactAgent/toolRegistry.ts';
import { escapeXmlAttribute, escapeXmlText, type KnowledgeToolContext } from '../knowledgeToolContext.ts';
import { assertInsideDirectory } from '../../../files/pathGuards.ts';
import { atomicTextWrite } from '../../../atomicTextWrite.ts';

/** Max content length accepted per edit call. / 单次编辑接受的最大内容长度。 */
const MAX_EDIT_CONTENT_CHARS = 30_000;
/** Max preview chars returned after a successful edit. / 编辑成功后返回的最大预览字符数。 */
const MAX_RESULT_PREVIEW_CHARS = 2_000;

/**
 * ReAct tool definition for editing markdown files in the knowledge library.
 * 编辑资料库 Markdown 文件的 ReAct 工具定义。
 */
export const editFileTool: ReActTool<KnowledgeToolContext> = {
  name: 'edit_file',
  description: [
    '修改资料库中的 Markdown 文件（笔记）：支持查找替换（replace）、追加内容（append）、整体改写（overwrite）。',
    '适用：用户明确要求修改、补充、重写某篇笔记内容时。',
    '不适用：仅检索或阅读内容——读取用 grep_chunks / list_knowledge_chunks；创建新笔记不在此工具范围。',
    'file_path 传相对于资料库根目录的文件路径（如 "笔记.md" 或 "子目录/笔记.md"）；',
    'replace 需提供 old_string（要替换的原文）和 new_string（替换后的文本）；',
    'append 需提供 content（追加到文件末尾的文本）；overwrite 需提供 content（新文件全文）。',
    '每次编辑前请先用 grep_chunks 或 list_knowledge_chunks 确认文件当前内容，避免误改。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对于资料库根目录的 Markdown 文件路径',
      },
      operation: {
        type: 'string',
        enum: ['replace', 'append', 'overwrite'],
        description: '操作类型：replace=查找替换，append=追加到末尾，overwrite=整体改写',
      },
      old_string: {
        type: 'string',
        description: '（replace 专用）要查找并替换的原文片段，必须与文件内容完全匹配',
      },
      new_string: {
        type: 'string',
        description: '（replace 专用）替换后的文本',
      },
      content: {
        type: 'string',
        description: '（append / overwrite 专用）要写入的 Markdown 内容',
      },
    },
    required: ['file_path', 'operation'],
  },
  execute: async (args, ctx) => runEditFile(args, ctx),
};

/**
 * Execute edit_file: validate inputs, perform the edit, and return a summary.
 * 执行 edit_file：校验输入、执行编辑并返回摘要。
 *
 * @param args - Tool arguments / 工具参数
 * @param ctx - Knowledge tool context / 知识工具上下文
 * @returns Tool execution result / 工具执行结果
 */
async function runEditFile(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<ReActToolExecution> {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  const operation = typeof args.operation === 'string' ? args.operation.trim() : '';
  const oldString = typeof args.old_string === 'string' ? args.old_string : '';
  const newString = typeof args.new_string === 'string' ? args.new_string : '';
  const content = typeof args.content === 'string' ? args.content : '';

  if (!filePath) {
    return { ok: false, observation: '<tool_error>缺少必填参数 file_path。</tool_error>', message: '缺少 file_path 参数。' };
  }
  if (!['replace', 'append', 'overwrite'].includes(operation)) {
    return { ok: false, observation: `<tool_error>不支持的操作 "${escapeXmlText(operation)}"；请使用 replace、append 或 overwrite。</tool_error>`, message: `不支持的操作：${operation}。` };
  }

  // Resolve and guard the target path inside the library root.
  // 解析并守卫目标路径在资料库根目录内。
  let safePath: string;
  try {
    safePath = assertInsideDirectory(path.resolve(ctx.libraryPath, filePath), ctx.libraryPath);
  } catch {
    return { ok: false, observation: `<tool_error>路径 "${escapeXmlText(filePath)}" 超出资料库范围，已拒绝。</tool_error>`, message: '文件路径超出资料库范围。' };
  }

  // Only .md files are editable.
  // 仅允许编辑 .md 文件。
  if (!safePath.toLowerCase().endsWith('.md')) {
    return { ok: false, observation: '<tool_error>edit_file 仅支持编辑 Markdown（.md）文件。</tool_error>', message: '仅支持 .md 文件。' };
  }

  // Check the file exists for replace/append; overwrite may create a new file.
  // replace/append 要求文件已存在；overwrite 可创建新文件。
  let currentContent = '';
  if (operation !== 'overwrite') {
    try {
      currentContent = await fs.readFile(safePath, 'utf8');
    } catch {
      return { ok: false, observation: `<tool_error>文件 "${escapeXmlText(filePath)}" 不存在；overwrite 可创建新文件。</tool_error>`, message: `文件不存在：${filePath}。` };
    }
  } else {
    try {
      currentContent = await fs.readFile(safePath, 'utf8');
    } catch {
      // File doesn't exist yet — overwrite will create it.
      // 文件尚不存在 — overwrite 将创建它。
    }
  }

  let nextContent: string;
  let changeDescription: string;

  switch (operation) {
    case 'replace': {
      if (!oldString) {
        return { ok: false, observation: '<tool_error>replace 操作需要提供 old_string 参数。</tool_error>', message: 'replace 缺少 old_string。' };
      }
      const occurrences = currentContent.split(oldString).length - 1;
      if (occurrences === 0) {
        return {
          ok: false,
          observation: `<tool_error>在 "${escapeXmlText(filePath)}" 中未找到 old_string；请先用 grep_chunks 确认文件内容后重试。</tool_error>`,
          message: 'old_string 未匹配到文件内容。',
        };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          observation: `<tool_error>old_string 在文件中出现 ${occurrences} 次，无法确定替换目标；请提供更长的唯一上下文片段。</tool_error>`,
          message: `old_string 不唯一（${occurrences} 处匹配）。`,
        };
      }
      nextContent = currentContent.replace(oldString, newString);
      const removed = oldString.length;
      const added = newString.length;
      changeDescription = `已将 ${removed} 字符替换为 ${added} 字符`;
      break;
    }
    case 'append': {
      if (!content) {
        return { ok: false, observation: '<tool_error>append 操作需要提供 content 参数。</tool_error>', message: 'append 缺少 content。' };
      }
      if (content.length > MAX_EDIT_CONTENT_CHARS) {
        return { ok: false, observation: `<tool_error>content 超过 ${MAX_EDIT_CONTENT_CHARS} 字符上限，请分批追加。</tool_error>`, message: 'content 超出长度限制。' };
      }
      const separator = currentContent && !currentContent.endsWith('\n') ? '\n\n' : '';
      nextContent = currentContent + separator + content;
      changeDescription = `已在末尾追加 ${content.length} 字符`;
      break;
    }
    case 'overwrite': {
      if (!content) {
        return { ok: false, observation: '<tool_error>overwrite 操作需要提供 content 参数。</tool_error>', message: 'overwrite 缺少 content。' };
      }
      if (content.length > MAX_EDIT_CONTENT_CHARS) {
        return { ok: false, observation: `<tool_error>content 超过 ${MAX_EDIT_CONTENT_CHARS} 字符上限，请使用 replace/append 分批修改。</tool_error>`, message: 'content 超出长度限制。' };
      }
      nextContent = content;
      changeDescription = `已整体改写文件（${content.length} 字符）`;
      break;
    }
    default:
      return { ok: false, observation: '<tool_error>未知操作。</tool_error>', message: '未知操作。' };
  }

  // Atomic write with path guard.
  // 带路径守卫的原子写入。
  try {
    await atomicTextWrite(safePath, nextContent, async () => {
      assertInsideDirectory(safePath, ctx.libraryPath);
    });
  } catch (writeError) {
    const message = writeError instanceof Error ? writeError.message : String(writeError);
    return { ok: false, observation: `<tool_error>写入失败：${escapeXmlText(message)}</tool_error>`, message: `文件写入失败：${message}` };
  }

  const fileName = path.basename(safePath);
  const preview = nextContent.length > MAX_RESULT_PREVIEW_CHARS
    ? nextContent.slice(0, MAX_RESULT_PREVIEW_CHARS)
    : nextContent;
  const truncated = nextContent.length > MAX_RESULT_PREVIEW_CHARS;

  const observation = [
    `<file_edited file="${escapeXmlAttribute(fileName)}" operation="${escapeXmlAttribute(operation)}" total_chars="${nextContent.length}">`,
    `  <content>${escapeXmlText(preview)}${truncated ? '\n…（已截断）' : ''}</content>`,
    '</file_edited>',
    `<retrieval_note>${escapeXmlText(`${changeDescription}。文件已保存。如需继续修改，请先用 grep_chunks 确认最新内容。`)}</retrieval_note>`,
  ].join('\n');

  return {
    ok: true,
    observation,
    message: `已修改「${fileName}」：${changeDescription}。`,
  };
}
