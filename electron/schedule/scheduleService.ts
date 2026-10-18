/**
 * Schedule service — CRUD, range queries, categories, course times.
 * 日程服务 — 增删改查、范围查询、分类、节次时间。
 */
import type Database from 'better-sqlite3';
import {
  ScheduleDatabase,
  generateScheduleId,
} from './scheduleDatabase.ts';
import { expandOccurrences } from './scheduleRecurrence.ts';
import type {
  ScheduleItem,
  ScheduleOccurrence,
  ScheduleRangeQuery,
  ScheduleCreateRequest,
  ScheduleUpdateRequest,
  ScheduleDeleteRequest,
  ScheduleOccurrenceOverrideRequest,
  TodoStatus,
  ScheduleCategory,
  CourseTimeSettings,
  ScheduleChangedEvent,
  RecurrenceRule,
  CourseMeta,
  ScheduleReminder,
  ScheduleItemKind,
  ScheduleItemStatus,
} from '../../shared/schedule.ts';

// ── Row mapping helpers ──────────────────────────────────────────────────────

interface ScheduleItemRow {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: number;
  status: string;
  todo_status: string | null;
  due_at: string | null;
  priority: string | null;
  completed_at: string | null;
  library_path: string | null;
  library_name: string | null;
  note_path: string | null;
  category: string | null;
  tags_json: string;
  color: string | null;
  recurrence_json: string | null;
  course_meta_json: string | null;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRowToItem(row: ScheduleItemRow, reminders: ScheduleReminder[]): ScheduleItem {
  return {
    id: row.id,
    kind: row.kind as ScheduleItemKind,
    title: row.title,
    description: row.description,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day === 1,
    status: row.status as ScheduleItemStatus,
    todoStatus: row.todo_status as TodoStatus | null,
    dueAt: row.due_at,
    priority: row.priority as ScheduleItem['priority'],
    completedAt: row.completed_at,
    libraryPath: row.library_path,
    libraryName: row.library_name,
    notePath: row.note_path,
    category: row.category,
    tags: JSON.parse(row.tags_json) as string[],
    color: row.color,
    recurrence: row.recurrence_json ? JSON.parse(row.recurrence_json) as RecurrenceRule : null,
    course: row.course_meta_json ? JSON.parse(row.course_meta_json) as CourseMeta : null,
    reminders,
    importBatchId: row.import_batch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

export interface ScheduleServiceOptions {
  workspacePath: () => string;
  onChanged: (event: ScheduleChangedEvent) => void;
  onRemindersInvalidated: () => void;
}

export class ScheduleService {
  private readonly db = new ScheduleDatabase();
  private readonly options: ScheduleServiceOptions;

  constructor(options: ScheduleServiceOptions) {
    this.options = options;
  }

  private get database(): Database.Database {
    return this.db.getDatabase(this.options.workspacePath());
  }

  private getReminders(itemId: string): ScheduleReminder[] {
    const rows = this.database.prepare(
      'SELECT id, item_id, offset_minutes, delivery, enabled FROM schedule_reminders WHERE item_id = ?',
    ).all(itemId) as Array<{ id: string; item_id: string; offset_minutes: number; delivery: string; enabled: number }>;
    return rows.map(r => ({
      id: r.id,
      itemId: r.item_id,
      offsetMinutes: r.offset_minutes,
      delivery: r.delivery as ScheduleReminder['delivery'],
      enabled: r.enabled === 1,
    }));
  }

  private getItemById(id: string): ScheduleItem | null {
    const row = this.database.prepare('SELECT * FROM schedule_items WHERE id = ?').get(id) as ScheduleItemRow | undefined;
    if (!row) return null;
    return mapRowToItem(row, this.getReminders(id));
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  createItem(req: ScheduleCreateRequest): ScheduleItem {
    const id = generateScheduleId();
    const now = new Date().toISOString().replace('Z', '').split('.')[0];

    this.database.prepare(`
      INSERT INTO schedule_items (
        id, kind, title, description, location, start_at, end_at, all_day,
        status, todo_status, due_at, priority, completed_at,
        library_path, library_name, note_path,
        category, tags_json, color, recurrence_json, course_meta_json,
        import_batch_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      req.kind,
      req.title,
      req.description ?? null,
      req.location ?? null,
      req.startAt ?? null,
      req.endAt ?? null,
      req.allDay ? 1 : 0,
      req.status ?? 'confirmed',
      req.todoStatus ?? null,
      req.dueAt ?? null,
      req.priority ?? null,
      null, // completedAt
      req.libraryPath ?? null,
      req.libraryName ?? null,
      req.notePath ?? null,
      req.category ?? null,
      JSON.stringify(req.tags ?? []),
      req.color ?? null,
      req.recurrence ? JSON.stringify(req.recurrence) : null,
      req.course ? JSON.stringify(req.course) : null,
      null, // importBatchId
      now,
      now,
    );

    // Insert reminders
    if (req.reminders && req.reminders.length > 0) {
      const insertReminder = this.database.prepare(
        'INSERT INTO schedule_reminders (id, item_id, offset_minutes, delivery, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const r of req.reminders) {
        insertReminder.run(
          generateScheduleId(),
          id,
          r.offsetMinutes,
          r.delivery ?? 'both',
          r.enabled !== false ? 1 : 0,
          now,
          now,
        );
      }
    }

    this.options.onChanged({ reason: 'item', ids: [id] });
    this.options.onRemindersInvalidated();

    return this.getItemById(id)!;
  }

  updateItem(req: ScheduleUpdateRequest): ScheduleItem {
    const existing = this.getItemById(req.id);
    if (!existing) throw new Error('日程项不存在。');

    const patch = req.patch;
    const now = new Date().toISOString().replace('Z', '').split('.')[0];

    // Build dynamic SET clause
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.kind !== undefined) { sets.push('kind = ?'); values.push(patch.kind); }
    if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
    if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
    if (patch.location !== undefined) { sets.push('location = ?'); values.push(patch.location); }
    if (patch.startAt !== undefined) { sets.push('start_at = ?'); values.push(patch.startAt); }
    if (patch.endAt !== undefined) { sets.push('end_at = ?'); values.push(patch.endAt); }
    if (patch.allDay !== undefined) { sets.push('all_day = ?'); values.push(patch.allDay ? 1 : 0); }
    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
    if (patch.todoStatus !== undefined) { sets.push('todo_status = ?'); values.push(patch.todoStatus); }
    if (patch.dueAt !== undefined) { sets.push('due_at = ?'); values.push(patch.dueAt); }
    if (patch.priority !== undefined) { sets.push('priority = ?'); values.push(patch.priority); }
    if (patch.libraryPath !== undefined) { sets.push('library_path = ?'); values.push(patch.libraryPath); }
    if (patch.libraryName !== undefined) { sets.push('library_name = ?'); values.push(patch.libraryName); }
    if (patch.notePath !== undefined) { sets.push('note_path = ?'); values.push(patch.notePath); }
    if (patch.category !== undefined) { sets.push('category = ?'); values.push(patch.category); }
    if (patch.tags !== undefined) { sets.push('tags_json = ?'); values.push(JSON.stringify(patch.tags)); }
    if (patch.color !== undefined) { sets.push('color = ?'); values.push(patch.color); }
    if (patch.recurrence !== undefined) { sets.push('recurrence_json = ?'); values.push(patch.recurrence ? JSON.stringify(patch.recurrence) : null); }
    if (patch.course !== undefined) { sets.push('course_meta_json = ?'); values.push(patch.course ? JSON.stringify(patch.course) : null); }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(now);
      values.push(req.id);
      this.database.prepare(`UPDATE schedule_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    // Replace reminders if provided
    if (patch.reminders !== undefined) {
      this.database.prepare('DELETE FROM schedule_reminders WHERE item_id = ?').run(req.id);
      const insertReminder = this.database.prepare(
        'INSERT INTO schedule_reminders (id, item_id, offset_minutes, delivery, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const r of patch.reminders) {
        insertReminder.run(
          generateScheduleId(),
          req.id,
          r.offsetMinutes,
          r.delivery ?? 'both',
          r.enabled !== false ? 1 : 0,
          now,
          now,
        );
      }
    }

    this.options.onChanged({ reason: 'item', ids: [req.id] });
    this.options.onRemindersInvalidated();

    return this.getItemById(req.id)!;
  }

  deleteItem(req: ScheduleDeleteRequest): void {
    if (req.scope === 'occurrence' && req.occurrenceStart) {
      // Add an occurrence override that cancels this instance
      const now = new Date().toISOString().replace('Z', '').split('.')[0];
      this.database.prepare(`
        INSERT OR REPLACE INTO schedule_occurrence_overrides
        (item_id, occurrence_start, cancelled, updated_at)
        VALUES (?, ?, 1, ?)
      `).run(req.id, req.occurrenceStart, now);
    } else {
      this.database.prepare('DELETE FROM schedule_items WHERE id = ?').run(req.id);
    }

    this.options.onChanged({ reason: 'item', ids: [req.id] });
    this.options.onRemindersInvalidated();
  }

  setTodoStatus(id: string, status: TodoStatus): ScheduleItem {
    const now = new Date().toISOString().replace('Z', '').split('.')[0];
    const completedAt = status === 'done' ? now : null;
    this.database.prepare(
      'UPDATE schedule_items SET todo_status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
    ).run(status, completedAt, now, id);

    this.options.onChanged({ reason: 'item', ids: [id] });
    return this.getItemById(id)!;
  }

  // ── Range query with occurrence expansion ─────────────────────────────────

  listOccurrences(query: ScheduleRangeQuery): ScheduleOccurrence[] {
    // Fetch all items that could overlap the range
    let sql = 'SELECT * FROM schedule_items WHERE 1=1';
    const params: unknown[] = [];

    if (query.kinds && query.kinds.length > 0) {
      sql += ` AND kind IN (${query.kinds.map(() => '?').join(', ')})`;
      params.push(...query.kinds);
    }
    if (query.libraryPath !== undefined) {
      sql += query.libraryPath === null
        ? ' AND library_path IS NULL'
        : ' AND library_path = ?';
      if (query.libraryPath !== null) params.push(query.libraryPath);
    }
    if (query.categories && query.categories.length > 0) {
      sql += ` AND category IN (${query.categories.map(() => '?').join(', ')})`;
      params.push(...query.categories);
    }
    if (query.search) {
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      const like = `%${query.search}%`;
      params.push(like, like);
    }
    if (!query.includeCompletedTodos) {
      sql += " AND NOT (kind = 'todo' AND todo_status = 'done')";
    }

    // For non-recurring items, filter by date overlap
    sql += ` AND (
      (start_at IS NOT NULL AND start_at < ? AND (end_at IS NULL OR end_at >= ?))
      OR (due_at IS NOT NULL AND due_at >= ? AND due_at < ?)
      OR recurrence_json IS NOT NULL
      OR kind = 'course'
    )`;
    params.push(query.to, query.from, query.from, query.to);

    const rows = this.database.prepare(sql).all(...params) as ScheduleItemRow[];

    // Fetch overrides for recurring items
    const overrideRows = this.database.prepare('SELECT * FROM schedule_occurrence_overrides').all() as Array<{
      item_id: string; occurrence_start: string; title: string | null; description: string | null;
      location: string | null; start_at: string | null; end_at: string | null; cancelled: number;
    }>;
    const overridesMap = new Map<string, typeof overrideRows>();
    for (const o of overrideRows) {
      const key = `${o.item_id}|${o.occurrence_start}`;
      if (!overridesMap.has(key)) overridesMap.set(key, []);
      overridesMap.get(key)!.push(o);
    }

    const results: ScheduleOccurrence[] = [];

    for (const row of rows) {
      const reminders = this.getReminders(row.id);
      const item = mapRowToItem(row, reminders);

      const courseTimes = item.kind === 'course' ? this.getCourseTimes() : undefined;
      const occurrences = expandOccurrences(item, query.from, query.to, courseTimes);

      for (const occ of occurrences) {
        const overrideKey = `${item.id}|${occ.originalStart}`;
        const overrides = overridesMap.get(overrideKey);
        const cancelledOverride = overrides?.find(o => o.cancelled === 1);
        if (cancelledOverride) continue;

        const appliedOverride = overrides?.find(o => o.cancelled === 0);
        const isOverride = Boolean(appliedOverride);

        const occurrence: ScheduleOccurrence = {
          occurrenceKey: overrideKey,
          originalStart: occ.originalStart,
          item: appliedOverride
            ? {
                ...item,
                title: appliedOverride.title ?? item.title,
                description: appliedOverride.description ?? item.description,
                location: appliedOverride.location ?? item.location,
              }
            : item,
          startAt: appliedOverride?.start_at ?? occ.startAt,
          endAt: appliedOverride?.end_at ?? occ.endAt,
          isOverride,
        };

        // Filter by tags if specified
        if (query.tags && query.tags.length > 0) {
          const hasTag = query.tags.some(t => item.tags.includes(t));
          if (!hasTag) continue;
        }

        results.push(occurrence);
      }
    }

    // Sort by startAt
    results.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return results;
  }

  // ── Occurrence overrides ──────────────────────────────────────────────────

  applyOccurrenceOverride(req: ScheduleOccurrenceOverrideRequest): void {
    const now = new Date().toISOString().replace('Z', '').split('.')[0];
    this.database.prepare(`
      INSERT OR REPLACE INTO schedule_occurrence_overrides
      (item_id, occurrence_start, title, description, location, start_at, end_at, cancelled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      req.itemId,
      req.occurrenceStart,
      req.patch.title ?? null,
      req.patch.description ?? null,
      req.patch.location ?? null,
      req.patch.startAt ?? null,
      req.patch.endAt ?? null,
      now,
    );

    this.options.onChanged({ reason: 'item', ids: [req.itemId] });
    this.options.onRemindersInvalidated();
  }

  // ── Categories ────────────────────────────────────────────────────────────

  listCategories(): ScheduleCategory[] {
    const rows = this.database.prepare(
      'SELECT name, color, sort_order FROM schedule_categories ORDER BY sort_order',
    ).all() as Array<{ name: string; color: string; sort_order: number }>;
    return rows.map(r => ({ name: r.name, color: r.color, sortOrder: r.sort_order }));
  }

  upsertCategory(name: string, color: string): ScheduleCategory {
    const now = new Date().toISOString().replace('Z', '').split('.')[0];
    this.database.prepare(`
      INSERT INTO schedule_categories (name, color, sort_order, created_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(name) DO UPDATE SET color = excluded.color
    `).run(name, color, now);
    this.options.onChanged({ reason: 'category' });
    return { name, color, sortOrder: 0 };
  }

  deleteCategory(name: string): void {
    this.database.prepare('DELETE FROM schedule_categories WHERE name = ?').run(name);
    this.options.onChanged({ reason: 'category' });
  }

  // ── Course times ──────────────────────────────────────────────────────────

  getCourseTimes(): CourseTimeSettings {
    const row = this.database.prepare(
      "SELECT value FROM schedule_settings WHERE key = 'course_times'",
    ).get() as { value: string } | undefined;
    if (!row) return getDefaultCourseTimes();
    try { return JSON.parse(row.value) as CourseTimeSettings; } catch { return getDefaultCourseTimes(); }
  }

  setCourseTimes(settings: CourseTimeSettings): void {
    const now = new Date().toISOString().replace('Z', '').split('.')[0];
    this.database.prepare(`
      INSERT INTO schedule_settings (key, value, updated_at)
      VALUES ('course_times', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(settings), now);
    this.options.onChanged({ reason: 'settings' });
  }

  // ── Import batches ────────────────────────────────────────────────────────

  listImportBatches(): Array<{ id: string; sourceType: string; sourceLabel: string; itemCount: number; status: string; createdAt: string }> {
    const rows = this.database.prepare(
      'SELECT id, source_type, source_label, item_count, status, created_at FROM schedule_import_batches ORDER BY created_at DESC',
    ).all() as Array<{ id: string; source_type: string; source_label: string; item_count: number; status: string; created_at: string }>;
    return rows.map(r => ({
      id: r.id,
      sourceType: r.source_type,
      sourceLabel: r.source_label,
      itemCount: r.item_count,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  revertImport(batchId: string): void {
    this.database.prepare("UPDATE schedule_import_batches SET status = 'reverted' WHERE id = ?").run(batchId);
    this.database.prepare('DELETE FROM schedule_items WHERE import_batch_id = ?').run(batchId);
    this.options.onChanged({ reason: 'import' });
    this.options.onRemindersInvalidated();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    this.db.closeAll();
  }
}

// ── Default course times ─────────────────────────────────────────────────────

function getDefaultCourseTimes(): CourseTimeSettings {
  return [
    { period: 1, startTime: '08:00', endTime: '08:45' },
    { period: 2, startTime: '08:55', endTime: '09:40' },
    { period: 3, startTime: '10:00', endTime: '10:45' },
    { period: 4, startTime: '10:55', endTime: '11:40' },
    { period: 5, startTime: '14:00', endTime: '14:45' },
    { period: 6, startTime: '14:55', endTime: '15:40' },
    { period: 7, startTime: '16:00', endTime: '16:45' },
    { period: 8, startTime: '16:55', endTime: '17:40' },
    { period: 9, startTime: '19:00', endTime: '19:45' },
    { period: 10, startTime: '19:55', endTime: '20:40' },
    { period: 11, startTime: '20:50', endTime: '21:35' },
    { period: 12, startTime: '21:45', endTime: '22:30' },
  ];
}