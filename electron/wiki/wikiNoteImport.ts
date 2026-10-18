/**
 * Import Wiki documents and section subtrees as Markdown notes, with image transfer and dedup reuse.
 * 将 Wiki 整篇文档与章节子树导入为 Markdown 笔记，含图片搬运与同源去重复用。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseNoteFrontmatter, stringifyNoteFrontmatter } from '../../shared/frontmatter.ts';
import { assertExistingDirectory, assertInsideDirectory, getUniquePath, sanitizeEntryName } from '../files/pathGuards.ts';
import { readParseImagesManifest, rewriteMarkdownImageReferences } from '../pipeline/parseImages.ts';

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** Shared identity of a Wiki import source, used for reuse matching / Wiki 导入源的共享身份信息，用于复用判定 */
interface WikiNoteImportInput {
  sourceLibraryPath: string;
  targetLibraryPath: string;
  documentId: string;
  contentHash: string;
  documentName: string;
  parseDirectory: string;
}

/**
 * Input for importing a Wiki section subtree as a note, on top of document-level import identity.
 * 在整篇导入身份之上，追加章节子树导入所需的节点信息。
 */
export interface WikiSectionNoteImportInput extends WikiNoteImportInput {
  /** Section node id (e.g. wiki:<documentId>:<structureNodeId>) / 章节节点 id（形如 wiki:<documentId>:<structureNodeId>） */
  nodeId: string;
  /** Section title, also used as the note base name / 章节标题，也用作笔记基础文件名 */
  nodeTitle: string;
  /** Rendered markdown of the section subtree / 章节子树渲染出的 markdown 正文 */
  markdown: string;
}

/** Same source and version reuse is decided via the wiki_source frontmatter; whole-document reuse only matches records without nodeId. / 同源同版本的整篇/章节笔记按 wiki_source frontmatter 判定复用；整篇只复用无 nodeId 的记录。 */
function matchesExistingWikiSource(data: Record<string, unknown>, sourceLibrary: string, documentId: string, contentHash: string, nodeId?: string): boolean {
  const source = data.wiki_source as { libraryPath?: string; documentId?: string; contentHash?: string; nodeId?: string } | undefined;
  if (source?.libraryPath !== sourceLibrary || source.documentId !== documentId || source.contentHash !== contentHash) return false;
  return nodeId ? source.nodeId === nodeId : !source.nodeId;
}

/** Scan the target library for an existing note with matching wiki_source; oversized or corrupt notes are skipped. / 在目标笔记库中查找 wiki_source 匹配的已有笔记；体积超限或损坏的笔记直接跳过。 */
function findExistingWikiNote(targetLibrary: string, sourceLibrary: string, input: WikiNoteImportInput, nodeId?: string): string | null {
  for (const entry of fs.readdirSync(targetLibrary, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
    const notePath = path.join(targetLibrary, entry.name);
    if (fs.statSync(notePath).size > MAX_DOCUMENT_BYTES + 65536) continue;
    try {
      if (matchesExistingWikiSource(parseNoteFrontmatter(fs.readFileSync(notePath, 'utf8')).data, sourceLibrary, input.documentId, input.contentHash, nodeId)) {
        return notePath;
      }
    } catch { /* Invalid existing frontmatter must not break the import, and must not overwrite that note. / 无效的已有 frontmatter 不影响导入，也不能覆盖该笔记。 */ }
  }
  return null;
}

/**
 * Create a note from validated full parse artifacts; same source and version reuse the existing note,
 * while user edits and same-named files are preserved.
 * 从已校验的完整 parse 产物创建笔记；同源同版本复用，保留笔记编辑和同名文件。
 *
 * @param input - Source/target library identity and parse directory / 源库与目标库身份及 parse 产物目录
 * @returns Path of the note and whether it was newly created / 笔记路径以及是否新建
 */
export async function importWikiDocumentAsNote(input: WikiNoteImportInput): Promise<{ path: string; created: boolean }> {
  const targetLibrary = fs.realpathSync(assertExistingDirectory(input.targetLibraryPath));
  const sourceLibrary = fs.realpathSync(assertExistingDirectory(input.sourceLibraryPath));
  const parseDirectory = assertInsideDirectory(fs.realpathSync(input.parseDirectory), sourceLibrary);
  const markdownPath = assertInsideDirectory(fs.realpathSync(path.join(parseDirectory, 'document.md')), parseDirectory);
  if (fs.statSync(markdownPath).size > MAX_DOCUMENT_BYTES) throw new Error('文档解析正文超过 16 MB，暂时无法转为笔记。');
  const lines = fs.readFileSync(markdownPath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const layoutPath = assertInsideDirectory(fs.realpathSync(path.join(parseDirectory, 'line-layout.jsonl')), parseDirectory);
  const blankBefore = new Set<number>();
  for (const line of fs.readFileSync(layoutPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { lineNo?: number; blankBefore?: boolean };
    if (record.blankBefore && Number.isInteger(record.lineNo) && record.lineNo! > 0) blankBefore.add(record.lineNo!);
  }
  const markdown = lines.flatMap((line, index) => blankBefore.has(index + 1) ? ['', line] : [line]).join('\n');
  if (!markdown.trim()) throw new Error('文档解析正文为空，请先在资料库重新处理。');
  return writeWikiMarkdownAsNote({ sourceLibrary, targetLibrary, parseDirectory, input, markdown });
}

/**
 * Store the rendered markdown of a Wiki section subtree as a note; reuses the document-level
 * import conventions for images, dedup and frontmatter.
 * 把 Wiki 章节子树的渲染 markdown 存为笔记；复用整篇导入的图片/去重/frontmatter 约定。
 *
 * @param input - Section node identity plus rendered markdown / 章节节点身份与渲染出的 markdown
 * @returns Path of the note and whether it was newly created / 笔记路径以及是否新建
 */
export async function importWikiSectionAsNote(input: WikiSectionNoteImportInput): Promise<{ path: string; created: boolean }> {
  const targetLibrary = fs.realpathSync(assertExistingDirectory(input.targetLibraryPath));
  const sourceLibrary = fs.realpathSync(assertExistingDirectory(input.sourceLibraryPath));
  const parseDirectory = assertInsideDirectory(fs.realpathSync(input.parseDirectory), sourceLibrary);
  if (!input.markdown.trim()) throw new Error('该章节没有可导入的正文内容。');
  return writeWikiMarkdownAsNote({
    sourceLibrary, targetLibrary, parseDirectory, input,
    markdown: input.markdown,
    nodeId: input.nodeId,
    nodeTitle: input.nodeTitle,
    baseNameOverride: input.nodeTitle,
  });
}

/** Shared note writer: reuses an existing note when wiki_source matches; otherwise copies verified images and creates the note with rollback on failure. / 笔记写入共用逻辑：wiki_source 匹配则复用已有笔记；否则搬运经校验的图片并新建笔记，失败时回滚。 */
async function writeWikiMarkdownAsNote(options: {
  sourceLibrary: string;
  targetLibrary: string;
  parseDirectory: string;
  input: WikiNoteImportInput;
  markdown: string;
  nodeId?: string;
  nodeTitle?: string;
  baseNameOverride?: string;
}): Promise<{ path: string; created: boolean }> {
  const { sourceLibrary, targetLibrary, parseDirectory, input, markdown } = options;
  const existing = findExistingWikiNote(targetLibrary, sourceLibrary, input, options.nodeId);
  if (existing) return { path: existing, created: false };

  const createdFiles: string[] = [];
  try {
    const imageManifest = readParseImagesManifest(parseDirectory);
    const rewrites = new Map<string, string>();
    if (imageManifest?.images.length) {
      const sourceKey = crypto.createHash('sha256').update(`${sourceLibrary}\0${input.documentId}`).digest('hex').slice(0, 16);
      const imageDirectory = assertInsideDirectory(path.join(targetLibrary, 'image', 'wiki', sourceKey), targetLibrary);
      // Validate each existing parent directory to avoid writing attachments outside the note library via symlinks.
      // 检查每个已存在的父目录，避免通过符号链接把附件写到笔记库外。
      let parent = targetLibrary;
      for (const segment of ['image', 'wiki', sourceKey]) {
        parent = path.join(parent, segment);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent);
        assertInsideDirectory(fs.realpathSync(parent), targetLibrary);
      }
      for (const image of imageManifest.images) {
        const sourcePath = assertInsideDirectory(fs.realpathSync(path.join(parseDirectory, image.relativePath)), parseDirectory);
        const bytes = fs.readFileSync(sourcePath);
        // Verify the artifact image has not been tampered with since parsing.
        // 校验解析阶段产物图片未被篡改。
        if (bytes.length !== image.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
          throw new Error('文档图片产物已变化，请先重新处理文档。');
        }
        const imageName = `${image.sha256}${path.extname(image.name)}`;
        const imagePath = assertInsideDirectory(path.join(imageDirectory, imageName), imageDirectory);
        if (fs.existsSync(imagePath)) {
          // Same-named image already exists in the note library; reject if its content hash differs.
          // 笔记库内已存在同名图片；若内容 hash 不一致则拒绝导入。
          assertInsideDirectory(fs.realpathSync(imagePath), targetLibrary);
          if (crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex') !== image.sha256) {
            throw new Error('笔记库内的同名图片已变化，无法导入。');
          }
        } else {
          fs.copyFileSync(sourcePath, imagePath, fs.constants.COPYFILE_EXCL);
          createdFiles.push(imagePath);
        }
        rewrites.set(image.relativePath, path.relative(targetLibrary, imagePath).replace(/\\/g, '/'));
      }
    }
    let body = rewriteMarkdownImageReferences(markdown, rewrites);
    const parsed = parseNoteFrontmatter(body);
    // Carry over the source frontmatter's tags; [[wiki links]] stay as-is in the body, not rewritten.
    // 搬运来源 frontmatter 的 tags；[[wiki链接]] 保留在正文原样，不重写。
    const carriedTags = parsed.data.tags;
    const source: Record<string, unknown> = { libraryPath: sourceLibrary, documentId: input.documentId, contentHash: input.contentHash, sourceName: input.documentName };
    if (options.nodeId) {
      source.nodeId = options.nodeId;
      source.nodeTitle = options.nodeTitle ?? '';
    }
    body = parsed.content;
    const frontmatter: Record<string, unknown> = { ...parsed.data, wiki_source: source };
    if (Array.isArray(carriedTags) && !frontmatter.tags) frontmatter.tags = carriedTags;
    const content = stringifyNoteFrontmatter(body, frontmatter);
    const baseName = sanitizeEntryName(path.parse(options.baseNameOverride ?? input.documentName).name);
    const notePath = getUniquePath(targetLibrary, `${baseName}.md`);
    const handle = await fs.promises.open(notePath, 'wx');
    createdFiles.push(notePath);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return { path: notePath, created: true };
  } catch (error) {
    for (const createdPath of createdFiles.reverse()) {
      try { fs.unlinkSync(createdPath); } catch { /* Clean up newly created files from this run while preserving the original error. / 清理本次新增文件，保留原始错误。 */ }
    }
    throw error;
  }
}
