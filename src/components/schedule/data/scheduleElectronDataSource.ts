/**
 * Schedule data source — wraps window.electronAPI schedule methods.
 * 日程数据源 — 封装 window.electronAPI 的日程方法。
 */
import type {
  ScheduleRangeQuery,
  ScheduleOccurrence,
  ScheduleCreateRequest,
  ScheduleItem,
  ScheduleUpdateRequest,
  ScheduleDeleteRequest,
  ScheduleOccurrenceOverrideRequest,
  TodoStatus,
  ScheduleCategory,
  CourseTimeSettings,
  ScheduleChangedEvent,
  ScheduleReminderFiredEvent,
  ScheduleImportPreviewResult,
  ScheduleImportCommitRequest,
  ScheduleImportCommitResult,
} from '../../../../shared/schedule.ts';

export interface ScheduleDataSource {
  listOccurrences(query: ScheduleRangeQuery): Promise<ScheduleOccurrence[]>;
  createItem(req: ScheduleCreateRequest): Promise<ScheduleItem>;
  updateItem(req: ScheduleUpdateRequest): Promise<ScheduleItem>;
  deleteItem(req: ScheduleDeleteRequest): Promise<void>;
  updateOccurrence(req: ScheduleOccurrenceOverrideRequest): Promise<void>;
  setTodoStatus(id: string, status: TodoStatus): Promise<ScheduleItem>;
  listCategories(): Promise<ScheduleCategory[]>;
  upsertCategory(name: string, color: string): Promise<ScheduleCategory>;
  deleteCategory(name: string): Promise<void>;
  getCourseTimes(): Promise<CourseTimeSettings>;
  setCourseTimes(settings: CourseTimeSettings): Promise<void>;
  onChanged(callback: (event: ScheduleChangedEvent) => void): () => void;
  onReminder(callback: (event: ScheduleReminderFiredEvent) => void): () => void;
  onReminderClicked(callback: (event: { itemId: string }) => void): () => void;
  importPickFile(kind: 'csv' | 'excel' | 'image'): Promise<string | null>;
  importPreviewCsv(filePath: string): Promise<ScheduleImportPreviewResult>;
  importPreviewExcel(filePath: string): Promise<ScheduleImportPreviewResult>;
  importCommit(req: ScheduleImportCommitRequest): Promise<ScheduleImportCommitResult>;
  importPreviewUrl(url: string): Promise<ScheduleImportPreviewResult>;
  importPreviewImage(filePath: string): Promise<ScheduleImportPreviewResult>;
  importOpenBrowser(url: string): Promise<ScheduleImportPreviewResult>;
}

export function createElectronScheduleDataSource(): ScheduleDataSource {
  const api = window.electronAPI;
  return {
    listOccurrences: (query) => api.listScheduleOccurrences(query),
    createItem: (req) => api.createScheduleItem(req),
    updateItem: (req) => api.updateScheduleItem(req),
    deleteItem: (req) => api.deleteScheduleItem(req),
    updateOccurrence: (req) => api.updateScheduleOccurrence(req),
    setTodoStatus: (id, status) => api.setScheduleTodoStatus(id, status),
    listCategories: () => api.listScheduleCategories(),
    upsertCategory: (name, color) => api.upsertScheduleCategory(name, color),
    deleteCategory: (name) => api.deleteScheduleCategory(name),
    getCourseTimes: () => api.getScheduleCourseTimes(),
    setCourseTimes: (settings) => api.setScheduleCourseTimes(settings),
    onChanged: (cb) => api.onScheduleChanged(cb),
    onReminder: (cb) => api.onScheduleReminder(cb),
    onReminderClicked: (cb) => api.onScheduleReminderClicked(cb),
    importPickFile: (kind) => api.scheduleImportPickFile(kind),
    importPreviewCsv: (filePath) => api.scheduleImportPreviewCsv(filePath),
    importPreviewExcel: (filePath) => api.scheduleImportPreviewExcel(filePath),
    importCommit: (req) => api.scheduleImportCommit(req),
    importPreviewUrl: (url) => api.scheduleImportPreviewUrl(url),
    importPreviewImage: (filePath) => api.scheduleImportPreviewImage(filePath),
    importOpenBrowser: (url) => api.scheduleImportOpenBrowser(url),
  };
}