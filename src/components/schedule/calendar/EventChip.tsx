/**
 * EventChip — compact event rendering for month view cells.
 * 事件芯片 — 月视图单元格的紧凑事件渲染。
 */
import type { ScheduleOccurrence } from '../../../../shared/schedule.ts';

interface EventChipProps {
  occurrence: ScheduleOccurrence;
  onClick?: (occ: ScheduleOccurrence) => void;
}

export default function EventChip({ occurrence, onClick }: EventChipProps) {
  const { item, startAt } = occurrence;
  const kindClass = `schedule-event-chip--${item.kind}`;
  const doneClass = item.kind === 'todo' && item.todoStatus === 'done' ? 'schedule-event-chip--done' : '';

  const timeLabel = item.allDay ? '' : startAt.includes('T') ? startAt.split('T')[1].slice(0, 5) : '';

  return (
    <div
      className={`schedule-event-chip ${kindClass} ${doneClass}`}
      style={item.color ? { borderLeftColor: item.color, background: `${item.color}20` } : undefined}
      onClick={(e) => { e.stopPropagation(); onClick?.(occurrence); }}
      title={item.title}
    >
      {timeLabel && <span className="schedule-event-chip-time">{timeLabel}</span>}
      <span className="schedule-event-chip-title">{item.title}</span>
    </div>
  );
}