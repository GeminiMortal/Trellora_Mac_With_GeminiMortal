/**
 * Skill definition resolution: maps available AI skills to catalog entries
 * and resolves selected skill IDs into full definitions for prompt injection.
 * 技能定义解析：将可用 AI 技能映射为目录条目，把选中的技能 ID 解析为完整定义以注入 prompt。
 */

import type { AiSkill } from '../ai/aiTypes.ts';

/**
 * A lightweight skill entry for the catalog dropdown / selection UI.
 * 轻量级技能条目，用于目录下拉菜单与选择界面。
 */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
}

/**
 * A catalog entry enriched with the full instruction text for prompt injection.
 * 目录条目扩展，包含用于注入 prompt 的完整指令文本。
 */
export interface SelectedSkillDefinition extends SkillCatalogEntry {
  instruction: string;
}

/**
 * Result of resolving available skills into catalog and selected subsets.
 * 解析可用技能后的目录与已选子集结果。
 */
export interface ResolvedSkillDefinitions {
  catalog: SkillCatalogEntry[];
  selected: SelectedSkillDefinition[];
}

/**
 * Derive a bounded discovery description from a skill's instruction text.
 * 从技能指令文本中提取有长度限制的发现描述。
 *
 * @param name - Skill name / 技能名称
 * @param instruction - Full skill instruction / 完整技能指令
 * @returns Bounded description string (≤120 chars) / 有长度限制的描述字符串（≤120 字符）
 */
export function deriveSkillDescription(name: string, instruction: string): string {
  const normalized = instruction.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
  if (!normalized) return `${name.trim() || 'AI Skill'} 的工作方式与适用边界。`;
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}…`;
}

/**
 * Resolve available skills into a catalog and the user-selected subset.
 * Rejects more than 3 selections and missing/disabled skill IDs.
 * 将可用技能解析为目录和用户已选子集。超过 3 个选择或技能不存在/已停用时抛出错误。
 *
 * @param availableSkills - All registered AI skills / 所有已注册的 AI 技能
 * @param selectedSkillIds - User-selected skill IDs / 用户选中的技能 ID 列表
 * @returns Resolved catalog and selected definitions / 解析后的目录与已选定义
 */
export function resolveSkillDefinitions(
  availableSkills: readonly AiSkill[],
  selectedSkillIds: readonly string[] = [],
): ResolvedSkillDefinitions {
  const enabled = availableSkills.filter((skill) => skill.enabled);
  const byId = new Map(enabled.map((skill) => [skill.id, skill]));
  const selectedIds = [...new Set(selectedSkillIds)];
  if (selectedIds.length > 3) throw new Error('每次最多选择 3 个 AI 助手 Skill。');
  const selected = selectedIds.map((id): SelectedSkillDefinition => {
    const skill = byId.get(id);
    if (!skill) throw new Error('所选 AI 助手技能不存在或已停用。');
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description || deriveSkillDescription(skill.name, skill.instruction),
      instruction: skill.instruction,
    };
  });
  return {
    catalog: enabled.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description || deriveSkillDescription(skill.name, skill.instruction),
    })),
    selected,
  };
}
