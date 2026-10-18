/**
 * Model configuration change types: provider patches, save results, and connection impact analysis.
 * 模型配置变更类型：供应商补丁、保存结果与连接影响分析。
 */

import type { AiGenerationApi, AiModelSettings, AiModelSettingsInput } from '../electron/knowledge/ai/aiTypes.ts';
import type { ModelHub, ModelHubPatch } from './modelHubTypes';

/**
 * Partial update applied to a single model provider connection.
 * 应用到单个模型供应商连接的局部更新。
 */
export interface ModelProviderPatch {
  /** New endpoint URL. / 新的端点 URL。 */
  endpoint?: string;
  /** New API dialect. / 新的 API 方言。 */
  api?: Exclude<AiGenerationApi, 'ollama-chat'>;
  /** New API key, or null to clear it. / 新的 API 密钥；null 表示清除。 */
  apiKey?: string | null;
  /** New model list. / 新的模型列表。 */
  models?: string[];
}

/**
 * A user-requested model configuration change: hub-level or profile-level.
 * 用户请求的模型配置变更：中心级或档案级。
 */
export type ModelConfigurationChange =
  /** Hub-level change, optionally targeting a single provider. / 中心级变更，可选针对单个供应商。 */
  | { kind: 'hub'; hubPatch?: ModelHubPatch; provider?: { id: string; patch: ModelProviderPatch } }
  /** Profile-level change replacing model settings. / 档案级变更，替换模型设置。 */
  | { kind: 'profiles'; settings: AiModelSettingsInput; hubPatch?: ModelHubPatch };

/**
 * One library whose stored connection would change as a side effect of a configuration save.
 * 会因配置保存副作用而改变已存连接的单个资料库。
 */
export interface ModelConnectionImpact {
  /** Absolute path of the affected library. / 受影响资料库的绝对路径。 */
  libraryPath: string;
  /** Display name of the affected library. / 受影响资料库的显示名称。 */
  libraryName: string;
  /** Model name bound to the library. / 资料库绑定的模型名称。 */
  model: string;
  /** Endpoint currently stored for the library. / 资料库当前存储的端点。 */
  previousEndpoint: string;
  /** Endpoint that would be stored after the save. / 保存后将写入的端点。 */
  nextEndpoint: string;
}

/**
 * Outcome of a model configuration save: applied immediately, or pending user confirmation of impacts.
 * 模型配置保存结果：立即生效，或等待用户确认影响。
 */
export type ModelConfigurationSaveResult =
  /** Configuration saved and hub state returned. / 配置已保存并返回中心状态。 */
  | { status: 'saved'; hub: ModelHub; modelSettings?: AiModelSettings }
  /** Impacts need explicit confirmation before applying. / 需显式确认影响后才应用。 */
  | { status: 'confirmation-required'; impacts: ModelConnectionImpact[]; confirmationToken: string };

/**
 * Draft inputs for probing a provider catalog to list its available models.
 * 用于探测供应商模型目录的草稿输入。
 */
export interface ModelProviderCatalogDraft {
  /** Endpoint to query. / 要查询的端点。 */
  endpoint: string;
  /** API key used for the query, when required. / 查询所需的 API 密钥（如需）。 */
  apiKey?: string;
}
