/**
 * Plugin registry: tracks loaded plugins and their runtime registrations.
 * 插件注册表：跟踪已加载插件及其运行时注册。
 */

import type { LoadedPlugin, PluginManifest, PluginState } from './pluginTypes.ts';

export class PluginRegistry {
  private readonly plugins = new Map<string, LoadedPlugin>();

  /** Adds a plugin; throws on duplicate id. */
  add(plugin: LoadedPlugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`插件 ${plugin.manifest.id} 重复注册。`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  remove(id: string): boolean {
    return this.plugins.delete(id);
  }

  all(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  /** Summaries for the plugin management UI. */
  summaries(): Array<{ manifest: PluginManifest; state: PluginState; error?: string }> {
    return this.all().map((p) => ({
      manifest: p.manifest,
      state: p.state,
      error: p.error?.message,
    }));
  }

  setState(id: string, state: PluginState, error?: Error): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    plugin.state = state;
    plugin.error = error;
  }
}
