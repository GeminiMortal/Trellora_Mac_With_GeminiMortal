/**
 * Resolution of a model's effective context window: physical window discovery, product ceilings, runtime profiles, and token reservations.
 * 模型有效上下文窗口的解析：物理窗口发现、产品上限、运行时配置档与 token 预留。
 */

import {
  ASSISTANT_AUTO_COMPACT_RATIO,
  ASSISTANT_CONTEXT_BUDGET_TOKENS,
  ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS,
  ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS,
  ASSISTANT_WORKING_MEMORY_MAX_TOKENS,
} from './assistantContextBudget';

/**
 * Fallback window used when no model metadata is available; equals the strict WeKnora-compatible default.
 * 无模型元数据时使用的回退窗口；等于与 WeKnora 兼容的严格默认值。
 */
export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;

/**
 * Where the effective context window value came from.
 * 有效上下文窗口值的来源。
 */
export type EffectiveContextWindowSource = 'application-fixed' | 'provider' | 'ollama' | 'configured' | 'known-model' | 'conservative-default';

/**
 * Confidence level of the resolved window value.
 * 解析出的窗口值的置信度。
 */
export type EffectiveContextWindowConfidence = 'exact' | 'declared' | 'estimated';

/**
 * Origin of the physical context window metadata.
 * 物理上下文窗口元数据的出处。
 */
export type AssistantPhysicalContextSource = 'provider' | 'model-catalog' | 'ollama' | 'user' | 'unknown';

/**
 * Whether the context window adapts to the real model window or stays at the legacy fixed 128K.
 * 上下文窗口是自适应真实模型窗口，还是保持旧的固定 128K。
 */
export type AssistantContextWindowMode = 'adaptive-real-window' | 'legacy-fixed-128k';

/**
 * Named runtime profile matching the resolved window size.
 * 与解析窗口大小对应的具名运行时配置档。
 */
export type AssistantContextRuntimeProfileId = 'conservative-200k' | '128k' | '256k' | 'custom';

/**
 * Whether the product ceiling follows the model window or is fixed by the application.
 * 产品上限跟随模型窗口，还是由应用固定。
 */
export type AssistantProductContextCapMode = 'follow-model' | 'fixed';

/**
 * Full runtime profile of one model: physical window, ceilings, reservations, and warnings.
 * 单个模型的完整运行时配置档：物理窗口、上限、预留与警告。
 */
export interface AssistantModelRuntimeProfile {
  /** Provider that serves the model. / 提供该模型的供应商。 */
  providerId: string;
  /** Model identifier. / 模型标识。 */
  modelId: string;
  /** Named profile matching the resolved window. / 与解析窗口匹配的具名配置档。 */
  runtimeProfileId: AssistantContextRuntimeProfileId;
  /** Physical context window in tokens, when discovered. / 已发现的物理上下文窗口（token）。 */
  physicalContextTokens?: number;
  /** Where the physical window metadata came from. / 物理窗口元数据的出处。 */
  physicalSource: AssistantPhysicalContextSource;
  /** Whether the product ceiling follows the model or is fixed. / 产品上限跟随模型还是固定。 */
  productCapMode: AssistantProductContextCapMode;
  /** Product ceiling in tokens. / 产品上限（token）。 */
  productCeilingTokens: number;
  /** User-configured cap in tokens, when set. / 用户配置的上限（token，如有）。 */
  userCapTokens?: number;
  /** Resolved effective window in tokens. / 解析出的有效窗口（token）。 */
  effectiveContextTokens: number;
  /** Token count at which auto-compaction triggers. / 触发自动压缩的 token 数。 */
  autoCompactAtTokens: number;
  /** Tokens reserved for model output. / 为模型输出预留的 token 数。 */
  reservedOutputTokens: number;
  /** Tokens reserved as a safety margin. / 作为安全余量预留的 token 数。 */
  safetyTokens: number;
  /** User-facing warnings raised during resolution. / 解析过程中产生的面向用户警告。 */
  warnings: string[];
}

/**
 * Resolved effective context window with provenance and the underlying runtime profile.
 * 解析出的有效上下文窗口，含来源与底层运行时配置档。
 */
export interface EffectiveContextWindow {
  /** Effective window size in tokens. / 有效窗口大小（token）。 */
  tokens: number;
  /** Application product ceiling in tokens. / 应用产品上限（token）。 */
  applicationCeiling: number;
  /** Where the resolved value came from. / 解析值的来源。 */
  source: EffectiveContextWindowSource;
  /** Confidence of the resolved value. / 解析值的置信度。 */
  confidence: EffectiveContextWindowConfidence;
  /** Window discovered from the provider, when available. / 从供应商发现的窗口（如有）。 */
  discoveredTokens?: number;
  /** User-configured cap, when set. / 用户配置的上限（如有）。 */
  configuredCapTokens?: number;
  /** Window from the known-model catalog, when available. / 已知模型目录中的窗口（如有）。 */
  knownModelTokens?: number;
  /** Model's maximum output tokens, when declared. / 模型声明的最大输出 token（如有）。 */
  modelMaxOutputTokens?: number;
  /** Combined user-facing warning text, when any. / 合并后的面向用户警告文本（如有）。 */
  warning?: string;
  /** Full runtime profile backing the result. / 支撑该结果的完整运行时配置档。 */
  runtimeProfile: AssistantModelRuntimeProfile;
}

/**
 * Inputs describing the application ceiling and every known model window signal.
 * 描述应用上限与全部已知模型窗口信号的输入。
 */
export interface EffectiveContextWindowInput {
  /** Application product ceiling in tokens. / 应用产品上限（token）。 */
  applicationCeiling?: number;
  /** Window discovered from the live provider connection. / 从实时供应商连接发现的窗口。 */
  discoveredModelWindow?: number;
  /** Origin of the discovered window. / 已发现窗口的出处。 */
  discoveredSource?: Extract<EffectiveContextWindowSource, 'provider' | 'ollama'>;
  /** User-configured window cap. / 用户配置的窗口上限。 */
  configuredModelWindow?: number;
  /** Window from the known-model catalog. / 已知模型目录中的窗口。 */
  knownModelWindow?: number;
  /** Model's declared maximum output tokens. / 模型声明的最大输出 token。 */
  modelMaxOutputTokens?: number;
  /** Provider id for labeling. / 用于标注的供应商 id。 */
  providerId?: string;
  /** Model id for labeling. / 用于标注的模型 id。 */
  modelId?: string;
  /** Requested output token reservation. / 请求的输出 token 预留。 */
  reservedOutputTokens?: number;
  /** Requested safety token reservation. / 请求的安全 token 预留。 */
  safetyTokens?: number;
  /** Context window mode selection. / 上下文窗口模式选择。 */
  mode?: AssistantContextWindowMode;
}

/**
 * Resolve the model's real usable window and runtime profile. Every applicable ceiling participates in the minimum, so stale UI metadata can never enlarge a provider-declared or locally discovered physical window.
 * 解析模型的真实可用窗口与运行时配置档。所有适用上限都参与取最小值，因此过期的界面元数据绝不可能放大供应商声明或本地发现的物理窗口。
 *
 * @param input - Window signals and labeling inputs / 窗口信号与标注输入
 * @returns Resolved runtime profile with reservations and warnings / 含预留与警告的已解析运行时配置档
 */
export function resolveAssistantModelRuntimeProfile(input: EffectiveContextWindowInput = {}): AssistantModelRuntimeProfile {
  const configuredProductCeiling = normalizePositiveInteger(input.applicationCeiling);
  const discoveredTokens = normalizePositiveInteger(input.discoveredModelWindow);
  const userCapTokens = normalizePositiveInteger(input.configuredModelWindow);
  const knownModelTokens = normalizePositiveInteger(input.knownModelWindow);
  const modelMaxOutputTokens = normalizePositiveInteger(input.modelMaxOutputTokens);
  const warnings: string[] = [];

  // Legacy mode pins the window to the 128K baseline and skips physical-window validation.
  // 旧模式将窗口固定为 128K 基线，并跳过物理窗口校验。
  if (input.mode === 'legacy-fixed-128k') {
    warnings.push('已启用 Legacy Fixed128K 回退模式；该模式不会校验模型真实物理窗口。');
    const productCeiling = ASSISTANT_CONTEXT_BUDGET_TOKENS;
    const safetyTokens = resolveSafetyTokens(productCeiling, input.safetyTokens);
    const reservedOutputTokens = resolveReservedOutputTokens(productCeiling, modelMaxOutputTokens, input.reservedOutputTokens);
    return {
      providerId: input.providerId?.trim() || 'unknown-provider',
      modelId: input.modelId?.trim() || 'unknown-model',
      runtimeProfileId: '128k',
      physicalSource: 'unknown',
      productCapMode: 'fixed',
      productCeilingTokens: ASSISTANT_CONTEXT_BUDGET_TOKENS,
      ...(userCapTokens ? { userCapTokens } : {}),
      effectiveContextTokens: productCeiling,
      autoCompactAtTokens: Math.floor(productCeiling * ASSISTANT_AUTO_COMPACT_RATIO),
      reservedOutputTokens,
      safetyTokens,
      warnings,
    };
  }

  // Determine the physical window from the strongest available signal: live discovery, catalog, user cap, then the conservative default.
  // 从最强可用信号确定物理窗口：实时发现、模型目录、用户上限，最后是保守默认值。
  let physicalContextTokens: number;
  let physicalSource: AssistantPhysicalContextSource;
  if (discoveredTokens) {
    physicalContextTokens = discoveredTokens;
    physicalSource = input.discoveredSource === 'ollama' ? 'ollama' : 'provider';
  } else if (knownModelTokens) {
    physicalContextTokens = knownModelTokens;
    physicalSource = 'model-catalog';
  } else if (userCapTokens) {
    physicalContextTokens = userCapTokens;
    physicalSource = 'user';
    warnings.push(`未发现模型窗口元数据，暂按用户设置的 ${userCapTokens} token 上限运行；请确认模型实际支持。`);
  } else {
    physicalContextTokens = ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;
    physicalSource = 'unknown';
    warnings.push(`未识别模型上下文窗口，已按保守的 ${ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS} token 运行。`);
  }

  // The effective window is the minimum of every ceiling so no single stale signal can enlarge it.
  // 有效窗口取所有上限的最小值，使任何单个过期信号都无法放大窗口。
  const productCeiling = configuredProductCeiling ?? physicalContextTokens;
  const effectiveContextTokens = Math.min(
    configuredProductCeiling ?? Number.MAX_SAFE_INTEGER,
    physicalContextTokens,
    discoveredTokens ?? Number.MAX_SAFE_INTEGER,
    userCapTokens ?? Number.MAX_SAFE_INTEGER,
    knownModelTokens ?? Number.MAX_SAFE_INTEGER,
  );
  if (configuredProductCeiling && (physicalContextTokens > configuredProductCeiling
    || userCapTokens && userCapTokens > configuredProductCeiling
    || knownModelTokens && knownModelTokens > configuredProductCeiling)) {
    warnings.push(`模型或用户上限超过产品上限，已限制为 ${productCeiling} token。`);
  }
  if (userCapTokens && discoveredTokens && userCapTokens > discoveredTokens) {
    warnings.push(`用户上限 ${userCapTokens} token 高于已发现的物理窗口 ${discoveredTokens} token，已采用较小值。`);
  }
  const safetyTokens = resolveSafetyTokens(effectiveContextTokens, input.safetyTokens);
  const reservedOutputTokens = resolveReservedOutputTokens(effectiveContextTokens, modelMaxOutputTokens, input.reservedOutputTokens);

  return {
    providerId: input.providerId?.trim() || 'unknown-provider',
    modelId: input.modelId?.trim() || 'unknown-model',
    runtimeProfileId: resolveRuntimeProfileId(effectiveContextTokens, physicalSource),
    physicalContextTokens,
    physicalSource,
    productCapMode: configuredProductCeiling ? 'fixed' : 'follow-model',
    productCeilingTokens: productCeiling,
    ...(userCapTokens ? { userCapTokens } : {}),
    effectiveContextTokens,
    autoCompactAtTokens: Math.floor(effectiveContextTokens * ASSISTANT_AUTO_COMPACT_RATIO),
    reservedOutputTokens,
    safetyTokens,
    warnings,
  };
}

/**
 * Resolve the effective context window together with its provenance and confidence level.
 * 解析有效上下文窗口，同时给出其来源与置信度。
 *
 * @param input - Window signals and labeling inputs / 窗口信号与标注输入
 * @returns Effective window with source, confidence, and runtime profile / 含来源、置信度与运行时配置档的有效窗口
 */
export function resolveEffectiveContextWindow(input: EffectiveContextWindowInput = {}): EffectiveContextWindow {
  const runtimeProfile = resolveAssistantModelRuntimeProfile(input);
  const discoveredTokens = normalizePositiveInteger(input.discoveredModelWindow);
  const configuredCapTokens = normalizePositiveInteger(input.configuredModelWindow);
  const knownModelTokens = normalizePositiveInteger(input.knownModelWindow);
  const modelMaxOutputTokens = normalizePositiveInteger(input.modelMaxOutputTokens);
  const legacyFixed = input.mode === 'legacy-fixed-128k';
  // Attribute the result to the most specific ceiling that actually determined the effective value.
  // 将结果归属于真正决定了有效值的最具体上限。
  const source = legacyFixed || runtimeProfile.productCapMode === 'fixed'
      && runtimeProfile.effectiveContextTokens === runtimeProfile.productCeilingTokens
      && runtimeProfile.physicalContextTokens !== undefined
      && runtimeProfile.physicalContextTokens > runtimeProfile.productCeilingTokens
    ? 'application-fixed'
    : configuredCapTokens !== undefined
      && runtimeProfile.effectiveContextTokens === configuredCapTokens
      && configuredCapTokens < (runtimeProfile.physicalContextTokens ?? Number.MAX_SAFE_INTEGER)
      ? 'configured'
      : knownModelTokens !== undefined
        && runtimeProfile.effectiveContextTokens === knownModelTokens
        && knownModelTokens < (discoveredTokens ?? Number.MAX_SAFE_INTEGER)
        ? 'known-model'
        : runtimeProfile.physicalSource === 'provider' ? 'provider'
          : runtimeProfile.physicalSource === 'ollama' ? 'ollama'
            : runtimeProfile.physicalSource === 'model-catalog' ? 'known-model'
              : runtimeProfile.physicalSource === 'user' ? 'configured'
                : 'conservative-default';
  return {
    tokens: runtimeProfile.effectiveContextTokens,
    applicationCeiling: runtimeProfile.productCeilingTokens,
    source,
    // Directly observed windows are exact; catalog/config values are declared; the fallback is estimated.
    // 直接观测到的窗口为 exact；目录/配置值为 declared；回退值为 estimated。
    confidence: source === 'application-fixed' || source === 'provider' || source === 'ollama'
      ? 'exact'
      : source === 'conservative-default' ? 'estimated' : 'declared',
    ...(discoveredTokens ? { discoveredTokens } : {}),
    ...(configuredCapTokens ? { configuredCapTokens } : {}),
    ...(knownModelTokens ? { knownModelTokens } : {}),
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
    ...(runtimeProfile.warnings.length ? { warning: runtimeProfile.warnings.join(' ') } : {}),
    runtimeProfile,
  };
}

/**
 * Resolve the L1 working-memory window; L1 uses a stable 200K product ceiling while the final provider send still observes the resolved physical window and ModelCallCoordinator hard veto.
 * 解析 L1 工作记忆窗口；L1 使用稳定的 200K 产品上限，而最终向供应商发送仍受已解析物理窗口与 ModelCallCoordinator 硬性否决约束。
 *
 * @param resolvedContextWindowTokens - Previously resolved effective window, when available / 已解析的有效窗口（如有）
 * @returns Working-memory window capped at the L1 maximum / 封顶于 L1 上限的工作记忆窗口
 */
export function resolveWorkingMemoryWindowTokens(resolvedContextWindowTokens?: number): number {
  const resolved = normalizePositiveInteger(resolvedContextWindowTokens)
    ?? ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;
  return Math.min(ASSISTANT_WORKING_MEMORY_MAX_TOKENS, resolved);
}

/**
 * Reserve output tokens, scaling to 12.5% of the window with a floor of 1024 and honoring the model's declared maximum.
 * 预留输出 token：按窗口的 12.5% 缩放、下限 1024，并受模型声明的最大值约束。
 *
 * @param contextWindowTokens - Resolved context window / 已解析的上下文窗口
 * @param modelMaxOutputTokens - Model's declared maximum output tokens / 模型声明的最大输出 token
 * @param requested - Requested reservation / 请求的预留值
 * @returns Output token reservation / 输出 token 预留值
 */
function resolveReservedOutputTokens(contextWindowTokens: number, modelMaxOutputTokens?: number, requested?: number): number {
  const scaled = Math.max(1_024, Math.floor(contextWindowTokens * 0.125));
  return Math.min(requested ?? 8_192, modelMaxOutputTokens ?? Number.MAX_SAFE_INTEGER, scaled);
}

/**
 * Reserve safety-margin tokens, using a larger ratio for small windows and a floor of 2048.
 * 预留安全余量 token：小窗口使用更高比例，下限 2048。
 *
 * @param contextWindowTokens - Resolved context window / 已解析的上下文窗口
 * @param requested - Requested reservation / 请求的预留值
 * @returns Safety token reservation / 安全 token 预留值
 */
function resolveSafetyTokens(contextWindowTokens: number, requested?: number): number {
  const configured = normalizePositiveInteger(requested);
  if (configured) return Math.min(configured, contextWindowTokens);
  const ratio = contextWindowTokens < ASSISTANT_CONTEXT_BUDGET_TOKENS ? 0.05 : 0.03125;
  return Math.min(contextWindowTokens, Math.max(2_048, Math.floor(contextWindowTokens * ratio)));
}

/**
 * Coerce a value to a positive safe integer, or undefined when it is not one.
 * 将值强制转换为正安全整数；不符合时返回 undefined。
 *
 * @param value - Candidate numeric value / 候选数值
 * @returns Positive safe integer, or undefined / 正安全整数，或 undefined
 */
function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Map a resolved effective window to its named runtime profile id.
 * 将已解析的有效窗口映射为具名运行时配置档 id。
 *
 * @param effectiveContextTokens - Resolved effective window / 已解析的有效窗口
 * @param physicalSource - Origin of the physical window metadata / 物理窗口元数据的出处
 * @returns Named runtime profile id / 具名运行时配置档 id
 */
function resolveRuntimeProfileId(
  effectiveContextTokens: number,
  physicalSource: AssistantPhysicalContextSource,
): AssistantContextRuntimeProfileId {
  if (physicalSource === 'unknown' && effectiveContextTokens === ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS) return 'conservative-200k';
  if (effectiveContextTokens === ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS['128k']) return '128k';
  if (effectiveContextTokens === ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS['256k']) return '256k';
  return 'custom';
}
