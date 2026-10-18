/**
 * Schedule reminder service — in-memory due queue + setTimeout + safety tick.
 * 日程提醒服务 — 内存到期队列 + setTimeout + 安全轮询。
 */
import { Notification, powerMonitor } from 'electron';
import type { BrowserWindow } from 'electron';
import type { ScheduleReminderFiredEvent, ReminderDelivery } from '../../shared/schedule.ts';
import type { ScheduleService } from './scheduleService.ts';

interface DueReminder {
  fireAt: number;                      // Date.now() milliseconds
  reminderId: string;
  itemId: string;
  occurrenceKey: string;
  title: string;
  startAt: string;
  location: string | null;
  delivery: ReminderDelivery;
}

export interface ScheduleReminderServiceOptions {
  scheduleService: ScheduleService;
  getMainWindow: () => BrowserWindow | null;
  getWorkspacePath: () => string;
}

export class ScheduleReminderService {
  private queue: DueReminder[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private safetyTick: ReturnType<typeof setInterval> | null = null;
  private resumeHandler: (() => void) | null = null;
  private disposed = false;
  private readonly options: ScheduleReminderServiceOptions;

  constructor(options: ScheduleReminderServiceOptions) {
    this.options = options;
    this.startSafetyTick();
    this.startResumeListener();
  }

  /**
   * Rebuild the in-memory due queue from the database.
   * 从数据库重建内存到期队列。
   */
  rebuild(): void {
    if (this.disposed) return;

    this.queue = [];
    const now = Date.now();

    try {
      const db = (this.options.scheduleService as any).database;
      if (!db) return;

      // Fetch all enabled reminders with their items
      const rows = db.prepare(`
        SELECT r.id AS reminder_id, r.item_id, r.offset_minutes, r.delivery,
               i.title, i.start_at, i.location
        FROM schedule_reminders r
        JOIN schedule_items i ON i.id = r.item_id
        WHERE r.enabled = 1
          AND i.start_at IS NOT NULL
      `).all() as Array<{
        reminder_id: string; item_id: string; offset_minutes: number;
        delivery: string; title: string; start_at: string; location: string | null;
      }>;

      // Get fired reminders to avoid duplicates
      const firedRows = db.prepare(
        'SELECT reminder_id, occurrence_key FROM schedule_fired_reminders',
      ).all() as Array<{ reminder_id: string; occurrence_key: string }>;
      const firedSet = new Set(firedRows.map(r => `${r.reminder_id}|${r.occurrence_key}`));

      for (const row of rows) {
        const startMs = new Date(row.start_at).getTime();
        if (isNaN(startMs)) continue;

        const fireAt = startMs - row.offset_minutes * 60000;
        const occurrenceKey = row.start_at; // simplified; recurring items need full expansion
        const dedupeKey = `${row.reminder_id}|${occurrenceKey}`;

        // Skip if already fired
        if (firedSet.has(dedupeKey)) continue;

        // Skip if too far in the past (>5 minutes)
        if (fireAt < now - 5 * 60000) continue;

        this.queue.push({
          fireAt,
          reminderId: row.reminder_id,
          itemId: row.item_id,
          occurrenceKey,
          title: row.title,
          startAt: row.start_at,
          location: row.location,
          delivery: row.delivery as ReminderDelivery,
        });
      }

      // Sort by fire time
      this.queue.sort((a, b) => a.fireAt - b.fireAt);
    } catch {
      // Silently handle errors during rebuild
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed || this.queue.length === 0) return;

    const now = Date.now();
    const next = this.queue[0];
    const delay = Math.max(0, Math.min(next.fireAt - now, 60000)); // cap at 60s

    this.timer = setTimeout(() => this.processDue(), delay);
  }

  private processDue(): void {
    if (this.disposed) return;

    const now = Date.now();
    while (this.queue.length > 0 && this.queue[0].fireAt <= now) {
      const reminder = this.queue.shift()!;
      this.fireReminder(reminder, now);
    }

    this.scheduleNext();
  }

  private fireReminder(reminder: DueReminder, now: number): void {
    const missedByMs = now - reminder.fireAt;

    // Record as fired
    try {
      const db = (this.options.scheduleService as any).database;
      if (db) {
        const firedAt = new Date(now).toISOString().replace('Z', '').split('.')[0];
        db.prepare(
          'INSERT OR IGNORE INTO schedule_fired_reminders (reminder_id, occurrence_key, fired_at, delivery) VALUES (?, ?, ?, ?)',
        ).run(reminder.reminderId, reminder.occurrenceKey, firedAt, reminder.delivery);
      }
    } catch { /* ignore */ }

    const firedEvent: ScheduleReminderFiredEvent = {
      reminderId: reminder.reminderId,
      itemId: reminder.itemId,
      occurrenceKey: reminder.occurrenceKey,
      title: reminder.title,
      startAt: reminder.startAt,
      location: reminder.location,
      delivery: reminder.delivery,
      firedAt: new Date(now).toISOString(),
      missedByMs,
    };

    // System notification
    if (reminder.delivery === 'system' || reminder.delivery === 'both') {
      try {
        const body = [
          reminder.location ? `📍 ${reminder.location}` : null,
          `⏰ ${reminder.startAt}`,
        ].filter(Boolean).join('\n');

        const notification = new Notification({
          title: reminder.title,
          body: body || '日程提醒',
          silent: false,
        });

        notification.on('click', () => {
          const win = this.options.getMainWindow();
          if (win && !win.isDestroyed()) {
            win.show();
            win.focus();
            win.webContents.send('schedule:reminder-clicked', { itemId: reminder.itemId });
          }
        });

        notification.show();
      } catch { /* Notification not supported */ }
    }

    // In-app notification
    if (reminder.delivery === 'in_app' || reminder.delivery === 'both') {
      const win = this.options.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('schedule:reminder', firedEvent);
      }
    }
  }

  private startSafetyTick(): void {
    this.safetyTick = setInterval(() => {
      if (!this.disposed && this.queue.length > 0) {
        this.processDue();
      }
    }, 60000);
  }

  private startResumeListener(): void {
    this.resumeHandler = () => {
      if (!this.disposed) {
        // Catch up on missed reminders
        this.rebuild();
      }
    };
    powerMonitor.on('resume', this.resumeHandler);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.safetyTick) {
      clearInterval(this.safetyTick);
      this.safetyTick = null;
    }
    if (this.resumeHandler) {
      powerMonitor.removeListener('resume', this.resumeHandler);
      this.resumeHandler = null;
    }
    this.queue = [];
  }
}