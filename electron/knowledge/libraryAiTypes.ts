/**
 * AI-driven library plan and organization suggestion types.
 * AI 驱动的资料库计划与组织建议类型。
 */

/** A single step in an AI-generated learning plan. / AI 生成学习计划中的单个步骤。 */
export interface LearningPlanStep {
  title: string;
  rationale: string;
  sourceTitles: string[];
}

/** A complete AI-generated learning plan for a library. / AI 为资料库生成的完整学习计划。 */
export interface LearningPlan {
  goal: string;
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
  steps: LearningPlanStep[];
}

/** A group of notes suggested for organizational restructuring. / 建议进行组织重构的一组笔记。 */
export interface OrganizationSuggestionGroup {
  title: string;
  noteTitles: string[];
  rationale: string;
}

/** A complete AI-generated organization suggestion with next steps. / AI 生成的完整组织建议及后续步骤。 */
export interface OrganizationSuggestion {
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
  groups: OrganizationSuggestionGroup[];
  nextActions: string[];
}
import type { AiProviderKind } from './aiTypes';
