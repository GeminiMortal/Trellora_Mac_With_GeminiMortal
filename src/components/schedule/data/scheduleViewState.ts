/**
 * Pure view-state helpers for the schedule calendar.
 * 日程日历的纯视图状态辅助函数。
 */

export type CalendarViewMode = 'year' | 'month' | 'week' | 'day';

/**
 * Compute the visible date range [from, to) for a given view mode and anchor date.
 * 计算给定视图模式和锚点日期的可见日期范围 [from, to)。
 */
export function visibleRange(view: CalendarViewMode, anchor: Date): { from: string; to: string } {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const d = anchor.getDate();

  switch (view) {
    case 'year': {
      return {
        from: `${y}-01-01`,
        to: `${y + 1}-01-01`,
      };
    }
    case 'month': {
      const firstDay = new Date(y, m, 1);
      const lastDay = new Date(y, m + 1, 0);
      // Pad to full weeks (Mon–Sun)
      const startPad = (firstDay.getDay() + 6) % 7; // Mon=0
      const from = new Date(firstDay);
      from.setDate(from.getDate() - startPad);
      const endPad = 42 - startPad - lastDay.getDate(); // always 6 rows
      const to = new Date(lastDay);
      to.setDate(to.getDate() + endPad + 1);
      return { from: toDateStr(from), to: toDateStr(to) };
    }
    case 'week': {
      // Monday of the week containing anchor
      const dayOfWeek = (anchor.getDay() + 6) % 7; // Mon=0
      const monday = new Date(anchor);
      monday.setDate(monday.getDate() - dayOfWeek);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 7);
      return { from: toDateStr(monday), to: toDateStr(sunday) };
    }
    case 'day': {
      const next = new Date(anchor);
      next.setDate(next.getDate() + 1);
      return { from: toDateStr(anchor), to: toDateStr(next) };
    }
  }
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Build a 6×7 grid of date cells for a month view.
 * 构建月视图的 6×7 日期单元格网格。
 */
export interface MonthGridCell {
  date: string;          // YYYY-MM-DD
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isToday: boolean;
}

export function buildMonthGrid(anchor: Date): MonthGridCell[][] {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const firstDay = new Date(y, m, 1);
  const startPad = (firstDay.getDay() + 6) % 7; // Mon=0
  const today = toDateStr(new Date());

  const cells: MonthGridCell[] = [];
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startPad);

  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dateStr = toDateStr(d);
    cells.push({
      date: dateStr,
      dayOfMonth: d.getDate(),
      isCurrentMonth: d.getMonth() === m,
      isToday: dateStr === today,
    });
  }

  // Split into 6 rows of 7
  const rows: MonthGridCell[][] = [];
  for (let r = 0; r < 6; r++) {
    rows.push(cells.slice(r * 7, (r + 1) * 7));
  }
  return rows;
}

/**
 * Get the days of a week containing the given date.
 * 获取给定日期所在周的每天。
 */
export function getWeekDays(anchor: Date): Array<{ date: string; dayOfWeek: number; isToday: boolean }> {
  const dayOfWeek = (anchor.getDay() + 6) % 7; // Mon=0
  const monday = new Date(anchor);
  monday.setDate(monday.getDate() - dayOfWeek);
  const today = toDateStr(new Date());

  const days: Array<{ date: string; dayOfWeek: number; isToday: boolean }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = toDateStr(d);
    days.push({
      date: dateStr,
      dayOfWeek: d.getDay(),
      isToday: dateStr === today,
    });
  }
  return days;
}

/**
 * Navigate to previous/next period.
 * 导航到上一个/下一个时间段。
 */
export function navigateDate(current: Date, view: CalendarViewMode, direction: -1 | 1): Date {
  const d = new Date(current);
  switch (view) {
    case 'year':
      d.setFullYear(d.getFullYear() + direction);
      break;
    case 'month':
      d.setMonth(d.getMonth() + direction);
      break;
    case 'week':
      d.setDate(d.getDate() + 7 * direction);
      break;
    case 'day':
      d.setDate(d.getDate() + direction);
      break;
  }
  return d;
}

/**
 * Format a period label for the toolbar.
 * 格式化工具栏的时段标签。
 */
export function formatPeriodLabel(view: CalendarViewMode, anchor: Date): string {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const d = anchor.getDate();

  switch (view) {
    case 'year':
      return `${y}年`;
    case 'month':
      return `${y}年${m + 1}月`;
    case 'week': {
      const dayOfWeek = (anchor.getDay() + 6) % 7;
      const monday = new Date(anchor);
      monday.setDate(monday.getDate() - dayOfWeek);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      return `${monday.getMonth() + 1}/${monday.getDate()} – ${sunday.getMonth() + 1}/${sunday.getDate()}`;
    }
    case 'day':
      return `${y}年${m + 1}月${d}日`;
  }
}

/**
 * Weekday labels (Mon–Sun).
 */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
export const WEEKDAY_LABELS_FULL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];