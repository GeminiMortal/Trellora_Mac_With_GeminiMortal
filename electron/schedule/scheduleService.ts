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
  ScheduleExternalUpsertItem,
  ScheduleExternalUpsertResult,
  ScheduleExternalRemoveResult,
  ScheduleExternalMapping,
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
import {
  SCHEDULE_EXTERNAL_MAX_BATCH,
  SCHEDULE_EXTERNAL_TITLE_MAX,
  SCHEDULE_EXTERNAL_DESCRIPTION_MAX,
  SCHEDULE_EXTERNAL_DEFAULT_CATEGORY,
  SCHEDULE_EXTERNAL_DEFAULT_CATEGORY_COLOR,
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
      req.completedAt ?? null, // completedAt（外部数据源可回填 done_at）
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
    if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(patch.completedAt); }
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
      // 用户删除条目时同步清掉外部映射：映射表已删、远端再次变化时按契约 §8 重建（属预期）。
      // Drop external mappings with the item: once the mapping is gone, a later
      // remote change recreates the entry (contract §8, expected behavior).
      this.database.prepare('DELETE FROM schedule_external_items WHERE item_id = ?').run(req.id);
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

  // ── External (plugin-sourced) items — 契约 §4.1 ───────────────────────────
  // 插件日程扩展点：按 (source, externalId) 映射做幂等 upsert。插件只经此 API
  // 写日程，不直接接触 SQLite；无映射的用户条目绝不触碰。

  /**
   * 幂等 upsert 外部条目：命中 (source, externalId) 映射则按 patch 语义更新，
   * 否则新建条目并登记映射。每次写入经 createItem/updateItem 自动触发 schedule:changed。
   * 语义约束（契约 §4.1）：单次上限 500 条、title≤200 / description≤4000 截断、
   * 本地完成态优先（本地 done/cancelled 而远端未完成时跳过状态字段，其余照常更新）。
   */
  upsertExternalItems(source: string, items: ScheduleExternalUpsertItem[]): ScheduleExternalUpsertResult {
    const sourceKey = normalizeExternalSource(source);
    if (!Array.isArray(items)) throw new Error('外部日程 upsert 的 items 必须是数组。');
    if (items.length > SCHEDULE_EXTERNAL_MAX_BATCH) {
      throw new Error(`单次 upsert 上限为 ${SCHEDULE_EXTERNAL_MAX_BATCH} 条（收到 ${items.length} 条）。`);
    }

    const upsertedIds: string[] = [];
    let skipped = 0;

    for (const item of items) {
      const rawExternalId = item && typeof item === 'object' ? (item as { externalId?: unknown }).externalId : undefined;
      const externalId = typeof rawExternalId === 'string' ? rawExternalId.trim() : '';
      const request = externalId ? buildExternalCreateRequest(item) : null;
      // 字段级容错：缺 externalId/title/kind 非法的条目跳过并计数，不中断整批（契约 §7）。
      if (!request) { skipped += 1; continue; }
      const patch: ScheduleCreateRequest = { ...request };
      const mapping = this.getExternalMapping(sourceKey, externalId);
      this.ensureExternalCategory(request.category ?? SCHEDULE_EXTERNAL_DEFAULT_CATEGORY);

      if (mapping) {
        const existing = this.getItemById(mapping.item_id);
        if (existing) {
          const localCompleted = existing.todoStatus === 'done' || existing.todoStatus === 'cancelled';
          const remoteCompleted = request.todoStatus === 'done' || request.todoStatus === 'cancelled' || request.status === 'cancelled';
          if (localCompleted && !remoteCompleted) {
            // 本地完成态优先：跳过状态字段（todoStatus/status/completedAt），其余照常更新。
            // Local completion wins: drop the status fields, update everything else.
            patch.status = undefined;
            patch.todoStatus = undefined;
            patch.completedAt = undefined;
            skipped += 1;
          }
          this.updateItem({ id: mapping.item_id, patch });
          this.touchExternalMapping(sourceKey, externalId, mapping.item_id);
          upsertedIds.push(mapping.item_id);
          continue;
        }
        // 映射在但条目已被用户删除：映射表已删/条目缺失时重建（契约 §8 属预期）。
      }

      const created = this.createItem(patch);
      this.database.prepare(`
        INSERT INTO schedule_external_items (source, external_id, item_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source, external_id) DO UPDATE SET item_id = excluded.item_id, updated_at = excluded.updated_at
      `).run(sourceKey, externalId, created.id, nowTimestamp());
      upsertedIds.push(created.id);
    }

    return { upsertedIds, skipped };
  }

  /**
   * 删除本 source 下指定 externalId 的条目及其映射。只删映射表内的条目，
   * 无映射的用户条目绝不触碰（契约 §4.1）。
   */
  removeExternalItems(source: string, externalIds: string[]): ScheduleExternalRemoveResult {
    const sourceKey = normalizeExternalSource(source);
    if (!Array.isArray(externalIds)) throw new Error('外部日程 remove 的 externalIds 必须是数组。');
    if (externalIds.length > SCHEDULE_EXTERNAL_MAX_BATCH) {
      throw new Error(`单次 remove 上限为 ${SCHEDULE_EXTERNAL_MAX_BATCH} 条（收到 ${externalIds.length} 条）。`);
    }

    const removedIds: string[] = [];
    for (const raw of externalIds) {
      const externalId = typeof raw === 'string' ? raw.trim() : '';
      if (!externalId) continue;
      const mapping = this.getExternalMapping(sourceKey, externalId);
      if (!mapping) continue;
      this.database.prepare('DELETE FROM schedule_external_items WHERE source = ? AND external_id = ?').run(sourceKey, externalId);
      const existing = this.getItemById(mapping.item_id);
      if (existing) {
        this.deleteItem({ id: mapping.item_id, scope: 'series' });
        removedIds.push(mapping.item_id);
      }
    }
    return { removedIds };
  }

  /** 列出本 source 的外部映射（供插件做增量/裁剪决策）。 */
  listExternalSource(source: string): ScheduleExternalMapping[] {
    const sourceKey = normalizeExternalSource(source);
    const rows = this.database.prepare(
      'SELECT external_id, item_id, updated_at FROM schedule_external_items WHERE source = ? ORDER BY external_id',
    ).all(sourceKey) as Array<{ external_id: string; item_id: string; updated_at: string }>;
    return rows.map(r => ({ externalId: r.external_id, itemId: r.item_id, updatedAt: r.updated_at }));
  }

  private getExternalMapping(source: string, externalId: string): { item_id: string } | undefined {
    return this.database.prepare(
      'SELECT item_id FROM schedule_external_items WHERE source = ? AND external_id = ?',
    ).get(source, externalId) as { item_id: string } | undefined;
  }

  private touchExternalMapping(source: string, externalId: string, itemId: string): void {
    this.database.prepare(
      'UPDATE schedule_external_items SET item_id = ?, updated_at = ? WHERE source = ? AND external_id = ?',
    ).run(itemId, nowTimestamp(), source, externalId);
  }

  /**
   * 分类只在缺失时按默认色新建（契约 §5.1：首次同步 upsert 分类「群务台」#0F766E）；
   * 已存在的用户分类颜色绝不覆盖。
   */
  private ensureExternalCategory(name: string): void {
    const result = this.database.prepare(`
      INSERT INTO schedule_categories (name, color, sort_order, created_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(name) DO NOTHING
    `).run(name, SCHEDULE_EXTERNAL_DEFAULT_CATEGORY_COLOR, nowTimestamp());
    if (result.changes > 0) this.options.onChanged({ reason: 'category' });
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

// ── External item helpers ────────────────────────────────────────────────────

/** Schedule write timestamp (wall-clock, YYYY-MM-DDTHH:mm:ss). */
function nowTimestamp(): string {
  return new Date().toISOString().replace('Z', '').split('.')[0];
}

/** Normalizes the source key of an external mapping (契约 §4.1). */
function normalizeExternalSource(source: string): string {
  const value = typeof source === 'string' ? source.trim() : '';
  if (!value) throw new Error('外部日程 source 必须是非空字符串。');
  if (value.length > 128) throw new Error('外部日程 source 长度不得超过 128。');
  return value;
}

const EXTERNAL_KINDS: readonly ScheduleItemKind[] = ['event', 'todo', 'course'];
const EXTERNAL_STATUSES: readonly ScheduleItemStatus[] = ['confirmed', 'tentative', 'cancelled'];
const EXTERNAL_TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];
const EXTERNAL_PRIORITIES: ReadonlyArray<NonNullable<ScheduleCreateRequest['priority']>> = ['low', 'normal', 'high', 'urgent'];
const EXTERNAL_DELIVERIES: ReadonlyArray<NonNullable<NonNullable<ScheduleCreateRequest['reminders']>[number]['delivery']>> = ['system', 'in_app', 'both'];

/**
 * Coerces one external upsert item into a validated ScheduleCreateRequest with
 * the contract §4.1 truncation (title≤200 / description≤4000). Returns null for
 * items without externalId/title or with an invalid kind — the caller counts
 * them as skipped (契约 §7 字段级容错：缺字段不崩溃、计 skipped)。
 * 将一条外部 upsert 条目收敛为合法的 ScheduleCreateRequest（含截断）；
 * 缺 externalId/title 或 kind 非法返回 null，由调用方计 skipped。
 */
function buildExternalCreateRequest(item: ScheduleExternalUpsertItem): ScheduleCreateRequest | null {
  if (!item || typeof item !== 'object') return null;
  const title = typeof item.title === 'string' ? item.title.trim().slice(0, SCHEDULE_EXTERNAL_TITLE_MAX) : '';
  if (!title) return null;
  if (!EXTERNAL_KINDS.includes(item.kind)) return null;

  const category = typeof item.category === 'string' && item.category.trim()
    ? item.category.trim().slice(0, 64)
    : SCHEDULE_EXTERNAL_DEFAULT_CATEGORY;
  const todoStatus = item.kind === 'todo' && typeof item.todoStatus === 'string' && EXTERNAL_TODO_STATUSES.includes(item.todoStatus as TodoStatus)
    ? item.todoStatus as TodoStatus
    : null;
  const tags = Array.isArray(item.tags)
    ? item.tags
      .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      .map(tag => tag.trim().slice(0, 64))
      .slice(0, 32)
    : [];
  const reminders = Array.isArray(item.reminders)
    ? item.reminders.slice(0, 8).flatMap((reminder) => {
      const offset = reminder && typeof reminder === 'object' ? Number((reminder as { offsetMinutes?: unknown }).offsetMinutes) : NaN;
      if (!Number.isFinite(offset)) return [];
      const raw = reminder as { delivery?: unknown; enabled?: unknown };
      return [{
        offsetMinutes: offset,
        delivery: typeof raw.delivery === 'string' && EXTERNAL_DELIVERIES.includes(raw.delivery as never) ? raw.delivery as never : 'both' as const,
        enabled: raw.enabled !== false,
      }];
    })
    : [];

  return {
    kind: item.kind,
    title,
    description: typeof item.description === 'string' ? item.description.slice(0, SCHEDULE_EXTERNAL_DESCRIPTION_MAX) : null,
    location: typeof item.location === 'string' ? item.location.slice(0, 512) : null,
    startAt: typeof item.startAt === 'string' ? item.startAt : null,
    endAt: typeof item.endAt === 'string' ? item.endAt : null,
    allDay: Boolean(item.allDay),
    status: typeof item.status === 'string' && EXTERNAL_STATUSES.includes(item.status as ScheduleItemStatus) ? item.status as ScheduleItemStatus : 'confirmed',
    todoStatus,
    dueAt: typeof item.dueAt === 'string' ? item.dueAt : null,
    priority: typeof item.priority === 'string' && EXTERNAL_PRIORITIES.includes(item.priority as never) ? item.priority as never : null,
    completedAt: todoStatus === 'done' && typeof item.completedAt === 'string' ? item.completedAt : null,
    libraryPath: typeof item.libraryPath === 'string' ? item.libraryPath.slice(0, 512) : null,
    libraryName: typeof item.libraryName === 'string' ? item.libraryName.slice(0, 200) : null,
    notePath: typeof item.notePath === 'string' ? item.notePath.slice(0, 512) : null,
    category,
    tags,
    color: typeof item.color === 'string' && /^#[0-9a-fA-F]{3,8}$/u.test(item.color) ? item.color : null,
    recurrence: item.recurrence && typeof item.recurrence === 'object' ? item.recurrence : null,
    course: item.course && typeof item.course === 'object' ? item.course : null,
    reminders,
  };
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