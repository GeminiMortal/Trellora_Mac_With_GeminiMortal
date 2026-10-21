/**
 * ImportPreviewTable — editable preview of import drafts.
 * 导入预览表 — 可编辑的导入草稿预览。
 */
import { Table, TextInput, Select, Badge, ScrollArea, ActionIcon } from '@mantine/core';
import { Trash } from 'lucide-react';
import { t, useI18n } from '../../../i18n/index.ts';
import type { ScheduleImportDraft } from '../../../../shared/schedule.ts';

const WEEKDAY_LABELS: Record<number, string> = {
  0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六',
};

interface ImportPreviewTableProps {
  drafts: ScheduleImportDraft[];
  onChange: (drafts: ScheduleImportDraft[]) => void;
}

export default function ImportPreviewTable({ drafts, onChange }: ImportPreviewTableProps) {
  useI18n();

  const updateDraft = (index: number, patch: Partial<ScheduleImportDraft>) => {
    const updated = [...drafts];
    updated[index] = { ...updated[index], ...patch };
    onChange(updated);
  };

  const removeDraft = (index: number) => {
    onChange(drafts.filter((_, i) => i !== index));
  };

  if (drafts.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--mantine-color-dimmed)' }}>{t('无数据')}</div>;
  }

  return (
    <ScrollArea style={{ maxHeight: 400 }}>
      <Table striped highlightOnHover withTableBorder withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: 30 }}>#</Table.Th>
            <Table.Th>{t('课程名称')}</Table.Th>
            <Table.Th style={{ width: 80 }}>{t('星期')}</Table.Th>
            <Table.Th style={{ width: 100 }}>{t('节次')}</Table.Th>
            <Table.Th>{t('教室')}</Table.Th>
            <Table.Th>{t('教师')}</Table.Th>
            <Table.Th style={{ width: 80 }}>{t('单双周')}</Table.Th>
            <Table.Th style={{ width: 60 }}>{t('状态')}</Table.Th>
            <Table.Th style={{ width: 40 }} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {drafts.map((draft, i) => (
            <Table.Tr key={i}>
              <Table.Td>{draft.row}</Table.Td>
              <Table.Td>
                <TextInput
                  size="xs"
                  value={draft.title}
                  onChange={(e) => updateDraft(i, { title: e.currentTarget.value, valid: !!e.currentTarget.value.trim() })}
                  error={!draft.title}
                />
              </Table.Td>
              <Table.Td>
                <Select
                  size="xs"
                  value={draft.course ? String(draft.course.dayOfWeek) : ''}
                  onChange={(v) => {
                    if (draft.course && v) {
                      updateDraft(i, {
                        course: { ...draft.course, dayOfWeek: Number(v) },
                        recurrence: draft.recurrence ? { ...draft.recurrence, byWeekday: [Number(v)] } : null,
                      });
                    }
                  }}
                  data={Object.entries(WEEKDAY_LABELS).map(([v, label]) => ({ value: v, label }))}
                />
              </Table.Td>
              <Table.Td>
                {draft.course ? `${draft.course.startPeriod}-${draft.course.endPeriod}` : '-'}
              </Table.Td>
              <Table.Td>
                <TextInput
                  size="xs"
                  value={draft.location ?? ''}
                  onChange={(e) => updateDraft(i, { location: e.currentTarget.value || null })}
                />
              </Table.Td>
              <Table.Td>
                <TextInput
                  size="xs"
                  value={draft.course?.teacher ?? ''}
                  onChange={(e) => {
                    if (draft.course) {
                      updateDraft(i, { course: { ...draft.course, teacher: e.currentTarget.value || null } });
                    }
                  }}
                />
              </Table.Td>
              <Table.Td>
                <Select
                  size="xs"
                  value={draft.recurrence?.weekParity ?? 'all'}
                  onChange={(v) => {
                    if (draft.recurrence) {
                      updateDraft(i, { recurrence: { ...draft.recurrence, weekParity: (v ?? 'all') as 'all' | 'odd' | 'even' } });
                    }
                  }}
                  data={[
                    { value: 'all', label: '每周' },
                    { value: 'odd', label: '单周' },
                    { value: 'even', label: '双周' },
                  ]}
                />
              </Table.Td>
              <Table.Td>
                {draft.valid ? (
                  <Badge color="green" size="xs">✓</Badge>
                ) : (
                  <Badge color="red" size="xs" title={draft.issues.join('\n')}>!</Badge>
                )}
              </Table.Td>
              <Table.Td>
                <ActionIcon aria-label="删除此行" size="xs" variant="subtle" color="red" onClick={() => removeDraft(i)}>
                  <Trash size={12} />
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}