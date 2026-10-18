/**
 * Chinese statutory holidays and makeup work days data.
 * 中国法定节假日与调休补班数据。
 */

export interface HolidayInfo {
  /** Date string YYYY-MM-DD */
  date: string;
  /** Holiday name, e.g. "元旦", "春节" */
  name: string;
  /** Whether this is a makeup work day (补班) */
  isMakeupWorkDay?: boolean;
}

/**
 * Statutory holiday dates (rest days) keyed by year.
 * 法定节假日日期（休息日），按年份索引。
 */
const HOLIDAY_DATA: Record<string, HolidayInfo[]> = {
  '2025': [
    // 元旦 Jan 1
    { date: '2025-01-01', name: '元旦' },
    // 春节 Jan 28 – Feb 4 (8 days)
    { date: '2025-01-28', name: '春节' },
    { date: '2025-01-29', name: '春节' },
    { date: '2025-01-30', name: '春节' },
    { date: '2025-01-31', name: '春节' },
    { date: '2025-02-01', name: '春节' },
    { date: '2025-02-02', name: '春节' },
    { date: '2025-02-03', name: '春节' },
    { date: '2025-02-04', name: '春节' },
    // 清明节 Apr 4–6
    { date: '2025-04-04', name: '清明节' },
    { date: '2025-04-05', name: '清明节' },
    { date: '2025-04-06', name: '清明节' },
    // 劳动节 May 1–5
    { date: '2025-05-01', name: '劳动节' },
    { date: '2025-05-02', name: '劳动节' },
    { date: '2025-05-03', name: '劳动节' },
    { date: '2025-05-04', name: '劳动节' },
    { date: '2025-05-05', name: '劳动节' },
    // 端午节 May 31 – Jun 2
    { date: '2025-05-31', name: '端午节' },
    { date: '2025-06-01', name: '端午节' },
    { date: '2025-06-02', name: '端午节' },
    // 中秋节 + 国庆节 Oct 1–8
    { date: '2025-10-01', name: '国庆节' },
    { date: '2025-10-02', name: '国庆节' },
    { date: '2025-10-03', name: '国庆节' },
    { date: '2025-10-04', name: '中秋节' },
    { date: '2025-10-05', name: '中秋国庆' },
    { date: '2025-10-06', name: '中秋国庆' },
    { date: '2025-10-07', name: '中秋国庆' },
    { date: '2025-10-08', name: '中秋国庆' },
  ],
  '2026': [
    // 元旦 Jan 1–3
    { date: '2026-01-01', name: '元旦' },
    { date: '2026-01-02', name: '元旦' },
    { date: '2026-01-03', name: '元旦' },
    // 春节 Feb 17–23
    { date: '2026-02-17', name: '春节' },
    { date: '2026-02-18', name: '春节' },
    { date: '2026-02-19', name: '春节' },
    { date: '2026-02-20', name: '春节' },
    { date: '2026-02-21', name: '春节' },
    { date: '2026-02-22', name: '春节' },
    { date: '2026-02-23', name: '春节' },
    // 清明节 Apr 4–6
    { date: '2026-04-04', name: '清明节' },
    { date: '2026-04-05', name: '清明节' },
    { date: '2026-04-06', name: '清明节' },
    // 劳动节 May 1–5
    { date: '2026-05-01', name: '劳动节' },
    { date: '2026-05-02', name: '劳动节' },
    { date: '2026-05-03', name: '劳动节' },
    { date: '2026-05-04', name: '劳动节' },
    { date: '2026-05-05', name: '劳动节' },
    // 端午节 Jun 19–21
    { date: '2026-06-19', name: '端午节' },
    { date: '2026-06-20', name: '端午节' },
    { date: '2026-06-21', name: '端午节' },
    // 中秋节 Sep 25–27
    { date: '2026-09-25', name: '中秋节' },
    { date: '2026-09-26', name: '中秋节' },
    { date: '2026-09-27', name: '中秋节' },
    // 国庆节 Oct 1–7
    { date: '2026-10-01', name: '国庆节' },
    { date: '2026-10-02', name: '国庆节' },
    { date: '2026-10-03', name: '国庆节' },
    { date: '2026-10-04', name: '国庆节' },
    { date: '2026-10-05', name: '国庆节' },
    { date: '2026-10-06', name: '国庆节' },
    { date: '2026-10-07', name: '国庆节' },
  ],
};

/**
 * Makeup work days (补班日) — these are weekends that are work days due to holiday adjustments.
 * 调休补班日 — 因假期调整而在周末上班的日期。
 */
const MAKEUP_WORK_DAYS: Record<string, HolidayInfo[]> = {
  '2025': [
    { date: '2025-01-26', name: '春节调休', isMakeupWorkDay: true },
    { date: '2025-02-08', name: '春节调休', isMakeupWorkDay: true },
    { date: '2025-04-27', name: '劳动节调休', isMakeupWorkDay: true },
    { date: '2025-09-28', name: '国庆节调休', isMakeupWorkDay: true },
    { date: '2025-10-11', name: '国庆节调休', isMakeupWorkDay: true },
  ],
  '2026': [
    { date: '2026-02-15', name: '春节调休', isMakeupWorkDay: true },
    { date: '2026-02-28', name: '春节调休', isMakeupWorkDay: true },
    { date: '2026-04-26', name: '劳动节调休', isMakeupWorkDay: true },
    { date: '2026-05-09', name: '端午节调休', isMakeupWorkDay: true },
    { date: '2026-09-20', name: '中秋节调休', isMakeupWorkDay: true },
    { date: '2026-10-10', name: '国庆节调休', isMakeupWorkDay: true },
  ],
};

// Build lookup maps for fast access
const holidayMap = new Map<string, HolidayInfo>();
const makeupWorkDayMap = new Map<string, HolidayInfo>();

for (const yearData of Object.values(HOLIDAY_DATA)) {
  for (const info of yearData) {
    holidayMap.set(info.date, info);
  }
}
for (const yearData of Object.values(MAKEUP_WORK_DAYS)) {
  for (const info of yearData) {
    makeupWorkDayMap.set(info.date, info);
  }
}

/**
 * Get holiday info for a specific date.
 * 获取指定日期的节假日信息。
 */
export function getHolidayInfo(dateStr: string): HolidayInfo | undefined {
  return holidayMap.get(dateStr);
}

/**
 * Check if a date is a statutory holiday (rest day).
 * 判断指定日期是否为法定节假日（休息日）。
 */
export function isHoliday(dateStr: string): boolean {
  return holidayMap.has(dateStr);
}

/**
 * Check if a date is a makeup work day (补班日).
 * 判断指定日期是否为调休补班日。
 */
export function isMakeupWorkDay(dateStr: string): boolean {
  return makeupWorkDayMap.has(dateStr);
}

/**
 * Get makeup work day info for a specific date.
 * 获取指定日期的调休补班信息。
 */
export function getMakeupWorkDayInfo(dateStr: string): HolidayInfo | undefined {
  return makeupWorkDayMap.get(dateStr);
}

/**
 * Get all holidays for a given year.
 * 获取指定年份的所有法定节假日。
 */
export function getHolidaysForYear(year: number): HolidayInfo[] {
  return HOLIDAY_DATA[String(year)] ?? [];
}

/**
 * Get all makeup work days for a given year.
 * 获取指定年份的所有调休补班日。
 */
export function getMakeupWorkDaysForYear(year: number): HolidayInfo[] {
  return MAKEUP_WORK_DAYS[String(year)] ?? [];
}