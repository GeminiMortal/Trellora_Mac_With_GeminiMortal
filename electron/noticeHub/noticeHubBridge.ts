/**
 * 群务台（notice-hub）宿主桥接：配置持久化 + 状态缓存 + 事件总线桥。
 * Notice Hub host bridge: config persistence + status cache + event bus bridging.
 *
 * 契约来源：docs/notice-hub-插件化与日程适配方案.md §3 / §4.3 / §4.4 / §7（已冻结）。
 * - 配置持久化 userData/notice-hub.json（原子写入，读取与 DEFAULT_NOTICE_HUB_CONFIG 合并）。
 * - 状态缓存 NoticeHubStatus；插件 plugin:notice-hub:status → 缓存 → notice-hub:status-changed 推送。
 * - host:notice-hub:config：set-config 后发；插件激活完成后补发一次（幂等）。
 * - host:notice-hub:sync-now：立即同步请求，载荷固定 null。
 * - 访问令牌绝不写日志、状态载荷或错误消息（契约 §7）。
 *
 * Contract source: docs/notice-hub-插件化与日程适配方案.md §3 / §4.3 / §4.4 / §7 (frozen).
 * The access token never reaches logs, status payloads or error messages.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicTextWrite } from '../atomicTextWrite.ts';
import {
  applyNoticeHubConfigPatch,
  noticeHubConfigLogSummary,
  sanitizeNoticeHubConfig,
  sanitizeNoticeHubStatus,
} from './noticeHubConfig.ts';
import {
  DEFAULT_NOTICE_HUB_CONFIG,
  NOTICE_HUB_EVENT_CONFIG,
  NOTICE_HUB_EVENT_STATUS,
  NOTICE_HUB_EVENT_SYNC_NOW,
  createInitialNoticeHubStatus,
} from '../../shared/noticeHub.ts';
import type { PluginHost } from '../plugins/pluginHost.ts';
import type { NoticeHubConfig, NoticeHubStatus } from '../../shared/noticeHub.ts';

/** notice-hub 插件 ID（契约 §6 plugin.json）。Plugin id per contract §6. */
export const NOTICE_HUB_PLUGIN_ID = 'com.expertkt.notice-hub';

/** 配置持久化文件名（契约 §4.3）。Config file name per contract §4.3. */
export const NOTICE_HUB_CONFIG_FILE_NAME = 'notice-hub.json';

/**
 * 令牌落盘保护：seal 把明文令牌转成可落盘形态，open 还原。
 * 由 main.ts 注入 safeStorage 实现；缺省恒等实现（空令牌场景/测试）。
 * Token-at-rest protection injected from main.ts (safeStorage backed); identity by default.
 */
export interface NoticeHubTokenVault {
  seal: (plain: string) => string;
  open: (stored: string) => string;
}

export interface NoticeHubBridgeOptions {
  userDataPath: string;
  /** 惰性取得插件宿主（事件总线宿主侧）。Lazy plugin host accessor. */
  getPluginHost: () => PluginHost;
  /** 向所有窗口推送状态变更。Broadcasts status changes to every window. */
  broadcastStatus: (status: NoticeHubStatus) => void;
  tokenVault?: NoticeHubTokenVault;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** 深拷贝配置，避免调用方改写缓存。Clones config so callers cannot mutate the cache. */
function cloneConfig(config: NoticeHubConfig): NoticeHubConfig {
  return { ...config, reminderOffsetsMinutes: [...config.reminderOffsetsMinutes] };
}

/** 深拷贝状态。Clones status. */
function cloneStatus(status: NoticeHubStatus): NoticeHubStatus {
  return { ...status, counts: { ...status.counts } };
}

export class NoticeHubBridge {
  private readonly options: NoticeHubBridgeOptions;
  private readonly configFile: string;
  private readonly tokenVault: NoticeHubTokenVault;
  private config: NoticeHubConfig = cloneConfig(DEFAULT_NOTICE_HUB_CONFIG);
  private status: NoticeHubStatus = createInitialNoticeHubStatus(DEFAULT_NOTICE_HUB_CONFIG.enabled);
  private ready: Promise<void>;
  private host: PluginHost | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private configPushed = false;
  private firstStatusSeen = false;

  constructor(options: NoticeHubBridgeOptions) {
    this.options = options;
    this.configFile = path.join(options.userDataPath, NOTICE_HUB_CONFIG_FILE_NAME);
    this.tokenVault = options.tokenVault ?? { seal: (plain) => plain, open: (stored) => stored };
    this.ready = this.load();
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.options.onLog?.(level, message);
  }

  /**
   * 载入 userData/notice-hub.json：损坏或缺失时回退默认配置（不抛错、不写日志令牌）。
   * Loads the config file; corrupt/missing files fall back to defaults without secrets in logs.
   */
  private async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.configFile, 'utf8')) as unknown;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') this.log('warn', `[NOTICE-HUB] 配置文件读取失败（${code}），已回退默认配置。`);
      raw = undefined;
    }
    this.config = sanitizeNoticeHubConfig(raw);
    // 令牌解密失败时回退为空令牌（用户可重新填写），绝不把密文或明文写日志。
    // A failed token decrypt falls back to an empty token; neither ciphertext nor plaintext is logged.
    const rawToken = (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).token === 'string')
      ? (raw as Record<string, unknown>).token as string
      : '';
    if (rawToken) {
      try {
        this.config = { ...this.config, token: this.tokenVault.open(rawToken) };
      } catch {
        this.log('warn', '[NOTICE-HUB] 访问令牌解密失败，已重置为空令牌，请在设置中重新填写。');
        this.config = { ...this.config, token: '' };
      }
    }
    this.status = createInitialNoticeHubStatus(this.config.enabled);
    this.log('info', `[NOTICE-HUB] 配置已载入：${noticeHubConfigLogSummary(this.config)}`);
  }

  /**
   * 绑定插件宿主事件总线：订阅 plugin:notice-hub:status（幂等，可换绑）。
   * 绑定时不主动下发配置——插件尚未激活订阅，此刻 emit 会丢；配置由
   * 激活完成通知 / 首次插件状态 / 首次 get-config / set-config 这四个时机保证送达。
   * Subscribes to plugin status events; idempotent and re-bindable. No eager config push
   * here (the plugin has not subscribed yet); the four documented triggers guarantee delivery.
   */
  attachPluginHost(host: PluginHost): void {
    if (this.unsubscribeStatus) {
      this.unsubscribeStatus();
      this.unsubscribeStatus = null;
    }
    this.host = host;
    this.unsubscribeStatus = host.subscribe(NOTICE_HUB_EVENT_STATUS, (payload) => { this.handlePluginStatus(payload); });
  }

  /** 插件激活完成后补发一次配置（契约 §4.4：激活完成后立即发一次）。Push config once after plugin activation. */
  notifyPluginActivated(pluginId: string): void {
    if (pluginId !== NOTICE_HUB_PLUGIN_ID) return;
    this.configPushed = false;
    void this.ensureConfigPushed();
  }

  /** 幂等补发配置：首次 get-config / 首次插件状态 / 激活完成后各触发一次。Idempotent config push. */
  private async ensureConfigPushed(): Promise<void> {
    if (this.configPushed) return;
    await this.ready;
    const host = this.host;
    if (!host) return; // 宿主未绑定时保持未推送，绑定后由触发器补发。
    this.configPushed = true;
    host.emit(NOTICE_HUB_EVENT_CONFIG, cloneConfig(this.config));
    this.log('info', `[NOTICE-HUB] 配置已下发插件（${NOTICE_HUB_EVENT_CONFIG}）。`);
  }

  /** 插件状态 → 缓存净化 → 全窗口推送。Plugin status → sanitized cache → broadcast. */
  private handlePluginStatus(payload: unknown): void {
    if (!this.firstStatusSeen) {
      this.firstStatusSeen = true;
      void this.ensureConfigPushed();
    }
    const next = sanitizeNoticeHubStatus(payload, this.status);
    // 未启用时状态恒为 disabled（与配置一致，契约 §4.3 state）。
    this.status = this.config.enabled ? next : { ...next, state: 'disabled', nextSyncAt: null };
    this.broadcast();
  }

  private broadcast(): void {
    try {
      this.options.broadcastStatus(cloneStatus(this.status));
    } catch (error) {
      this.log('warn', `[NOTICE-HUB] 状态推送失败：${(error as Error).message}`);
    }
  }

  /** 读取配置（set-config/get-config 形状见契约 §4.3）。Reads config per contract §4.3. */
  async getConfig(): Promise<NoticeHubConfig> {
    await this.ready;
    void this.ensureConfigPushed();
    return cloneConfig(this.config);
  }

  /**
   * 写入配置补丁：先校验（失败抛中文可操作错误、无副作用），再原子持久化，成功后下发插件并按需推送状态。
   * Validates first (Chinese actionable errors, no side effects), persists atomically, then
   * emits host:notice-hub:config and pushes status on enabled transitions.
   *
   * @param patch - Partial config payload / 配置补丁
   * @returns The persisted configuration / 持久化后的完整配置
   */
  async setConfig(patch: unknown): Promise<NoticeHubConfig> {
    await this.ready;
    const next = applyNoticeHubConfigPatch(this.config, patch); // 校验失败在此抛出，未写盘。
    const serialized = JSON.stringify({ ...next, token: this.tokenVault.seal(next.token) }, null, 2);
    await atomicTextWrite(this.configFile, `${serialized}\n`, async () => undefined);

    const previous = this.config;
    this.config = cloneConfig(next);
    this.log('info', `[NOTICE-HUB] 配置已保存：${noticeHubConfigLogSummary(this.config)}`);

    // set-config 成功后下发插件（契约 §4.4）。
    this.configPushed = true;
    this.host?.emit(NOTICE_HUB_EVENT_CONFIG, cloneConfig(this.config));

    // enabled 切换同步状态缓存（disabled ↔ idle），并推送界面。
    let changed = false;
    if (previous.enabled !== next.enabled) {
      if (!next.enabled) {
        this.status = { ...this.status, state: 'disabled', nextSyncAt: null };
      } else if (this.status.state === 'disabled') {
        this.status = { ...this.status, state: 'idle' };
      }
      changed = true;
    }
    if (changed) this.broadcast();
    return cloneConfig(this.config);
  }

  /** 读取状态缓存（契约 §4.3）。Reads the cached status per contract §4.3. */
  async getStatus(): Promise<NoticeHubStatus> {
    await this.ready;
    return cloneStatus(this.status);
  }

  /**
   * 立即同步：经总线发 host:notice-hub:sync-now（载荷固定 null），返回 { ok: true }。
   * Requests an immediate sync via the bus with a null payload; returns { ok: true }.
   */
  async syncNow(): Promise<{ ok: true }> {
    await this.ready;
    await this.ensureConfigPushed();
    const host = this.host ?? this.options.getPluginHost();
    this.host ??= host;
    host.emit(NOTICE_HUB_EVENT_SYNC_NOW, null);
    return { ok: true };
  }
}
