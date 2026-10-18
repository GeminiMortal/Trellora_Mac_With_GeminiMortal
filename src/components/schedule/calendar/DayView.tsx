/**
 * DayView — single-column time grid for one day.
 * 日视图 — 单列时间格。
 */
import { useMemo } from 'react';
import type { ScheduleOccurrence } from '../../../../shared/schedule.ts';
import TimeGrid from './TimeGrid.tsx';

interface DayViewProps {
  anchorDate: Date;
  occurrences: ScheduleOccurrence[];
  onSelectSlot?: (date: string, hour: number) => void;
  onSelectOccurrence?: (occ: ScheduleOccurrence) => void;
  onMoveOccurrence?: (occurrenceKey: string, newDate: string, newStartMin: number, newEndMin: number) => void;
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function DayView({ anchorDate, occurrences, onSelectSlot, onSelectOccurrence, onMoveOccurrence }: DayViewProps) {
  const dateStr = toDateStr(anchorDate);
  const isToday = dateStr === toDateStr(new Date());

  const columns = useMemo(() => [{
    date: dateStr,
    isToday,
    dayOfWeek: anchorDate.getDay(),
  }], [dateStr, isToday, anchorDate]);

  return (
    <TimeGrid
      columns={columns}
      occurrences={occurrences}
      onSelectSlot={onSelectSlot}
      onSelectOccurrence={onSelectOccurrence}
      onMoveOccurrence={onMoveOccurrence}
    />
  );
}