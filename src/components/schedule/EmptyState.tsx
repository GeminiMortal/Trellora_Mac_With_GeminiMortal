/**
 * EmptyState — friendly empty state for calendar views.
 * 空状态 — 日历视图的友好空状态提示。
 */
import { Button, Text } from '@mantine/core';
import { CalendarPlus, CalendarX } from 'lucide-react';
import { t, useI18n } from '../../i18n/index.ts';

interface EmptyStateProps {
  view: 'year' | 'month' | 'week' | 'day';
  hasOccurrences: boolean;
  onNewEvent: () => void;
}

export default function EmptyState({ view, hasOccurrences, onNewEvent }: EmptyStateProps) {
  useI18n();
  if (hasOccurrences) return null;

  const messages: Record<string, string> = {
    year: t('这一年还没有日程，点击右上角新建开始规划。'),
    month: t('这个月还没有日程，点击右上角新建开始规划。'),
    week: t('本周还没有日程，点击空白时间格快速创建。'),
    day: t('今天还没有日程，点击空白时间格快速创建。'),
  };

  return (
    <div className="schedule-empty-state" role="status">
      <CalendarX size={48} strokeWidth={1} opacity={0.3} />
      <Text size="sm" c="dimmed" className="schedule-empty-state-text">
        {messages[view]}
      </Text>
      <Button
        size="xs"
        variant="light"
        leftSection={<CalendarPlus size={14} />}
        onClick={onNewEvent}
        className="schedule-empty-state-action"
      >
        {t('新建日程')}
      </Button>
    </div>
  );
}