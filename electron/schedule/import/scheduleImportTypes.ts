/**
 * Import pipeline internal types — draft, preview, commit contracts.
 * 导入管线内部类型 — 草稿、预览、提交契约。
 */
import type {
  ScheduleImportDraft,
  ScheduleImportSourceType,
  ScheduleImportPreviewResult,
  ScheduleImportCommitRequest,
  ScheduleImportCommitResult,
} from '../../../shared/schedule.ts';

export type {
  ScheduleImportDraft,
  ScheduleImportSourceType,
  ScheduleImportPreviewResult,
  ScheduleImportCommitRequest,
  ScheduleImportCommitResult,
};

/**
 * Raw row extracted from CSV/Excel before mapping.
 */
export interface RawImportRow {
  rowIndex: number;
  cells: Record<string, string>;
}

/**
 * Column mapping configuration.
 */
export interface ColumnMapping {
  [csvColumn: string]: keyof ScheduleImportDraft | '';
}

/**
 * Known column name aliases for auto-detection.
 */
export const COLUMN_ALIASES: Record<string, keyof ScheduleImportDraft> = {
  // Chinese
  '课程': 'title', '课程名': 'title', '课程名称': 'title', '名称': 'title', '标题': 'title', '科目': 'title',
  '星期': 'course.dayOfWeek', '周几': 'course.dayOfWeek', '礼拜': 'course.dayOfWeek',
  '节次': 'course.startPeriod', '开始节次': 'course.startPeriod', '起始节次': 'course.startPeriod',
  '结束节次': 'course.endPeriod',
  '教室': 'location', '地点': 'location', '上课地点': 'location', '教室地点': 'location',
  '教师': 'course.teacher', '老师': 'course.teacher', '授课教师': 'course.teacher', '授课老师': 'course.teacher',
  '周次': 'recurrence.weekRange', '单双周': 'course.weekParity',
  '备注': 'description', '描述': 'description', '说明': 'description',
  '标签': 'tags', '分类': 'category',
  // English
  'course': 'title', 'course name': 'title', 'name': 'title', 'title': 'title', 'subject': 'title',
  'weekday': 'course.dayOfWeek', 'day': 'course.dayOfWeek', 'day of week': 'course.dayOfWeek',
  'period': 'course.startPeriod', 'start period': 'course.startPeriod',
  'end period': 'course.endPeriod',
  'room': 'location', 'location': 'location', 'classroom': 'location',
  'teacher': 'course.teacher', 'instructor': 'course.teacher', 'professor': 'course.teacher',
  'weeks': 'recurrence.weekRange', 'parity': 'course.weekParity',
  'note': 'description', 'description': 'description', 'remark': 'description',
  'tag': 'tags', 'tags': 'tags', 'category': 'category',
};

/**
 * Weekday name/number mapping.
 */
export const WEEKDAY_MAP: Record<string, number> = {
  '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
  '周日': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6,
  '星期日': 0, '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6,
  '礼拜日': 0, '礼拜一': 1, '礼拜二': 2, '礼拜三': 3, '礼拜四': 4, '礼拜五': 5, '礼拜六': 6,
  'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6,
  'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6,
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
};

/**
 * Parse a weekday string to number (0=Sun..6=Sat).
 */
export function parseWeekday(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (WEEKDAY_MAP[trimmed] !== undefined) return WEEKDAY_MAP[trimmed];
  // Try extracting number
  const num = parseInt(trimmed, 10);
  if (num >= 0 && num <= 6) return num;
  return null;
}

/**
 * Parse a period range string like "1-2" or "3" to { start, end }.
 */
export function parsePeriodRange(value: string): { start: number; end: number } | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
  if (match) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    if (start >= 1 && end >= start && end <= 12) return { start, end };
  }
  const single = parseInt(trimmed, 10);
  if (single >= 1 && single <= 12) return { start: single, end: single };
  return null;
}

/**
 * Parse week range string like "1-16周" or "单周" to week info.
 */
export function parseWeekRange(value: string): { start: number; end: number; parity: 'all' | 'odd' | 'even' } | null {
  const trimmed = value.trim();
  // "1-16周" or "1-16"
  const rangeMatch = trimmed.match(/^(\d+)\s*[-–~]\s*(\d+)/);
  if (rangeMatch) {
    const parity = trimmed.includes('单') ? 'odd' : trimmed.includes('双') ? 'even' : 'all';
    return { start: parseInt(rangeMatch[1], 10), end: parseInt(rangeMatch[2], 10), parity };
  }
  if (trimmed.includes('单')) return { start: 1, end: 16, parity: 'odd' };
  if (trimmed.includes('双')) return { start: 1, end: 16, parity: 'even' };
  return null;
}