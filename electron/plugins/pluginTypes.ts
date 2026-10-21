/**
 * Plugin host core types.
 * 插件宿主核心类型。
 *
 * Mirrors plugins/sdk/trellora-plugin-sdk.d.ts but as runtime-importable
 * types. The SDK file is the public contract; this file is the host's
 * internal view of that contract.
 *
 * 与 plugins/sdk/trellora-plugin-sdk.d.ts 同构，但作为宿主可运行时导入的类型。
 * SDK 文件是公开契约；本文件是宿主对该契约的内部视角。
 */

// ── Manifest ─────────────────────────────────────────────────────────────────

export interface PluginEngineRange {
  trellora: string;
}

export type PluginPermission =
  | 'pipeline:parse'
  | 'ai:provider'
  | 'ui:command'
  | 'data:source'
  | 'system:file'
  | 'system:network'
  | 'system:subprocess';

export type PluginActivationEvent =
  | 'onStartup'
  | 'onParseRequest'
  | 'onAiRequest'
  | 'onUiCommand'
  | '*';

export interface PluginContributions {
  parsingRoutes?: Array<{ extension: string; route: string }>;
  aiProviders?: Array<{ id: string; api: string }>;
  uiCommands?: Array<{ id: string; title: string; panel?: 'sidebar' | 'command-palette' | 'toolbar' }>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  main: string;
  engine: PluginEngineRange;
  permissions: PluginPermission[];
  activation: PluginActivationEvent[];
  contributes?: PluginContributions;
}

// ── Loaded plugin state ──────────────────────────────────────────────────────

export type PluginState = 'registered' | 'active' | 'disabled' | 'error';

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute plugin root directory. */
  rootDir: string;
  state: PluginState;
  /** Set when state === 'error'. */
  error?: Error;
  /** Entry module exports (activate/deactivate). */
  entry?: PluginEntry;
}

export interface PluginEntry {
  activate(context: unknown): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ── Capability API contracts ─────────────────────────────────────────────────

export interface PluginParseInput {
  inputPath: string;
  outputDir: string;
  extension: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, message?: string) => void;
}

export interface PluginParseOutput {
  markdownFile: string;
  counts?: Record<string, number>;
}

export interface PluginAiGenerationInput {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  format?: 'json';
}

export interface PluginAiGenerationOutput {
  text: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface PluginUiCommandArgs {
  trigger: 'command-palette' | 'sidebar' | 'toolbar';
  payload?: unknown;
}

/** The context object handed to a plugin's activate(). */
export interface PluginContext {
  manifest: Readonly<PluginManifest>;
  storageDir: string;
  log: {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  };
  config: {
    get<T = unknown>(key: string, fallback?: T): T;
    has(key: string): boolean;
    keys(): readonly string[];
  };
  events: {
    on(event: string, listener: (payload: unknown) => void): () => void;
    once(event: string, listener: (payload: unknown) => void): () => void;
    off(event: string, listener: (payload: unknown) => void): void;
    emit(event: string, payload: unknown): void;
  };
  pipeline: {
    registerParsingRoute(contribution: {
      extension: string; route: string;
      handler: (input: PluginParseInput) => Promise<PluginParseOutput>;
    }): void;
  };
  ai: {
    registerProvider(contribution: {
      id: string;
      api: 'ollama-chat' | 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generate-content';
      endpoint: string;
      generate: (input: PluginAiGenerationInput) => Promise<PluginAiGenerationOutput>;
      listModels?: () => Promise<string[]>;
    }): void;
  };
  ui: {
    registerCommand(contribution: {
      id: string; title: string;
      panel?: 'sidebar' | 'command-palette' | 'toolbar'; icon?: string;
      execute: (args: PluginUiCommandArgs) => void | Promise<void>;
    }): void;
  };
  data: {
    registerDataSource(contribution: {
      id: string;
      kind: 'search' | 'embedding' | 'vector-store';
      search?: (query: string, options?: unknown) => Promise<unknown>;
      embed?: (texts: string[]) => Promise<number[][]>;
    }): void;
  };
  files: {
    readFile(relativePath: string): Promise<Uint8Array>;
    writeFile(relativePath: string, data: Uint8Array): Promise<void>;
    listDir(relativePath: string): Promise<string[]>;
  };
  network: {
    fetch(url: string, init?: RequestInit): Promise<Response>;
  };
}

// ── Permission tiering ───────────────────────────────────────────────────────

/** L2 permissions require explicit user authorization. */
export const L2_PERMISSIONS: ReadonlySet<PluginPermission> = new Set([
  'system:file',
  'system:network',
  'system:subprocess',
]);

/** L1 permissions are capability APIs declared in the manifest. */
export const L1_PERMISSIONS: ReadonlySet<PluginPermission> = new Set([
  'pipeline:parse',
  'ai:provider',
  'ui:command',
  'data:source',
]);
