/**
 * EventForm — form for creating/editing calendar events.
 * 日程表单 — 创建/编辑日历事件的表单。
 */
import { Stack, TextInput, Textarea, Switch, Group } from '@mantine/core';
import { t, useI18n } from '../../../i18n/index.ts';

interface EventFormData {
  title: string;
  description: string;
  location: string;
  startAt: string;   // YYYY-MM-DDTHH:mm
  endAt: string;
  allDay: boolean;
}

interface EventFormProps {
  value: EventFormData;
  onChange: (data: EventFormData) => void;
}

export default function EventForm({ value, onChange }: EventFormProps) {
  useI18n();

  return (
    <Stack gap="sm">
      <TextInput
        label={t('标题')}
        placeholder={t('添加标题')}
        value={value.title}
        onChange={(e) => onChange({ ...value, title: e.currentTarget.value })}
        required
      />
      <Group grow>
        <TextInput
          label={t('开始时间')}
          type="datetime-local"
          value={value.startAt}
          onChange={(e) => onChange({ ...value, startAt: e.currentTarget.value })}
        />
        <TextInput
          label={t('结束时间')}
          type="datetime-local"
          value={value.endAt}
          onChange={(e) => onChange({ ...value, endAt: e.currentTarget.value })}
        />
      </Group>
      <Switch
        label={t('全天')}
        checked={value.allDay}
        onChange={(e) => onChange({ ...value, allDay: e.currentTarget.checked })}
      />
      <TextInput
        label={t('地点')}
        placeholder={t('添加地点')}
        value={value.location}
        onChange={(e) => onChange({ ...value, location: e.currentTarget.value })}
      />
      <Textarea
        label={t('描述')}
        placeholder={t('添加描述')}
        value={value.description}
        onChange={(e) => onChange({ ...value, description: e.currentTarget.value })}
        autosize
        minRows={2}
      />
    </Stack>
  );
}