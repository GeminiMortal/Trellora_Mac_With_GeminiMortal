/**
 * Icon and color presets for materials-library folders.
 * 资料库文件夹的图标与配色预设。
 */
import {
  Archive,
  BookOpen,
  Briefcase,
  FileText,
  Folder,
  GraduationCap,
  Library,
  Lightbulb,
  type LucideIcon,
} from 'lucide-react';

/**
 * One selectable icon preset for a materials folder. / 资料文件夹可选的单个图标预设。 */
export interface MaterialsIconOption {
  /** Stable preset id / 稳定的预设 id */
  id: string;
  /** Display label / 展示名称 */
  label: string;
  /** Theme color token / 主题色 token */
  color: string;
  /** Lucide icon component / Lucide 图标组件 */
  Icon: LucideIcon;
}

/** Fallback icon id used when a folder has no preset. / 文件夹未设置预设时使用的默认图标 id。 */
export const DEFAULT_MATERIALS_ICON_ID = 'file';

/** All icon presets offered in the folder picker. / 文件夹选择器提供的全部图标预设。 */
export const MATERIALS_ICON_OPTIONS: MaterialsIconOption[] = [
  { id: 'file', label: '文档', color: 'gray', Icon: FileText },
  { id: 'book', label: '书籍', color: 'violet', Icon: BookOpen },
  { id: 'archive', label: '档案', color: 'teal', Icon: Archive },
  { id: 'folder', label: '文件夹', color: 'orange', Icon: Folder },
  { id: 'library', label: '书库', color: 'pink', Icon: Library },
  { id: 'study', label: '学习', color: 'yellow', Icon: GraduationCap },
  { id: 'work', label: '工作', color: 'gray', Icon: Briefcase },
  { id: 'idea', label: '灵感', color: 'yellow', Icon: Lightbulb },
];

/**
 * Resolves an icon preset by id, falling back to the first preset.
 * 按 id 解析图标预设；未命中时回退到第一个预设。
 *
 * @param iconId - Stored icon id, or null/undefined / 存储的图标 id；可为 null/undefined
 * @returns Matching preset, or the default preset / 匹配的预设；否则为默认预设
 */
export function getMaterialsIconOption(iconId: string | null | undefined): MaterialsIconOption {
  return MATERIALS_ICON_OPTIONS.find((option) => option.id === iconId)
    ?? MATERIALS_ICON_OPTIONS[0];
}
