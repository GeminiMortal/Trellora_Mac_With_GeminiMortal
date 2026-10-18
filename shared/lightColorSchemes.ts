/**
 * Light and dark color scheme definitions, brand color scales, and CSS custom-property tokens.
 * 浅色与深色配色方案定义、品牌色阶与 CSS 自定义属性 token。
 */

/**
 * Identifiers of the available light color schemes.
 * 可用浅色配色方案的标识列表。
 */
export const LIGHT_COLOR_SCHEME_IDS = ['green', 'blue', 'orange', 'gray', 'pink'] as const;

/**
 * Union of available light color scheme identifiers.
 * 可用浅色配色方案标识的联合类型。
 */
export type LightColorScheme = typeof LIGHT_COLOR_SCHEME_IDS[number];

/**
 * Ten-step brand color scale used by Mantine components.
 * Mantine 组件使用的十级品牌色阶。
 */
export type BrandColorScale = [string, string, string, string, string, string, string, string, string, string];

/**
 * Base color definition shared by light and dark schemes.
 * 浅色与深色方案共用的基础颜色定义。
 */
interface LightColorSchemeDefinition {
  /** Scheme identifier. / 方案标识。 */
  id: LightColorScheme;
  /** Display label. / 显示标签。 */
  label: string;
  /** Primary accent color. / 主强调色。 */
  accent: string;
  /** Page canvas background. / 页面画布背景色。 */
  canvas: string;
  /** Panel background color. / 面板背景色。 */
  panel: string;
  /** Hover state background. / 悬停状态背景色。 */
  hover: string;
  /** Selected state background. / 选中状态背景色。 */
  selected: string;
  /** Subtle border color. / 细边框颜色。 */
  border: string;
  /** Strong border color. / 强边框颜色。 */
  borderStrong: string;
  /** Primary text color. / 主文本颜色。 */
  text: string;
  /** Secondary text color. / 次级文本颜色。 */
  secondary: string;
  /** Tertiary text color. / 三级文本颜色。 */
  tertiary: string;
  /** Focus ring color. / 焦点环颜色。 */
  focus: string;
}

/**
 * Single source of truth for color schemes; legacy config field names are kept and the data is shared by the main process, CSS, and Mantine.
 * 配色的唯一数据源；保留旧配置字段名，主进程、CSS 与 Mantine 共用。
 */
export const LIGHT_COLOR_SCHEMES: readonly LightColorSchemeDefinition[] = [
  { id: 'green', label: '森林绿', accent: '#26745B', canvas: '#F5F8F6', panel: '#EDF3EF', hover: '#E5EFE8', selected: '#E3F0E8', border: '#D8E3DC', borderStrong: '#B9CDBF', text: '#24352C', secondary: '#55675C', tertiary: '#627367', focus: '#3E8C6F' },
  { id: 'blue', label: '雾蓝', accent: '#3268A8', canvas: '#F5F8FC', panel: '#EDF2F9', hover: '#E7EEF8', selected: '#E3EDF9', border: '#D9E3EF', borderStrong: '#B8CBE1', text: '#283649', secondary: '#586A81', tertiary: '#647287', focus: '#487BB5' },
  { id: 'orange', label: '暖橙', accent: '#B35C27', canvas: '#FCF8F3', panel: '#F7F0E7', hover: '#F7EBDD', selected: '#F9E6D7', border: '#EADDCF', borderStrong: '#DCC2AA', text: '#433429', secondary: '#786555', tertiary: '#7C695B', focus: '#B35C27' },
  { id: 'gray', label: '石墨灰', accent: '#5B6573', canvas: '#F7F8FA', panel: '#EEF0F3', hover: '#E9ECF1', selected: '#E6EAF0', border: '#DADEE5', borderStrong: '#BBC3CE', text: '#303742', secondary: '#5B6573', tertiary: '#69727F', focus: '#707C8D' },
  { id: 'pink', label: '玫瑰粉', accent: '#B34F78', canvas: '#FCF7F9', panel: '#F6EEF2', hover: '#F5E7EF', selected: '#F5E2EB', border: '#E9D9E1', borderStrong: '#D8B7C7', text: '#442F39', secondary: '#79606D', tertiary: '#806874', focus: '#B34F78' },
];

/**
 * Extended color definition adding raised surface and solid fill colors for dark themes.
 * 扩展颜色定义，为深色主题增加抬升表面色与实心填充色。
 */
interface ColorSchemeDefinition extends LightColorSchemeDefinition {
  /** Raised surface background above the panel. / 高于面板的抬升表面背景色。 */
  raised: string;
  /** Solid fill color for filled controls. / 实心控件的填充色。 */
  fill: string;
}

/**
 * Dark color schemes; dark backplates stay low-saturation and text color is separated from solid fill to balance readability and white-on-fill buttons.
 * 深色配色方案；深色底板保持低饱和，文字主色与实心填充色分开，兼顾阅读和白字按钮。
 */
export const DARK_COLOR_SCHEMES: readonly ColorSchemeDefinition[] = [
  { id: 'green', label: '森林绿', accent: '#83C8A5', fill: '#337C60', canvas: '#17201B', panel: '#1E2A23', raised: '#25342B', hover: '#2D3F33', selected: '#304D3C', border: '#364B3D', borderStrong: '#4F6B58', text: '#E8F0EA', secondary: '#B2C5B8', tertiary: '#95A99C', focus: '#96D7B7' },
  { id: 'blue', label: '雾蓝', accent: '#93B8E8', fill: '#3E70AD', canvas: '#181F2A', panel: '#202B3A', raised: '#293649', hover: '#304158', selected: '#2D4563', border: '#35465E', borderStrong: '#506B8D', text: '#E8EEF7', secondary: '#B6C4D9', tertiary: '#97AAC4', focus: '#B0CCF1' },
  { id: 'orange', label: '暖橙', accent: '#E5AE7E', fill: '#965829', canvas: '#241C18', panel: '#30251E', raised: '#3B2E24', hover: '#48362A', selected: '#543B28', border: '#513D2E', borderStrong: '#77583D', text: '#F3EAE1', secondary: '#D0BAA7', tertiary: '#B59980', focus: '#F0C49E' },
  { id: 'gray', label: '石墨灰', accent: '#B6C0D0', fill: '#5D6A7E', canvas: '#1C1F24', panel: '#252A32', raised: '#303640', hover: '#3B4350', selected: '#414D60', border: '#3D4551', borderStrong: '#5B687D', text: '#EBEEF3', secondary: '#BAC3D0', tertiary: '#9AA7BA', focus: '#D0D9E6' },
  { id: 'pink', label: '玫瑰粉', accent: '#DEA0BB', fill: '#A34F75', canvas: '#251B22', panel: '#32242D', raised: '#3E2D39', hover: '#4B3443', selected: '#57374A', border: '#523848', borderStrong: '#7C526A', text: '#F5E7EF', secondary: '#D2B4C4', tertiary: '#B991A5', focus: '#EDBDD2' },
];

/**
 * Normalize a scheme value to a known id; missing or unknown legacy values fall back to green without changing the user's light/dark choice.
 * 将配色值规范化为已知 id；缺失或未知的旧配置回到森林绿，不改变用户的浅色/深色选择。
 *
 * @param value - Raw scheme value from config / 来自配置的原始配色值
 * @returns Valid light color scheme id / 合法的浅色配色方案 id
 */
export function normalizeLightColorScheme(value: unknown): LightColorScheme {
  return LIGHT_COLOR_SCHEME_IDS.includes(value as LightColorScheme) ? value as LightColorScheme : 'green';
}

/**
 * Look up the light scheme definition for a value.
 * 查找某个值对应的浅色方案定义。
 *
 * @param value - Scheme value to resolve / 要解析的配色值
 * @returns Matching light scheme definition / 匹配的浅色方案定义
 */
export function getLightColorScheme(value: unknown): LightColorSchemeDefinition {
  return LIGHT_COLOR_SCHEMES.find(scheme => scheme.id === normalizeLightColorScheme(value))!;
}

/**
 * Look up the full scheme definition for a theme; light schemes are extended with white raised surfaces and accent fills.
 * 查找某个主题的完整方案定义；浅色方案扩展出白色抬升表面与强调填充色。
 *
 * @param theme - Light or dark theme / 浅色或深色主题
 * @param value - Scheme value to resolve / 要解析的配色值
 * @returns Matching color scheme definition / 匹配的颜色方案定义
 */
export function getColorScheme(theme: 'light' | 'dark', value: unknown): ColorSchemeDefinition {
  if (theme === 'dark') return DARK_COLOR_SCHEMES.find(scheme => scheme.id === normalizeLightColorScheme(value))!;
  const scheme = getLightColorScheme(value);
  return { ...scheme, raised: '#ffffff', fill: scheme.accent };
}

/**
 * Linearly mix a hex color toward a target hex color by the given amount.
 * 按给定比例将十六进制颜色向目标颜色线性混合。
 *
 * @param color - Source hex color / 源十六进制颜色
 * @param target - Target hex color / 目标十六进制颜色
 * @param amount - Mix ratio from 0 to 1 / 混合比例（0 到 1）
 * @returns Mixed hex color / 混合后的十六进制颜色
 */
function mixHex(color: string, target: string, amount: number): string {
  const channel = (index: number) => Math.round(parseInt(color.slice(index, index + 2), 16) * (1 - amount) + parseInt(target.slice(index, index + 2), 16) * amount).toString(16).padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * Build the ten-step light brand color scale; scale index 6 always equals the accent so Mantine light primary buttons match native controls.
 * 构建十级浅色品牌色阶；色阶索引 6 始终等于主色，让 Mantine 的浅色主按钮与原生控件一致。
 *
 * @param value - Scheme value to resolve / 要解析的配色值
 * @returns Ten-step brand color scale / 十级品牌色阶
 */
export function getLightBrandColors(value: unknown): BrandColorScale {
  const scheme = getLightColorScheme(value);
  // Green uses hand-tuned stops; other schemes derive steps by mixing toward white and black.
  // 绿色使用手工调校的色标；其他方案通过向白/黑混合推导色阶。
  if (scheme.id === 'green') return ['#f1f8f4', '#e3f0e8', '#c6e0d2', '#9cc7b0', '#72ac90', '#4a9272', '#26745b', '#1f604a', '#194d3c', '#133d30'];
  return [mixHex(scheme.accent, '#ffffff', .96), scheme.selected, ...[.72, .54, .38, .18].map(amount => mixHex(scheme.accent, '#ffffff', amount)), scheme.accent, ...[.16, .30, .43].map(amount => mixHex(scheme.accent, '#000000', amount))] as BrandColorScale;
}

/**
 * Build the ten-step brand color scale for a theme; in dark mode the accent sits at index 4 while index 6 keeps the deep fill needed for solid controls.
 * 构建某主题的十级品牌色阶；深色主色位于索引 4，索引 6 保持实心控件所需的深填充色。
 *
 * @param theme - Light or dark theme / 浅色或深色主题
 * @param value - Scheme value to resolve / 要解析的配色值
 * @returns Ten-step brand color scale / 十级品牌色阶
 */
export function getBrandColors(theme: 'light' | 'dark', value: unknown): BrandColorScale {
  if (theme === 'light') return getLightBrandColors(value);
  const scheme = getColorScheme(theme, value);
  return [
    ...[.9, .75, .55, .3].map(amount => mixHex(scheme.accent, '#ffffff', amount)),
    scheme.accent,
    mixHex(scheme.accent, scheme.fill, .5),
    scheme.fill,
    ...[.16, .3, .43].map(amount => mixHex(scheme.fill, '#000000', amount)),
  ] as BrandColorScale;
}

/**
 * Build CSS custom-property tokens overriding UI colors for the current appearance; AI, vendor marks, syntax categories, and task states keep their semantic colors.
 * 为当前外观构建覆盖界面颜色的 CSS 自定义属性 token；AI、厂商标识、语法类别和任务状态保留语义色。
 *
 * @param theme - Light or dark theme / 浅色或深色主题
 * @param value - Scheme value to resolve / 要解析的配色值
 * @returns Map of CSS custom-property names to values / CSS 自定义属性名到值的映射
 */
export function getColorSchemeTokens(theme: 'light' | 'dark', value: unknown): Record<string, string> {
  const scheme = getColorScheme(theme, value);
  const dark = theme === 'dark';
  return {
    '--surface-canvas': scheme.canvas,
    '--surface-panel': scheme.panel,
    '--surface-raised': scheme.raised,
    '--surface-hover': scheme.hover,
    '--surface-selected': scheme.selected,
    '--border-subtle': scheme.border,
    '--border-strong': scheme.borderStrong,
    '--text-primary': scheme.text,
    '--text-secondary': scheme.secondary,
    '--text-tertiary': scheme.tertiary,
    '--accent-primary': scheme.accent,
    '--accent-fill': scheme.fill,
    '--accent-focus': scheme.focus,
    '--accent-blue': 'var(--accent-primary)',
    // Green keeps hand-tuned quote/code/graph tints; other schemes derive them from the palette.
    // 绿色保留手工调校的引用/代码/图谱色调；其他方案从调色板推导。
    '--quote-bg': dark ? (scheme.id === 'green' ? '#263a2e' : scheme.raised) : (scheme.id === 'green' ? '#f0f6f2' : mixHex(scheme.panel, '#ffffff', .22)),
    '--quote-border': !dark && scheme.id === 'green' ? '#b9d4c4' : scheme.borderStrong,
    '--quote-text': scheme.secondary,
    '--code-bg': dark ? (scheme.id === 'green' ? '#1e2c24' : scheme.panel) : (scheme.id === 'green' ? '#f1f5f3' : mixHex(scheme.panel, '#ffffff', .28)),
    '--code-border': scheme.border,
    '--code-text': scheme.text,
    '--code-comment': scheme.tertiary,
    '--document-paper-background': dark ? scheme.raised : '#ffffff',
    '--document-paper-ink': scheme.text,
    '--document-paper-border': dark ? scheme.borderStrong : scheme.border,
    '--graph-edge': dark ? (scheme.id === 'green' ? '#819c8a' : mixHex(scheme.accent, scheme.canvas, .35)) : (scheme.id === 'green' ? '#8ea498' : mixHex(scheme.accent, '#ffffff', .45)),
  };
}

/**
 * Build CSS custom-property tokens for the light theme.
 * 构建浅色主题的 CSS 自定义属性 token。
 *
 * @param value - Scheme value to resolve / 要解析的配色值
 * @returns Map of CSS custom-property names to values / CSS 自定义属性名到值的映射
 */
export function getLightColorSchemeTokens(value: unknown): Record<string, string> {
  return getColorSchemeTokens('light', value);
}
