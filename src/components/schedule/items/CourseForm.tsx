/**
 * CourseForm — form for creating/editing course schedule items.
 * 课表表单 — 创建/编辑课表项的表单。
 */
import { useMemo } from 'react';
import { Stack, TextInput, Select, Group, NumberInput, Text } from '@mantine/core';
import { t, useI18n } from '../../../i18n/index.ts';
import type { CourseTimeSettings } from '../../../../shared/schedule.ts';
import type { CourseFormData } from './courseFormHelpers.ts';

interface CourseFormProps {
  value: CourseFormData;
  onChange: (data: CourseFormData) => void;
  courseTimes?: CourseTimeSettings;
}

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

export default function CourseForm({ value, onChange, courseTimes }: CourseFormProps) {
  useI18n();

  const timePreview = useMemo(() => {
    if (!courseTimes) return null;
    const startSlot = courseTimes.find(s => s.period === value.startPeriod);
    const endSlot = courseTimes.find(s => s.period === value.endPeriod);
    if (!startSlot || !endSlot) return null;
    return `${startSlot.startTime} - ${endSlot.endTime}`;
  }, [courseTimes, value.startPeriod, value.endPeriod]);

  return (
    <Stack gap="sm">
      <TextInput
        label={t('课程名称')}
        placeholder={t('输入课程名称')}
        value={value.title}
        onChange={(e) => onChange({ ...value, title: e.currentTarget.value })}
        required
      />
      <Group grow>
        <TextInput
          label={t('教师')}
          placeholder={t('教师姓名')}
          value={value.teacher}
          onChange={(e) => onChange({ ...value, teacher: e.currentTarget.value })}
        />
        <TextInput
          label={t('教室')}
          placeholder={t('教室地点')}
          value={value.location}
          onChange={(e) => onChange({ ...value, location: e.currentTarget.value })}
        />
      </Group>
      <Group grow>
        <Select
          label={t('星期')}
          data={WEEKDAY_OPTIONS}
          value={String(value.dayOfWeek)}
          onChange={(v) => onChange({ ...value, dayOfWeek: Number(v) })}
        />
        <Select
          label={t('单双周')}
          data={PARITY_OPTIONS}
          value={value.weekParity}
          onChange={(v) => onChange({ ...value, weekParity: v as CourseFormData['weekParity'] })}
        />
      </Group>
      <Group grow>
        <NumberInput
          label={t('开始节次')}
          min={1}
          max={12}
          value={value.startPeriod}
          onChange={(v) => onChange({ ...value, startPeriod: typeof v === 'number' ? v : 1 })}
        />
        <NumberInput
          label={t('结束节次')}
          min={1}
          max={12}
          value={value.endPeriod}
          onChange={(v) => onChange({ ...value, endPeriod: typeof v === 'number' ? v : 1 })}
        />
      </Group>
      {timePreview && (
        <Text size="sm" c="dimmed">
          ⏰ {timePreview}
        </Text>
      )}
      <Group grow>
        <TextInput
          label={t('学期开始日期')}
          type="date"
          value={value.startDate}
          onChange={(e) => onChange({ ...value, startDate: e.currentTarget.value })}
        />
        <TextInput
          label={t('学期结束日期')}
          type="date"
          value={value.endDate}
          onChange={(e) => onChange({ ...value, endDate: e.currentTarget.value })}
        />
      </Group>
      <TextInput
        label={t('学期名称')}
        placeholder={t('例如：2025 秋季学期')}
        value={value.termName}
        onChange={(e) => onChange({ ...value, termName: e.currentTarget.value })}
      />
    </Stack>
  );
}