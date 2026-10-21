/**
 * Trellora Plugin SDK — type definitions.
 * Trellora 插件 SDK —— 类型定义。
 *
 * Public API surface for plugin authors. All core APIs (L0) are freely
 * available; capability APIs (L1) and system APIs (L2) require explicit
 * permission declarations in plugin.json.
 *
 * Stability: `@experimental` APIs may change without a major bump until
 * the 1.4.0 plugin API freeze. Non-tagged APIs follow semver.
 *
 * Stability tiers / 稳定性分级:
 *   - @experimental — may change before 1.4.0 freeze / 1.4.0 冻结前可能变更
 *   - (none)        — stable, semver-protected / 稳定，遵循 semver
 */

// ── Manifest ─────────────────────────────────────────────────────────────────

/** Trellora engine compatibility range. Trellora 引擎兼容范围。 */
export interface PluginEngineRange {
  /** Semver range against Trellora version, e.g. ">=1.3.0". */
  trellora: string;
}

/** Permission tier identifiers. 权限层级标识。 */
export type PluginPermission =
  // L1 capability APIs
  | 'pipeline:parse'
  | 'ai:provider'
  | 'ui:command'
  | 'data:source'
  // L2 system APIs (explicit user authorization required)
  | 'system:file'
  | 'system:network'
  | 'system:subprocess';

/** Activation events: when the plugin should be loaded. 激活事件。 */
export type PluginActivationEvent =
  | 'onStartup'
  | 'onParseRequest'
  | 'onAiRequest'
  | 'onUiCommand'
  | '*';

/** Static contribution declarations (mirrored at runtime via the API). */
export interface PluginContributions {
  parsingRoutes?: Array<{ extension: string; route: string }>;
  aiProviders?: Array<{ id: string; api: string }>;
  uiCommands?: Array<{ id: string; title: string; panel?: 'sidebar' | 'command-palette' | 'toolbar' }>;
}

/** plugin.json manifest. 插件清单。 */
export interface PluginManifest {
  /** Reverse-DNS unique id, e.g. "com.example.markdown-extra". */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  /** Entry module relative to the plugin root. 入口模块。 */
  main: string;
  engine: PluginEngineRange;
  permissions: PluginPermission[];
  activation: PluginActivationEvent[];
  contributes?: PluginContributions;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Plugin entry contract. The module loaded from `main` must export an object
 * satisfying this interface (default export or `activate` named export).
 * 插件入口契约：`main` 指向的模块必须导出符合该接口的对象。
 */
export interface TrelloraPlugin {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ── Core (L0) ────────────────────────────────────────────────────────────────

/** Plugin-scoped logger. Prefixes every line with [plugin:<id>]. 插件日志器。 */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Read-only plugin configuration (from plugin.json + user overrides). */
export interface PluginConfig {
  get<T = unknown>(key: string, fallback?: T): T;
  has(key: string): boolean;
  /** All keys the manifest declared in `settings`. */
  keys(): readonly string[];
}

/**
 * Typed event bus shared with the host. Host events are namespaced
 * `host:<event>`; plugins may emit their own `plugin:<event>` events visible
 * to other plugins with the same permission.
 * 事件总线。
 */
export interface PluginEventBus {
  on(event: string, listener: (payload: unknown) => void): () => void;
  once(event: string, listener: (payload: unknown) => void): () => void;
  off(event: string, listener: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
}

// ── Capability APIs (L1) ─────────────────────────────────────────────────────

/** Input contract for a plugin parsing route handler. */
export interface PluginParseInput {
  inputPath: string;
  outputDir: string;
  extension: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, message?: string) => void;
}

/** Output contract for a plugin parsing route handler. */
export interface PluginParseOutput {
  /** Relative path (within outputDir) of the produced markdown. */
  markdownFile: string;
  /** Optional counts for pipeline status reporting. */
  counts?: Record<string, number>;
}

/** @experimental Parsing-route extension point. 解析路由扩展点。 */
export interface PluginParsingRouteApi {
  registerParsingRoute(contribution: {
    extension: string;
    route: string;
    handler: (input: PluginParseInput) => Promise<PluginParseOutput>;
  }): void;
}

/** AI generation request passed to a plugin provider. */
export interface PluginAiGenerationInput {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** JSON mode hint for structured outputs. */
  format?: 'json';
}

/** AI generation response from a plugin provider. */
export interface PluginAiGenerationOutput {
  text: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

/** @experimental AI provider extension point. AI Provider 扩展点。 */
export interface PluginAiProviderApi {
  registerProvider(contribution: {
    id: string;
    /** Must match one of the host's AiGenerationApi strings. */
    api: 'ollama-chat' | 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generate-content';
    endpoint: string;
    generate: (input: PluginAiGenerationInput) => Promise<PluginAiGenerationOutput>;
    listModels?: () => Promise<string[]>;
  }): void;
}

/** UI command invocation arguments. */
export interface PluginUiCommandArgs {
  /** The exact trigger context: command palette, sidebar button, etc. */
  trigger: 'command-palette' | 'sidebar' | 'toolbar';
  /** Optional payload supplied by the host. */
  payload?: unknown;
}

/** @experimental UI command extension point (commands + sidebar buttons). */
export interface PluginUiCommandApi {
  registerCommand(contribution: {
    id: string;
    title: string;
    panel?: 'sidebar' | 'command-palette' | 'toolbar';
    icon?: string;
    execute: (args: PluginUiCommandArgs) => void | Promise<void>;
  }): void;
}

/** @experimental Data-source extension point (search / retrieval sources). */
export interface PluginDataSourceApi {
  registerDataSource(contribution: {
    id: string;
    kind: 'search' | 'embedding' | 'vector-store';
    search?: (query: string, options?: unknown) => Promise<unknown>;
    embed?: (texts: string[]) => Promise<number[][]>;
  }): void;
}

// ── System APIs (L2, explicit authorization) ─────────────────────────────────

/** Bounded file access: only paths under the workspace root are reachable. */
export interface PluginFileApi {
  readFile(relativePath: string): Promise<Uint8Array>;
  writeFile(relativePath: string, data: Uint8Array): Promise<void>;
  listDir(relativePath: string): Promise<string[]>;
}

/** Outbound HTTP restricted to https URLs; the host applies SSRF guards. */
export interface PluginNetworkApi {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

// ── Context ──────────────────────────────────────────────────────────────────

/**
 * Everything handed to a plugin on `activate`. Capability/system sub-APIs
 * throw `PluginPermissionDeniedError` at call time when the corresponding
 * permission is missing from plugin.json.
 * 插件激活上下文。
 */
export interface PluginContext {
  /** Plugin manifest (read-only). */
  readonly manifest: Readonly<PluginManifest>;
  /** Plugin-scoped storage directory (created lazily). */
  readonly storageDir: string;

  // L0 core
  readonly log: PluginLogger;
  readonly config: PluginConfig;
  readonly events: PluginEventBus;

  // L1 capabilities (permission: pipeline:parse / ai:provider / ui:command / data:source)
  readonly pipeline: PluginParsingRouteApi;
  readonly ai: PluginAiProviderApi;
  readonly ui: PluginUiCommandApi;
  readonly data: PluginDataSourceApi;

  // L2 system (permission: system:file / system:network)
  readonly files: PluginFileApi;
  readonly network: PluginNetworkApi;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when an L1/L2 API is invoked without the required permission. */
export declare class PluginPermissionDeniedError extends Error {
  readonly pluginId: string;
  readonly permission: PluginPermission;
}

/** Thrown when a plugin call exceeds the host's execution budget. */
export declare class PluginTimeoutError extends Error {
  readonly pluginId: string;
  readonly api: string;
}
