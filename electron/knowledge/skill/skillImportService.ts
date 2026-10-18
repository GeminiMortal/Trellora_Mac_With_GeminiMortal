/**
 * Skill import service: imports skills from zip archives and validates metadata.
 * 技能导入服务：从 zip 归档导入技能并校验元数据。
 */

import fs from 'node:fs';
import { isBundledSkill } from './bundledSkills.ts';
import path from 'node:path';
import JSZip from 'jszip';
import { getAiSkillWorkspacePath } from '../aiSkillWorkspace.ts';
import {
  allowedResourceExtensions,
  ignoredDirectoryNames,
  listSkillResourceFiles,
  parseSkillMarkdown,
  validateDirectorySkillMetadata,
  type DirectorySkillLoadOutcome,
} from './skillDirectoryLoader.ts';
import type {
  AiSkillsOverview,
  DirectorySkillIssue,
  DirectorySkillOverride,
  DirectorySkillOverviewEntry,
  SkillImportResult,
} from '../ai/aiTypes.ts';

/**
 * 技能导入服务（设置 → AI 助手技能 → 导入）：把用户选择的文件夹 / .zip / 单个
 * SKILL.md 归一化为标准目录技能 `AI-Skill/<frontmatter name>/SKILL.md`。
 *
 * 校验与运行期加载完全同源（parseSkillMarkdown + validateDirectorySkillMetadata），
 * 保证「导入能过 = 加载能过」；包体安全检查对齐 WeKnora ParseSkillBundle：
 * 拒绝符号链接与路径逃逸，数量/大小上限按本地桌面场景收紧。
 * 落盘沿用项目惯例：先写临时目录，校验通过后原子改名为正式目录。
 */

const MAX_IMPORT_RESOURCE_FILES = 500;
const MAX_IMPORT_RESOURCE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 64 * 1024 * 1024;
/** 与 read_skill 资源遍历深度（MAX_RESOURCE_DEPTH=4）保持一致。 */
const MAX_IMPORT_DEPTH = 4;

/**
 * Source descriptor for skill import: directory, zip archive, or single markdown file.
 * 技能导入来源描述符：文件夹、zip 压缩包或单个 markdown 文件。
 */
export interface SkillImportSource {
  kind: 'directory' | 'zip' | 'markdown';
  path: string;
}

/**
 * Options for skill import operations.
 * 技能导入操作的选项。
 */
export interface SkillImportOptions {
  workspacePath: string;
  /** 设置技能（store）名单；导入技能不得与之重名，否则运行期会被并入逻辑放弃。 */
  existingConfigSkillNames: ReadonlySet<string>;
}

interface CollectedSkillFiles {
  /** 相对源根的 POSIX 风格路径 → 内容，含 SKILL.md。 */
  files: Map<string, Buffer>;
}

function toUserMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recursively remove a directory, working around a Node 24 bug where
 * rmSync on a renameSync-created directory causes a hard crash.
 * Prefers manual lstat-based deletion; falls back to rmSync on failure.
 * 递归删除目录，规避 Node 24 中 renameSync 创建的目录用 rmSync 删除
 * 会触发原生层硬崩溃的问题。优先手工逐项删除，失败时回退 rmSync。
 *
 * @param target - Directory path to remove / 要删除的目录路径
 */
export function removeDirectoryRecursively(target: string): void {
  try {
    removeEntryRecursively(target);
    return;
  } catch {
    // 手工删除失败（权限/占用等）时回退。
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
}

function removeEntryRecursively(entry: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entry);
  } catch {
    return; // 已不存在视为删除成功。
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(entry);
    return;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(entry)) removeEntryRecursively(path.join(entry, name));
    fs.rmdirSync(entry);
    return;
  }
  fs.unlinkSync(entry);
}

function assertResourceSize(relative: string, size: number, totalBytes: number): void {
  if (size > MAX_IMPORT_RESOURCE_FILE_BYTES) throw new Error(`文件 ${relative} 超过单文件 10MiB 上限。`);
  if (totalBytes + size > MAX_IMPORT_TOTAL_BYTES) throw new Error(`技能包总大小超过 64MiB 上限。`);
}

/** 读取文件夹形态来源；隐藏项与 node_modules 等按加载器语义跳过，其余超限即失败。 */
function collectFromDirectory(sourceRoot: string): CollectedSkillFiles {
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  const walk = (directory: string, relativePrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法读取目录 ${relativePrefix || '技能根'}：${toUserMessage(error)}`);
    }
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.name.startsWith('.') || ignoredDirectoryNames.has(entry.name)) continue;
      const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`技能目录包含不支持的项 ${relative}（符号链接等），导入已取消。`);
      if (relative.split('/').length > MAX_IMPORT_DEPTH) throw new Error(`文件 ${relative} 嵌套超过 ${MAX_IMPORT_DEPTH} 层。`);
      if (files.size >= MAX_IMPORT_RESOURCE_FILES + 1) throw new Error(`技能包内文件数量超过 ${MAX_IMPORT_RESOURCE_FILES} 上限。`);
      const stat = fs.statSync(path.join(directory, entry.name));
      if (!stat.isFile()) throw new Error(`技能目录包含不支持的项 ${relative}，导入已取消。`);
      assertResourceSize(relative, stat.size, totalBytes);
      const data = fs.readFileSync(path.join(directory, entry.name));
      if (data.includes(0)) throw new Error(`技能目录内文件 ${relative} 疑似二进制文件，技能仅支持文本附件，导入已取消。`);
      totalBytes += data.length;
      files.set(relative, data);
    }
  };
  walk(sourceRoot, '');
  if (files.size === 0) throw new Error('所选文件夹为空。');
  return { files };
}

function assertSafeZipEntryPath(normalized: string): string[] {
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) throw new Error(`压缩包内出现绝对路径 ${normalized}，导入已取消。`);
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error('压缩包内出现非法路径，导入已取消。');
  if (segments.some((segment) => segment === '..')) throw new Error(`压缩包内出现 .. 路径穿越 ${normalized}，导入已取消。`);
  return segments;
}

/** 读取 zip 形态来源（jszip）；拒绝 symlink 与路径逃逸，隐藏/依赖目录按加载器语义跳过。 */
async function collectFromZip(zipPath: string): Promise<CollectedSkillFiles> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  } catch {
    throw new Error('无法读取 zip 文件，文件可能已损坏。');
  }
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  const entries = Object.values(zip.files);
  const fileCount = entries.filter((entry) => !entry.dir).length;
  if (fileCount === 0) throw new Error('压缩包为空。');
  if (fileCount > MAX_IMPORT_RESOURCE_FILES + 1) throw new Error(`压缩包内文件数量超过 ${MAX_IMPORT_RESOURCE_FILES} 上限。`);
  for (const entry of entries) {
    if (entry.dir) continue;
    // JSZip 3.8+ 会先移除 `..` 段并把原名放到 unsafeOriginalName；安全校验
    // 必须针对原名，否则 `../escape.md` 会伪装成根级 `escape.md`。
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    const segments = assertSafeZipEntryPath(originalName.replace(/\\/g, '/'));
    if (segments.some((segment) => segment.startsWith('.')) || segments.some((segment) => ignoredDirectoryNames.has(segment))) continue;
    if (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000) {
      throw new Error(`压缩包包含符号链接 ${segments.join('/')}，导入已取消。`);
    }
    const relative = segments.join('/');
    // 压缩前的大小（内部字段，可能缺失）：缺失时依赖读取后的实际长度兜底。
    const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof declaredSize === 'number') assertResourceSize(relative, declaredSize, totalBytes);
    const data: Buffer = await entry.async('nodebuffer');
    if (data.includes(0)) throw new Error(`压缩包内文件 ${relative} 疑似二进制文件，技能仅支持文本附件，导入已取消。`);
    assertResourceSize(relative, data.length, totalBytes);
    totalBytes += data.length;
    files.set(relative, data);
  }
  if (files.size === 0) throw new Error('压缩包内没有可导入的文件。');
  return { files };
}

/** 单个 SKILL.md 形态来源：统一归位为技能根的 SKILL.md。 */
function collectFromMarkdownFile(filePath: string): CollectedSkillFiles {
  if (!/\.(md|markdown)$/i.test(filePath)) throw new Error('请选择 .md 或 .markdown 文件。');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('所选路径不是文件。');
  if (stat.size > MAX_IMPORT_RESOURCE_FILE_BYTES) throw new Error('SKILL.md 超过单文件 10MiB 上限。');
  return { files: new Map([['SKILL.md', fs.readFileSync(filePath)]]) };
}

interface SkillMainFileLocation {
  path: string;
  /** SKILL.md 所在目录前缀（'' 表示源根）；附加文件按该前缀圈定。 */
  prefix: string;
}

/** 定位 SKILL.md：取嵌套最浅者，允许 zip 单层包裹目录（兼容 GitHub zipball）。 */
function locateSkillMainFile(files: Map<string, Buffer>): SkillMainFileLocation {
  let best: { path: string; prefix: string; depth: number } | undefined;
  let bestCount = 0;
  for (const relative of files.keys()) {
    const segments = relative.split('/');
    if (segments[segments.length - 1].toLowerCase() !== 'skill.md') continue;
    if (best && segments.length > best.depth) continue;
    if (best && segments.length === best.depth) {
      bestCount += 1;
      continue;
    }
    best = { path: relative, prefix: segments.slice(0, -1).join('/'), depth: segments.length };
    bestCount = 1;
  }
  if (!best) throw new Error('未找到 SKILL.md（技能目录或压缩包必须包含 SKILL.md）。');
  if (bestCount > 1) throw new Error('同一层级找到多个 SKILL.md，无法确定技能根目录。');
  return { path: best.path, prefix: best.prefix };
}

interface SelectedResourceFile {
  relative: string;
  data: Buffer;
}

/** 圈定技能根内的附加文本文件；越界/超限/非文本一律失败，保证与 read_skill 读取语义一致。 */
function selectResourceFiles(files: Map<string, Buffer>, mainFilePath: string, prefix: string): SelectedResourceFile[] {
  const resources: SelectedResourceFile[] = [];
  let totalBytes = 0;
  for (const [relative, data] of files) {
    if (relative === mainFilePath) continue;
    // 技能根 = SKILL.md 所在目录；包裹层之外的散落文件不导入。
    let innerRelative: string;
    if (prefix) {
      if (!relative.startsWith(`${prefix}/`)) continue;
      innerRelative = relative.slice(prefix.length + 1);
    } else {
      innerRelative = relative;
    }
    if (innerRelative.split('/').length > MAX_IMPORT_DEPTH) throw new Error(`附加文件 ${innerRelative} 嵌套超过 ${MAX_IMPORT_DEPTH} 层。`);
    if (!allowedResourceExtensions.has(path.extname(innerRelative).toLowerCase())) {
      throw new Error(`附加文件 ${innerRelative} 不是支持的文本类型（md/txt/csv/tsv/json/yaml），导入已取消。`);
    }
    totalBytes += data.length;
    resources.push({ relative: innerRelative, data });
  }
  if (resources.length > MAX_IMPORT_RESOURCE_FILES) throw new Error(`附加文件数量超过 ${MAX_IMPORT_RESOURCE_FILES} 上限。`);
  if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw new Error(`附加文件总大小超过 64MiB 上限。`);
  return resources;
}

function resolveDestinationRoot(workspacePath: string, name: string): { root: string; destination: string; conflict: string | undefined } {
  const root = getAiSkillWorkspacePath(workspacePath);
  const nameKey = name.toLowerCase();
  let conflict: string | undefined;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // AI-Skill 尚不存在时视为无冲突。
  }
  for (const entry of entries) {
    if (entry.name.toLowerCase() === nameKey) {
      conflict = entry.isDirectory()
        ? `AI-Skill 下已存在同名技能目录 ${entry.name}。`
        : `AI-Skill 下已存在同名文件 ${entry.name}，无法创建技能目录。`;
      break;
    }
  }
  return { root, destination: path.join(root, name), conflict };
}

/**
 * Main entry point for skill import: normalizes source → locates & validates
 * SKILL.md → checks conflicts → atomic temp-directory write.
 * On failure returns { ok:false, error } without throwing or leaving partial directories.
 * 导入总入口：归一化来源 → 定位并校验 SKILL.md → 冲突检查 → 临时目录原子落盘。
 * 失败只返回 { ok:false, error }，不抛出、不留下半成品目录。
 *
 * @param source - Import source descriptor / 导入来源描述符
 * @param options - Import options including workspace path and existing skill names / 导入选项
 * @returns Import result with skill name or error / 包含技能名称或错误的导入结果
 */
export async function importAiSkillSource(source: SkillImportSource, options: SkillImportOptions): Promise<SkillImportResult> {
  try {
    const collected = source.kind === 'zip'
      ? await collectFromZip(source.path)
      : source.kind === 'markdown'
        ? collectFromMarkdownFile(source.path)
        : collectFromDirectory(source.path);
    const installed = installCollectedSkillFiles(collected.files, options);
    return { ok: true, skillName: installed.name, resourceFileCount: installed.resourceFileCount };
  } catch (error) {
    return { ok: false, error: toUserMessage(error) };
  }
}

/** 校验 + 冲突检查 + 临时目录原子落盘；导入与表单创建共用。 */
function installCollectedSkillFiles(files: Map<string, Buffer>, options: SkillImportOptions): { name: string; resourceFileCount: number } {
  const main = locateSkillMainFile(files);
  const mainContent = files.get(main.path);
  if (mainContent === undefined) throw new Error('SKILL.md 内容读取失败。');
  const parsed = parseSkillMarkdown(mainContent.toString('utf8'));
  if (!parsed) throw new Error('SKILL.md 缺少 YAML frontmatter。');
  const invalidReason = validateDirectorySkillMetadata(parsed);
  if (invalidReason) throw new Error(`SKILL.md 校验失败：${invalidReason}。`);
  const name = parsed.name.trim();
  if (options.existingConfigSkillNames.has(name.toLowerCase())) {
    throw new Error(`技能名「${name}」与设置技能重名，请先重命名后再导入。`);
  }
  const resources = selectResourceFiles(files, main.path, main.prefix);
  const { root, destination, conflict } = resolveDestinationRoot(options.workspacePath, name);
  if (conflict) throw new Error(conflict);
  fs.mkdirSync(root, { recursive: true });
  const temporaryDirectory = path.join(root, `.import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let renamed = false;
  try {
    fs.mkdirSync(temporaryDirectory, { recursive: true });
    fs.writeFileSync(path.join(temporaryDirectory, 'SKILL.md'), mainContent);
    for (const resource of resources) {
      const target = path.join(temporaryDirectory, ...resource.relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, resource.data);
    }
    fs.renameSync(temporaryDirectory, destination);
    renamed = true;
  } finally {
    if (!renamed) removeDirectoryRecursively(temporaryDirectory);
  }
  return { name, resourceFileCount: resources.length };
}

/** 生成标准 SKILL.md：description 用 JSON 标量转义，与 parseSkillMarkdown 的去引号语义闭环。 */
function formatSkillMarkdown(name: string, description: string, instruction: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instruction.trim()}\n`;
}

/**
 * Create a new directory skill from the settings form (P2). Generates a standard
 * SKILL.md and uses the same validation & atomic-write pipeline as import.
 * 表单新建（P2）：把设置表单内容生成为标准技能目录，与导入走同一校验与落盘链路。
 *
 * @param input - Form fields: name, description, instruction / 表单字段：名称、描述、指令
 * @param options - Import options / 导入选项
 * @returns Import result with skill name or error / 包含技能名称或错误的导入结果
 */
export function createDirectorySkillFromForm(input: { name: string; description: string; instruction: string }, options: SkillImportOptions): SkillImportResult {
  try {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    if (!name || !description || !instruction) throw new Error('请完整填写技能名称、能力描述与工作约束。');
    const content = formatSkillMarkdown(name, description, instruction);
    const installed = installCollectedSkillFiles(new Map([['SKILL.md', Buffer.from(content, 'utf8')]]), options);
    return { ok: true, skillName: installed.name, resourceFileCount: installed.resourceFileCount };
  } catch (error) {
    return { ok: false, error: toUserMessage(error) };
  }
}

/**
 * In-place update of a skill document (P2): rewrites SKILL.md with atomic temp-file
 * replacement. The frontmatter name is preserved to match the directory name.
 * 就地更新技能文档（P2）：重写 SKILL.md（frontmatter name 保持目录名），原子替换。
 *
 * @param input - Skill directory path and updated fields / 技能目录路径与更新字段
 * @returns Success or error result / 成功或错误结果
 */
export function updateDirectorySkillDocument(input: { basePath: string; name: string; description: string; instruction: string }): { ok: boolean; error?: string } {
  try {
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    if (!description || !instruction) throw new Error('能力描述与工作约束不能为空。');
    const content = formatSkillMarkdown(input.name, description, instruction);
    const parsed = parseSkillMarkdown(content);
    if (!parsed) throw new Error('生成的 SKILL.md 无法解析，已取消保存。');
    const invalidReason = validateDirectorySkillMetadata(parsed);
    if (invalidReason) throw new Error(`校验失败：${invalidReason}。`);
    const mainFile = findSkillMainFileInDirectory(input.basePath);
    if (!mainFile) throw new Error('技能目录中未找到 SKILL.md。');
    const temporaryFile = path.join(input.basePath, `.SKILL.md.${process.pid}.${Date.now()}.tmp`);
    let renamed = false;
    try {
      fs.writeFileSync(temporaryFile, content, 'utf8');
      fs.renameSync(temporaryFile, mainFile);
      renamed = true;
    } finally {
      if (!renamed && fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toUserMessage(error) };
  }
}

/**
 * Export a skill directory as a zip archive (P2). Wraps contents in a `<name>/` folder
 * so re-importing restores the original structure including resource files.
 * 导出技能目录为 zip（P2）：包裹 <name>/ 一层，重新导入即可还原（含附加文档）。
 *
 * @param input - Skill directory path and name / 技能目录路径与名称
 * @param targetPath - Destination zip file path / 目标 zip 文件路径
 * @returns Success or error result / 成功或错误结果
 */
export async function exportDirectorySkillToZip(input: { basePath: string; name: string }, targetPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const mainFile = findSkillMainFileInDirectory(input.basePath);
    if (!mainFile) throw new Error('技能目录中未找到 SKILL.md。');
    const zip = new JSZip();
    const folder = zip.folder(input.name);
    if (!folder) throw new Error('无法创建压缩包目录。');
    folder.file('SKILL.md', fs.readFileSync(mainFile));
    for (const relative of listSkillResourceFiles(input.basePath)) {
      folder.file(relative, fs.readFileSync(path.join(input.basePath, ...relative.split('/'))));
    }
    const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const temporaryFile = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    let renamed = false;
    try {
      fs.writeFileSync(temporaryFile, data);
      fs.renameSync(temporaryFile, targetPath);
      renamed = true;
    } finally {
      if (!renamed && fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toUserMessage(error) };
  }
}

/** 在技能目录内大小写不敏感地定位 SKILL.md。 */
function findSkillMainFileInDirectory(basePath: string): string | undefined {
  try {
    const match = fs.readdirSync(basePath).find((name) => name.toLowerCase() === 'skill.md');
    return match ? path.join(basePath, match) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the settings-page directory skills overview: loadDirectorySkills results
 * (without disabled filtering — disabled entries are shown) merged with store
 * override state. Name-conflicting directory skills are listed separately.
 * 设置页目录技能总览：loadDirectorySkills 结果（不带停用过滤，禁用项也展示）
 * + store 登记状态投影；与设置技能重名的目录技能单独列出（运行期不会生效）。
 *
 * @param input.outcome - Directory skill load outcome / 目录技能加载结果
 * @param input.overrides - Store override state by skill name / 按技能名的 store 覆盖状态
 * @param input.configSkillNames - Config-managed skill names / 设置管理的技能名称列表
 * @returns Overview with directory skills, skipped entries, and name conflicts / 包含目录技能、跳过条目和名称冲突的总览
 */
export function buildAiSkillsOverview(input: {
  outcome: DirectorySkillLoadOutcome;
  overrides: Readonly<Record<string, DirectorySkillOverride>> | undefined;
  configSkillNames: readonly string[];
}): AiSkillsOverview {
  const overrides = input.overrides ?? {};
  const overrideFor = (name: string): DirectorySkillOverride | undefined => {
    const direct = overrides[name];
    if (direct) return direct;
    const nameKey = name.toLowerCase();
    return Object.entries(overrides).find(([entryName]) => entryName.toLowerCase() === nameKey)?.[1];
  };
  const configKeys = new Set(input.configSkillNames.map((name) => name.trim().toLowerCase()));
  const directorySkills: DirectorySkillOverviewEntry[] = [];
  const nameConflicts: DirectorySkillIssue[] = [];
  for (const entry of input.outcome.skills) {
    if (configKeys.has(entry.name.toLowerCase())) {
      nameConflicts.push({ directory: path.basename(entry.basePath), reason: `与设置技能「${entry.name}」重名，设置技能优先，运行期不会生效` });
      continue;
    }
    const override = overrideFor(entry.name);
    directorySkills.push({
      name: entry.name,
      description: entry.description,
      instruction: entry.instruction,
      resourceFileCount: listSkillResourceFiles(entry.basePath).length,
      enabled: override?.enabled ?? true,
      system: isBundledSkill(entry.basePath, entry.name),
      ...(override?.importedAt ? { importedAt: override.importedAt } : {}),
    });
  }
  return { directorySkills, skipped: input.outcome.skipped, nameConflicts };
}
