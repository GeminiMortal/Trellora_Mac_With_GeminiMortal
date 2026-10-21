/**
 * 群务台（notice-hub）插件配置与状态共享类型。
 * Notice Hub plugin configuration and status shared types.
 *
 * 契约来源：docs/notice-hub-插件化与日程适配方案.md §4.3（已冻结）。
 * 字段名与取值不得偏离契约；如需变更先改契约文档再改代码。
 *
 * Contract source: docs/notice-hub-插件化与日程适配方案.md §4.3 (frozen).
 * Field names and values must not drift from the contract.
 */

/**
 * 群务台同步配置（持久化在 userData/notice-hub.json）。
 * Notice Hub sync configuration (persisted at userData/notice-hub.json).
 */
export interface NoticeHubConfig {
  enabled: boolean;                    // 默认 false：装完先配置再启用
  baseUrl: string;                     // 默认 "http://127.0.0.1:8766"（仅环回/https）
  token: string;                       // QQ_DIGEST_WEB_TOKEN；可空（空 token 仅环回可用）
  syncIntervalMinutes: number;         // 5–240，默认 15
  includeTodos: boolean;               // 默认 true
  includeNotices: boolean;             // 默认 false（公告进日历易打扰，默认关）
  pruneMissing: boolean;               // 默认 false（远端消失的条目不自动清理）
  categoryName: string;                // 默认 "群务台"
  reminderOffsetsMinutes: number[];    // 默认 [1440, 0]（提前 1 天 + 到点）
}

/**
 * 群务台同步状态（插件 → 宿主 → 渲染进程缓存）。
 * Notice Hub sync status (plugin → host → renderer cache).
 */
export interface NoticeHubStatus {
  state: 'disabled' | 'idle' | 'syncing' | 'ok' | 'error';
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;            // 面向用户的中文可操作错误
  counts: { todos: number; notices: number; skipped: number };
  serviceReachable: boolean | null;
  nextSyncAt: string | null;
}

/** 配置补丁（set-config 通道载荷）。Configuration patch (set-config channel payload). */
export type NoticeHubConfigPatch = Partial<NoticeHubConfig>;

/** 同步间隔（分钟）允许范围，契约 §4.3。Sync interval bounds per contract §4.3. */
export const NOTICE_HUB_SYNC_INTERVAL_MIN = 5;
export const NOTICE_HUB_SYNC_INTERVAL_MAX = 240;

/** 默认配置，契约 §4.3。Default configuration per contract §4.3. */
export const DEFAULT_NOTICE_HUB_CONFIG: NoticeHubConfig = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:8766',
  token: '',
  syncIntervalMinutes: 15,
  includeTodos: true,
  includeNotices: false,
  pruneMissing: false,
  categoryName: '群务台',
  reminderOffsetsMinutes: [1440, 0],
};

/** 初始状态：未启用时为 disabled。Initial status: disabled until configured. */
export function createInitialNoticeHubStatus(enabled: boolean): NoticeHubStatus {
  return {
    state: enabled ? 'idle' : 'disabled',
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    counts: { todos: 0, notices: 0, skipped: 0 },
    serviceReachable: null,
    nextSyncAt: null,
  };
}

// ── 事件总线与 IPC 通道名（契约 §4.3/§4.4，冻结） ────────────────────────────
// Event bus and IPC channel names (contract §4.3/§4.4, frozen).

/** host → plugin：下发配置（插件激活完成后发一次，set-config 后再发）。 */
export const NOTICE_HUB_EVENT_CONFIG = 'host:notice-hub:config';
/** host → plugin：请求立即同步。 */
export const NOTICE_HUB_EVENT_SYNC_NOW = 'host:notice-hub:sync-now';
/** plugin → host：上报同步状态。 */
export const NOTICE_HUB_EVENT_STATUS = 'plugin:notice-hub:status';

/** IPC：读取配置。 */
export const NOTICE_HUB_CHANNEL_GET_CONFIG = 'notice-hub:get-config';
/** IPC：写入配置（Partial 合并校验后持久化）。 */
export const NOTICE_HUB_CHANNEL_SET_CONFIG = 'notice-hub:set-config';
/** IPC：读取状态缓存。 */
export const NOTICE_HUB_CHANNEL_GET_STATUS = 'notice-hub:get-status';
/** IPC：立即同步（经事件总线请求插件）。 */
export const NOTICE_HUB_CHANNEL_SYNC_NOW = 'notice-hub:sync-now';
/** IPC（主 → 渲）：状态变更推送。 */
export const NOTICE_HUB_CHANNEL_STATUS_CHANGED = 'notice-hub:status-changed';
