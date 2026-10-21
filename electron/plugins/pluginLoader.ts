/**
 * Plugin loader: reads plugin directories, validates manifests, loads entry
 * modules, and wires the activation context.
 * 插件加载器：读取插件目录、校验清单、加载入口模块、装配激活上下文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePluginManifest } from './pluginManifest.ts';
import type { PluginPermissionManager } from './pluginPermission.ts';
import type { LoadedPlugin, PluginEntry, PluginManifest } from './pluginTypes.ts';
import { PluginRegistry } from './pluginRegistry.ts';

export interface PluginLoaderOptions {
  /** Root directory containing one subdirectory per plugin. */
  pluginsDir: string;
  permissions: PluginPermissionManager;
  registry: PluginRegistry;
  /** Trellora version for engine range checks. */
  trelloraVersion: string;
  /** Logger sink. */
  onLog?: (message: string) => void;
}

/** Minimal semver range check: supports ">=X.Y.Z" and "X.Y.Z" only. */
function satisfiesRange(range: string, version: string): boolean {
  const clean = range.trim();
  const m = clean.match(/^(>=)?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const want = [Number(m[2]), Number(m[3]), Number(m[4])];
  const got = version.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const a = got[i] ?? 0;
    const b = want[i];
    if (a > b) return true;
    if (a < b) return m[1] === '>=' ? false : false;
  }
  return true;
}

export class PluginLoader {
  constructor(private readonly options: PluginLoaderOptions) {}

  /** Scans pluginsDir and registers every valid plugin (state: registered). */
  discover(): LoadedPlugin[] {
    const { pluginsDir, onLog } = this.options;
    const loaded: LoadedPlugin[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      onLog?.(`[PLUGIN] 插件目录不存在或不可读：${pluginsDir}`);
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rootDir = path.join(pluginsDir, entry.name);
      try {
        const plugin = this.loadOne(rootDir);
        this.options.registry.add(plugin);
        this.options.permissions.declare(plugin.manifest.id, plugin.manifest.permissions);
        loaded.push(plugin);
        onLog?.(`[PLUGIN] 已注册插件 ${plugin.manifest.id}@${plugin.manifest.version}`);
      } catch (error) {
        onLog?.(`[PLUGIN] 插件 ${entry.name} 加载失败：${(error as Error).message}`);
      }
    }
    return loaded;
  }

  /** Loads one plugin directory: manifest parse + engine check + entry import. */
  private async loadEntry(rootDir: string, manifest: PluginManifest): Promise<PluginEntry> {
    const entryPath = path.resolve(rootDir, manifest.main);
    if (!entryPath.startsWith(path.resolve(rootDir) + path.sep)) {
      throw new Error(`plugin.json main 指向插件目录之外：${manifest.main}`);
    }
    const imported = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
    const candidate = (imported.default ?? imported) as Record<string, unknown>;
    const activate = candidate.activate;
    if (typeof activate !== 'function') {
      throw new Error('插件入口必须导出 activate(context) 函数。');
    }
    return {
      activate: activate as PluginEntry['activate'],
      deactivate: typeof candidate.deactivate === 'function' ? (candidate.deactivate as PluginEntry['deactivate']) : undefined,
    };
  }

  /** Synchronous manifest validation + registry insert; entry loaded later. */
  loadOne(rootDir: string): LoadedPlugin {
    const manifestPath = path.join(rootDir, 'plugin.json');
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    const manifest = parsePluginManifest(raw);
    if (!satisfiesRange(manifest.engine.trellora, this.options.trelloraVersion)) {
      throw new Error(`插件 ${manifest.id} 要求 Trellora ${manifest.engine.trellora}，当前 ${this.options.trelloraVersion}。`);
    }
    return { manifest, rootDir, state: 'registered' };
  }

  /** Loads the entry module for a registered plugin and returns it. */
  async loadEntryFor(plugin: LoadedPlugin): Promise<PluginEntry> {
    if (plugin.entry) return plugin.entry;
    const entry = await this.loadEntry(plugin.rootDir, plugin.manifest);
    plugin.entry = entry;
    return entry;
  }

  /** Lists plugin ids that request the given activation event. */
  idsForActivation(event: PluginManifest['activation'][number]): string[] {
    return this.options.registry.all()
      .filter((p) => p.manifest.activation.includes(event) || p.manifest.activation.includes('*'))
      .map((p) => p.manifest.id);
  }
}
