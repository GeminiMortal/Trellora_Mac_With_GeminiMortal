/**
 * Physical restore migration: remaps absolute paths, file URLs, workspace/principal bindings and source fingerprints in databases and metadata files.
 * 物理恢复迁移：在数据库和元数据文件中重映射绝对路径、文件 URL、工作区/主体绑定与源指纹。
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { assertTrustedMemoryScope } from '../knowledge/memory/memoryScope.ts';
import type { MemoryScope, TrustedMemoryScopeContext } from '../knowledge/memory/memoryTypes.ts';
import { createAssistantLibraryId } from '../knowledge/assistant/assistantLibraryIdentity.ts';
import { extractionSourceFingerprint, parseSourceClaims } from '../knowledge/memory/memoryExtractionSourceRepository.ts';

/**
 * Context for remapping source paths and identities during a physical restore.
 * 物理恢复期间重映射源路径与身份的上下文。
 */
export interface PhysicalRestoreContext {
  sourceScope: MemoryScope;
  target: TrustedMemoryScopeContext;
  roots: Array<{ source: string; target: string }>;
  libraries: Array<{ source: string; target: string }>;
  warnings: Set<string>;
}
// Double-quotes a SQLite identifier, escaping internal double quotes.
// 将 SQLite 标识符加双引号，内部双引号转义。
const identifier = (value: string) => `"${value.replace(/"/gu, '""')}"`;
// Tables scoped by workspace_id/principal_id whose rows must be rebound.
// 按 workspace_id/principal_id 范围限定、行需重绑定的表。
const scopedTables = ['memory_subjects', 'memory_items', 'memory_tombstones', 'memory_topic_stats', 'memory_doc_affinities', 'memory_doc_affinity_events', 'memory_item_embeddings', 'memory_extraction_jobs', 'memory_extraction_turn_receipts', 'memory_extraction_pending_sources', 'conversation_search_documents'];
// Column and key sets that carry absolute paths or file URLs requiring remapping.
// 携带绝对路径或文件 URL、需要重映射的列名与键名集合。
const pathColumns = new Set(['path', 'note_path', 'library_path', 'workspace_path', 'source_path', 'backup_path', 'output_path', 'file_path', 'absolute_path', 'attachment_path', 'artifact_path', 'document_path']);
const jsonColumns = new Set(['result_json', 'result_metadata_json', 'mapping_json', 'payload_json', 'run_json', 'input_json', 'source_refs_json', 'citations_json', 'digest_json', 'rolling_summary_json', 'metadata_json', 'context_json', 'messages_json', 'content_json', 'plan_json', 'summary_payload_json', 'artifact_ref_json', 'arguments_json', 'claimed_sessions_json', 'before_json', 'after_json']);
const pathKeys = new Set(['path', 'notePath', 'libraryPath', 'workspacePath', 'rootPath', 'absolutePath', 'inputPath', 'outputDir', 'artifactPath', 'manifestPath', 'documentPath', 'sourcePath', 'targetPath', 'sourceLibraryPath', 'sourceWorkspacePath', 'backupPath', 'filePath', 'imagePath', 'directoryPath', 'parentDirectoryPath', 'attachmentPath', 'sourceAbsolutePath', 'artifactDirectory']);
const pathArrays = new Set(['collapsedFolderPaths', 'pinnedEntryPaths', 'sourcePaths', 'notePaths', 'libraryPaths']);
const uriKeys = new Set(['fileUrl', 'imageUrl', 'url', 'href', 'uri']);

/**
 * Remaps a single absolute path from source to target using the closest-matching root.
 * 使用最匹配的根目录将单个绝对路径从源重映射到目标。
 *
 * @param value - Absolute path to remap / 要重映射的绝对路径
 * @param context - Restore context with root mappings / 含根目录映射的恢复上下文
 * @returns Remapped path / 重映射后的路径
 */
export function mapRestoredPath(value: string, context: PhysicalRestoreContext): string {
  if (!path.isAbsolute(value)) return value;
  for (const root of [...context.roots].sort((a, b) => b.source.length - a.source.length)) {
    const relative = path.relative(root.source, value);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return path.join(root.target, relative);
  }
  context.warnings.add(`未映射的外部路径：${value}`); return value;
}
/**
 * Only declared reference fields change; user/assistant text and arbitrary strings remain intact.
 * 仅已声明的引用字段会被更改；用户/助手文本与任意字符串保持不变。
 *
 * @param value - JSON value to migrate / 要迁移的 JSON 值
 * @param context - Restore context with root mappings / 含根目录映射的恢复上下文
 * @param parentKey - Key of the parent property (used for path/URL detection) / 父属性的键名（用于路径/URL 检测）
 * @param depth - Recursion depth (max 64) / 递归深度（最大 64）
 * @returns Migrated JSON value / 迁移后的 JSON 值
 */
export function mapRestoredJson(value: unknown, context: PhysicalRestoreContext, parentKey = '', depth = 0): unknown {
  if (depth > 64) throw new Error('恢复元数据嵌套过深，无法安全处理。');
  if (typeof value === 'string') {
    if (pathKeys.has(parentKey) || pathColumns.has(parentKey) || pathArrays.has(parentKey)) return mapRestoredPath(value, context);
    if (uriKeys.has(parentKey) && value.startsWith('file:')) { try { const source = fileURLToPath(value); const target = mapRestoredPath(source, context); return target === source ? value : pathToFileURL(target).href; } catch { context.warnings.add('存在无法迁移的文件链接，已保留原字符串。'); } }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => mapRestoredJson(item, context, parentKey, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const source = context.sourceScope; const scope = context.target.scope;
  const rebind = object.workspaceId === source.workspaceId && object.principalId === source.principalId;
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, rebind && key === 'workspaceId' ? scope.workspaceId : rebind && key === 'principalId' ? scope.principalId : mapRestoredJson(item, context, key, depth + 1)]));
}
function tables(database: Database.Database): Array<{ name: string; sql: string }> { return database.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>; }
function columns(database: Database.Database, table: string): string[] { return (database.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string }>).map(column => column.name); }
/**
 * Runs SQLite integrity and foreign-key checks, throwing on any failure.
 * 执行 SQLite 完整性和外键检查，失败时抛出。
 *
 * @param database - SQLite database handle to validate / 待校验的 SQLite 数据库句柄
 */
export function assertRestoredDatabase(database: Database.Database): void {
  const foreignKeys = database.pragma('foreign_key_check');
  if (database.pragma('integrity_check', { simple: true }) !== 'ok' || !Array.isArray(foreignKeys) || foreignKeys.length) throw new Error('恢复数据库完整性或关联校验失败，现有数据未改变。');
}
/**
 * The final trusted scope and the already-verified staging handle are separate arguments.
 * 最终可信范围与已校验的暂存句柄是独立的两个参数。
 *
 * @param database - SQLite database handle to migrate (in staging) / 要迁移的 SQLite 数据库句柄（暂存中）
 * @param context - Physical restore context with source/target mappings / 含源/目标映射的物理恢复上下文
 */
export function migratePhysicalDatabase(database: Database.Database, context: PhysicalRestoreContext): void {
  assertTrustedMemoryScope(context.target.scope); assertRestoredDatabase(database);
  database.pragma('foreign_keys = ON');
  database.transaction(() => {
    database.pragma('defer_foreign_keys = ON');
    const schema = tables(database); const names = new Set(schema.map(table => table.name));
    const source = context.sourceScope; const target = context.target.scope;
    // Rebind only snapshots that still match their source; edited claims stay stale.
    // 仅重绑定仍匹配源的快照；已编辑的声明保持旧值。
    const fingerprints = new Map<string, { old: string; next: string }>();
    if (names.has('qa_turns') && columns(database, 'qa_turns').includes('result_metadata_json')) {
      const turns = database.prepare(`SELECT turn_id, session_id, user_text, created_at, result_metadata_json FROM qa_turns
        WHERE json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ? AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?
          AND json_type(result_metadata_json, '$.memoryExtractionGeneration') = 'integer'`).all(source.workspaceId, source.principalId) as Array<{
            turn_id: string; session_id: string; user_text: string; created_at: string; result_metadata_json: string;
          }>;
      for (const turn of turns) {
        const generation = (JSON.parse(turn.result_metadata_json) as { memoryExtractionGeneration: number }).memoryExtractionGeneration;
        fingerprints.set(turn.turn_id, { old: extractionSourceFingerprint(source, generation, turn), next: extractionSourceFingerprint(target, generation, turn) });
      }
    }
    if (names.has('memory_subjects') && (source.workspaceId !== target.workspaceId || source.principalId !== target.principalId)) {
      const count = (scope: MemoryScope) => Number((database.prepare('SELECT COUNT(*) AS n FROM memory_subjects WHERE workspace_id=? AND principal_id=?').get(scope.workspaceId, scope.principalId) as { n: number }).n);
      const sourceCount = count(source), targetCount = count(target);
      if (sourceCount && targetCount) throw new Error('暂存数据已经包含冲突的目标记忆身份，恢复未自动合并。');
      if (sourceCount) {
        // Copy workspace settings for the new workspace_id before rebinding row-level scoping.
        // 在重绑定行级范围前为新 workspace_id 复制工作区设置。
        if (names.has('memory_workspace_settings') && source.workspaceId !== target.workspaceId) {
          const fields = columns(database, 'memory_workspace_settings');
          const exists = database.prepare('SELECT 1 FROM memory_workspace_settings WHERE workspace_id=?').get(target.workspaceId);
          if (!exists) database.prepare(`INSERT INTO memory_workspace_settings (${fields.map(identifier).join(',')}) SELECT ${fields.map(field => field === 'workspace_id' ? '?' : identifier(field)).join(',')} FROM memory_workspace_settings WHERE workspace_id=?`).run(target.workspaceId, source.workspaceId);
        }
        for (const table of scopedTables.filter(table => names.has(table))) {
          // Rebind proposal targets first so the immediate same-owner trigger also holds during restore.
          // 先重绑定提案目标，使恢复期间的同所有者触发器也能正常工作。
          const proposalTable = table === 'memory_items' && columns(database, table).includes('replaces_id');
          for (const filter of proposalTable ? [' AND replaces_id IS NULL', ' AND replaces_id IS NOT NULL'] : ['']) {
            database.prepare(`UPDATE ${identifier(table)} SET workspace_id=?,principal_id=? WHERE workspace_id=? AND principal_id=?${filter}`)
              .run(target.workspaceId, target.principalId, source.workspaceId, source.principalId);
          }
        }
      }
    }
    for (const table of schema.filter(table => !/CREATE VIRTUAL TABLE/iu.test(table.sql))) {
      const fields = columns(database, table.name); const scoped = fields.includes('workspace_id') && fields.includes('principal_id');
      const filter = scoped ? ' WHERE workspace_id=? AND principal_id=?' : ''; const params = scoped ? [target.workspaceId, target.principalId] : [];
      const mappedFields = fields.filter(field => pathColumns.has(field) || jsonColumns.has(field));
      if (mappedFields.length) {
        let lastRow = Number.MIN_SAFE_INTEGER;
        while (true) {
        const rows = database.prepare(`SELECT rowid AS restore_rowid,${mappedFields.map(identifier).join(',')} FROM ${identifier(table.name)}${filter}${filter ? ' AND' : ' WHERE'} rowid>? ORDER BY rowid LIMIT 100`).all(...params, lastRow) as Array<Record<string, unknown>>;
        if (!rows.length) break;
        for (const row of rows) for (const field of mappedFields) {
          const value = row[field]; if (typeof value !== 'string') continue;
          let mapped: string;
          if (pathColumns.has(field)) mapped = mapRestoredPath(value, context);
          else { try { if (value.length > 16 * 1024 ** 2) throw new Error(); mapped = JSON.stringify(mapRestoredJson(JSON.parse(value), context)); } catch { throw new Error(`恢复结构数据无效或过大：${table.name}.${field}`); } }
          if (mapped !== value) database.prepare(`UPDATE ${identifier(table.name)} SET ${identifier(field)}=? WHERE rowid=?`).run(mapped, row.restore_rowid);
        }
        lastRow = Number(rows[rows.length - 1].restore_rowid);
        }
      }
      if (fields.includes('library_id')) for (const library of context.libraries) {
        const sourceId = createAssistantLibraryId(library.source), targetId = createAssistantLibraryId(library.target);
        if (sourceId !== targetId) database.prepare(`UPDATE ${identifier(table.name)} SET library_id=? WHERE library_id=?`).run(targetId, sourceId);
      }
    }
    if (names.has('memory_migration_audit')) for (const library of context.libraries) {
      const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
      database.prepare('UPDATE memory_migration_audit SET source_store=? WHERE source_store=?').run(`assistant-memory:${hash(library.target)}`, `assistant-memory:${hash(library.source)}`);
    }
    for (const table of ['memory_extraction_turn_receipts', 'memory_extraction_pending_sources'].filter(table => names.has(table))) {
      for (const [turnId, fingerprint] of fingerprints) database.prepare(`UPDATE ${identifier(table)} SET source_fingerprint=?
        WHERE workspace_id=? AND principal_id=? AND turn_id=? AND source_fingerprint=?`).run(fingerprint.next, target.workspaceId, target.principalId, turnId, fingerprint.old);
    }
    if (names.has('memory_extraction_jobs') && columns(database, 'memory_extraction_jobs').includes('claimed_sources_json')) {
      const jobs = database.prepare('SELECT id, claimed_sources_json FROM memory_extraction_jobs WHERE workspace_id=? AND principal_id=?').all(target.workspaceId, target.principalId) as Array<{ id: string; claimed_sources_json: string }>;
      for (const job of jobs) {
        const claims = parseSourceClaims(job.claimed_sources_json).map(claim => {
          const fingerprint = fingerprints.get(claim.turnId);
          return fingerprint?.old === claim.fingerprint ? { ...claim, fingerprint: fingerprint.next } : claim;
        });
        database.prepare('UPDATE memory_extraction_jobs SET claimed_sources_json=? WHERE id=?').run(JSON.stringify(claims), job.id);
      }
    }
    assertRestoredDatabase(database);
  })();
  assertRestoredDatabase(database);
}

/**
 * Migrates a single metadata file (.json or .jsonl) by remapping paths and scope bindings.
 * 通过重映射路径与范围绑定来迁移单个元数据文件（.json 或 .jsonl）。
 *
 * @param file - Absolute path to the metadata file / 元数据文件的绝对路径
 * @param context - Physical restore context / 物理恢复上下文
 * @param signal - Abort signal for the migration / 迁移中止信号
 */
export async function migrateMetadataFile(file: string, context: PhysicalRestoreContext, signal: AbortSignal): Promise<void> {
  if (file.endsWith('.json')) {
    if ((await fs.promises.stat(file)).size > 16 * 1024 ** 2) throw new Error('单个恢复元数据文件超过 16 MiB 上限，请分库处理。');
    const original = await fs.promises.readFile(file, 'utf8'); const value = mapRestoredJson(JSON.parse(original), context); const mapped = JSON.stringify(value);
    signal.throwIfAborted(); if (JSON.stringify(JSON.parse(original)) !== mapped) await fs.promises.writeFile(file, `${mapped}\n`, 'utf8');
    return;
  }
  if (!file.endsWith('.jsonl')) return;
  let lineBytes = 0;
  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) { for (const byte of chunk) { if (byte === 10) lineBytes = 0; else if (++lineBytes > 8 * 1024 ** 2) { callback(new Error('恢复元数据行超过 8 MiB 上限。')); return; } } callback(null, chunk); } });
  const temporary = `${file}.restore-partial`; const input = fs.createReadStream(file); const lines = readline.createInterface({ input: input.pipe(bound), crlfDelay: Infinity }); const output = fs.createWriteStream(temporary, { flags: 'wx' });
  const abort = () => { input.destroy(new Error('恢复已取消。')); bound.destroy(new Error('恢复已取消。')); }; signal.addEventListener('abort', abort, { once: true });
  input.on('error', error => bound.destroy(error));
  let changed = false; let failure: Error | undefined; output.on('error', error => { failure = error; input.destroy(error); });
  try {
    for await (const line of lines) { signal.throwIfAborted(); if (line.length > 8 * 1024 ** 2) throw new Error('恢复元数据行超过 8 MiB 上限。'); if (failure) throw failure; if (!line.trim()) continue; const value = JSON.parse(line); const mapped = JSON.stringify(mapRestoredJson(value, context)); changed ||= mapped !== JSON.stringify(value); if (!output.write(`${mapped}\n`)) await once(output, 'drain'); }
    output.end(); if (!output.closed) await once(output, 'close'); if (failure) throw failure;
    if (!input.closed) { input.destroy(); await once(input, 'close'); }
    if (changed) await fs.promises.rename(temporary, file); else await fs.promises.unlink(temporary);
  } finally { signal.removeEventListener('abort', abort); lines.close(); input.destroy(); bound.destroy(); if (!output.closed) { output.destroy(); await once(output, 'close').catch(() => undefined); } await fs.promises.rm(temporary, { force: true }); }
}
