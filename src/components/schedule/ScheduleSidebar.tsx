/**
 * ScheduleSidebar — mini calendar, category filters, upcoming todos.
 * 日程侧栏 — 迷你日历、分类筛选、待办列表。
 */
import { useMemo } from 'react';
import { Group, Badge } from '@mantine/core';
import { t, useI18n } from '../../i18n/index.ts';
import type { ScheduleOccurrence, ScheduleCategory } from '../../../shared/schedule.ts';
import { buildMonthGrid, WEEKDAY_LABELS } from './data/scheduleViewState.ts';
import TodoPanel from './todos/TodoPanel.tsx';
import type { TodoStatus } from '../../../shared/schedule.ts';

interface ScheduleSidebarProps {
  anchorDate: Date;
  occurrences: ScheduleOccurrence[];
  categories: ScheduleCategory[];
  selectedCategories: string[];
  onSelectDate?: (date: string) => void;
  onToggleCategory?: (category: string) => void;
  onToggleTodoStatus?: (id: string, status: TodoStatus) => void;
  onSelectOccurrence?: (occ: ScheduleOccurrence) => void;
}

export default function ScheduleSidebar({
  anchorDate, occurrences, categories, selectedCategories,
  onSelectDate, onToggleCategory, onToggleTodoStatus, onSelectOccurrence,
}: ScheduleSidebarProps) {
  useI18n();


  // Mini calendar grid
  const miniGrid = useMemo(() => buildMonthGrid(anchorDate), [anchorDate]);

  // Count events per date for dots
  const eventDates = useMemo(() => {
    const set = new Set<string>();
    for (const occ of occurrences) {
      set.add(occ.startAt.split('T')[0]);
    }
    return set;
  }, [occurrences]);

  return (
    <div className="schedule-sidebar">
      {/* Mini calendar */}
      <div className="schedule-sidebar-section">
        <div className="schedule-mini-calendar">
          {WEEKDAY_LABELS.map((label, i) => (
            <div key={i} className="schedule-mini-calendar-header">{label[0]}</div>
          ))}
          {miniGrid.flat().map((cell) => (
            <div
              key={cell.date}
              className={`schedule-mini-calendar-day ${!cell.isCurrentMonth ? 'schedule-mini-calendar-day--other' : ''} ${cell.isToday ? 'schedule-mini-calendar-day--today' : ''}`}
              onClick={() => onSelectDate?.(cell.date)}
            >
              {cell.dayOfMonth}
              {eventDates.has(cell.date) && cell.isCurrentMonth && (
                <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--mantine-color-blue-filled)', margin: '1px auto 0' }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Category filters */}
      {categories.length > 0 && (
        <div className="schedule-sidebar-section">
          <div className="schedule-sidebar-section-title">{t('分类')}</div>
          <Group gap={4}>
            {categories.map((cat) => {
              const isSelected = selectedCategories.length === 0 || selectedCategories.includes(cat.name);
              return (
                <Badge
                  key={cat.name}
                  size="sm"
                  variant={isSelected ? 'filled' : 'outline'}
                  style={{ cursor: 'pointer', background: isSelected ? cat.color : undefined }}
                  onClick={() => onToggleCategory?.(cat.name)}
                >
                  {cat.name}
                </Badge>
              );
            })}
          </Group>
        </div>
      )}

      {/* Todo list */}
      <div className="schedule-sidebar-section" style={{ flex: 1, overflow: 'hidden' }}>
        <div className="schedule-sidebar-section-title">{t('待办')}</div>
        <TodoPanel
          occurrences={occurrences}
          onToggleStatus={onToggleTodoStatus}
          onSelect={onSelectOccurrence}
        />
      </div>
    </div>
  );
}