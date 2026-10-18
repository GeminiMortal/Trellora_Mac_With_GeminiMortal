/**
 * MonthView — monthly calendar grid with event chips.
 * 月视图 — 带事件芯片的月历网格。支持拖选日期范围创建日程。
 */
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { ScheduleOccurrence } from '../../../../shared/schedule.ts';
import { buildMonthGrid, WEEKDAY_LABELS } from '../data/scheduleViewState.ts';
import { getHolidayInfo, isMakeupWorkDay } from '../data/holidays.ts';
import EventChip from './EventChip.tsx';

const MAX_VISIBLE_EVENTS = 3;

interface MonthViewProps {
  anchorDate: Date;
  occurrences: ScheduleOccurrence[];
  onSelectDate?: (date: string) => void;
  onSelectOccurrence?: (occ: ScheduleOccurrence) => void;
  onSelectRange?: (startDate: string, endDate: string) => void;
}

export default function MonthView({ anchorDate, occurrences, onSelectDate, onSelectOccurrence, onSelectRange }: MonthViewProps) {
  const grid = useMemo(() => buildMonthGrid(anchorDate), [anchorDate]);
  const flatCells = useMemo(() => grid.flat(), [grid]);

  // ── Drag-select state ──────────────────────────────────────────────────────
  const [dragStart, setDragStart] = useState<string | null>(null);
  const [dragEnd, setDragEnd] = useState<string | null>(null);
  const isDragging = dragStart !== null && dragEnd !== null;

  const getDateIndex = useCallback((date: string) => flatCells.findIndex((c) => c.date === date), [flatCells]);

  const handleCellMouseDown = useCallback((date: string) => {
    setDragStart(date);
    setDragEnd(date);
  }, []);

  const handleCellMouseEnter = useCallback((date: string) => {
    if (dragStart) setDragEnd(date);
  }, [dragStart]);

  const handleMouseUp = useCallback(() => {
    if (dragStart && dragEnd) {
      const start = dragStart <= dragEnd ? dragStart : dragEnd;
      const end = dragStart <= dragEnd ? dragEnd : dragStart;
      if (start === end) {
        onSelectDate?.(start);
      } else {
        onSelectRange?.(start, end);
      }
    }
    setDragStart(null);
    setDragEnd(null);
  }, [dragStart, dragEnd, onSelectDate, onSelectRange]);

  // Global mouseup listener
  useEffect(() => {
    if (!dragStart) return;
    const onUp = () => handleMouseUp();
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [dragStart, handleMouseUp]);

  // Determine which cells are in the selection range
  const selectedDates = useMemo(() => {
    if (!dragStart || !dragEnd) return new Set<string>();
    const start = dragStart <= dragEnd ? dragStart : dragEnd;
    const end = dragStart <= dragEnd ? dragEnd : dragStart;
    const set = new Set<string>();
    let inRange = false;
    for (const cell of flatCells) {
      if (cell.date === start) inRange = true;
      if (inRange) set.add(cell.date);
      if (cell.date === end) break;
    }
    return set;
  }, [dragStart, dragEnd, flatCells]);

  // ── Group occurrences by date ──────────────────────────────────────────────
  const occByDate = useMemo(() => {
    const map = new Map<string, ScheduleOccurrence[]>();
    for (const occ of occurrences) {
      const date = occ.startAt.split('T')[0];
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(occ);
    }
    return map;
  }, [occurrences]);

  const isSelecting = dragStart !== null;

  return (
    <div className="schedule-month-grid" role="grid" aria-label="月视图">
      {/* Header row */}
      {WEEKDAY_LABELS.map((label, i) => (
        <div key={i} className="schedule-month-header" role="columnheader">{label}</div>
      ))}

      {/* Day cells */}
      {flatCells.map((cell) => {
        const dayOccs = occByDate.get(cell.date) ?? [];
        const visible = dayOccs.slice(0, MAX_VISIBLE_EVENTS);
        const remaining = dayOccs.length - visible.length;
        const isSelected = selectedDates.has(cell.date);

        return (
          <div
            key={cell.date}
            className={`schedule-month-cell ${!cell.isCurrentMonth ? 'schedule-month-cell--other-month' : ''} ${cell.isToday ? 'schedule-month-cell--today' : ''} ${isSelected ? 'schedule-month-cell--selecting' : ''}`}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              handleCellMouseDown(cell.date);
            }}
            onMouseEnter={() => handleCellMouseEnter(cell.date)}
            role="gridcell"
            tabIndex={0}
            aria-label={`${cell.date}${dayOccs.length > 0 ? `，${dayOccs.length} 个日程` : ''}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelectDate?.(cell.date);
            }}
          >
            <div className="schedule-month-cell-header">
              <div className={`schedule-month-cell-day ${getHolidayInfo(cell.date) ? 'schedule-month-cell-day--holiday' : ''} ${isMakeupWorkDay(cell.date) ? 'schedule-month-cell-day--makeup' : ''}`}>
                {cell.dayOfMonth}
              </div>
              {getHolidayInfo(cell.date) && (
                <span className="schedule-month-holiday-tag">{getHolidayInfo(cell.date)!.name}</span>
              )}
              {isMakeupWorkDay(cell.date) && (
                <span className="schedule-month-makeup-tag">班</span>
              )}
            </div>
            <div className="schedule-month-events">
              {visible.map((occ) => (
                <EventChip
                  key={occ.occurrenceKey}
                  occurrence={occ}
                  onClick={onSelectOccurrence}
                />
              ))}
              {remaining > 0 && (
                <div
                  className="schedule-month-more"
                  onClick={(e) => { e.stopPropagation(); onSelectDate?.(cell.date); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onSelectDate?.(cell.date); } }}
                >
                  +{remaining} 更多
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Range preview */}
      {isSelecting && dragStart && dragEnd && dragStart !== dragEnd && (
        <div className="schedule-month-range-preview" aria-live="polite">
          {dragStart <= dragEnd ? dragStart : dragEnd} ~ {dragStart <= dragEnd ? dragEnd : dragStart}
        </div>
      )}
    </div>
  );
}