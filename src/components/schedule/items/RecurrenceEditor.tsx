/**
 * RecurrenceEditor — UI for editing recurrence rules.
 * 重复规则编辑器 — 编辑重复规则的 UI。
 */
import { Stack, Select, Group, MultiSelect, TextInput, NumberInput } from '@mantine/core';
import { t, useI18n } from '../../../i18n/index.ts';
import type { RecurrenceRule } from '../../../../shared/schedule.ts';

interface RecurrenceEditorProps {
  value: RecurrenceRule | null;
  onChange: (rule: RecurrenceRule | null) => void;
}

const FREQUENCY_OPTIONS = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

const WEEKDAY_OPTIONS = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '0', label: '周日' },
];

const PARITY_OPTIONS = [
  { value: 'all', label: '每周' },
  { value: 'odd', label: '单周' },
  { value: 'even', label: '双周' },
];

export default function RecurrenceEditor({ value, onChange }: RecurrenceEditorProps) {
  useI18n();

  const rule: RecurrenceRule = value ?? {
    frequency: 'none',
    interval: 1,
    byWeekday: [],
    byMonthDay: [],
    weekParity: 'all',
    anchorStart: '',
    endsOn: null,
    excludedDates: [],
  };

  const update = (patch: Partial<RecurrenceRule>) => {
    const merged = { ...rule, ...patch };
    if (merged.frequency === 'none') {
      onChange(null);
    } else {
      onChange(merged);
    }
  };

  return (
    <Stack gap="sm">
      <Select
        label={t('重复频率')}
        data={FREQUENCY_OPTIONS}
        value={rule.frequency}
        onChange={(v) => update({ frequency: (v ?? 'none') as RecurrenceRule['frequency'] })}
      />

      {rule.frequency !== 'none' && (
        <>
          <Group grow>
            <NumberInput
              label={t('间隔')}
              min={1}
              max={30}
              value={rule.interval}
              onChange={(v) => update({ interval: typeof v === 'number' ? v : 1 })}
            />
            {rule.frequency === 'weekly' && (
              <Select
                label={t('单双周')}
                data={PARITY_OPTIONS}
                value={rule.weekParity}
                onChange={(v) => update({ weekParity: (v ?? 'all') as RecurrenceRule['weekParity'] })}
              />
            )}
          </Group>

          {rule.frequency === 'weekly' && (
            <MultiSelect
              label={t('重复日')}
              data={WEEKDAY_OPTIONS}
              value={rule.byWeekday.map(String)}
              onChange={(v) => update({ byWeekday: v.map(Number) })}
            />
          )}

          <Group grow>
            <TextInput
              label={t('开始日期')}
              type="date"
              value={rule.anchorStart}
              onChange={(e) => update({ anchorStart: e.currentTarget.value })}
            />
            <TextInput
              label={t('结束日期')}
              type="date"
              value={rule.endsOn ?? ''}
              onChange={(e) => update({ endsOn: e.currentTarget.value || null })}
            />
          </Group>
        </>
      )}
    </Stack>
  );
}