/**
 * SQLite database owner for the schedule/calendar feature.
 * 日程功能的 SQLite 数据库持有者。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEDULE_SCHEMA_VERSION = 1;
export const SCHEDULE_DIRECTORY_NAME = 'schedule';
export const SCHEDULE_DATABASE_NAME = 'schedule.db';

export class ScheduleDatabaseError extends Error {
  constructor(
    readonly code: 'SCHEDULE_DATABASE_CORRUPT' | 'SCHEDULE_DATABASE_UNAVAILABLE',
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
  }
}

export class ScheduleDatabase {
  private readonly connections = new Map<string, Database.Database>();

  /**
   * Get or open a connection for the given workspace path.
   * 获取或为给定工作区路径打开一个连接。
   */
  getDatabase(workspacePath: string): Database.Database {
    const normalizedPath = path.resolve(workspacePath);
    const existing = this.connections.get(normalizedPath);
    if (existing) return existing;

    const metaDir = path.join(normalizedPath, '.menghan-meta');
    const scheduleDir = path.join(metaDir, SCHEDULE_DIRECTORY_NAME);
    fs.mkdirSync(scheduleDir, { recursive: true });

    const databasePath = path.join(scheduleDir, SCHEDULE_DATABASE_NAME);
    let database: Database.Database | undefined;
    try {
      database = new Database(databasePath);
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      database.pragma('synchronous = NORMAL');

      const integrity = database.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') {
        throw new ScheduleDatabaseError(
          'SCHEDULE_DATABASE_CORRUPT',
          '日程数据库完整性校验失败。请备份并恢复 schedule.db。',
        );
      }

      migrateScheduleDatabase(database);
      this.connections.set(normalizedPath, database);
      return database;
    } catch (error) {
      if (database) {
        try { database.close(); } catch { /* ignore */ }
      }
      if (error instanceof ScheduleDatabaseError) throw error;
      throw new ScheduleDatabaseError(
        'SCHEDULE_DATABASE_UNAVAILABLE',
        `无法打开日程数据库: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  closeAll(): void {
    for (const db of this.connections.values()) {
      try { db.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}

/**
 * Run incremental schema migrations.
 * 运行增量结构迁移。
 */
function migrateScheduleDatabase(database: Database.Database): void {
  const version = Number(database.pragma('user_version', { simple: true }));

  if (!Number.isInteger(version) || version < 0 || version > SCHEDULE_SCHEMA_VERSION) {
    throw new ScheduleDatabaseError(
      'SCHEDULE_DATABASE_UNAVAILABLE',
      `日程数据库版本 ${version} 不受支持。`,
    );
  }

  if (version === SCHEDULE_SCHEMA_VERSION) return;

  if (version === 0) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schedule_terms (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          start_date    TEXT NOT NULL,
          end_date      TEXT NOT NULL,
          week_count    INTEGER NOT NULL CHECK (week_count > 0),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedule_items (
          id              TEXT PRIMARY KEY,
          kind            TEXT NOT NULL CHECK (kind IN ('event', 'todo', 'course')),
          title           TEXT NOT NULL,
          description     TEXT,
          location        TEXT,
          start_at        TEXT,
          end_at          TEXT,
          all_day         INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
          status          TEXT NOT NULL DEFAULT 'confirmed'
                          CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
          todo_status     TEXT CHECK (todo_status IS NULL OR todo_status IN ('pending', 'in_progress', 'done', 'cancelled')),
          due_at          TEXT,
          priority        TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent')),
          completed_at    TEXT,
          library_path    TEXT,
          library_name    TEXT,
          note_path       TEXT,
          category        TEXT,
          tags_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
          color           TEXT,
          recurrence_json TEXT CHECK (recurrence_json IS NULL OR json_valid(recurrence_json)),
          course_meta_json TEXT CHECK (course_meta_json IS NULL OR json_valid(course_meta_json)),
          import_batch_id TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS schedule_items_start ON schedule_items(start_at)
          WHERE start_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS schedule_items_due ON schedule_items(due_at)
          WHERE due_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS schedule_items_library ON schedule_items(library_path);
        CREATE INDEX IF NOT EXISTS schedule_items_batch ON schedule_items(import_batch_id);

        CREATE TABLE IF NOT EXISTS schedule_occurrence_overrides (
          item_id          TEXT NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
          occurrence_start TEXT NOT NULL,
          title            TEXT,
          description      TEXT,
          location         TEXT,
          start_at         TEXT,
          end_at           TEXT,
          cancelled        INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
          updated_at       TEXT NOT NULL,
          PRIMARY KEY (item_id, occurrence_start)
        );

        CREATE TABLE IF NOT EXISTS schedule_reminders (
          id             TEXT PRIMARY KEY,
          item_id        TEXT NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
          offset_minutes INTEGER NOT NULL,
          delivery       TEXT NOT NULL DEFAULT 'both' CHECK (delivery IN ('system', 'in_app', 'both')),
          enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS schedule_reminders_item ON schedule_reminders(item_id);

        CREATE TABLE IF NOT EXISTS schedule_fired_reminders (
          reminder_id    TEXT NOT NULL,
          occurrence_key TEXT NOT NULL,
          fired_at       TEXT NOT NULL,
          delivery       TEXT NOT NULL,
          PRIMARY KEY (reminder_id, occurrence_key)
        );

        CREATE TABLE IF NOT EXISTS schedule_import_batches (
          id           TEXT PRIMARY KEY,
          source_type  TEXT NOT NULL CHECK (source_type IN ('csv', 'excel', 'image', 'url', 'manual')),
          source_label TEXT NOT NULL,
          summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
          item_count   INTEGER NOT NULL DEFAULT 0,
          status       TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed', 'reverted')),
          created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedule_categories (
          name       TEXT PRIMARY KEY,
          color      TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedule_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL CHECK (json_valid(value)),
          updated_at TEXT NOT NULL
        );
      `);
    })();
  }

  database.pragma(`user_version = ${SCHEDULE_SCHEMA_VERSION}`);
}

/**
 * Generate a unique ID for schedule entities.
 * 生成日程实体的唯一 ID。
 */
export function generateScheduleId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}