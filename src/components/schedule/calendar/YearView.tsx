/**
 * YearView — 12 mini-month grids with density dots.
 * 年视图 — 12 个迷你月历网格，带密度点。
 */
import { useMemo } from 'react';
import type { ScheduleOccurrence } from '../../../../shared/schedule.ts';
import { buildMonthGrid, WEEKDAY_LABELS } from '../data/scheduleViewState.ts';
import { isHoliday, isMakeupWorkDay } from '../data/holidays.ts';

interface YearViewProps {
  anchorDate: Date;
  occurrences: ScheduleOccurrence[];
  onSelectMonth?: (month: number) => void;
  onSelectDate?: (date: string) => void;
}

export default function YearView({ anchorDate, occurrences, onSelectMonth, onSelectDate }: YearViewProps) {
  const year = anchorDate.getFullYear();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Count occurrences per date
  const occCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const occ of occurrences) {
      const date = occ.startAt.split('T')[0];
      map.set(date, (map.get(date) ?? 0) + 1);
    }
    return map;
  }, [occurrences]);

  const months = useMemo(() => {
    return Array.from({ length: 12 }, (_, m) => {
      const anchor = new Date(year, m, 1);
      const grid = buildMonthGrid(anchor);
      return { month: m, grid };
    });
  }, [year]);

  return (
    <div className="schedule-year-grid">
      {months.map(({ month, grid }) => (
        <div key={month} className="schedule-year-month" onClick={() => onSelectMonth?.(month)}>
          <div className="schedule-year-month-title">{month + 1}月</div>
          <div className="schedule-year-mini-grid">
            {grid.flat().map((cell) => {
              const count = occCountByDate.get(cell.date) ?? 0;
              return (
                <div
                  key={cell.date}
                  className={`schedule-year-mini-day ${!cell.isCurrentMonth ? 'schedule-year-mini-day--other' : ''} ${cell.isToday ? 'schedule-year-mini-day--today' : ''} ${isHoliday(cell.date) ? 'schedule-year-mini-day--holiday' : ''} ${isMakeupWorkDay(cell.date) ? 'schedule-year-mini-day--makeup' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onSelectDate?.(cell.date); }}
                >
                  {cell.dayOfMonth}
                  {count > 0 && cell.isCurrentMonth && (
                    <div className="schedule-year-mini-dots">
                      {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                        <div key={i} className="schedule-year-mini-dot" style={{ background: 'var(--mantine-color-blue-filled)' }} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}