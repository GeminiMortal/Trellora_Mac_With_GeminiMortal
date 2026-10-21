/**
 * CourseForm helpers — shared types and builders for course schedule items.
 * 课表表单辅助 —— 课表项的共享类型与构建器。
 *
 * Extracted from CourseForm.tsx so the component file only exports the
 * component (keeps React Fast Refresh working).
 * 从 CourseForm.tsx 抽出，使组件文件只导出组件（保证 React Fast Refresh 正常）。
 */
import type { CourseMeta, RecurrenceRule, CourseTimeSettings } from '../../../../shared/schedule.ts';

export interface CourseFormData {
  title: string;
  location: string;
  teacher: string;
  dayOfWeek: number;
  startPeriod: number;
  endPeriod: number;
  weekParity: 'all' | 'odd' | 'even';
  startDate: string;       // YYYY-MM-DD term start
  endDate: string;         // YYYY-MM-DD term end
  termName: string;
}

/**
 * Build a RecurrenceRule from course form data.
 */
export function buildCourseRecurrence(data: CourseFormData): RecurrenceRule {
  return {
    frequency: 'weekly_pattern',
    interval: 1,
    byWeekday: [data.dayOfWeek],
    byMonthDay: [],
    weekParity: data.weekParity,
    anchorStart: data.startDate,
    endsOn: data.endDate,
    excludedDates: [],
  };
}

/**
 * Build CourseMeta from course form data.
 */
export function buildCourseMeta(data: CourseFormData, courseTimes?: CourseTimeSettings): CourseMeta {
  const startSlot = courseTimes?.find(s => s.period === data.startPeriod);
  const endSlot = courseTimes?.find(s => s.period === data.endPeriod);
  return {
    courseName: data.title,
    teacher: data.teacher || null,
    classroom: data.location || null,
    dayOfWeek: data.dayOfWeek,
    startPeriod: data.startPeriod,
    endPeriod: data.endPeriod,
    startTime: startSlot?.startTime ?? null,
    endTime: endSlot?.endTime ?? null,
    termId: null,
  };
}
