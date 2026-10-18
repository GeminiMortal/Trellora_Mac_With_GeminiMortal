/**
 * ScheduleItemModal — modal for creating/editing schedule items.
 * 日程项弹窗 — 创建/编辑日程项的弹窗。
 */
import { useState, useEffect, useMemo } from 'react';
import { Modal, Button, Group, SegmentedControl, Stack, Divider } from '@mantine/core';
import { t, useI18n } from '../../../i18n/index.ts';
import type { ScheduleItem, ScheduleCreateRequest, ScheduleOccurrence, RecurrenceRule, CourseTimeSettings } from '../../../../shared/schedule.ts';
import EventForm from './EventForm.tsx';
import TodoForm from './TodoForm.tsx';
import CourseForm, { buildCourseRecurrence, buildCourseMeta, type CourseFormData } from './CourseForm.tsx';
import RecurrenceEditor from './RecurrenceEditor.tsx';

type ItemKind = 'event' | 'todo' | 'course';

interface ScheduleItemModalProps {
  opened: boolean;
  onClose: () => void;
  onSave: (req: ScheduleCreateRequest) => void;
  onDelete?: () => void;
  editingItem?: ScheduleItem | null;
  defaultDate?: string;
  defaultHour?: number;
  defaultKind?: ItemKind;
  courseTimes?: CourseTimeSettings;
}

export default function ScheduleItemModal({
  opened, onClose, onSave, onDelete, editingItem, defaultDate, defaultHour, defaultKind, courseTimes,
}: ScheduleItemModalProps) {
  useI18n();
  const [kind, setKind] = useState<ItemKind>(defaultKind ?? 'event');

  // Event form state
  const [eventData, setEventData] = useState({
    title: '', description: '', location: '',
    startAt: null as Date | null, endAt: null as Date | null, allDay: false,
  });

  // Todo form state
  const [todoData, setTodoData] = useState({
    title: '', description: '', dueAt: null as Date | null,
    priority: 'normal' as 'low' | 'normal' | 'high' | 'urgent' | null,
  });

  // Course form state
  const [courseData, setCourseData] = useState<CourseFormData>({
    title: '', location: '', teacher: '',
    dayOfWeek: 1, startPeriod: 1, endPeriod: 2,
    weekParity: 'all', startDate: '', endDate: '', termName: '',
  });

  // Recurrence for events
  const [recurrence, setRecurrence] = useState<RecurrenceRule | null>(null);

  // Initialize form when editing or with defaults
  useEffect(() => {
    if (!opened) return;

    if (editingItem) {
      if (editingItem.kind === 'course' && editingItem.course) {
        setKind('course');
        setCourseData({
          title: editingItem.course.courseName,
          location: editingItem.course.classroom ?? '',
          teacher: editingItem.course.teacher ?? '',
          dayOfWeek: editingItem.course.dayOfWeek,
          startPeriod: editingItem.course.startPeriod,
          endPeriod: editingItem.course.endPeriod,
          weekParity: editingItem.recurrence?.weekParity ?? 'all',
          startDate: editingItem.recurrence?.anchorStart ?? '',
          endDate: editingItem.recurrence?.endsOn ?? '',
          termName: '',
        });
      } else if (editingItem.kind === 'todo') {
        setKind('todo');
        setTodoData({
          title: editingItem.title,
          description: editingItem.description ?? '',
          dueAt: editingItem.dueAt ? new Date(editingItem.dueAt) : null,
          priority: editingItem.priority,
        });
      } else {
        setKind('event');
        setEventData({
          title: editingItem.title,
          description: editingItem.description ?? '',
          location: editingItem.location ?? '',
          startAt: editingItem.startAt ? new Date(editingItem.startAt) : null,
          endAt: editingItem.endAt ? new Date(editingItem.endAt) : null,
          allDay: editingItem.allDay,
        });
        setRecurrence(editingItem.recurrence);
      }
    } else {
      // New item with defaults
      setKind(defaultKind ?? 'event');
      setRecurrence(null);
      const defaultStart = defaultDate
        ? new Date(`${defaultDate}T${defaultHour !== undefined ? String(defaultHour).padStart(2, '0') : '09'}:00:00`)
        : null;
      const defaultEnd = defaultStart ? new Date(defaultStart.getTime() + 3600000) : null;

      setEventData({ title: '', description: '', location: '', startAt: defaultStart, endAt: defaultEnd, allDay: false });
      setTodoData({ title: '', description: '', dueAt: defaultStart, priority: 'normal' });
      setCourseData({
        title: '', location: '', teacher: '',
        dayOfWeek: defaultDate ? new Date(defaultDate + 'T00:00:00').getDay() : 1,
        startPeriod: defaultHour ?? 1, endPeriod: (defaultHour ?? 1) + 1,
        weekParity: 'all', startDate: defaultDate ?? '', endDate: '', termName: '',
      });
    }
  }, [opened, editingItem, defaultDate, defaultHour, defaultKind]);

  const handleSave = () => {
    if (kind === 'event') {
      if (!eventData.title.trim()) return;
      onSave({
        kind: 'event',
        title: eventData.title.trim(),
        description: eventData.description || null,
        location: eventData.location || null,
        startAt: eventData.startAt ? formatLocalIso(eventData.startAt) : null,
        endAt: eventData.endAt ? formatLocalIso(eventData.endAt) : null,
        allDay: eventData.allDay,
        recurrence,
      });
    } else if (kind === 'todo') {
      if (!todoData.title.trim()) return;
      onSave({
        kind: 'todo',
        title: todoData.title.trim(),
        description: todoData.description || null,
        dueAt: todoData.dueAt ? formatLocalIso(todoData.dueAt) : null,
        priority: todoData.priority,
        todoStatus: 'pending',
      });
    } else {
      if (!courseData.title.trim()) return;
      const rec = buildCourseRecurrence(courseData);
      const meta = buildCourseMeta(courseData, courseTimes);
      onSave({
        kind: 'course',
        title: courseData.title.trim(),
        location: courseData.location || null,
        description: null,
        startAt: `${courseData.startDate}T00:00:00`,
        endAt: `${courseData.endDate}T23:59:59`,
        recurrence: rec,
        course: meta,
      });
    }
  };

  const KIND_OPTIONS = [
    { label: t('日程'), value: 'event' },
    { label: t('待办'), value: 'todo' },
    { label: t('课表'), value: 'course' },
  ];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={editingItem ? t('编辑日程') : t('新建日程')}
      size="md"
    >
      <Stack gap="md">
        {!editingItem && (
          <SegmentedControl
            value={kind}
            onChange={(v) => setKind(v as ItemKind)}
            data={KIND_OPTIONS}
          />
        )}

        {kind === 'event' && (
          <EventForm value={eventData} onChange={setEventData} />
        )}
        {kind === 'todo' && (
          <TodoForm value={todoData} onChange={setTodoData} />
        )}
        {kind === 'course' && (
          <CourseForm value={courseData} onChange={setCourseData} courseTimes={courseTimes} />
        )}

        {/* Recurrence editor for events */}
        {kind === 'event' && (
          <>
            <Divider label={t('重复规则')} labelPosition="left" />
            <RecurrenceEditor value={recurrence} onChange={setRecurrence} />
          </>
        )}

        <Group justify="space-between">
          {editingItem && onDelete ? (
            <Button variant="light" color="red" onClick={onDelete}>
              {t('删除')}
            </Button>
          ) : (
            <div />
          )}
          <Group>
            <Button variant="subtle" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button onClick={handleSave}>
              {t('保存')}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function formatLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${min}:00`;
}