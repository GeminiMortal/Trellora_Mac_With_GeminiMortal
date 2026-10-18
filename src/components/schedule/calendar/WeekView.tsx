/**
 * WeekView — 7-column time grid for a week.
 * 周视图 — 一周的 7 列时间格。
 */
import { useMemo } from 'react';
import type { ScheduleOccurrence } from '../../../../shared/schedule.ts';
import { getWeekDays, WEEKDAY_LABELS } from '../data/scheduleViewState.ts';
import { getHolidayInfo, isMakeupWorkDay } from '../data/holidays.ts';
import TimeGrid from './TimeGrid.tsx';

interface WeekViewProps {
  anchorDate: Date;
  occurrences: ScheduleOccurrence[];
  onSelectSlot?: (date: string, hour: number) => void;
  onSelectOccurrence?: (occ: ScheduleOccurrence) => void;
  onMoveOccurrence?: (occurrenceKey: string, newDate: string, newStartMin: number, newEndMin: number) => void;
}

export default function WeekView({ anchorDate, occurrences, onSelectSlot, onSelectOccurrence, onMoveOccurrence }: WeekViewProps) {
  const weekDays = useMemo(() => getWeekDays(anchorDate), [anchorDate]);

  const columns = weekDays.map((day, i) => ({
    date: day.date,
    isToday: day.isToday,
    dayOfWeek: day.dayOfWeek,
    label: WEEKDAY_LABELS[i],
  }));

  return (
    <>
      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: `50px repeat(7, 1fr)`, borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <div />
        {columns.map((col, i) => (
          <div
            key={col.date}
            style={{
              padding: '6px 4px',
              textAlign: 'center',
              fontSize: 12,
              fontWeight: 600,
              color: col.isToday ? 'var(--mantine-color-blue-filled)' : getHolidayInfo(col.date) ? 'var(--mantine-color-red-filled)' : 'var(--mantine-color-dimmed)',
              borderRight: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <div>{col.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{parseInt(col.date.split('-')[2])}</div>
            {getHolidayInfo(col.date) && (
              <div style={{ fontSize: 10, color: 'var(--mantine-color-red-filled)', fontWeight: 500, lineHeight: 1.2 }}>
                {getHolidayInfo(col.date)!.name}
              </div>
            )}
            {isMakeupWorkDay(col.date) && (
              <div style={{ fontSize: 9, color: 'var(--mantine-color-orange-filled)', fontWeight: 500 }}>补班</div>
            )}
          </div>
        ))}
      </div>
      <TimeGrid
        columns={columns}
        occurrences={occurrences}
        onSelectSlot={onSelectSlot}
        onSelectOccurrence={onSelectOccurrence}
        onMoveOccurrence={onMoveOccurrence}
      />
    </>
  );
}