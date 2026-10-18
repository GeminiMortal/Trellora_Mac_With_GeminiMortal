/**
 * TodoForm — form for creating/editing todo items.
 * 待办表单 — 创建/编辑待办项的表单。
 */
import { Stack, TextInput, Textarea, Select, Group } from '@mantine/core';
import { t, useI18n } from '../../../i18n/index.ts';

interface TodoFormData {
  title: string;
  description: string;
  dueAt: string;   // YYYY-MM-DDTHH:mm
  priority: 'low' | 'normal' | 'high' | 'urgent' | null;
}

interface TodoFormProps {
  value: TodoFormData;
  onChange: (data: TodoFormData) => void;
}

export default function TodoForm({ value, onChange }: TodoFormProps) {
  useI18n();

  return (
    <Stack gap="sm">
      <TextInput
        label={t('标题')}
        placeholder={t('添加待办事项')}
        value={value.title}
        onChange={(e) => onChange({ ...value, title: e.currentTarget.value })}
        required
      />
      <Group grow>
        <TextInput
          label={t('截止时间')}
          type="datetime-local"
          value={value.dueAt}
          onChange={(e) => onChange({ ...value, dueAt: e.currentTarget.value })}
        />
        <Select
          label={t('优先级')}
          value={value.priority ?? 'normal'}
          onChange={(v) => onChange({ ...value, priority: (v as TodoFormData['priority']) ?? 'normal' })}
          data={[
            { value: 'low', label: t('低') },
            { value: 'normal', label: t('普通') },
            { value: 'high', label: t('高') },
            { value: 'urgent', label: t('紧急') },
          ]}
        />
      </Group>
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