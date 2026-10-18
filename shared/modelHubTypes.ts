/**
 * Model hub types: provider connections, model slots, and hub patches shared with the renderer.
 * 模型中心类型：与渲染进程共享的供应商连接、模型槽位与中心补丁。
 */

import type { AiGenerationApi } from '../electron/knowledge/ai/aiTypes.ts';

/**
 * Slot identifiers for the generation, embedding, and rerank model roles.
 * 生成、嵌入与重排模型角色的槽位标识。
 */
export type ModelSlotId = 'generation' | 'embedding' | 'rerank';

/**
 * The model assigned to a slot.
 * 指派给某个槽位的模型。
 */
export interface ModelSlot {
  /** Source key that owns the model, such as a provider id. / 拥有该模型的来源键，例如供应商 id。 */
  source: string;
  /** Model name within the source. / 来源内的模型名称。 */
  model: string;
}

/**
 * A configured remote or local model provider connection.
 * 已配置的远程或本地模型供应商连接。
 */
export interface ProviderConnection {
  /** Unique provider id. / 唯一供应商 id。 */
  id: string;
  /** Display label. / 显示标签。 */
  label: string;
  /** Current endpoint URL. / 当前端点 URL。 */
  endpoint: string;
  /** Default endpoint used for reset. / 用于重置的默认端点。 */
  defaultEndpoint: string;
  /** API dialect of the provider. / 供应商的 API 方言。 */
  api: Exclude<AiGenerationApi, 'ollama-chat'>;
  /** Whether the provider supports generation only, without embeddings or rerank. / 供应商是否仅支持生成，不支持嵌入或重排。 */
  generationOnly: boolean;
  /** Whether an API key is stored for the provider. / 是否已为该供应商存储 API 密钥。 */
  hasKey: boolean;
  /** Known model names. / 已知模型名称列表。 */
  models: string[];
  /** Known embedding model presets. / 已知嵌入模型预设。 */
  embeddingPresets: string[];
  /** Known rerank model presets. / 已知重排模型预设。 */
  rerankPresets: string[];
}

/**
 * Full model hub state: Ollama settings, remote consent, providers, and slot assignments.
 * 完整模型中心状态：Ollama 设置、远程同意、供应商与槽位指派。
 */
export interface ModelHub {
  /** Ollama server endpoint. / Ollama 服务端点。 */
  ollamaEndpoint: string;
  /** Ollama embedding model presets. / Ollama 嵌入模型预设。 */
  ollamaEmbeddingPresets: string[];
  /** Whether the user consented to remote model providers. / 用户是否同意使用远程模型供应商。 */
  remoteConsent: boolean;
  /** Configured providers. / 已配置的供应商。 */
  providers: ProviderConnection[];
  /** Model assigned to each slot. / 每个槽位指派的模型。 */
  slots: Record<ModelSlotId, ModelSlot>;
}

/**
 * Partial update applied to the model hub state.
 * 应用到模型中心状态的局部更新。
 */
export interface ModelHubPatch {
  /** New Ollama endpoint. / 新的 Ollama 端点。 */
  ollamaEndpoint?: string;
  /** New remote consent flag. / 新的远程同意标记。 */
  remoteConsent?: boolean;
  /** Per-slot model updates. / 按槽位的模型更新。 */
  slots?: Partial<Record<ModelSlotId, Partial<ModelSlot>>>;
}
