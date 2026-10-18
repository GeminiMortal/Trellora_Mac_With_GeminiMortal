/**
 * Shared types for release update checks between the main process and the renderer.
 * 主进程与渲染进程之间发布更新检查的共享类型定义。
 */

/**
 * Result of a release update check against the published release feed.
 * 对已发布版本源进行更新检查的结果。
 */
export interface ReleaseCheckResult {
  /** Overall check outcome: up to date, newer release found, or check failed. / 检查结论：当前已是最新、发现新版本，或检查失败。 */
  state: 'current' | 'available' | 'unavailable';
  /** Version currently running. / 当前运行的版本号。 */
  currentVersion: string;
  /** Latest version found, when available. / 发现的最新版本号（如果可用）。 */
  latestVersion?: string;
  /** URL of the release page for the user to open. / 供用户打开的发布页面链接。 */
  releaseUrl?: string;
  /** ISO timestamp of when the check ran. / 本次检查执行时的 ISO 时间戳。 */
  checkedAt: string;
  /** Stable error code when the check failed. / 检查失败时的稳定错误码。 */
  code?: 'NO_RELEASE' | 'RATE_LIMITED' | 'TIMEOUT' | 'INVALID_RELEASE' | 'NETWORK_ERROR';
  /** Whether this result came from a cached previous check. / 本次结果是否来自先前检查的缓存。 */
  cached?: boolean;
}
