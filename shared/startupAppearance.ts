/**
 * Startup appearance snapshot passed via the command line so the first frame paints with correct theme and language.
 * 通过命令行传递的启动外观快照，使首帧以正确的主题与语言绘制。
 */

import { normalizeAppLanguage, type AppLanguage } from './appLanguage';
import { normalizeLightColorScheme, type LightColorScheme } from './lightColorSchemes';

/**
 * Command-line argument prefix carrying the startup appearance JSON payload.
 * 携带启动外观 JSON 负载的命令行参数前缀。
 */
export const STARTUP_APPEARANCE_ARGUMENT = '--trellora-startup-appearance=';

/**
 * Appearance metadata received by the first frame; the first frame receives only appearance metadata and never paths, model configuration, or credentials.
 * 首帧接收的外观元数据；首帧只接收外观元数据，不携带路径、模型配置或凭据。
 */
export interface StartupAppearance {
  /** Resolved theme for the first frame. / 首帧使用的已解析主题。 */
  theme: 'light' | 'dark';
  /** User theme preference mode. / 用户主题偏好模式。 */
  themeMode: 'system' | 'light' | 'dark';
  /** Light theme color scheme. / 亮色主题配色方案。 */
  lightColorScheme: LightColorScheme;
  /** UI language. / 界面语言。 */
  language: AppLanguage;
}

/**
 * Parse the startup snapshot provided by the main process; on missing or corrupt data the existing cache continues to be used.
 * 解析主进程提供的启动快照；缺失或损坏时继续使用已有缓存。
 *
 * @param args - Process command-line arguments / 进程命令行参数
 * @returns Parsed appearance snapshot, or null when absent or invalid / 解析出的外观快照；缺失或无效时返回 null
 */
export function readStartupAppearance(args: readonly string[]): StartupAppearance | null {
  const argument = args.find(value => value.startsWith(STARTUP_APPEARANCE_ARGUMENT));
  if (!argument) return null;
  try {
    const value = JSON.parse(decodeURIComponent(argument.slice(STARTUP_APPEARANCE_ARGUMENT.length)));
    // The theme is required and must be one of the two concrete themes.
    // 主题字段必填，且必须是两个具体主题之一。
    if (!value || (value.theme !== 'light' && value.theme !== 'dark')) return null;
    return {
      theme: value.theme,
      themeMode: ['system', 'light', 'dark'].includes(value.themeMode) ? value.themeMode : 'system',
      lightColorScheme: normalizeLightColorScheme(value.lightColorScheme),
      language: normalizeAppLanguage(value.language),
    };
  } catch { return null; }
}
