/**
 * TodoPanel — sidebar panel showing todo items grouped by due date.
 * 待办面板 — 侧栏面板，按截止日期分组显示待办项。
 */
import { useMemo } from 'react';
import { Stack, Text, Checkbox, Group, Badge, ScrollArea } from '@mantine/core';
import { t, useI18n } from '../../../i18n/index.ts';
import type { ScheduleOccurrence, TodoStatus } from '../../../../shared/schedule.ts';

interface TodoPanelProps {
  occurrences: ScheduleOccurrence[];
  onToggleStatus?: (id: string, status: TodoStatus) => void;
  onSelect?: (occ: ScheduleOccurrence) => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'red',
  high: 'orange',
  normal: 'blue',
  low: 'gray',
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

export default function TodoPanel({ occurrences, onToggleStatus, onSelect }: TodoPanelProps) {
  useI18n();

  // Filter to todo items only
  const todos = useMemo(() => {
    return occurrences.filter(o => o.item.kind === 'todo');
  }, [occurrences]);

  // Group by due date
  const grouped = useMemo(() => {
    const groups = new Map<string, ScheduleOccurrence[]>();
    const today = new Date().toISOString().split('T')[0];

    for (const todo of todos) {
      const dueAt = todo.item.dueAt;
      let key: string;
      if (!dueAt) {
        key = '无截止日期';
      } else {
        const dueDate = dueAt.split('T')[0];
        if (dueDate < today) {
          key = '已过期';
        } else if (dueDate === today) {
          key = '今天';
        } else {
          key = dueDate;
        }
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(todo);
    }

    // Sort groups: 已过期 > 今天 > dates > 无截止日期
    const order = ['已过期', '今天'];
    const sorted = [...groups.entries()].sort(([a], [b]) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      if (a === '无截止日期') return 1;
      if (b === '无截止日期') return -1;
      return a.localeCompare(b);
    });

    return sorted;
  }, [todos]);

  if (todos.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Text size="sm" c="dimmed">{t('暂无待办')}</Text>
      </div>
    );
  }

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Stack gap="md" p="md">
        {grouped.map(([group, items]) => (
          <div key={group}>
            <Group gap="xs" mb={4}>
              <Text size="xs" fw={600} c="dimmed">{group}</Text>
              <Badge size="xs" variant="light">{items.length}</Badge>
            </Group>
            <Stack gap={2}>
              {items.map((occ) => {
                const item = occ.item;
                const isDone = item.todoStatus === 'done';
                const priorityColor = PRIORITY_COLORS[item.priority ?? 'normal'];

                return (
                  <Group
                    key={occ.occurrenceKey}
                    gap="xs"
                    style={{
                      padding: '4px 6px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      opacity: isDone ? 0.5 : 1,
                      transition: 'opacity 0.15s',
                    }}
                    onClick={() => onSelect?.(occ)}
                  >
                    <Checkbox
                      checked={isDone}
                      onChange={(e) => {
                        e.stopPropagation();
                        onToggleStatus?.(item.id, isDone ? 'pending' : 'done');
                      }}
                      size="sm"
                    />
                    <Text
                      size="sm"
                      style={{ flex: 1, textDecoration: isDone ? 'line-through' : 'none' }}
                      lineClamp={1}
                    >
                      {item.title}
                    </Text>
                    {item.priority && item.priority !== 'normal' && (
                      <Badge size="xs" color={priorityColor} variant="light">
                        {t(PRIORITY_LABELS[item.priority])}
                      </Badge>
                    )}
                  </Group>
                );
              })}
            </Stack>
          </div>
        ))}
      </Stack>
    </ScrollArea>
  );
}