/**
 * Import service — orchestrate parse → preview → commit pipeline.
 * 导入服务 — 编排 解析 → 预览 → 提交 管线。
 */
import type Database from 'better-sqlite3';
import type { ScheduleImportSourceType, ScheduleImportPreviewResult, ScheduleImportCommitRequest, ScheduleImportCommitResult } from '../../../shared/schedule.ts';
import type { RawImportRow, ColumnMapping } from './scheduleImportTypes.ts';
import { parseWeekday, parsePeriodRange, parseWeekRange } from './scheduleImportTypes.ts';
import { parseCsvFile } from './scheduleCsvParser.ts';
import { parseExcelFile } from './scheduleExcelParser.ts';
import { generateScheduleId } from '../scheduleDatabase.ts';

export interface ImportServiceOptions {
  getDatabase: () => Database.Database;
}

export class ScheduleImportService {
  private readonly options: ImportServiceOptions;

  constructor(options: ImportServiceOptions) {
    this.options = options;
  }

  /**
   * Preview a CSV import.
   */
  async previewCsv(filePath: string): Promise<ScheduleImportPreviewResult> {
    try {
      const { rows, headers, encoding, delimiter, autoMapping } = parseCsvFile(filePath);
      if (rows.length === 0) {
        return { status: 'failed', code: 'PARSE_EMPTY', message: '文件内容为空。' };
      }

      const drafts = rowsToDrafts(rows, autoMapping);
      const warnings: string[] = [];
      const invalidCount = drafts.filter(d => !d.valid).length;
      if (invalidCount > 0) warnings.push(`${invalidCount} 条记录缺少必要信息。`);

      return {
        status: 'ok',
        draft: drafts,
        warnings,
        columnMapping: autoMapping,
        encoding,
      };
    } catch (error) {
      return {
        status: 'failed',
        code: 'FILE_UNREADABLE',
        message: `无法读取文件: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Preview an Excel import.
   */
  async previewExcel(filePath: string): Promise<ScheduleImportPreviewResult> {
    try {
      const { rows, headers, sheetName, autoMapping } = await parseExcelFile(filePath);
      if (rows.length === 0) {
        return { status: 'failed', code: 'PARSE_EMPTY', message: '工作表内容为空。' };
      }

      const drafts = rowsToDrafts(rows, autoMapping);
      const warnings: string[] = [];
      const invalidCount = drafts.filter(d => !d.valid).length;
      if (invalidCount > 0) warnings.push(`${invalidCount} 条记录缺少必要信息。`);

      return {
        status: 'ok',
        draft: drafts,
        warnings,
        columnMapping: autoMapping,
      };
    } catch (error) {
      return {
        status: 'failed',
        code: 'FILE_UNREADABLE',
        message: `无法读取文件: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Commit import drafts to the database.
   */
  commit(request: ScheduleImportCommitRequest): ScheduleImportCommitResult {
    const db = this.options.getDatabase();
    const batchId = generateScheduleId();
    const now = new Date().toISOString().replace('Z', '').split('.')[0];

    let createdCount = 0;
    let skippedCount = 0;

    db.transaction(() => {
      // Create import batch
      db.prepare(`
        INSERT INTO schedule_import_batches (id, source_type, source_label, summary_json, item_count, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'committed', ?)
      `).run(batchId, request.sourceType, request.sourceLabel, '{}', request.drafts.length, now);

      // Insert items
      const insertItem = db.prepare(`
        INSERT INTO schedule_items (
          id, kind, title, description, location, start_at, end_at, all_day,
          status, todo_status, due_at, priority, completed_at,
          library_path, library_name, note_path,
          category, tags_json, color, recurrence_json, course_meta_json,
          import_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const draft of request.drafts) {
        if (!draft.valid || !draft.title) {
          skippedCount++;
          continue;
        }

        const id = generateScheduleId();
        insertItem.run(
          id,
          draft.kind,
          draft.title,
          draft.description ?? null,
          draft.location ?? null,
          draft.startAt ?? null,
          draft.endAt ?? null,
          draft.allDay ? 1 : 0,
          'confirmed',
          draft.todoStatus ?? null,
          draft.dueAt ?? null,
          null, // priority
          null, // completedAt
          request.libraryPath ?? null,
          null, // libraryName
          null, // notePath
          draft.category ?? null,
          JSON.stringify(draft.tags ?? []),
          null, // color
          draft.recurrence ? JSON.stringify(draft.recurrence) : null,
          draft.course ? JSON.stringify(draft.course) : null,
          batchId,
          now,
          now,
        );
        createdCount++;
      }

      // Update batch item count
      db.prepare('UPDATE schedule_import_batches SET item_count = ? WHERE id = ?').run(createdCount, batchId);
    })();

    return { batchId, createdCount, skippedCount };
  }
}

/**
 * Convert raw rows to import drafts using column mapping.
 */
function rowsToDrafts(rows: RawImportRow[], mapping: ColumnMapping): import('../../../shared/schedule.ts').ScheduleImportDraft[] {
  return rows.map((row) => {
    const title = getField(row, mapping, 'title') ?? '';
    const dayOfWeekStr = getField(row, mapping, 'course.dayOfWeek');
    const startPeriodStr = getField(row, mapping, 'course.startPeriod');
    const endPeriodStr = getField(row, mapping, 'course.endPeriod');
    const location = getField(row, mapping, 'location');
    const teacher = getField(row, mapping, 'course.teacher');
    const weekRangeStr = getField(row, mapping, 'recurrence.weekRange');
    const weekParityStr = getField(row, mapping, 'course.weekParity');

    const dayOfWeek = dayOfWeekStr ? parseWeekday(dayOfWeekStr) : null;
    const periodRange = startPeriodStr ? parsePeriodRange(startPeriodStr) : null;
    const endPeriod = endPeriodStr ? (parsePeriodRange(endPeriodStr)?.end ?? periodRange?.end) : periodRange?.end;
    const weekRange = weekRangeStr ? parseWeekRange(weekRangeStr) : null;
    const parity = weekParityStr === '单周' ? 'odd' : weekParityStr === '双周' ? 'even' : weekRange?.parity ?? 'all';

    const issues: string[] = [];
    if (!title) issues.push('缺少课程名称');
    if (dayOfWeek === null) issues.push('无法识别星期');
    if (!periodRange) issues.push('无法识别节次');

    const isCourse = dayOfWeek !== null && periodRange !== null;

    return {
      row: row.rowIndex,
      title,
      kind: isCourse ? 'course' as const : 'event' as const,
      description: getField(row, mapping, 'description') ?? null,
      location: location ?? null,
      startAt: null,
      endAt: null,
      allDay: false,
      course: isCourse ? {
        courseName: title,
        teacher: teacher ?? null,
        classroom: location ?? null,
        dayOfWeek: dayOfWeek!,
        startPeriod: periodRange!.start,
        endPeriod: endPeriod ?? periodRange!.end,
        startTime: null,
        endTime: null,
        termId: null,
      } : null,
      recurrence: isCourse ? {
        frequency: 'weekly_pattern' as const,
        interval: 1,
        byWeekday: [dayOfWeek!],
        byMonthDay: [],
        weekParity: parity,
        anchorStart: '',
        endsOn: null,
        excludedDates: [],
      } : null,
      tags: [],
      category: getField(row, mapping, 'category') ?? null,
      todoStatus: null,
      dueAt: null,
      valid: issues.length === 0,
      issues,
    };
  });
}

/**
 * Get a field value from a raw row using the column mapping.
 */
function getField(row: RawImportRow, mapping: ColumnMapping, target: string): string | null {
  for (const [csvCol, mappedField] of Object.entries(mapping)) {
    if (mappedField === target) {
      const value = row.cells[csvCol];
      if (value && value.trim()) return value.trim();
    }
  }
  return null;
}