/**
 * SE-0 action profiles for the unified selection-edit workflow. Each profile
 * declares context strategy, default writeback mode, source authorization,
 * evidence policy, and protected anchor kinds per edit action.
 * 统一选区编辑工作流的 SE-0 动作配置。每个配置声明对应编辑动作的上下文策略、
 * 默认写回方式、来源授权、证据策略与受保护锚点类型。
 */

import type {
  SelectionEditAction,
  SelectionEditContextScope,
  SelectionEditSourceAuthorization,
  SelectionEditWritebackMode,
} from './selectionEditTypes.ts';

/**
 * Supported strategies for deciding which context to gather before editing.
 * 决定编辑前收集何种上下文的策略列表。
 */
export const selectionEditContextStrategies = ['local-first', 'current-note-adaptive', 'content-classified'] as const;

/**
 * Union of available context strategies.
 * 可用上下文策略的联合类型。
 */
export type SelectionEditContextStrategy = typeof selectionEditContextStrategies[number];

/**
 * Policies controlling when evidence is required to support new facts.
 * 控制新增事实何时需要证据支撑的策略列表。
 */
export const selectionEditEvidencePolicies = ['forbid-new-facts', 'require-for-new-facts', 'when-additive'] as const;

/**
 * Union of available evidence policies.
 * 可用证据策略的联合类型。
 */
export type SelectionEditEvidencePolicy = typeof selectionEditEvidencePolicies[number];

/**
 * Token kinds that must be preserved verbatim in edit suggestions.
 * 编辑建议中必须原样保留的锚点 token 类型列表。
 */
export const selectionEditProtectedAnchorKinds = [
  'number',
  'date',
  'url',
  'code',
  'proper-noun',
  'link-target',
  'placeholder',
] as const;

/**
 * Union of protected anchor kinds.
 * 受保护锚点类型的联合类型。
 */
export type SelectionEditProtectedAnchorKind = typeof selectionEditProtectedAnchorKinds[number];

/**
 * Per-action configuration: context strategy, default writeback mode, source
 * authorization, evidence policy, and protected anchor kinds.
 * 单个动作的配置：上下文策略、默认写回方式、来源授权、证据策略与受保护锚点类型。
 */
export interface SelectionEditActionProfile {
  label: string;
  description: string;
  contextStrategy: SelectionEditContextStrategy;
  defaultContextScope: SelectionEditContextScope;
  defaultWritebackMode: SelectionEditWritebackMode;
  defaultAllowedSources: SelectionEditSourceAuthorization;
  evidencePolicy: SelectionEditEvidencePolicy;
  protectedAnchorKinds: readonly SelectionEditProtectedAnchorKind[];
}

// SE-0 phase authorizes only the current note; other sources stay disabled.
// SE-0 阶段仅授权当前笔记；其他来源保持禁用。
const localOnlySources: SelectionEditSourceAuthorization = {
  currentNote: true,
  noteLibrary: false,
  materialsLibrary: false,
  web: false,
  personalization: false,
};

/**
 * SE-0 defaults. They describe intended routing only; they do not make any
 * source available before the corresponding capability adapter is implemented.
 * SE-0 默认配置。它们仅描述预期路由；在对应能力适配器实现之前，
 * 不会使任何来源真正可用。
 */
export const selectionEditProfiles = {
  polish: {
    label: '润色表达',
    description: '改善清晰度和连贯性，不新增事实。',
    contextStrategy: 'local-first',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  shorten: {
    label: '精简',
    description: '保留关键结论和限定条件，删除重复表达。',
    contextStrategy: 'current-note-adaptive',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  expand: {
    label: '扩写',
    description: '按需读取当前笔记相关原文，并为新增事实提供依据。',
    contextStrategy: 'current-note-adaptive',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'insert-below',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'require-for-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  proofread: {
    label: '校对',
    description: '修正语病、标点和术语一致性，不改变原意。',
    contextStrategy: 'local-first',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  explain: {
    label: '解释',
    description: '结合当前笔记的定义和论证补充说明。',
    contextStrategy: 'current-note-adaptive',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'insert-below',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'require-for-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  translate: {
    label: '翻译',
    description: '保持术语、专名、代码和链接一致。',
    contextStrategy: 'local-first',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'replace',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'forbid-new-facts',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
  custom: {
    label: '自定义',
    description: '先区分形式改写与内容增补，再决定来源和写回方式。',
    contextStrategy: 'content-classified',
    defaultContextScope: 'auto',
    defaultWritebackMode: 'copy-only',
    defaultAllowedSources: localOnlySources,
    evidencePolicy: 'when-additive',
    protectedAnchorKinds: selectionEditProtectedAnchorKinds,
  },
} as const satisfies Record<SelectionEditAction, SelectionEditActionProfile>;
