/**
 * 群务台（notice-hub）配置校验、归一化与状态载荷净化（纯函数，无窗口/进程副作用）。
 * Notice Hub config validation, normalization and status payload sanitizing (pure functions).
 *
 * 契约来源：docs/notice-hub-插件化与日程适配方案.md §4.3 / §4.4 / §7（已冻结）。
 * 字段名与取值以 shared/noticeHub.ts 为准；错误文案一律中文、可操作，且不回显任何令牌内容。
 *
 * Contract source: docs/notice-hub-插件化与日程适配方案.md §4.3 / §4.4 / §7 (frozen).
 * Field names follow shared/noticeHub.ts; errors are Chinese, actionable and never echo tokens.
 */
import { parsePluginServiceUrl } from '../websearch/webFetchClient.ts';
import {
  DEFAULT_NOTICE_HUB_CONFIG,
  NOTICE_HUB_SYNC_INTERVAL_MAX,
  NOTICE_HUB_SYNC_INTERVAL_MIN,
  createInitialNoticeHubStatus,
} from '../../shared/noticeHub.ts';
import type { NoticeHubConfig, NoticeHubStatus } from '../../shared/noticeHub.ts';

/** 访问令牌最大长度（超长视为误输入，拒绝保存而非静默截断）。Token max length; overlong input is rejected. */
export const NOTICE_HUB_TOKEN_MAX_LENGTH = 512;
/** 日程分类名称最大长度（与设置面板校验一致）。Category name max length (matches the settings panel). */
export const NOTICE_HUB_CATEGORY_NAME_MAX_LENGTH = 30;
/** 单个提醒提前量上限（分钟，30 天，与设置面板一致）。Single reminder offset cap in minutes (30 days). */
export const NOTICE_HUB_REMINDER_OFFSET_MAX_MINUTES = 43200;
/** 提醒提前量个数上限（与设置面板一致）。Reminder offset count cap (matches the settings panel). */
export const NOTICE_HUB_REMINDER_OFFSET_MAX_COUNT = 8;
/** 状态错误文案上限（防超长载荷进入界面与推送）。Status error text cap for pushed payloads. */
export const NOTICE_HUB_STATUS_ERROR_MAX_LENGTH = 500;

type ConfigField = keyof NoticeHubConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 布尔字段强转保护：布尔直通，0/1 与常见文本布尔可转，其余拒绝。Boolean coercion guard. */
function coerceBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off', ''].includes(text)) return false;
  }
  throw new Error(`${label}只能是布尔值（true / false）。`);
}

/**
 * baseUrl 校验：复用 parsePluginServiceUrl（公共 https + 环回 http，契约 §4.2），
 * 并拒绝携带账号信息/查询串/片段的地址，防止令牌被拼进 URL 落盘或进日志。
 * baseUrl validation per contract §4.2; credentials/query/fragment are refused so the token
 * can never ride along inside the URL.
 */
function coerceBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('群务台服务地址需为文本。');
  const trimmed = value.trim();
  if (!trimmed) throw new Error('请填写群务台服务地址，例如 http://127.0.0.1:8766。');
  try {
    parsePluginServiceUrl(trimmed);
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : '地址不合法。';
    throw new Error(`群务台服务地址无效：${reason}仅支持 https 公网地址或环回 http，例如 http://127.0.0.1:8766。`);
  }
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error('群务台服务地址无效：URL 格式错误。'); }
  if (parsed.username || parsed.password) throw new Error('群务台服务地址不允许内嵌账号或密码，请改用「访问令牌」。');
  if (parsed.search || parsed.hash) throw new Error('群务台服务地址不允许携带查询参数或片段，请把令牌填入「访问令牌」。');
  return trimmed;
}

/** 令牌字段：类型与长度保护；裁掉首尾空白（令牌本身不含空白）。Token field type/length guard. */
function coerceToken(value: unknown): string {
  if (typeof value !== 'string') throw new Error('访问令牌需为文本。');
  const trimmed = value.trim();
  if (trimmed.length > NOTICE_HUB_TOKEN_MAX_LENGTH) throw new Error(`访问令牌过长（最多 ${NOTICE_HUB_TOKEN_MAX_LENGTH} 个字符）。`);
  return trimmed;
}

function coerceCategoryName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('日程分类名称需为文本。');
  const trimmed = value.trim();
  if (!trimmed) throw new Error('请填写日程分类名称，例如「群务台」。');
  if (trimmed.length > NOTICE_HUB_CATEGORY_NAME_MAX_LENGTH) throw new Error(`日程分类名称最多 ${NOTICE_HUB_CATEGORY_NAME_MAX_LENGTH} 个字符。`);
  return trimmed;
}

/** 同步间隔：有限数字，四舍五入后夹取 5–240（契约 §4.3）。Interval: finite number, rounded, clamped 5–240. */
function coerceSyncInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('同步间隔需为数字（分钟）。');
  return Math.min(NOTICE_HUB_SYNC_INTERVAL_MAX, Math.max(NOTICE_HUB_SYNC_INTERVAL_MIN, Math.round(value)));
}

/**
 * 提醒提前量：过滤 NaN/±Infinity/非数字，钳制到 0–43200，取整、去重、最多 8 个。
 * Reminder offsets: drop non-finite entries, clamp to 0–43200, round, dedupe, cap at 8.
 */
function coerceReminderOffsets(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('提醒提前量需为数字数组（分钟），例如 [1440, 0]。');
  const seen = new Set<number>();
  const offsets: number[] = [];
  for (const item of value) {
    // 过滤：非数字与 NaN/±Infinity 一律丢弃（契约要求）。
    if (typeof item !== 'number' || !Number.isFinite(item)) continue;
    const minutes = Math.round(Math.min(NOTICE_HUB_REMINDER_OFFSET_MAX_MINUTES, Math.max(0, item)));
    if (seen.has(minutes)) continue;
    seen.add(minutes);
    offsets.push(minutes);
    if (offsets.length >= NOTICE_HUB_REMINDER_OFFSET_MAX_COUNT) break;
  }
  return offsets;
}

/** 单字段归一化表：非法输入抛出中文可操作错误。Per-field coercers; invalid input throws Chinese errors. */
const coercers: { [K in ConfigField]: (value: unknown) => NoticeHubConfig[K] } = {
  enabled: (value) => coerceBoolean(value, '「启用」开关'),
  baseUrl: coerceBaseUrl,
  token: coerceToken,
  syncIntervalMinutes: coerceSyncInterval,
  includeTodos: (value) => coerceBoolean(value, '「同步待办」开关'),
  includeNotices: (value) => coerceBoolean(value, '「同步公告」开关'),
  pruneMissing: (value) => coerceBoolean(value, '「清理远端已消失条目」开关'),
  categoryName: coerceCategoryName,
  reminderOffsetsMinutes: coerceReminderOffsets,
};

/**
 * 把 set-config 补丁合并进基础配置并逐字段校验；未知字段忽略，未提供（null/undefined）保持原值。
 * 任一字段非法即抛错，且在校验完成前不产生任何副作用。
 *
 * Merges a set-config patch into the base config with per-field validation. Unknown keys are
 * ignored, null/undefined means "not provided"; any invalid field throws before side effects.
 *
 * @param base - Current configuration / 当前配置
 * @param raw - Untrusted patch payload / 不可信补丁载荷
 * @returns Validated merged configuration / 校验通过的合并结果
 */
export function applyNoticeHubConfigPatch(base: NoticeHubConfig, raw: unknown): NoticeHubConfig {
  if (!isRecord(raw)) throw new Error('配置内容无效：应为包含配置字段的对象。');
  const next: NoticeHubConfig = { ...base, reminderOffsetsMinutes: [...base.reminderOffsetsMinutes] };
  for (const key of Object.keys(next) as ConfigField[]) {
    if (!(key in coercers)) continue;
    const value = raw[key];
    if (value === undefined || value === null) continue;
    (next as unknown as Record<string, unknown>)[key] = coercers[key](value);
  }
  return next;
}

/**
 * 磁盘配置读取合并：与 DEFAULT_NOTICE_HUB_CONFIG 合并；单字段损坏时回退默认值，不整体报废配置文件。
 * Stored config merge with defaults; one corrupt field falls back to its default instead of failing the file.
 *
 * @param raw - Parsed JSON from userData/notice-hub.json / 磁盘解析结果
 * @returns Safe merged configuration / 安全的合并配置
 */
export function sanitizeNoticeHubConfig(raw: unknown): NoticeHubConfig {
  const next: NoticeHubConfig = { ...DEFAULT_NOTICE_HUB_CONFIG, reminderOffsetsMinutes: [...DEFAULT_NOTICE_HUB_CONFIG.reminderOffsetsMinutes] };
  if (!isRecord(raw)) return next;
  for (const key of Object.keys(coercers) as ConfigField[]) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    try { (next as unknown as Record<string, unknown>)[key] = coercers[key](value); } catch { /* 该字段回退默认值 */ }
  }
  return next;
}

const NOTICE_HUB_STATES: readonly NoticeHubStatus['state'][] = ['disabled', 'idle', 'syncing', 'ok', 'error'];

function sanitizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function sanitizeTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * 插件状态载荷净化：只保留契约 §4.3 的字段并逐项做类型保护，
 * 丢弃一切多余字段——即使插件误带凭据也不会被转发到渲染进程。
 *
 * Sanitizes the plugin status payload: keeps only contract §4.3 fields with per-field type
 * guards and drops everything else, so a stray credential can never reach the renderer.
 *
 * @param raw - Untrusted payload from plugin:notice-hub:status / 插件上报的不可信载荷
 * @param fallback - Previous cached status used for invalid enum values / 枚举非法时的回退值
 * @returns Safe NoticeHubStatus / 安全状态
 */
export function sanitizeNoticeHubStatus(raw: unknown, fallback: NoticeHubStatus): NoticeHubStatus {
  const base = fallback ?? createInitialNoticeHubStatus(DEFAULT_NOTICE_HUB_CONFIG.enabled);
  if (!isRecord(raw)) return { ...base, counts: { ...base.counts } };
  const state: NoticeHubStatus['state'] = typeof raw.state === 'string' && (NOTICE_HUB_STATES as readonly string[]).includes(raw.state)
    ? raw.state as NoticeHubStatus['state']
    : base.state;
  const counts = isRecord(raw.counts)
    ? { todos: sanitizeCount(raw.counts.todos), notices: sanitizeCount(raw.counts.notices), skipped: sanitizeCount(raw.counts.skipped) }
    : { ...base.counts };
  return {
    state,
    lastSyncAt: sanitizeTimestamp(raw.lastSyncAt),
    lastSuccessAt: sanitizeTimestamp(raw.lastSuccessAt),
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, NOTICE_HUB_STATUS_ERROR_MAX_LENGTH) || null : null,
    counts,
    serviceReachable: typeof raw.serviceReachable === 'boolean' ? raw.serviceReachable : null,
    nextSyncAt: sanitizeTimestamp(raw.nextSyncAt),
  };
}

/**
 * 日志安全摘要：令牌只显示「已设置/空」，绝不输出内容（契约 §7）。
 * Log-safe summary: the token is only shown as set/empty, never its content (contract §7).
 *
 * @param config - Configuration to summarize / 待摘要配置
 * @returns One-line summary without secrets / 不含机密的单行摘要
 */
export function noticeHubConfigLogSummary(config: NoticeHubConfig): string {
  return `enabled=${config.enabled} baseUrl=${config.baseUrl} token=${config.token ? '<已设置>' : '<空>'}`
    + ` interval=${config.syncIntervalMinutes}m includeTodos=${config.includeTodos} includeNotices=${config.includeNotices}`
    + ` pruneMissing=${config.pruneMissing} category=${config.categoryName} offsets=[${config.reminderOffsetsMinutes.join(', ')}]`;
}
