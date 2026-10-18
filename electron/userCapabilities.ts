/**
 * Aggregates local, AI and pipeline state into a user-facing capability snapshot with cached receipts.
 * 将本地、AI 与流水线状态聚合为面向用户的能力快照，并缓存连接回执。
 */
import crypto from 'node:crypto';
import type { CapabilityRequest, CapabilitySnapshot, CapabilityState, UserCapability } from '../shared/userCapabilities.ts';
import type { AiProviderConfig, AiProviderStatus } from './knowledge/ai/aiTypes.ts';
import type { PipelineDocumentStatus } from './pipeline/types.ts';

/**
 * Runtime inputs needed to compute one capability snapshot.
 * 计算一次能力快照所需的运行时输入。
 */
export interface CapabilityContext extends CapabilityRequest {
  /** Active generation model configuration / 当前生效的语言模型配置 */
  generation: AiProviderConfig;
  /** Whether a PDF parsing service (MinerU) is configured / 是否已配置 PDF 解析服务（MinerU） */
  pdfConfigured: boolean;
  /** Pipeline statuses, optionally scoped to one document / 流水线状态，可限定到单篇文档 */
  statuses: PipelineDocumentStatus[];
  /** Whether an embedding model is configured / 是否已配置向量模型 */
  semanticConfigured: boolean;
  /** Identity of the bound embedding configuration / 已绑定向量配置的标识 */
  semanticIdentity?: string;
  /** Whether the semantic index matches the current configuration / 语义索引是否与当前配置一致 */
  semanticCurrent?: boolean;
}

/**
 * Cached connection receipts are bound to the actual configuration and expire.
 * 缓存的连接回执绑定到实际配置，且会过期。
 */
export class UserCapabilities {
  private readonly checks = new Map<string, { at: number; status: AiProviderStatus }>();
  private readonly semanticChecks = new Map<string, { at: number; available: boolean }>();
  /**
   * Remembers the outcome of an embedding connectivity check.
   * 记录向量连接检测结果。
   *
   * @param identity - Configuration identity the result belongs to / 结果所属的配置标识
   * @param available - Whether the embedding service was reachable / 向量服务是否可达
   */
  rememberSemantic(identity: string, available: boolean): void { this.semanticChecks.set(identity, { at: Date.now(), available }); }
  // Hash the full provider config so receipts are invalidated whenever any setting changes.
  // 对完整提供商配置做哈希，任何设置变化都会使回执失效。
  private key(config: AiProviderConfig): string { return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
  /**
   * Remembers the outcome of a generation-model connectivity check.
   * 记录语言模型连接检测结果。
   *
   * @param config - Provider configuration that was tested / 被检测的提供商配置
   * @param status - Resulting provider status / 得到的提供商状态
   */
  rememberGeneration(config: AiProviderConfig, status: AiProviderStatus): void { this.checks.set(this.key(config), { at: Date.now(), status }); }
  /**
   * Builds the capability snapshot shown in the UI from cached receipts and pipeline state.
   * 根据缓存回执与流水线状态构建 UI 展示的能力快照。
   *
   * @param context - Runtime capability inputs / 运行时能力输入
   * @returns Snapshot listing every capability with its state and message / 列出各能力状态与提示信息的快照
   */
  snapshot(context: CapabilityContext): CapabilitySnapshot {
    const checkedAt = new Date().toISOString();
    const item = (id: UserCapability['id'], state: CapabilityState, code: string, message: string, action = ''): UserCapability => ({ id, state, code, message, action, checkedAt });
    const config = context.generation;
    const configured = Boolean(config.model) && (config.kind === 'ollama' || Boolean(config.apiKey && config.remoteContentConsent));
    const check = this.checks.get(this.key(config));
    // Receipts expire after five minutes so stale connectivity results never report "available".
    // 回执五分钟后过期，避免陈旧连接结果仍显示“可用”。
    const verified = check && Date.now() - check.at < 5 * 60_000 ? check.status : undefined;
    const selectedModel = verified?.models.some(model => model.name === config.model);
    const statuses = context.statuses.filter(status => !context.documentId || status.documentId === context.documentId);
    const busy = statuses.some(status => status.state === 'RUNNING' || status.state === 'QUEUED');
    const failed = statuses.some(status => status.state === 'FAILED' || status.state === 'FAILED_RETRYABLE');
    const ftsCurrent = statuses.some(status => status.ftsIndex?.state === 'CURRENT');
    const semantic = context.semanticIdentity ? this.semanticChecks.get(context.semanticIdentity) : undefined;
    const testedSemantic = semantic && Date.now() - semantic.at < 5 * 60_000 ? semantic : undefined;
    return {
      libraryPath: context.libraryPath, documentId: context.documentId,
      capabilities: [
        item('editing', 'available', 'LOCAL_EDITING_READY', '本地笔记可直接使用'),
        item('keywordSearch', 'available', 'LOCAL_SEARCH_READY', '本地关键词搜索可直接使用'),
        item('generation', !configured ? 'unconfigured' : !verified ? 'unverified' : !verified.available ? 'unreachable' : !selectedModel ? 'failed' : 'available', !configured ? 'GENERATION_CONFIG_REQUIRED' : !verified ? 'GENERATION_NOT_CHECKED' : !verified.available ? 'GENERATION_UNREACHABLE' : !selectedModel ? 'GENERATION_MODEL_MISSING' : 'GENERATION_READY', !configured ? '配置语言模型后可使用智能回答' : !verified ? '语言模型已配置，等待连接检测' : !verified.available ? '无法连接语言模型服务' : !selectedModel ? '服务未返回所选语言模型' : '语言模型连接检测通过', '打开模型设置'),
        item('materialFullText', ftsCurrent ? 'available' : busy ? 'processing' : failed ? 'failed' : 'unconfigured', ftsCurrent ? 'MATERIAL_FTS_READY' : busy ? 'MATERIAL_PROCESSING' : failed ? 'MATERIAL_PROCESSING_FAILED' : 'MATERIAL_FTS_PENDING', ftsCurrent ? '资料全文索引可用' : busy ? '资料正在处理' : failed ? '资料处理失败，请查看任务详情' : '资料处理完成后可搜索全文', '查看资料任务'),
        item('materialSemantic', !context.semanticConfigured ? 'unconfigured' : busy ? 'processing' : testedSemantic?.available === false ? 'unreachable' : testedSemantic?.available && context.semanticCurrent ? 'available' : 'unverified', !context.semanticConfigured ? 'EMBEDDING_CONFIG_REQUIRED' : testedSemantic?.available === false ? 'EMBEDDING_UNREACHABLE' : testedSemantic?.available && context.semanticCurrent ? 'EMBEDDING_READY' : 'EMBEDDING_NOT_CHECKED', !context.semanticConfigured ? '配置向量模型后可使用语义检索' : busy ? '资料向量正在处理' : testedSemantic?.available === false ? '无法连接向量模型服务' : testedSemantic?.available && context.semanticCurrent ? '向量连接与资料索引可用' : testedSemantic?.available ? '向量连接检测通过，资料向量索引尚未完成' : '向量模型已绑定，连接需要按需检测', '打开向量模型设置'),
        item('pdfParsing', context.pdfConfigured ? 'unverified' : 'unconfigured', context.pdfConfigured ? 'MINERU_NOT_CHECKED' : 'MINERU_CONFIG_REQUIRED', context.pdfConfigured ? 'MinerU 已配置；每批 PDF 上传前需要确认' : 'PDF 可先导入本地；云解析需要 MinerU 密钥和网络', '打开文档解析设置'),
        item('documentWorker', 'unverified', 'WORKER_NOT_CHECKED', '本地文档处理组件等待运行检测', '检测本地组件'),
      ],
    };
  }
}
