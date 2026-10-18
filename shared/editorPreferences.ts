/**
 * Editor preference shape, defaults, zoom bounds, and normalization for persisted settings.
 * 编辑器偏好的结构、默认值、缩放边界及持久化设置的规范化。
 */

/**
 * User-configurable editor preferences.
 * 用户可配置的编辑器偏好。
 */
export interface EditorPreferences {
  /** Editor font size in pixels. / 编辑器字号（像素）。 */
  editorFontSizePx: number;
  /** Editor line height multiplier. / 编辑器行高倍数。 */
  editorLineHeight: number;
  /** Paragraph spacing in pixels. / 段落间距（像素）。 */
  editorParagraphSpacingPx: number;
  /** Content column width preset. / 内容列宽预设。 */
  editorContentWidth: 'narrow' | 'standard' | 'wide' | 'full';
  /** Default zoom applied to the editor. / 编辑器默认缩放。 */
  defaultEditorZoom: number;
  /** How pasted content is inserted. / 粘贴内容的插入方式。 */
  editorPasteMode: 'preserve-format' | 'plain-text';
  /** Whether typed Markdown syntax auto-converts. / 输入的 Markdown 语法是否自动转换。 */
  editorMarkdownAutoConvert: boolean;
  /** Whether the selection toolbar is enabled. / 是否启用选区工具栏。 */
  editorSelectionToolbarEnabled: boolean;
  /** Whether focus mode is enabled. / 是否启用专注模式。 */
  editorFocusModeEnabled: boolean;
  /** Whether typewriter mode is enabled. / 是否启用打字机模式。 */
  editorTypewriterModeEnabled: boolean;
}

/**
 * Minimum editor zoom factor. / 编辑器最小缩放倍数。
 */
export const EDITOR_ZOOM_MIN = 0.75;

/**
 * Maximum editor zoom factor. / 编辑器最大缩放倍数。
 */
export const EDITOR_ZOOM_MAX = 1.5;

/**
 * Zoom increment applied per step. / 每次缩放调整的步进值。
 */
export const EDITOR_ZOOM_STEP = 0.05;

/**
 * Default editor preferences used for new workspaces and normalization fallbacks.
 * 新工作区及规范化回退使用的默认编辑器偏好。
 */
export const defaultEditorPreferences: EditorPreferences = {
  editorFontSizePx: 16, editorLineHeight: 1.7, editorParagraphSpacingPx: 12,
  editorContentWidth: 'standard', defaultEditorZoom: 1, editorPasteMode: 'preserve-format',
  editorMarkdownAutoConvert: true, editorSelectionToolbarEnabled: true,
  editorFocusModeEnabled: false, editorTypewriterModeEnabled: false,
};

/**
 * Valid preference keys, derived from the defaults object.
 * 有效偏好键列表，从默认值对象推导。
 */
export const editorPreferenceKeys = Object.keys(defaultEditorPreferences) as Array<keyof EditorPreferences>;

/**
 * Pixel widths for each content column preset; 0 means full width.
 * 各内容列宽预设的像素宽度；0 表示全宽。
 */
export const editorContentWidths = { narrow: 720, standard: 900, wide: 1120, full: 0 } as const;

/**
 * Normalize unknown persisted values into a complete, safe EditorPreferences object.
 * 将未知的持久化值规范化为完整、安全的 EditorPreferences 对象。
 *
 * @param value - Raw persisted preferences object / 原始持久化偏好对象
 * @returns Normalized preferences with clamped numbers and validated enums / 数字已钳制、枚举已校验的规范化偏好
 */
// Only finite numbers and explicit boolean/enum values enter persisted editor settings.
// 只有有限数值和显式布尔/枚举值才会进入持久化的编辑器设置。
export function normalizeEditorPreferences(value: unknown): EditorPreferences {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  // Snap numeric values to [min, max] and quantize to the given step.
  // 将数值钳制到 [min, max] 并按给定步进量化。
  const number = (key: keyof EditorPreferences, min: number, max: number, step: number) => {
    const n = v[key];
    return typeof n === 'number' && Number.isFinite(n)
      ? Number((min + Math.round((Math.max(min, Math.min(max, n)) - min) / step) * step).toFixed(2))
      : defaultEditorPreferences[key] as number;
  };
  const boolean = (key: keyof EditorPreferences) => typeof v[key] === 'boolean' ? v[key] as boolean : defaultEditorPreferences[key] as boolean;
  return {
    editorFontSizePx: number('editorFontSizePx', 12, 24, 1),
    editorLineHeight: number('editorLineHeight', 1.2, 2.4, 0.1),
    editorParagraphSpacingPx: number('editorParagraphSpacingPx', 0, 32, 1),
    editorContentWidth: typeof v.editorContentWidth === 'string' && ['narrow', 'standard', 'wide', 'full'].includes(v.editorContentWidth) ? v.editorContentWidth as EditorPreferences['editorContentWidth'] : 'standard',
    defaultEditorZoom: number('defaultEditorZoom', EDITOR_ZOOM_MIN, EDITOR_ZOOM_MAX, EDITOR_ZOOM_STEP),
    editorPasteMode: v.editorPasteMode === 'plain-text' ? 'plain-text' : 'preserve-format',
    editorMarkdownAutoConvert: boolean('editorMarkdownAutoConvert'),
    editorSelectionToolbarEnabled: boolean('editorSelectionToolbarEnabled'),
    editorFocusModeEnabled: boolean('editorFocusModeEnabled'),
    editorTypewriterModeEnabled: boolean('editorTypewriterModeEnabled'),
  };
}
