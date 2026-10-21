/**
 * Plugin AI provider registry: lets plugins register custom LLM providers
 * that generateAiText dispatches to before falling back to built-in transports.
 * 插件 AI Provider 注册表：允许插件注册自定义 LLM Provider，
 * generateAiText 在回退到内建传输前优先分发到这里。
 */

import type { PluginAiGenerationInput, PluginAiGenerationOutput } from '../../plugins/pluginTypes.ts';

export interface PluginAiProvider {
  id: string;
  /** Wire protocol (mirrors AiGenerationApi). */
  api: string;
  endpoint: string;
  generate: (input: PluginAiGenerationInput) => Promise<PluginAiGenerationOutput>;
  listModels?: () => Promise<string[]>;
}

const providers = new Map<string, PluginAiProvider>();

/** Registers a plugin AI provider. Throws on duplicate id. */
export function registerPluginAiProvider(provider: PluginAiProvider): void {
  if (providers.has(provider.id)) throw new Error(`AI Provider ${provider.id} 已被占用。`);
  providers.set(provider.id, provider);
}

/** Removes a plugin AI provider (plugin disable/uninstall). */
export function unregisterPluginAiProvider(id: string): boolean {
  return providers.delete(id);
}

/** Returns a plugin provider by id, if registered. */
export function getPluginAiProvider(id: string): PluginAiProvider | undefined {
  return providers.get(id);
}

/** Lists all plugin provider ids. */
export function listPluginAiProviderIds(): string[] {
  return [...providers.keys()];
}

/** Checks whether a provider id is plugin-registered (vs built-in). */
export function isPluginAiProvider(id: string): boolean {
  return providers.has(id);
}
