/**
 * PluginContext builder: assembles the L0/L1/L2 API surface handed to a
 * plugin's activate(). Capability APIs are guarded by the permission manager.
 * 插件上下文装配器：构建 activate() 收到的 L0/L1/L2 API 面。
 * 能力 API 经权限管理器守卫。
 */

import type { PluginPermissionManager } from './pluginPermission.ts';
import type {
  PluginAiGenerationInput, PluginAiGenerationOutput,
  PluginContext, PluginParseInput, PluginParseOutput, PluginPermission,
  PluginUiCommandArgs,
} from './pluginTypes.ts';
import fs from 'node:fs';
import path from 'node:path';
import { registerCustomParsingRoute } from '../pipeline/routes.ts';
import { parsePublicWebUrl } from '../websearch/webFetchClient.ts';
import { registerPluginAiProvider } from '../knowledge/ai/pluginAiProviders.ts';

/** Contribution registries the host exposes to plugins. */
export interface ContributionSink {
  parsingRoutes: Map<string, { pluginId: string; route: string; handler: (input: PluginParseInput) => Promise<PluginParseOutput> }>;
  aiProviders: Map<string, { pluginId: string; api: string; endpoint: string; generate: (input: PluginAiGenerationInput) => Promise<PluginAiGenerationOutput> }>;
  uiCommands: Map<string, { pluginId: string; title: string; panel?: string; execute: (args: PluginUiCommandArgs) => void | Promise<void> }>;
}

export interface PluginContextOptions {
  pluginId: string;
  manifest: unknown;
  storageDir: string;
  permissions: PluginPermissionManager;
  sink: ContributionSink;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  emitEvent: (event: string, payload: unknown) => void;
  subscribe: (event: string, listener: (payload: unknown) => void) => () => void;
}

/**
 * Builds the runtime context for one plugin. Every L1/L2 sub-API asserts the
 * corresponding permission before touching the host.
 * 构建单个插件的运行时上下文。L1/L2 子 API 在触达宿主前先校验权限。
 */
export function buildPluginContext(options: PluginContextOptions): PluginContext {
  const { pluginId, permissions, sink, onLog, emitEvent, subscribe, storageDir } = options;

  const guard = (permission: PluginPermission): void => {
    permissions.assert(pluginId, permission);
  };

  const log = {
    info: (message: string, ...args: unknown[]) => onLog('info', `${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`),
    warn: (message: string, ...args: unknown[]) => onLog('warn', `${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`),
    error: (message: string, ...args: unknown[]) => onLog('error', `${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`),
  };

  const events = {
    on: (event: string, listener: (payload: unknown) => void) => subscribe(event, listener),
    once: (event: string, listener: (payload: unknown) => void) => {
      const off = subscribe(event, (payload) => { off(); listener(payload); });
      return off;
    },
    off: (_event: string, _listener: (payload: unknown) => void) => { /* handled by the returned off() */ },
    emit: (event: string, payload: unknown) => emitEvent(event, payload),
  };

  const context: PluginContext = {
    manifest: options.manifest as PluginContext['manifest'],
    storageDir: options.storageDir,
    log,
    config: {
      get: <T = unknown>(_key: string, fallback?: T) => fallback as T,
      has: () => false,
      keys: () => [],
    },
    events,
    pipeline: {
      registerParsingRoute: (contribution) => {
        guard('pipeline:parse');
        if (sink.parsingRoutes.has(contribution.extension)) {
          throw new Error(`解析路由扩展名 ${contribution.extension} 已被占用。`);
        }
        // Wire into the real pipeline route table so pipelineOrchestrator/pathLayout
        // see the plugin extension as a first-class route.
        // 接入真实流水线路由表，使 pipelineOrchestrator/pathLayout 把插件扩展名
        // 作为一等解析路由。
        registerCustomParsingRoute(contribution.extension, {
          route: contribution.route,
          handler: contribution.handler as never,
        });
        sink.parsingRoutes.set(contribution.extension, { pluginId, route: contribution.route, handler: contribution.handler });
      },
    },
    ai: {
      registerProvider: (contribution) => {
        guard('ai:provider');
        if (sink.aiProviders.has(contribution.id)) throw new Error(`AI Provider ${contribution.id} 已被占用。`);
        registerPluginAiProvider({
          id: contribution.id,
          api: contribution.api,
          endpoint: contribution.endpoint,
          generate: contribution.generate as never,
          listModels: contribution.listModels as never,
        });
        sink.aiProviders.set(contribution.id, { pluginId, api: contribution.api, endpoint: contribution.endpoint, generate: contribution.generate });
      },
    },
    ui: {
      registerCommand: (contribution) => {
        guard('ui:command');
        if (sink.uiCommands.has(contribution.id)) throw new Error(`UI 命令 ${contribution.id} 已被占用。`);
        sink.uiCommands.set(contribution.id, { pluginId, title: contribution.title, panel: contribution.panel, execute: contribution.execute });
      },
    },
    data: {
      registerDataSource: (contribution) => {
        guard('data:source');
        onLog('info', `data source ${contribution.id} registered (kind=${contribution.kind})`);
      },
    },
    files: {
      // Bounded to the plugin's own storageDir (rootDir/.storage). Paths are
      // resolved and asserted to stay inside it, blocking traversal outside.
      // 限定在插件自身 storageDir（rootDir/.storage）内。路径解析后断言留在其中，
      // 阻止越界访问。
      readFile: async (relativePath: string) => {
        guard('system:file');
        const abs = safePluginPath(storageDir, relativePath);
        return new Uint8Array(await fs.promises.readFile(abs));
      },
      writeFile: async (relativePath: string, data: Uint8Array) => {
        guard('system:file');
        const abs = safePluginPath(storageDir, relativePath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, data);
      },
      listDir: async (relativePath: string) => {
        guard('system:file');
        const abs = safePluginPath(storageDir, relativePath);
        return (await fs.promises.readdir(abs, { withFileTypes: true })).map((e) => e.name);
      },
    },
    network: {
      // Outbound HTTP restricted to public https URLs via the SSRF guard.
      // 出站 HTTP 限定公共 https URL（SSRF 防护）。
      fetch: async (url: string, init?: RequestInit) => {
        guard('system:network');
        const parsed = parsePublicWebUrl(url);
        if (parsed.protocol !== 'https:') throw new Error('插件网络请求仅支持 https。');
        return globalThis.fetch(parsed.href, { ...init, signal: init?.signal ?? AbortSignal.timeout(PLUGIN_NETWORK_TIMEOUT_MS) });
      },
    },
  };

  return context;
}

const PLUGIN_NETWORK_TIMEOUT_MS = 10_000;

/**
 * Resolves a relative path under the plugin storage root and asserts the
 * result stays inside it, blocking ../ traversal and absolute paths.
 * 解析插件存储根下的相对路径并断言结果留在其内，阻止 ../ 越界与绝对路径。
 */
function safePluginPath(storageDir: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('插件文件路径必须是非空相对路径。');
  }
  const root = path.resolve(storageDir);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`插件文件路径越界：${relativePath}`);
  }
  return abs;
}
