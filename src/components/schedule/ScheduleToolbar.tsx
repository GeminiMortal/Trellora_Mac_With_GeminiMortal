/**
 * ScheduleToolbar — view switcher, date navigation, new item button.
 * 日程工具栏 — 视图切换、日期导航、新建按钮。
 */
import { Button, SegmentedControl, Menu, ActionIcon, Indicator } from '@mantine/core';
import { ChevronLeft, ChevronRight, Plus, CalendarDays, Import, Bell } from 'lucide-react';
import { t, useI18n } from '../../i18n/index.ts';
import type { CalendarViewMode } from './data/scheduleViewState.ts';
import { formatPeriodLabel } from './data/scheduleViewState.ts';

interface ScheduleToolbarProps {
  view: CalendarViewMode;
  anchorDate: Date;
  onViewChange: (view: CalendarViewMode) => void;
  onNavigate: (direction: -1 | 1) => void;
  onToday: () => void;
  onNewEvent: () => void;
  onNewTodo: () => void;
  onNewCourse?: () => void;
  onImport?: () => void;
  onNotificationCenter?: () => void;
  unreadNotifications?: number;
}

export default function ScheduleToolbar({
  view, anchorDate, onViewChange, onNavigate, onToday, onNewEvent, onNewTodo, onNewCourse, onImport,
  onNotificationCenter, unreadNotifications,
}: ScheduleToolbarProps) {
  useI18n();

  return (
    <div className="schedule-toolbar">
      <div className="schedule-toolbar-nav">
        <ActionIcon variant="subtle" size="sm" onClick={() => onNavigate(-1)}>
          <ChevronLeft size={16} />
        </ActionIcon>
        <ActionIcon variant="subtle" size="sm" onClick={() => onNavigate(1)}>
          <ChevronRight size={16} />
        </ActionIcon>
      </div>

      <Button variant="subtle" size="xs" onClick={onToday}>
        {t('今天')}
      </Button>

      <div className="schedule-toolbar-period">
        {formatPeriodLabel(view, anchorDate)}
      </div>

      <SegmentedControl
        size="xs"
        value={view}
        onChange={(v) => onViewChange(v as CalendarViewMode)}
        data={[
          { label: t('年'), value: 'year' },
          { label: t('月'), value: 'month' },
          { label: t('周'), value: 'week' },
          { label: t('日'), value: 'day' },
        ]}
      />

      <div className="schedule-toolbar-actions">
        {onNotificationCenter && (
          <Indicator disabled={!unreadNotifications} size={8} offset={2} color="red">
            <ActionIcon variant="subtle" size="sm" onClick={onNotificationCenter} title={t('通知中心')}>
              <Bell size={16} />
            </ActionIcon>
          </Indicator>
        )}
        {onImport && (
          <ActionIcon variant="subtle" size="sm" onClick={onImport} title={t('导入')}>
            <Import size={16} />
          </ActionIcon>
        )}
        <Menu position="bottom-end">
          <Menu.Target>
            <Button size="xs" leftSection={<Plus size={14} />}>
              {t('新建')}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<CalendarDays size={14} />} onClick={onNewEvent}>
              {t('日程')}
            </Menu.Item>
            <Menu.Item onClick={onNewTodo}>
              {t('待办')}
            </Menu.Item>
            {onNewCourse && (
              <Menu.Item onClick={onNewCourse}>
                {t('课表')}
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
  );
}