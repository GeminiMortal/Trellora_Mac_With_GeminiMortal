/**
 * TimeGrid — shared hour-axis + absolute event layer for week/day views.
 * 时间格 — 周/日视图共用的小时轴 + 绝对定位事件层。
 * Supports drag-to-move and drag-to-resize events.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type { ScheduleOccurrence } from '../../../../shared/schedule.ts';
import { computeTimeGridLayout, getHourLabels } from '../data/timeGridLayout.ts';

const HOUR_HEIGHT = 60;
const MIN_DURATION_MINUTES = 15;
const SNAP_MINUTES = 15;

type DragMode = 'move' | 'resize';
interface DragState {
  mode: DragMode;
  occurrence: ScheduleOccurrence;
  startY: number;
  origTopPx: number;
  origHeightPx: number;
  origStartMin: number;
  origEndMin: number;
  origDate: string;
  currentColIdx: number;
  deltaMinutes: number;
  deltaColumns: number;
}

interface TimeGridProps {
  columns: Array<{ date: string; isToday: boolean; dayOfWeek: number }>;
  occurrences: ScheduleOccurrence[];
  onSelectSlot?: (date: string, hour: number) => void;
  onSelectOccurrence?: (occ: ScheduleOccurrence) => void;
  onMoveOccurrence?: (occurrenceKey: string, newDate: string, newStartMin: number, newEndMin: number) => void;
}

export default function TimeGrid({ columns, occurrences, onSelectSlot, onSelectOccurrence, onMoveOccurrence }: TimeGridProps) {
  const hourLabels = getHourLabels();
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [nowOffset, setNowOffset] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      const now = new Date();
      scrollRef.current.scrollTop = Math.max(0, now.getHours() * HOUR_HEIGHT - 100);
    }
  }, []);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setNowOffset(now.getHours() * HOUR_HEIGHT + (now.getMinutes() / 60) * HOUR_HEIGHT);
    };
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, []);

  // Group occurrences by column date
  const occsByColumn = new Map<string, ScheduleOccurrence[]>();
  for (const col of columns) occsByColumn.set(col.date, []);
  for (const occ of occurrences) {
    const date = occ.startAt.split('T')[0];
    if (occsByColumn.has(date)) occsByColumn.get(date)!.push(occ);
  }

  // ── Drag handlers ──────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.MouseEvent, occurrence: ScheduleOccurrence, mode: DragMode) => {
    if (!onMoveOccurrence) return;
    e.preventDefault();
    e.stopPropagation();
    const date = occurrence.startAt.split('T')[0];
    const [sh, sm] = occurrence.startAt.split('T')[1].split(':').map(Number);
    const [eh, em] = occurrence.endAt.split('T')[1].split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const colIdx = columns.findIndex((c) => c.date === date);

    setDrag({
      mode,
      occurrence,
      startY: e.clientY,
      origTopPx: startMin * (HOUR_HEIGHT / 60),
      origHeightPx: (endMin - startMin) * (HOUR_HEIGHT / 60),
      origStartMin: startMin,
      origEndMin: endMin,
      origDate: date,
      currentColIdx: colIdx >= 0 ? colIdx : 0,
      deltaMinutes: 0,
      deltaColumns: 0,
    });
  }, [columns, onMoveOccurrence]);

  const handleDragMove = useCallback((e: React.MouseEvent) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const deltaMin = Math.round(dy / (HOUR_HEIGHT / 60) / SNAP_MINUTES) * SNAP_MINUTES;

    if (drag.mode === 'move') {
      // Compute column delta from X
      const colsEl = colsRef.current;
      let deltaCol = 0;
      if (colsEl) {
        const rect = colsEl.getBoundingClientRect();
        const colWidth = rect.width / columns.length;
        const origX = (drag.currentColIdx + 0.5) * colWidth + rect.left;
        deltaCol = Math.round((e.clientX - origX) / colWidth);
        deltaCol = Math.max(-drag.currentColIdx, Math.min(columns.length - 1 - drag.currentColIdx, deltaCol));
      }
      setDrag((prev) => prev ? { ...prev, deltaMinutes: deltaMin, deltaColumns: deltaCol } : prev);
    } else {
      // Resize: only bottom edge
      setDrag((prev) => prev ? { ...prev, deltaMinutes: deltaMin } : prev);
    }
  }, [drag, columns.length]);

  const handleDragEnd = useCallback(() => {
    if (!drag) return;
    const { mode, occurrence, deltaMinutes, deltaColumns, origDate, origStartMin, origEndMin } = drag;

    if (deltaMinutes !== 0 || deltaColumns !== 0) {
      let newDate = origDate;
      let newStart = origStartMin;
      let newEnd = origEndMin;

      if (mode === 'move') {
        newStart = Math.max(0, Math.min(24 * 60 - 30, origStartMin + deltaMinutes));
        const duration = origEndMin - origStartMin;
        newEnd = newStart + duration;
        if (deltaColumns !== 0) {
          const newColIdx = columns.findIndex((c) => c.date === origDate) + deltaColumns;
          if (newColIdx >= 0 && newColIdx < columns.length) {
            newDate = columns[newColIdx].date;
          }
        }
      } else {
        newEnd = Math.max(origStartMin + MIN_DURATION_MINUTES, Math.min(24 * 60, origEndMin + deltaMinutes));
      }

      onMoveOccurrence?.(occurrence.occurrenceKey, newDate, newStart, newEnd);
    }
    setDrag(null);
  }, [drag, columns, onMoveOccurrence]);

  // Global mouse events during drag
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      e.preventDefault();
      const dy = e.clientY - drag.startY;
      const deltaMin = Math.round(dy / (HOUR_HEIGHT / 60) / SNAP_MINUTES) * SNAP_MINUTES;

      if (drag.mode === 'move') {
        const colsEl = colsRef.current;
        let deltaCol = 0;
        if (colsEl) {
          const rect = colsEl.getBoundingClientRect();
          const colWidth = rect.width / columns.length;
          const origX = (drag.currentColIdx + 0.5) * colWidth + rect.left;
          deltaCol = Math.round((e.clientX - origX) / colWidth);
          deltaCol = Math.max(-drag.currentColIdx, Math.min(columns.length - 1 - drag.currentColIdx, deltaCol));
        }
        setDrag((prev) => prev ? { ...prev, deltaMinutes: deltaMin, deltaColumns: deltaCol } : prev);
      } else {
        setDrag((prev) => prev ? { ...prev, deltaMinutes: deltaMin } : prev);
      }
    };
    const onUp = () => handleDragEnd();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, columns.length, handleDragEnd]);

  // Compute drag preview style
  const getDragPreviewStyle = (occ: ScheduleOccurrence): React.CSSProperties | undefined => {
    if (!drag || drag.occurrence.occurrenceKey !== occ.occurrenceKey) return undefined;
    const { mode, deltaMinutes, deltaColumns, origTopPx, origHeightPx, origStartMin, origEndMin, origDate } = drag;

    if (mode === 'move') {
      const newTop = (origStartMin + deltaMinutes) * (HOUR_HEIGHT / 60);
      const newLeft = deltaColumns !== 0 ? `${((columns.findIndex((c) => c.date === origDate) + deltaColumns) * 100) / columns.length}%` : undefined;
      return {
        top: newTop,
        height: origHeightPx,
        opacity: 0.7,
        zIndex: 10,
        ...(newLeft !== undefined ? { left: newLeft, width: `${100 / columns.length}%` } : {}),
      };
    }
    // resize
    return {
      top: origTopPx,
      height: Math.max((origEndMin - origStartMin + deltaMinutes) * (HOUR_HEIGHT / 60), 20),
      opacity: 0.7,
      zIndex: 10,
    };
  };

  const hasDrag = drag !== null;

  return (
    <div className="schedule-time-grid" ref={scrollRef}>
      <div className="schedule-time-axis" aria-hidden="true">
        {hourLabels.map(({ hour, label }) => (
          <div key={hour} className="schedule-time-axis-label" style={{ height: HOUR_HEIGHT }}>
            {label}
          </div>
        ))}
      </div>

      <div
        className="schedule-time-columns"
        ref={colsRef}
        style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}
      >
        {columns.map((col, colIdx) => {
          const colOccs = occsByColumn.get(col.date) ?? [];
          const layout = computeTimeGridLayout(colOccs);

          return (
            <div key={col.date} className="schedule-time-column" style={{ position: 'relative' }}>
              {/* Hour slots */}
              {hourLabels.map(({ hour }) => (
                <div
                  key={hour}
                  className="schedule-time-slot"
                  style={{ height: HOUR_HEIGHT, cursor: hasDrag ? 'move' : 'pointer' }}
                  onClick={() => !hasDrag && onSelectSlot?.(col.date, hour)}
                  role="button"
                  tabIndex={-1}
                  aria-label={`${col.date} ${hour}:00`}
                />
              ))}

              {/* Event blocks */}
              {layout.map((block) => {
                const { occurrence, column, totalColumns } = block;
                const widthPct = 100 / totalColumns;
                const leftPct = column * widthPct;
                const previewStyle = getDragPreviewStyle(occurrence);
                const isDragging = drag?.occurrence.occurrenceKey === occurrence.occurrenceKey;

                return (
                  <div
                    key={occurrence.occurrenceKey}
                    className={`schedule-time-block schedule-time-block--${occurrence.item.kind} ${occurrence.item.kind === 'todo' && occurrence.item.todoStatus === 'done' ? 'schedule-time-block--done' : ''} ${isDragging ? 'schedule-time-block--dragging' : ''}`}
                    style={{
                      top: block.topMinutes * (HOUR_HEIGHT / 60),
                      height: Math.max(block.durationMinutes * (HOUR_HEIGHT / 60), 20),
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      ...(occurrence.item.color ? { borderLeftColor: occurrence.item.color, background: `${occurrence.item.color}20` } : {}),
                      ...(previewStyle ?? {}),
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      handleDragStart(e, occurrence, 'move');
                    }}
                    onClick={(e) => {
                      if (drag && drag.deltaMinutes !== 0) { e.stopPropagation(); return; }
                      e.stopPropagation();
                      onSelectOccurrence?.(occurrence);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${occurrence.item.title}, ${occurrence.startAt}`}
                    onKeyDown={(e) => { if (e.key === 'Enter') onSelectOccurrence?.(occurrence); }}
                  >
                    <div className="schedule-time-block-title">{occurrence.item.title}</div>
                    {occurrence.item.location && (
                      <div className="schedule-time-block-location">📍 {occurrence.item.location}</div>
                    )}
                    {/* Resize handle */}
                    {onMoveOccurrence && (
                      <div
                        className="schedule-time-block-resize"
                        onMouseDown={(e) => {
                          if (e.button !== 0) return;
                          handleDragStart(e, occurrence, 'resize');
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {/* Now line */}
              {col.isToday && nowOffset !== null && (
                <div className="schedule-now-line" style={{ top: nowOffset }} aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>

      {/* Drag hint */}
      {drag && (
        <div className="schedule-drag-hint" aria-live="polite">
          {drag.mode === 'move'
            ? `移动到 ${drag.deltaColumns !== 0 ? columns[Math.max(0, Math.min(columns.length - 1, columns.findIndex((c) => c.date === drag.origDate) + drag.deltaColumns))]?.date : drag.origDate} · ${Math.round((drag.origStartMin + drag.deltaMinutes) / 15) * 15} 分钟`
            : `调整为 ${Math.round((drag.origEndMin + drag.deltaMinutes - drag.origStartMin) / 15) * 15} 分钟`}
        </div>
      )}
    </div>
  );
}