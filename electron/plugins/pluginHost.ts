/**
 * PluginHost: orchestrates discovery, lifecycle, and contribution dispatch.
 * 插件宿主：编排发现、生命周期与贡献点分发。
 *
 * Lifecycle: discover → registered → activate → active ⇄ disabled → uninstall
 * 生命周期：发现 → 已注册 → 激活 → 运行 ⇄ 禁用 → 卸载
 */

import path from 'node:path';
import { buildPluginContext, type ContributionSink } from './pluginContext.ts';
import { unregisterCustomParsingRoute } from '../pipeline/routes.ts';
import { unregisterPluginAiProvider } from '../knowledge/ai/pluginAiProviders.ts';
import { PluginLoader, type PluginLoaderOptions } from './pluginLoader.ts';
import { PluginPermissionManager, type PermissionStore } from './pluginPermission.ts';
import { PluginRegistry } from './pluginRegistry.ts';
import type { PluginActivationEvent } from './pluginTypes.ts';

const PLUGIN_TIMEOUT_MS = 5_000;

export interface PluginHostOptions {
  pluginsDir: string;
  trelloraVersion: string;
  permissionStore: PermissionStore;
  onLog?: (message: string) => void;
  /** Prompt for L2 authorization; return true to grant, false to refuse. */
  onRequestL2Authorization?: (manifest: { id: string; name: string; version: string }, permissions: string[]) => Promise<boolean>;
}

export class PluginHost {
  readonly registry = new PluginRegistry();
  readonly permissions: PluginPermissionManager;
  private readonly loader: PluginLoader;
  private readonly sink: ContributionSink = {
    parsingRoutes: new Map(),
    aiProviders: new Map(),
    uiCommands: new Map(),
  };
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(private readonly options: PluginHostOptions) {
    this.permissions = new PluginPermissionManager(options.permissionStore);
    this.loader = new PluginLoader({
      pluginsDir: options.pluginsDir,
      permissions: this.permissions,
      registry: this.registry,
      trelloraVersion: options.trelloraVersion,
      onLog: options.onLog,
    } satisfies PluginLoaderOptions);
  }

  /** Scans the plugin directory and registers all valid plugins. */
  discover(): void {
    this.loader.discover();
  }

  /** Activates plugins that request the given event. Returns activated ids. */
  async activateFor(event: PluginActivationEvent): Promise<string[]> {
    const ids = this.loader.idsForActivation(event);
    const activated: string[] = [];
    for (const id of ids) {
      const ok = await this.activate(id);
      if (ok) activated.push(id);
    }
    return activated;
  }

  /** Activates one plugin (idempotent). Returns true on success. */
  async activate(id: string): Promise<boolean> {
    const plugin = this.registry.get(id);
    if (!plugin) return false;
    if (plugin.state === 'active') return true;

    // L2 permissions require explicit user authorization before activation.
    // L2 权限在激活前需要用户显式授权。
    const l2Needed = plugin.manifest.permissions.filter((p) => p.startsWith('system:'));
    if (l2Needed.length > 0 && this.options.onRequestL2Authorization) {
      const granted = await this.options.onRequestL2Authorization(plugin.manifest, l2Needed);
      if (!granted) {
        this.registry.setState(id, 'disabled', new Error('用户拒绝了 L2 系统权限。'));
        this.options.onLog?.(`[PLUGIN] ${id} 未激活：用户拒绝 L2 权限。`);
        return false;
      }
      for (const perm of l2Needed) this.permissions.grant(id, perm);
    }

    try {
      const entry = await this.loader.loadEntryFor(plugin);
      const context = buildPluginContext({
        pluginId: id,
        manifest: plugin.manifest,
        storageDir: path.join(plugin.rootDir, '.storage'),
        permissions: this.permissions,
        sink: this.sink,
        onLog: (level, message) => this.options.onLog?.(`[PLUGIN:${id}] ${level}: ${message}`),
        emitEvent: (event, payload) => this.emit(event, payload),
        subscribe: (event, listener) => this.subscribe(event, listener),
      });

      await this.withTimeout(entry.activate(context), `activate(${id})`);
      this.registry.setState(id, 'active');
      this.options.onLog?.(`[PLUGIN] 已激活 ${id}`);
      return true;
    } catch (error) {
      this.registry.setState(id, 'error', error as Error);
      this.options.onLog?.(`[PLUGIN] 激活 ${id} 失败：${(error as Error).message}`);
      return false;
    }
  }

  /** Disables an active plugin (runs deactivate if present and drops its contributions). */
  async disable(id: string): Promise<void> {
    const plugin = this.registry.get(id);
    if (!plugin || plugin.state !== 'active') return;
    try {
      if (plugin.entry?.deactivate) {
        await this.withTimeout(plugin.entry.deactivate(), `deactivate(${id})`);
      }
      this.dropContributions(id);
      this.registry.setState(id, 'disabled');
    } catch (error) {
      this.registry.setState(id, 'error', error as Error);
    }
  }

  /** Removes every contribution a plugin registered, so it can be re-activated. */
  private dropContributions(id: string): void {
    for (const [ext, route] of this.sink.parsingRoutes) {
      if (route.pluginId === id) { this.sink.parsingRoutes.delete(ext); unregisterCustomParsingRoute(ext); }
    }
    for (const [pid, provider] of this.sink.aiProviders) {
      if (provider.pluginId === id) { this.sink.aiProviders.delete(pid); unregisterPluginAiProvider(pid); }
    }
    for (const [cid, command] of this.sink.uiCommands) {
      if (command.pluginId === id) this.sink.uiCommands.delete(cid);
    }
  }

  /** Uninstalls a plugin: deactivates, removes registry entry and permissions. */
  async uninstall(id: string): Promise<void> {
    await this.disable(id);
    this.registry.remove(id);
    this.permissions.forget(id);
    this.options.onLog?.(`[PLUGIN] 已卸载 ${id}`);
  }

  /** L1 dispatch helpers used by the host's extension points. */
  getContributions(): ContributionSink {
    return this.sink;
  }

  /** Event bus (host + plugins share one bus). */
  subscribe(event: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return () => set!.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try { listener(payload); } catch { /* listener errors never break the bus */ }
    }
  }

  /** Per-call timeout guard so a hung plugin cannot block the host. */
  private async withTimeout(promise: Promise<void> | void, label: string): Promise<void> {
    if (!(promise instanceof Promise)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} 超时（${PLUGIN_TIMEOUT_MS}ms）`)), PLUGIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
