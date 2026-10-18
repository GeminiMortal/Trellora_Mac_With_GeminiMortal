/**
 * 日程功能共享类型定义
 * Schedule feature shared type definitions.
 *
 * 时间约定：wall-clock 用 YYYY-MM-DDTHH:mm:ss（无时区），全天/截止日期用 YYYY-MM-DD。
 * Timestamp convention: wall-clock times use naive local YYYY-MM-DDTHH:mm:ss;
 * all-day / due dates use plain YYYY-MM-DD.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export type ScheduleItemKind = 'event' | 'todo' | 'course';
export type ScheduleItemStatus = 'confirmed' | 'tentative' | 'cancelled';
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
export type ReminderDelivery = 'system' | 'in_app' | 'both';
export type ScheduleImportSourceType = 'csv' | 'excel' | 'image' | 'url' | 'manual';

// ── Structured JSON types ────────────────────────────────────────────────────

export interface RecurrenceRule {
  frequency: 'none' | 'daily' | 'weekly' | 'monthly' | 'weekly_pattern';
  interval: number;                    // every N days/weeks/months (>=1)
  byWeekday: number[];                 // 0=Sun..6=Sat (weekly)
  byMonthDay: number[];                // 1..31 (monthly)
  weekParity: 'all' | 'odd' | 'even';  // 单双周
  anchorStart: string;                 // YYYY-MM-DD week-1 anchor
  endsOn: string | null;               // YYYY-MM-DD or null (open)
  excludedDates: string[];             // YYYY-MM-DD
}

export interface CourseMeta {
  courseName: string;
  teacher: string | null;
  classroom: string | null;
  dayOfWeek: number;                   // 0=Sun..6=Sat
  startPeriod: number;                 // 节次
  endPeriod: number;
  startTime: string | null;            // "08:00" override
  endTime: string | null;
  termId: string | null;               // schedule_terms.id
}

// ── Entity types ─────────────────────────────────────────────────────────────

export interface ScheduleReminder {
  id: string;
  itemId: string;
  offsetMinutes: number;
  delivery: ReminderDelivery;
  enabled: boolean;
}

export interface ScheduleItem {
  id: string;
  kind: ScheduleItemKind;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string | null;              // YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD
  endAt: string | null;
  allDay: boolean;
  status: ScheduleItemStatus;
  todoStatus: TodoStatus | null;       // only for kind='todo'
  dueAt: string | null;                // only for kind='todo'
  priority: 'low' | 'normal' | 'high' | 'urgent' | null;
  completedAt: string | null;
  libraryPath: string | null;          // null = global
  libraryName: string | null;          // display snapshot
  notePath: string | null;             // optional linked note
  category: string | null;
  tags: string[];
  color: string | null;                // hex override
  recurrence: RecurrenceRule | null;
  course: CourseMeta | null;
  reminders: ScheduleReminder[];
  importBatchId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Rendered occurrence (recurrence expanded, overrides applied). */
export interface ScheduleOccurrence {
  occurrenceKey: string;               // `${itemId}|${originalStart}`
  originalStart: string;
  item: ScheduleItem;                  // with occurrence-level overrides applied
  startAt: string;
  endAt: string;
  isOverride: boolean;
}

// ── Query types ──────────────────────────────────────────────────────────────

export interface ScheduleRangeQuery {
  from: string;                        // ISO, inclusive
  to: string;                          // ISO, exclusive
  kinds?: ScheduleItemKind[];
  libraryPath?: string | null;         // undefined=all, null=global only
  categories?: string[];
  tags?: string[];
  search?: string;
  includeCompletedTodos?: boolean;
}

// ── CRUD request/response ────────────────────────────────────────────────────

export interface ScheduleCreateRequest {
  kind: ScheduleItemKind;
  title: string;
  description?: string | null;
  location?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  allDay?: boolean;
  status?: ScheduleItemStatus;
  todoStatus?: TodoStatus | null;
  dueAt?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | null;
  libraryPath?: string | null;
  libraryName?: string | null;
  notePath?: string | null;
  category?: string | null;
  tags?: string[];
  color?: string | null;
  recurrence?: RecurrenceRule | null;
  course?: CourseMeta | null;
  reminders?: Array<{ offsetMinutes: number; delivery: ReminderDelivery; enabled?: boolean }>;
}

export interface ScheduleUpdateRequest {
  id: string;
  patch: Partial<ScheduleCreateRequest>;
}

export interface ScheduleDeleteRequest {
  id: string;
  scope: 'series' | 'occurrence';
  occurrenceStart?: string;            // required when scope='occurrence'
}

export interface ScheduleOccurrenceOverrideRequest {
  itemId: string;
  occurrenceStart: string;
  patch: {
    title?: string;
    description?: string | null;
    location?: string | null;
    startAt?: string | null;
    endAt?: string | null;
    cancelled?: boolean;
  };
}

// ── Categories ───────────────────────────────────────────────────────────────

export interface ScheduleCategory {
  name: string;
  color: string;
  sortOrder: number;
}

// ── Import types ─────────────────────────────────────────────────────────────

export interface ScheduleImportDraft {
  row: number;
  title: string;
  kind: ScheduleItemKind;
  description: string | null;
  location: string | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  course: CourseMeta | null;
  recurrence: RecurrenceRule | null;
  tags: string[];
  category: string | null;
  todoStatus: TodoStatus | null;
  dueAt: string | null;
  valid: boolean;
  issues: string[];
}

export type ScheduleImportPreviewResult =
  | {
      status: 'ok';
      draft: ScheduleImportDraft[];
      warnings: string[];
      columnMapping?: Record<string, string>;
      encoding?: string;
    }
  | {
      status: 'failed';
      code: 'FILE_UNREADABLE' | 'PARSE_EMPTY' | 'UNSUPPORTED_FORMAT'
        | 'AI_MODEL_UNAVAILABLE' | 'AI_OUTPUT_INVALID' | 'NETWORK_BLOCKED';
      message: string;
    };

export interface ScheduleImportCommitRequest {
  drafts: ScheduleImportDraft[];
  sourceType: ScheduleImportSourceType;
  sourceLabel: string;
  libraryPath?: string | null;
}

export interface ScheduleImportCommitResult {
  batchId: string;
  createdCount: number;
  skippedCount: number;
}

export interface ScheduleImportBatch {
  id: string;
  sourceType: ScheduleImportSourceType;
  sourceLabel: string;
  summaryJson: string;
  itemCount: number;
  status: 'committed' | 'reverted';
  createdAt: string;
}

// ── Course times ─────────────────────────────────────────────────────────────

export interface CourseTimeSlot {
  period: number;
  startTime: string;                   // "08:00"
  endTime: string;                     // "08:45"
}

export type CourseTimeSettings = CourseTimeSlot[];

// ── Events (push from main → renderer) ──────────────────────────────────────

export interface ScheduleChangedEvent {
  reason: 'item' | 'import' | 'settings' | 'category';
  ids?: string[];
}

export interface ScheduleReminderFiredEvent {
  reminderId: string;
  itemId: string;
  occurrenceKey: string;
  title: string;
  startAt: string;
  location: string | null;
  delivery: ReminderDelivery;
  firedAt: string;
  missedByMs: number;
}