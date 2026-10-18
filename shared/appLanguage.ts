/**
 * Application language codes and normalization helpers shared across processes.
 * 跨进程共享的应用语言代码与规范化辅助函数。
 */

/**
 * Language codes the application supports.
 * 应用支持的语言代码列表。
 */
export const APP_LANGUAGES = ['zh-CN', 'en-US'] as const;

/**
 * Union of supported application language codes.
 * 受支持的应用语言代码联合类型。
 */
export type AppLanguage = typeof APP_LANGUAGES[number];

/**
 * Normalize an unknown language value to a supported code, falling back to Simplified Chinese.
 * 将未知的语言值规范化为受支持的语言代码，无法识别时回退到简体中文。
 *
 * @param value - Raw language value from config or input / 来自配置或输入的原始语言值
 * @returns A supported application language / 受支持的应用语言
 */
// 旧配置与不支持的语言统一回退到简体中文。
export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}
