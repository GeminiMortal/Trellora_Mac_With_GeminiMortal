/**
 * ScheduleView — main container for the schedule/calendar feature.
 * 日程视图 — 日程/日历功能的主容器。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { t, useI18n } from '../../i18n/index.ts';
import type { ScheduleOccurrence, ScheduleCreateRequest, ScheduleItem, ScheduleReminderFiredEvent, ScheduleCategory, CourseTimeSettings } from '../../../shared/schedule.ts';
import { createElectronScheduleDataSource } from './data/scheduleElectronDataSource.ts';
import type { ScheduleDataSource } from './data/scheduleElectronDataSource.ts';
import { visibleRange, navigateDate, type CalendarViewMode } from './data/scheduleViewState.ts';
import ScheduleToolbar from './ScheduleToolbar.tsx';
import ScheduleSidebar from './ScheduleSidebar.tsx';
import MonthView from './calendar/MonthView.tsx';
import WeekView from './calendar/WeekView.tsx';
import DayView from './calendar/DayView.tsx';
import YearView from './calendar/YearView.tsx';
import ScheduleItemModal from './items/ScheduleItemModal.tsx';
import ImportModal from './import/ImportModal.tsx';
import ReminderToast from './notifications/ReminderToast.tsx';
import NotificationCenter from './notifications/NotificationCenter.tsx';
import EmptyState from './EmptyState.tsx';
import '../../styles/schedule.css';

export default function ScheduleView() {
  useI18n();

  // ── Data source ──────────────────────────────────────────────────────────
  const dataSource: ScheduleDataSource = useMemo(() => createElectronScheduleDataSource(), []);

  // ── View state ───────────────────────────────────────────────────────────
  const [view, setView] = useState<CalendarViewMode>('month');
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [occurrences, setOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [categories, setCategories] = useState<ScheduleCategory[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [courseTimes, setCourseTimes] = useState<CourseTimeSettings>([]);

  // ── Modal state ──────────────────────────────────────────────────────────
  const [modalOpened, setModalOpened] = useState(false);
  const [importOpened, setImportOpened] = useState(false);
  const [notifCenterOpened, setNotifCenterOpened] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [editingItem, setEditingItem] = useState<ScheduleItem | null>(null);
  const [defaultDate, setDefaultDate] = useState<string | undefined>();
  const [defaultHour, setDefaultHour] = useState<number | undefined>();
  const [defaultKind, setDefaultKind] = useState<'event' | 'todo' | 'course'>('event');

  // ── Compute visible range ────────────────────────────────────────────────
  const range = useMemo(() => visibleRange(view, anchorDate), [view, anchorDate]);

  // ── Fetch occurrences ────────────────────────────────────────────────────
  const fetchOccurrences = useCallback(async () => {
    try {
      const result = await dataSource.listOccurrences({
        from: range.from,
        to: range.to,
        includeCompletedTodos: true,
        categories: selectedCategories.length > 0 ? selectedCategories : undefined,
      });
      setOccurrences(result);
    } catch {
      // silently handle
    }
  }, [dataSource, range.from, range.to, selectedCategories]);

  useEffect(() => {
    fetchOccurrences();
  }, [fetchOccurrences]);

  // ── Fetch categories & course times ──────────────────────────────────────
  useEffect(() => {
    dataSource.listCategories().then(setCategories).catch(() => {});
    dataSource.getCourseTimes().then(setCourseTimes).catch(() => {});
  }, [dataSource]);

  // ── Subscribe to changes ─────────────────────────────────────────────────
  useEffect(() => {
    const unsub = dataSource.onChanged(() => {
      fetchOccurrences();
      dataSource.listCategories().then(setCategories).catch(() => {});
    });
    return unsub;
  }, [dataSource, fetchOccurrences]);

  // ── Subscribe to reminders ───────────────────────────────────────────────
  useEffect(() => {
    const unsub = dataSource.onReminder((event: ScheduleReminderFiredEvent) => {
      const toastFn = (window as any).__scheduleReminderToast;
      if (toastFn) toastFn(event);
    });
    return unsub;
  }, [dataSource]);

  useEffect(() => {
    const unsub = dataSource.onReminderClicked(() => fetchOccurrences());
    return unsub;
  }, [dataSource, fetchOccurrences]);

  // ── Navigation handlers ──────────────────────────────────────────────────
  const handleNavigate = useCallback((direction: -1 | 1) => {
    setAnchorDate((prev) => navigateDate(prev, view, direction));
  }, [view]);

  const handleToday = useCallback(() => setAnchorDate(new Date()), []);

  const handleViewChange = useCallback((newView: CalendarViewMode) => setView(newView), []);

  // ── Item CRUD handlers ───────────────────────────────────────────────────
  const handleNewEvent = useCallback(() => {
    setEditingItem(null);
    setDefaultKind('event');
    setDefaultDate(undefined);
    setDefaultHour(undefined);
    setModalOpened(true);
  }, []);

  const handleNewTodo = useCallback(() => {
    setEditingItem(null);
    setDefaultKind('todo');
    setDefaultDate(undefined);
    setDefaultHour(undefined);
    setModalOpened(true);
  }, []);

  const handleNewCourse = useCallback(() => {
    setEditingItem(null);
    setDefaultKind('course');
    setDefaultDate(undefined);
    setDefaultHour(undefined);
    setModalOpened(true);
  }, []);

  const handleSelectDate = useCallback((date: string) => {
    setView('day');
    setAnchorDate(new Date(date + 'T00:00:00'));
  }, []);

  const handleSelectSlot = useCallback((date: string, hour: number) => {
    setEditingItem(null);
    setDefaultKind('event');
    setDefaultDate(date);
    setDefaultHour(hour);
    setModalOpened(true);
  }, []);

  const handleSelectOccurrence = useCallback((occ: ScheduleOccurrence) => {
    setEditingItem(occ.item);
    setDefaultKind(occ.item.kind === 'course' ? 'course' : occ.item.kind === 'todo' ? 'todo' : 'event');
    setModalOpened(true);
  }, []);

  const handleSave = useCallback(async (req: ScheduleCreateRequest) => {
    try {
      if (editingItem) {
        await dataSource.updateItem({ id: editingItem.id, patch: req });
      } else {
        await dataSource.createItem(req);
      }
      setModalOpened(false);
      setEditingItem(null);
    } catch {
      // handle error
    }
  }, [dataSource, editingItem]);

  const handleDelete = useCallback(async () => {
    if (!editingItem) return;
    try {
      await dataSource.deleteItem({ id: editingItem.id, scope: 'series' });
      setModalOpened(false);
      setEditingItem(null);
    } catch {
      // handle error
    }
  }, [dataSource, editingItem]);

  const handleToggleTodoStatus = useCallback(async (id: string, status: 'pending' | 'done') => {
    try {
      await dataSource.setTodoStatus(id, status);
    } catch {
      // handle error
    }
  }, [dataSource]);

  const handleToggleCategory = useCallback((category: string) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category],
    );
  }, []);

  // ── Drag-to-reschedule handler ───────────────────────────────────────────
  const handleMoveOccurrence = useCallback(async (occurrenceKey: string, newDate: string, newStartMin: number, newEndMin: number) => {
    // Find the occurrence by key
    const occ = occurrences.find((o) => o.occurrenceKey === occurrenceKey);
    if (!occ) return;

    const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
    const newStartAt = `${newDate}T${fmtMin(newStartMin)}`;
    const newEndAt = `${newDate}T${fmtMin(newEndMin)}`;

    try {
      // If the occurrence has an override, update the override; otherwise update the item
      if (occurrenceKey.includes('#')) {
        // Recurring occurrence — create/update override
        await dataSource.updateOccurrence({
          itemId: occ.item.id,
          occurrenceStart: occ.startAt,
          startAt: newStartAt,
          endAt: newEndAt,
        });
      } else {
        await dataSource.updateItem({
          id: occ.item.id,
          patch: { startAt: newStartAt, endAt: newEndAt },
        });
      }
    } catch {
      // silently handle
    }
  }, [occurrences, dataSource]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  const scheduleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle when schedule view is focused or no modal is open
      if (modalOpened || importOpened || notifCenterOpened) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      switch (e.key) {
        case 't': e.preventDefault(); handleToday(); break;
        case 'm': e.preventDefault(); handleViewChange('month'); break;
        case 'w': e.preventDefault(); handleViewChange('week'); break;
        case 'd': e.preventDefault(); handleViewChange('day'); break;
        case 'y': e.preventDefault(); handleViewChange('year'); break;
        case 'n': e.preventDefault(); handleNewEvent(); break;
        case 'ArrowLeft': e.preventDefault(); handleNavigate(-1); break;
        case 'ArrowRight': e.preventDefault(); handleNavigate(1); break;
        case 'b': e.preventDefault(); setNotifCenterOpened((v) => !v); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modalOpened, importOpened, notifCenterOpened, handleToday, handleViewChange, handleNewEvent, handleNavigate]);

  // ── Month drag-select range handler ──────────────────────────────────────
  const handleSelectRange = useCallback((startDate: string, endDate: string) => {
    setEditingItem(null);
    setDefaultKind('event');
    setDefaultDate(startDate + 'T08:00:00');
    setDefaultHour(8);
    setModalOpened(true);
  }, []);

  // ── Year view navigation ─────────────────────────────────────────────────
  const handleSelectMonth = useCallback((month: number) => {
    setView('month');
    setAnchorDate((prev) => {
      const d = new Date(prev);
      d.setMonth(month);
      return d;
    });
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="schedule-view" ref={scheduleRef} tabIndex={-1} role="application" aria-label={t('日程管理')}>
      <ScheduleToolbar
        view={view}
        anchorDate={anchorDate}
        onViewChange={handleViewChange}
        onNavigate={handleNavigate}
        onToday={handleToday}
        onNewEvent={handleNewEvent}
        onNewTodo={handleNewTodo}
        onNewCourse={handleNewCourse}
        onImport={() => setImportOpened(true)}
        onNotificationCenter={() => setNotifCenterOpened(true)}
        unreadNotifications={unreadNotifCount}
      />

      <div className="schedule-content">
        <nav aria-label={t('侧边栏')}>
        <ScheduleSidebar
          anchorDate={anchorDate}
          occurrences={occurrences}
          categories={categories}
          selectedCategories={selectedCategories}
          onSelectDate={handleSelectDate}
          onToggleCategory={handleToggleCategory}
          onToggleTodoStatus={handleToggleTodoStatus}
          onSelectOccurrence={handleSelectOccurrence}
        />
        </nav>

        <main className="schedule-main" aria-label={t('日历视图')}>
          <EmptyState view={view} hasOccurrences={occurrences.length > 0} onNewEvent={handleNewEvent} />
          {view === 'year' && (
            <YearView
              anchorDate={anchorDate}
              occurrences={occurrences}
              onSelectMonth={handleSelectMonth}
              onSelectDate={handleSelectDate}
            />
          )}
          {view === 'month' && (
            <MonthView
              anchorDate={anchorDate}
              occurrences={occurrences}
              onSelectDate={handleSelectDate}
              onSelectOccurrence={handleSelectOccurrence}
              onSelectRange={handleSelectRange}
            />
          )}
          {view === 'week' && (
            <WeekView
              anchorDate={anchorDate}
              occurrences={occurrences}
              onSelectSlot={handleSelectSlot}
              onSelectOccurrence={handleSelectOccurrence}
              onMoveOccurrence={handleMoveOccurrence}
            />
          )}
          {view === 'day' && (
            <DayView
              anchorDate={anchorDate}
              occurrences={occurrences}
              onSelectSlot={handleSelectSlot}
              onSelectOccurrence={handleSelectOccurrence}
              onMoveOccurrence={handleMoveOccurrence}
            />
          )}
        </main>
      </div>

      <ScheduleItemModal
        opened={modalOpened}
        onClose={() => { setModalOpened(false); setEditingItem(null); }}
        onSave={handleSave}
        onDelete={editingItem ? handleDelete : undefined}
        editingItem={editingItem}
        defaultDate={defaultDate}
        defaultHour={defaultHour}
        defaultKind={defaultKind}
        courseTimes={courseTimes}
      />

      <ImportModal
        opened={importOpened}
        onClose={() => setImportOpened(false)}
        dataSource={dataSource}
        onImported={() => fetchOccurrences()}
      />

      <ReminderToast
        onDismiss={() => {}}
        onClick={(itemId) => {
          const item = occurrences.find((o) => o.item.id === itemId)?.item;
          if (item) {
            setEditingItem(item);
            setModalOpened(true);
          }
        }}
      />

      <NotificationCenter
        opened={notifCenterOpened}
        onClose={() => setNotifCenterOpened(false)}
        onClickItem={(itemId) => {
          const item = occurrences.find((o) => o.item.id === itemId)?.item;
          if (item) {
            setEditingItem(item);
            setModalOpened(true);
          }
        }}
      />
    </div>
  );
}