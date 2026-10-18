/**
 * Pure functions for expanding recurrence rules into concrete occurrences.
 * 重复规则展开为具体事件的纯函数。
 */
import type { ScheduleItem, RecurrenceRule, CourseTimeSettings } from '../../shared/schedule.ts';

export interface RawOccurrence {
  startAt: string;
  endAt: string;
  originalStart: string;
}

const MAX_OCCURRENCES = 500;

/**
 * Parse a naive local ISO datetime string into its date components.
 */
function parseDateComponents(iso: string): { year: number; month: number; day: number } {
  const [datePart] = iso.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function toDateString(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toMidnight(dateStr: string): string {
  return `${dateStr}T00:00:00`;
}

/**
 * Compute the duration in milliseconds between two ISO strings.
 */
function durationMs(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toDateString(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function addWeeks(dateStr: string, weeks: number): string {
  return addDays(dateStr, weeks * 7);
}

function addMonths(dateStr: string, months: number): string {
  const { year, month, day } = parseDateComponents(dateStr);
  const totalMonths = (year * 12 + month - 1) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  // Clamp day to last day of month
  const lastDay = new Date(newYear, newMonth, 0).getDate();
  return toDateString(newYear, newMonth, Math.min(day, lastDay));
}

function daysSince(a: string, b: string): number {
  const msPerDay = 86400000;
  return Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / msPerDay);
}

/**
 * Get the weekday of a date string (0=Sun..6=Sat).
 */
function getWeekday(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00').getDay();
}

/**
 * Expand a single item's recurrence rule into concrete occurrences within [from, to).
 * 将单个日程项的重复规则展开为 [from, to) 范围内的具体事件。
 */
export function expandOccurrences(
  item: ScheduleItem,
  from: string,
  to: string,
  courseTimes?: CourseTimeSettings,
): RawOccurrence[] {
  const rule = item.recurrence;
  if (!rule || rule.frequency === 'none') {
    // Non-recurring: return as-is if it falls in range
    if (!item.startAt) return [];
    const occ: RawOccurrence = {
      startAt: item.startAt,
      endAt: item.endAt ?? item.startAt,
      originalStart: item.startAt,
    };
    if (isInRange(occ.startAt, from, to)) return [occ];
    return [];
  }

  const anchor = rule.anchorStart;
  if (!anchor) return [];

  const dur = item.startAt && item.endAt ? durationMs(item.startAt, item.endAt) : 0;
  const excludedSet = new Set(rule.excludedDates);
  const horizon = to < addDays(from, 366) ? to : addDays(from, 366);
  const results: RawOccurrence[] = [];

  let current = anchor;
  let count = 0;

  while (current < horizon && count < MAX_OCCURRENCES) {
    count++;

    // Check endsOn
    if (rule.endsOn && current > rule.endsOn) break;

    // Check parity (单双周)
    if (rule.weekParity !== 'all' && (rule.frequency === 'weekly' || rule.frequency === 'weekly_pattern')) {
      const weekIndex = Math.floor(daysSince(anchor, current) / 7);
      const isOdd = weekIndex % 2 === 0; // week 0 = odd (第一周)
      if (rule.weekParity === 'odd' && !isOdd) { current = advance(current, rule); continue; }
      if (rule.weekParity === 'even' && isOdd) { current = advance(current, rule); continue; }
    }

    // Check weekday filter
    if (rule.byWeekday.length > 0 && (rule.frequency === 'weekly' || rule.frequency === 'weekly_pattern')) {
      const wd = getWeekday(current);
      if (!rule.byWeekday.includes(wd)) { current = advance(current, rule); continue; }
    }

    // Check month-day filter
    if (rule.byMonthDay.length > 0 && rule.frequency === 'monthly') {
      const { day } = parseDateComponents(current);
      if (!rule.byMonthDay.includes(day)) { current = advance(current, rule); continue; }
    }

    // Check excluded
    if (excludedSet.has(current)) { current = advance(current, rule); continue; }

    // Emit if in range
    if (isInRange(current, from, to)) {
      let startAt: string;
      let endAt: string;

      // For course items, use course meta times if available
      if (item.kind === 'course' && item.course) {
        const startTime = item.course.startTime ?? courseTimes?.find(s => s.period === item.course!.startPeriod)?.startTime;
        const endTime = item.course.endTime ?? courseTimes?.find(s => s.period === item.course!.endPeriod)?.endTime;
        startAt = startTime ? `${current}T${startTime}:00` : toMidnight(current);
        endAt = endTime ? `${current}T${endTime}:00` : startAt;
      } else {
        startAt = item.startAt && item.startAt.includes('T')
          ? `${current}T${item.startAt.split('T')[1]}`
          : toMidnight(current);
        endAt = dur > 0
          ? new Date(new Date(startAt).getTime() + dur).toISOString().replace('Z', '').split('.')[0]
          : startAt;
      }

      results.push({ startAt, endAt, originalStart: startAt });
    }

    current = advance(current, rule);
  }

  return results;
}

/**
 * Advance to the next candidate date based on the recurrence rule.
 */
function advance(current: string, rule: RecurrenceRule): string {
  const interval = Math.max(1, rule.interval);
  switch (rule.frequency) {
    case 'daily':
    case 'weekly_pattern':
      return addDays(current, interval);
    case 'weekly':
      return addDays(current, 1); // daily scan, weekday filter handles skipping
    case 'monthly':
      return addDays(current, 1); // daily scan, month-day filter handles skipping
    default:
      return addDays(current, 1);
  }
}

function isInRange(dateStr: string, from: string, to: string): boolean {
  return dateStr >= from && dateStr < to;
}