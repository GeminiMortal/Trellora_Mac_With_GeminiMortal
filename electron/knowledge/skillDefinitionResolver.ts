/**
 * Skill definition resolution: catalogs available skills and resolves selected definitions.
 * 技能定义解析：编目可用技能并解析已选定义。
 */

import type { AiSkill } from './aiTypes';

/** A skill catalog entry for discovery. / 用于发现的技能目录条目。 */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
}

/** A selected skill with its full instruction text. / 含完整指令文本的已选技能。 */
export interface SelectedSkillDefinition extends SkillCatalogEntry {
  instruction: string;
}

/** Resolved skill definitions split into catalog and selected sets. / 解析后的技能定义，分为目录集和已选集。 */
export interface ResolvedSkillDefinitions {
  catalog: SkillCatalogEntry[];
  selected: SelectedSkillDefinition[];
}

/**
 * Derive a bounded description from a skill's instruction text.
 * 从技能指令文本中推导出有长度限制的描述。
 *
 * @param name - Skill name / 技能名称
 * @param instruction - Raw instruction text / 原始指令文本
 * @returns Bounded description string / 有长度限制的描述字符串
 */
export function deriveSkillDescription(name: string, instruction: string): string {
  const normalized = instruction.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
  if (!normalized) return `${name.trim() || 'AI Skill'} 的工作方式与适用边界。`;
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}…`;
}

/**
 * Resolve available skills into catalog and selected definitions.
 * 将可用技能解析为目录和已选定义。
 *
 * @param availableSkills - All configured skills / 所有已配置的技能
 * @param selectedSkillIds - IDs of skills to activate / 待激活的技能 ID 列表
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
