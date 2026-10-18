/**
 * SQLite database owner for the retired workspace-level conversation memory.
 * 已废弃的工作区级会话记忆的 SQLite 数据库持有者。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Expected schema version of conversation-memory.db.
 * conversation-memory.db 的预期结构版本。
 */
export const ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION = 1;

/**
 * Directory name under the workspace root that holds the memory database.
 * 工作区根目录下存放记忆数据库的目录名。
 */
export const ASSISTANT_WORKSPACE_MEMORY_DIRECTORY_NAME = 'ConversationMemory';

/**
 * File name of the SQLite database.
 * SQLite 数据库文件名。
 */
export const ASSISTANT_WORKSPACE_MEMORY_DATABASE_NAME = 'conversation-memory.db';

/**
 * Structured error for conversation-memory database failures.
 * 会话记忆数据库故障的结构化错误。
 */
export class AssistantWorkspaceMemoryDatabaseError extends Error {
  constructor(
    readonly code: 'ASSISTANT_WORKSPACE_MEMORY_DATABASE_CORRUPT' | 'ASSISTANT_WORKSPACE_MEMORY_DATABASE_UNAVAILABLE',
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
  }
}

/**
 * Read-only compatibility owner for the retired knowledge-base Q&A history.
 * Phase 6 never creates, migrates, repairs, or writes conversation-memory.db.
 * 已废弃知识库问答历史的只读兼容持有者。Phase 6 不会创建、迁移、修复或写入
 * conversation-memory.db。
 */
export class AssistantWorkspaceMemoryDatabase {
  private readonly connections = new Map<string, Database.Database>();

  /**
   * Get or open a read-only connection for the given workspace path.
   * 获取或为给定工作区路径打开一个只读连接。
   *
   * @param workspacePath - Absolute workspace path / 绝对工作区路径
   * @returns Database instance, or undefined when the file does not exist / 数据库实例，文件不存在时为 undefined
   */
  getDatabase(workspacePath: string): Database.Database | undefined {
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const existing = this.connections.get(normalizedWorkspacePath);
    if (existing) return existing;

    const databasePath = getAssistantWorkspaceMemoryDatabasePath(normalizedWorkspacePath);
    if (!fs.existsSync(databasePath)) return undefined;
    let database: Database.Database | undefined;
    try {
    // Open in read-only mode and run a quick integrity check before accepting.
    // 以只读模式打开，接受前运行快速完整性检查。
      database = new Database(databasePath, { readonly: true, fileMustExist: true });
      database.pragma('query_only = ON');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      const integrity = database.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') {
        throw new AssistantWorkspaceMemoryDatabaseError(
          'ASSISTANT_WORKSPACE_MEMORY_DATABASE_CORRUPT',
          '知识库问答历史数据库完整性校验失败。请先备份并恢复 ConversationMemory 中的数据库。',
        );
      }
      const version = Number(database.pragma('user_version', { simple: true }));
      if (version !== ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION) {
        throw new AssistantWorkspaceMemoryDatabaseError(
          'ASSISTANT_WORKSPACE_MEMORY_DATABASE_UNAVAILABLE',
          '旧知识库问答历史数据库版本不受只读兼容层支持。',
        );
      }
      assertV1Shape(database);
      this.connections.set(normalizedWorkspacePath, database);
      return database;
    } catch (error) {
      database?.close();
      if (error instanceof AssistantWorkspaceMemoryDatabaseError) throw error;
      throw new AssistantWorkspaceMemoryDatabaseError(
        'ASSISTANT_WORKSPACE_MEMORY_DATABASE_CORRUPT',
        '无法只读打开旧知识库问答历史数据库。为避免丢失历史记录，应用未自动重建该数据库。',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Close every cached connection and clear the pool.
   * 关闭所有缓存的连接并清空连接池。
   */
  closeAll(): void {
    for (const database of this.connections.values()) database.close();
    this.connections.clear();
  }
}

/**
 * Derive the absolute path to conversation-memory.db for a workspace.
 * 推导工作区对应的 conversation-memory.db 绝对路径。
 *
 * @param workspacePath - Absolute workspace path / 绝对工作区路径
 * @returns Absolute database file path / 数据库文件的绝对路径
 */
export function getAssistantWorkspaceMemoryDatabasePath(workspacePath: string): string {
  return path.join(
    path.resolve(workspacePath),
    ASSISTANT_WORKSPACE_MEMORY_DIRECTORY_NAME,
    ASSISTANT_WORKSPACE_MEMORY_DATABASE_NAME,
  );
}

/**
 * Create or migrate the conversation-memory schema to the current version.
 * 创建或将会话记忆结构迁移至当前版本。
 *
 * @param database - Writable database handle / 可写的数据库句柄
 */
export function migrateAssistantWorkspaceMemoryDatabase(database: Database.Database): void {
  // Check current schema version: reject unknown or future versions.
  // 检查当前结构版本：拒绝未知或未来版本。
  const version = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION) {
    throw new AssistantWorkspaceMemoryDatabaseError(
      'ASSISTANT_WORKSPACE_MEMORY_DATABASE_UNAVAILABLE',
      '知识库问答历史数据库版本不受当前应用支持。',
    );
  }
  if (version === ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION) {
    assertV1Shape(database);
    return;
  }

  // From version 0 → ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION: create the full v1 schema.
  // 从版本 0 迁移到当前版本：创建完整的 v1 结构。
  database.transaction(() => {
    database.exec(`
      CREATE TABLE conversation_memory_libraries (
        library_id TEXT PRIMARY KEY,
        library_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE assistant_workspace_sessions (
        session_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES conversation_memory_libraries(library_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
        last_turn_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_turn_seq >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE assistant_workspace_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES assistant_workspace_sessions(session_id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL CHECK (turn_seq > 0),
        user_text TEXT NOT NULL,
        assistant_text TEXT,
        scope_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'cancelled', 'error', 'interrupted')),
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (session_id, turn_seq)
      );
      CREATE TABLE conversation_memory_migrations (
        migration_key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );
      CREATE INDEX idx_assistant_workspace_sessions_order
        ON assistant_workspace_sessions(library_id, is_pinned DESC, updated_at DESC, session_id DESC);
      CREATE INDEX idx_assistant_workspace_turns_session_seq
        ON assistant_workspace_turns(session_id, turn_seq ASC);
    `);
    database.pragma(`user_version = ${ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION}`);
    assertV1Shape(database);
  })();
}

// Validate that all v1 tables exist and foreign keys are intact.
// 校验所有 v1 表均存在且外键完好。
function assertV1Shape(database: Database.Database): void {
  const requiredTables = [
    'conversation_memory_libraries',
    'assistant_workspace_sessions',
    'assistant_workspace_turns',
    'conversation_memory_migrations',
  ];
  for (const table of requiredTables) {
    const exists = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { present: number } | undefined;
    if (!exists) throw new Error(`conversation-memory v1 结构缺少表：${table}`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('conversation-memory v1 外键校验失败。');
}
