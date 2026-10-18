/**
 * ReminderToast — in-app notification stack for schedule reminders.
 * 提醒弹窗 — 日程提醒的应用内通知堆栈。
 */
import { useEffect, useState, useCallback } from 'react';
import type { ScheduleReminderFiredEvent } from '../../../../shared/schedule.ts';

interface ReminderToastProps {
  onDismiss: (reminderId: string) => void;
  onClick: (itemId: string) => void;
}

export default function ReminderToast({ onDismiss, onClick }: ReminderToastProps) {
  const [toasts, setToasts] = useState<ScheduleReminderFiredEvent[]>([]);

  const addToast = useCallback((event: ScheduleReminderFiredEvent) => {
    setToasts((prev) => [...prev, event]);
    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.reminderId !== event.reminderId));
    }, 8000);
  }, []);

  // Expose addToast via a global callback for the parent to call
  useEffect(() => {
    (window as any).__scheduleReminderToast = addToast;
    return () => { delete (window as any).__scheduleReminderToast; };
  }, [addToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="schedule-reminder-toast">
      {toasts.map((toast) => (
        <div
          key={toast.reminderId}
          className="schedule-reminder-toast-item"
          onClick={() => {
            onClick(toast.itemId);
            onDismiss(toast.reminderId);
            setToasts((prev) => prev.filter((t) => t.reminderId !== toast.reminderId));
          }}
        >
          <div className="schedule-reminder-toast-title">🔔 {toast.title}</div>
          <div className="schedule-reminder-toast-meta">
            {toast.location && <span>📍 {toast.location} · </span>}
            <span>⏰ {toast.startAt.includes('T') ? toast.startAt.split('T')[1].slice(0, 5) : toast.startAt}</span>
          </div>
        </div>
      ))}
    </div>
  );
}