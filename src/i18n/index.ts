/**
 * Runtime i18n helpers: language state, translation lookup, and React subscription hooks.
 * 运行时国际化辅助：语言状态、翻译查询与 React 订阅 Hook。
 */
import { useSyncExternalStore } from 'react';
import { normalizeAppLanguage, type AppLanguage } from '../../shared/appLanguage.ts';
import { english } from './en.ts';

type TranslationValues = Record<string, string | number | null | undefined>;
let language: AppLanguage = 'zh-CN';
const listeners = new Set<() => void>();

/**
 * Drives the app language from loaded preferences without storing a duplicate or remounting the editor.
 * 由已加载的应用偏好驱动语言；不另存一份偏好，也不重新挂载编辑器。
 *
 * @param value - Raw language preference value / 原始语言偏好值
 * @returns Nothing; updates language state and notifies subscribers / 无返回值；更新语言状态并通知订阅者
 */
export function setAppLanguage(value: unknown): void {
  const next = normalizeAppLanguage(value);
  document.documentElement.lang = next;
  if (next === language) return;
  language = next;
  listeners.forEach(listener => listener());
}

/**
 * Translates application UI copy only; unknown text is returned unchanged to preserve diagnostics and user content.
 * 仅翻译应用文案；未知文本原样返回，保留服务端诊断和用户内容。
 *
 * @param source - Source string to translate / 要翻译的源字符串
 * @param values - Optional values for {name} placeholders / 用于 {name} 占位符的可选替换值
 * @returns The translated message / 翻译后的文案
 */
export function t(source: string, values?: TranslationValues): string {
  const message = language === 'en-US' && Object.hasOwn(english, source) ? english[source] : source;
  // Interpolate {name} placeholders; leave unknown tokens unchanged / 替换 {name} 占位符，未知占位符原样保留
  return values ? message.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key] ?? '') : match) : message;
}

/**
 * Returns the current app language.
 * 返回当前应用语言。
 *
 * @returns The active language code / 当前语言代码
 */
export const getAppLanguage = (): AppLanguage => language;

/**
 * Localizes only option display labels, preserving protocol values and extra fields.
 * 只映射选项的显示名称，保留协议值和附加字段。
 *
 * @param options - Options whose labels will be translated / 需要翻译 label 的选项列表
 * @returns New options with localized labels / label 已本地化的新选项
 */
export function localizeOptions<T extends { label: string }>(options: readonly T[]): T[] {
  return options.map(option => ({ ...option, label: t(option.label) }));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * Subscribes to language changes so cached pages, dialogs, and helper components update immediately.
 * 订阅语言变化，让缓存页面、弹窗和辅助组件也即时更新。
 *
 * @returns An object with the current language and the t translation function / 包含当前语言与 t 翻译函数的对象
 */
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, () => language);
  return { language: locale, t };
}
