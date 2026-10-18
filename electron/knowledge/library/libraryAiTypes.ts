/**
 * Shared AI output types for whole-library learning plans and organization suggestions.
 * 整库学习计划与整理建议的共享 AI 输出类型定义。
 */
import type { AiProviderKind } from '../ai/aiTypes.ts';

/**
 * AI-driven library plan and organization suggestion types.
 * AI 驱动的资料库计划与组织建议类型。
 */

/**
 * A single step in an AI-generated learning plan.
 * AI 生成学习计划中的单个步骤。
 *
 * @property title - Step title / 步骤标题
 * @property rationale - Why this step is included / 包含此步骤的理由
 * @property sourceTitles - Titles of source notes used / 使用的来源笔记标题
 */
export interface LearningPlanStep {
  title: string;
  rationale: string;
  sourceTitles: string[];
}

/**
 * A complete AI-generated learning plan for a library.
 * AI 为资料库生成的完整学习计划。
 *
 * @property goal - Learning goal / 学习目标
 * @property provider - AI provider used / 使用的 AI 提供方
 * @property model - Model identifier / 模型标识
 * @property generatedAt - ISO timestamp of generation / 生成时间的 ISO 时间戳
 * @property steps - Ordered learning steps / 有序的学习步骤
 */
export interface LearningPlan {
  goal: string;
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
  steps: LearningPlanStep[];
}

/**
 * A group of notes suggested for organizational restructuring.
 * 建议进行组织重构的一组笔记。
 *
 * @property title - Group title / 分组标题
 * @property noteTitles - Notes in this group / 该分组中的笔记标题
 * @property rationale - Why these notes belong together / 这些笔记归为一组的理由
 */
export interface OrganizationSuggestionGroup {
  title: string;
  noteTitles: string[];
  rationale: string;
}

/**
 * A complete AI-generated organization suggestion with next steps.
 * AI 生成的完整组织建议及后续步骤。
 *
 * @property provider - AI provider used / 使用的 AI 提供方
 * @property model - Model identifier / 模型标识
 * @property generatedAt - ISO timestamp of generation / 生成时间的 ISO 时间戳
 * @property groups - Suggested note groupings / 建议的笔记分组
 * @property nextActions - Recommended follow-up actions / 推荐的后续操作
 */
export interface OrganizationSuggestion {
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
  groups: OrganizationSuggestionGroup[];
  nextActions: string[];
}