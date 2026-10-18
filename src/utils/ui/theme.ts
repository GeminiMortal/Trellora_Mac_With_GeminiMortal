/**
 * Theme and color-scheme resolution and DOM application helpers.
 * 主题与配色方案的解析及 DOM 应用辅助函数。
 */
import type { AppPreferences } from '../../electron';
import { getColorSchemeTokens, normalizeLightColorScheme, type LightColorScheme } from '../../../shared/lightColorSchemes.ts';

/**
 * Final light/dark appearance after resolving the user preference.
 * 解析用户偏好后的最终明暗外观。
 */
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key for the cached theme mode. / 缓存主题模式的 localStorage 键。 */
export const THEME_MODE_STORAGE_KEY = 'trellora-theme-mode';
/** localStorage key for the cached light color scheme. / 缓存浅色配色方案的 localStorage 键。 */
export const LIGHT_COLOR_SCHEME_STORAGE_KEY = 'trellora-light-color-scheme';

/**
 * Reads the cached theme mode from localStorage, ignoring invalid values.
 * 从 localStorage 读取缓存的主题模式，忽略无效值。
 */
function getStoredThemeMode(): AppPreferences['theme'] | null {
  try {
    const value = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return value === 'system' || value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Mirrors the theme mode to localStorage so index.html can pick a canvas before React is ready.
 * 将主题模式镜像到 localStorage，供 index.html 在 React 就绪前选择画布。
 */
function cacheThemeMode(theme: AppPreferences['theme']): void {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, theme);
  } catch {
    // Electron Store remains the source of truth; this mirror only lets index.html choose a canvas before React and IPC are ready. / Electron Store 仍是唯一真实来源；该镜像仅供 index.html 在 React 与 IPC 就绪前选择画布。
  }
}

/**
 * Reads the effective light color scheme from the document or localStorage.
 * 从文档或 localStorage 读取当前生效的浅色配色方案。
 *
 * @returns Normalized light color scheme / 归一化后的浅色配色方案
 */
export function getDocumentLightColorScheme(): LightColorScheme {
  const scheme = document.documentElement.dataset.lightColorScheme;
  if (scheme) return normalizeLightColorScheme(scheme);
  try { return normalizeLightColorScheme(window.localStorage.getItem(LIGHT_COLOR_SCHEME_STORAGE_KEY)); }
  catch { return 'green'; }
}

/**
 * Replaces the full token set on each switch to avoid colors lingering across appearances or schemes.
 * 每次切换完整替换色板，避免浅深外观或不同配色之间残留颜色。
 *
 * @param theme - Target resolved theme / 目标明暗主题
 * @param value - Light color scheme to apply / 要应用的浅色配色方案
 * @returns Nothing / 无返回值
 */
export function applyColorScheme(theme: ResolvedTheme, value: LightColorScheme): void {
  const root = document.documentElement;
  const scheme = normalizeLightColorScheme(value);
  for (const [key, color] of Object.entries(getColorSchemeTokens(theme, scheme))) {
    root.style.setProperty(key, color);
  }
  root.dataset.lightColorScheme = scheme;
}

/**
 * Resolves a user theme preference to light or dark, following the OS when set to system.
 * 将用户主题偏好解析为明暗值，设为 system 时跟随操作系统。
 *
 * @param theme - Stored theme preference / 已保存的主题偏好
 * @returns Resolved theme / 解析后的主题
 */
export function resolveTheme(theme: AppPreferences['theme']): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Reads the theme currently applied to the document, falling back to the stored preference.
 * 读取文档当前应用的主题，缺失时回退到已存偏好。
 *
 * @returns Resolved theme / 解析后的主题
 */
export function getDocumentTheme(): ResolvedTheme {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark'
    ? theme
    : resolveTheme(getStoredThemeMode() ?? 'system');
}

/**
 * Applies density and light-scheme preferences and caches them for early startup.
 * 应用密度与浅色配色偏好，并缓存供启动早期使用。
 *
 * @param preferences - App preferences to apply / 要应用的应用偏好
 * @returns The resolved theme / 解析后的主题
 */
export function applyAppearance(preferences: AppPreferences): ResolvedTheme {
  const resolvedTheme = resolveTheme(preferences.theme);
  const root = document.documentElement;
  root.dataset.density = preferences.density;
  cacheThemeMode(preferences.theme);
  try { window.localStorage.setItem(LIGHT_COLOR_SCHEME_STORAGE_KEY, normalizeLightColorScheme(preferences.lightColorScheme)); }
  catch { /* If the startup cache is unwritable, Electron Store still persists the scheme. / 启动缓存不可写时，仍由 Electron Store 保存配色。 */ }
  return resolvedTheme;
}
