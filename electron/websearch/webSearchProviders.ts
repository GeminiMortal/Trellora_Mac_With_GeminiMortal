import type { WebSearchProviderAdapter, WebSearchProviderExtras, WebSearchProviderId, WebSearchRuntimeConfig } from './webSearchTypes.ts';
import { zhipuSearchProvider } from './zhipuSearchProvider.ts';
import { duckduckgoSearchProvider } from './duckduckgoSearchProvider.ts';
import { searxngSearchProvider } from './searxngSearchProvider.ts';
import { tavilySearchProvider } from './tavilySearchProvider.ts';
import { baiduSearchProvider } from './baiduSearchProvider.ts';

/**
 * Web search adapter registry + factory (web search design §3.1, aligned with WeKnora
 * WebSearchService routing by providerID). Registration order equals settings-page display order;
 * to add a vendor: implement an adapter and register it with one registerWebSearchProvider call.
 * 联网搜索适配器注册表 + 工厂（联网搜索设计方案 §3.1，对标 WeKnora
 * WebSearchService 按 providerID 路由）。注册顺序即设置页展示顺序；
 * 新增厂商：实现适配器后调用 registerWebSearchProvider 一行注册。
 */
const registry = new Map<WebSearchProviderId, WebSearchProviderAdapter>();

/**
 * Register a provider adapter; duplicate ids are rejected.
 * 注册厂商适配器；重复 id 会被拒绝。
 *
 * @param adapter - Adapter implementing the provider contract / 实现厂商契约的适配器
 */
export function registerWebSearchProvider(adapter: WebSearchProviderAdapter): void {
  if (registry.has(adapter.id)) throw new Error(`联网搜索适配器 ${adapter.id} 重复注册。`);
  registry.set(adapter.id, adapter);
}

registerWebSearchProvider(zhipuSearchProvider);
registerWebSearchProvider(duckduckgoSearchProvider);
registerWebSearchProvider(searxngSearchProvider);
registerWebSearchProvider(tavilySearchProvider);
registerWebSearchProvider(baiduSearchProvider);

/**
 * List all registered adapters in registration order.
 * 按注册顺序列出全部已注册适配器。
 *
 * @returns Registered adapters / 已注册的适配器列表
 */
export function listWebSearchProviders(): WebSearchProviderAdapter[] {
  return [...registry.values()];
}

/**
 * Look up one adapter by provider id.
 * 按厂商 id 查找单个适配器。
 *
 * @param id - Provider id / 厂商 id
 * @returns The adapter, or undefined when unregistered / 对应适配器；未注册时为 undefined
 */
export function getWebSearchProvider(id: WebSearchProviderId): WebSearchProviderAdapter | undefined {
  return registry.get(id);
}

/**
 * Result of resolving the effective adapter for the current config.
 * 按当前配置解析生效适配器的结果。
 */
export interface ResolvedWebSearchProvider {
  adapter?: WebSearchProviderAdapter;
  /** Actionable Chinese error when the adapter exists but prerequisites are unmet (capability gating degrades on this) / 适配器存在但前置配置不满足时的中文可操作错误（能力门控据此降级） */
  error?: string;
}

/**
 * Resolve the effective adapter for the current config; prerequisite checks live in each vendor's validateConfig,
 * and missing configuration yields an explicit error instead of runtime noise.
 * 按当前配置解析生效适配器；前置校验由各厂商的 validateConfig 自持，
 * 缺配置返回明确错误而非运行时噪音。
 *
 * @param input - Provider id and runtime config / 厂商 id 与运行时配置
 * @returns Resolved adapter and optional error / 解析出的适配器与可选错误
 */
export function resolveWebSearchProvider(input: {
  provider: WebSearchProviderId;
  config: WebSearchRuntimeConfig;
}): ResolvedWebSearchProvider {
  const adapter = registry.get(input.provider);
  if (!adapter) return { error: `未知联网搜索厂商 ${input.provider}。` };
  const validationError = adapter.validateConfig?.(input.config);
  if (validationError) return { adapter, error: validationError };
  return { adapter };
}

/**
 * Validate and fill non-secret config values per vendor configFields (aligned with WeKnora Parameters.ExtraConfig):
 * unknown keys are dropped, invalid values fall back to field defaults; vendors without configFields get an empty set.
 * 按厂商 configFields 校验并补全非密配置取值（对标 WeKnora Parameters.ExtraConfig）：
 * 未知键丢弃，非法取值回退字段默认值；无 configFields 的厂商返回空集。
 *
 * @param providerId - Vendor id / 厂商 id
 * @param raw - Raw stored extras blob / 原始存储的 extras 数据
 * @returns Normalized extras keyed by field key / 按字段键归一化后的 extras
 */
export function normalizeProviderExtras(providerId: WebSearchProviderId, raw: unknown): WebSearchProviderExtras {
  const fields = registry.get(providerId)?.configFields ?? [];
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const extras: WebSearchProviderExtras = {};
  for (const field of fields) {
    const value = source[field.key];
    extras[field.key] = typeof value === 'string' && field.options.some((option) => option.value === value) ? value : field.default;
  }
  return extras;
}
