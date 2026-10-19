/**
 * Bundled skill definitions and workspace synchronization.
 * 内置技能定义与工作区同步。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Map of bundled skill directory names to their display names. / 内置技能目录名到显示名的映射。 */
export const bundledSkillNames: Readonly<Record<string, string>> = {
  'builtin-knowledge': 'builtin-knowledge',
  'builtin-learning': 'builtin-learning',
  'builtin-organize': 'builtin-organize',
  'builtin-edit': 'builtin-edit',
  'generate-experiment-report': '实验报告生成',
  'generate-study-doc': '学习文档生成',
};

/**
 * Ensure all bundled skills exist in the workspace, copying missing ones atomically.
 * 只补齐缺失的内置技能；保留用户编辑、模板和启停登记。
 *
 * @param workspacePath - Root path of the workspace / 工作区根路径
 * @param bundleRoot - Path to the bundled skill source directory / 内置技能源目录路径
 */
export function ensureBundledSkills(workspacePath: string, bundleRoot: string): void {
  const root = path.join(path.resolve(workspacePath), 'AI-Skill');
  fs.mkdirSync(root, { recursive: true });
  for (const directory of Object.keys(bundledSkillNames)) {
    const destination = path.join(root, directory);
    if (fs.existsSync(destination)) continue;
    const source = path.join(bundleRoot, directory);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`内置技能"${bundledSkillNames[directory]}"缺失，请重新安装应用。`);
    const temporary = path.join(root, `.builtin-${randomUUID()}`);
    try {
      fs.cpSync(source, temporary, { recursive: true, dereference: false });
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

/**
 * Check whether a skill path belongs to a bundled skill.
 * 来源标签只匹配应用发布的目录及技能名。
 *
 * @param basePath - Skill directory path / 技能目录路径
 * @param name - Skill display name / 技能显示名
 * @returns True if the path/name pair matches a bundled skill / 若路径/名称对匹配内置技能则返回 true
 */
export function isBundledSkill(basePath: string, name: string): boolean {
  return bundledSkillNames[path.basename(basePath)] === name;
}
