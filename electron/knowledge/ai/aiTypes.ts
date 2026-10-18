/**
 * Shared type definitions for AI providers, model profiles, skills and settings.
 * AI 提供商、模型档案、技能与设置的共享类型定义。
 */

/**
 * Structured insight generated for a note: summary, key points and suggested tags.
 * 为笔记生成的结构化洞察：摘要、要点与建议标签。
 */
export interface AiInsightPayload {
  /** Concise summary of the note. / 笔记的简明摘要。 */
  summary: string;
  /** Key points extracted from the note. / 从笔记中提取的要点。 */
  keyPoints: string[];
  /** Suggested tags for the note. / 建议的笔记标签。 */
  suggestedTags: string[];
}

/**
 * How the app connects to a model: local Ollama or an openai-compatible remote endpoint.
 * 应用与模型的连接方式：本地 Ollama 或 openai-compatible 远程端点。
 */
export type AiProviderKind = 'ollama' | 'openai-compatible';

/**
 * Well-known remote vendor identifiers; `custom` covers user-defined endpoints.
 * 已知远程厂商标识；`custom` 表示用户自定义端点。
 */
export type AiRemoteProviderId = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'moonshot' | 'qwen' | 'zhipu' | 'siliconflow' | 'openrouter' | 'custom';

/**
 * Wire protocol used by a generation model. Provider identity and protocol are
 * intentionally separate so multiple vendors can share one transport adapter.
 * 生成模型使用的线路协议；提供商身份与协议刻意分离，允许多个厂商共用同一传输适配器。
 * Variants: `ollama-chat` (local Ollama), `openai-completions` (legacy completions),
 * `openai-responses` (Responses API), `anthropic-messages` (Claude), `google-generate-content` (Gemini).
 */
export type AiGenerationApi =
  | 'ollama-chat'
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generate-content';

/**
 * Persisted insight record for a note, including provenance (provider, model and generation time).
 * 持久化的笔记洞察记录，含来源信息（提供商、模型与生成时间）。
 */
export interface AiInsight extends AiInsightPayload {
  /** Path of the note the insight was generated for. / 该洞察所属笔记的路径。 */
  notePath: string;
  /** Content hash of the note at generation time. / 生成时笔记内容的哈希。 */
  contentHash: string;
  /** Provider kind used for generation. / 生成所用的提供商类型。 */
  provider: AiProviderKind;
  /** Model used for generation. / 生成所用的模型。 */
  model: string;
  /** ISO timestamp of generation. / 生成时间的 ISO 时间戳。 */
  generatedAt: string;
}

/**
 * Model entry as listed by Ollama or a remote catalog, with optional capability metadata.
 * Ollama 或远程目录列出的模型条目，含可选能力元数据。
 */
export interface OllamaModel {
  /** Model identifier. / 模型标识。 */
  name: string;
  /** Model size in bytes when reported by Ollama. / Ollama 上报的模型大小（字节）。 */
  size?: number;
  /** ISO timestamp of the model's last modification. / 模型最后修改时间的 ISO 时间戳。 */
  modifiedAt?: string;
  /** Context window size in tokens, if known. / 上下文窗口大小（token 数），如已知。 */
  contextWindowTokens?: number;
  /** Provenance of contextWindowTokens: 'provider' from the API, 'ollama' from local heuristics. / contextWindowTokens 来源：'provider' 来自 API，'ollama' 来自本地启发。 */
  contextWindowSource?: 'provider' | 'ollama';
  /** Maximum output token count, if declared. / 最大输出 token 数（如声明）。 */
  maxOutputTokens?: number;
  /** Whether the model supports extended reasoning / thinking. / 模型是否支持扩展推理/思考。 */
  reasoning?: boolean;
}

/**
 * Full connection configuration for one model profile (local or remote).
 * 单个模型档案的完整连接配置（本地或远程）。
 */
export interface AiProviderConfig {
  /** Connection mode: local Ollama or openai-compatible remote. / 连接模式：本地 Ollama 或 openai-compatible 远程。 */
  kind: AiProviderKind;
  /** Remote vendor identity when kind is 'openai-compatible'. / kind 为 'openai-compatible' 时的远程厂商标识。 */
  provider?: AiRemoteProviderId;
  /** Wire protocol for the generation API. / 生成 API 的线路协议。 */
  api?: AiGenerationApi;
  /** Base endpoint URL of the provider. / 提供商基础地址。 */
  endpoint?: string;
  /** API authentication key (never exposed to renderer). / API 鉴权密钥（不暴露给渲染进程）。 */
  apiKey?: string;
  /** Default model identifier to call. / 默认调用的模型标识。 */
  model?: string;
  /**
   * Present only when the user explicitly set a cap in Settings.
   * 仅当用户在设置中明确指定上限时存在。
   */
  contextWindowTokens?: number;
  /** Provenance of the context window cap; only 'user' is used today. / 上下文窗口上限来源；目前仅使用 'user'。 */
  contextWindowTokensSource?: 'user';
  /** Model used for embeddings (e.g. vector indexing). / 用于嵌入的模型（如向量索引）。 */
  embeddingModel?: string;
  /** Cached catalog of models known to this provider. / 该提供商已知模型的缓存目录。 */
  availableModels?: OllamaModel[];
  /** Whether the user has consented to sending content to this remote provider. / 用户是否已同意向该远程提供商发送内容。 */
  remoteContentConsent?: boolean;
}

/**
 * Health snapshot of a provider connection returned by connectivity checks.
 * 连接性检查返回的提供商连接健康快照。
 */
export interface AiProviderStatus {
  /** Whether the provider endpoint is reachable. / 提供商端点是否可达。 */
  available: boolean;
  /** Endpoint URL that was checked. / 已检查的端点地址。 */
  endpoint: string;
  /** Models discovered at the endpoint. / 端点发现的模型列表。 */
  models: OllamaModel[];
  /** Optional human-readable status message. / 可选的可读状态消息。 */
  message?: string;
}

/**
 * User-facing model profile: an id/label pair wrapping a provider config.
 * 面向用户的模型档案：由标识/名称包装的提供商配置。
 */
export interface AiModelProfile {
  /** Unique profile identifier (pattern: model_XXXXXXXX). / 档案唯一标识（格式：model_XXXXXXXX）。 */
  id: string;
  /** Human-readable label shown in the UI. / 界面中显示的可读名称。 */
  label: string;
  /** Underlying provider connection config. / 底层提供商连接配置。 */
  config: AiProviderConfig;
}

/**
 * Renderer-safe provider config with the API key replaced by a presence flag.
 * 渲染进程安全的提供商配置：API 密钥替换为存在性标记。
 */
export type AiProviderConfigView = Omit<AiProviderConfig, 'apiKey'> & { hasApiKey: boolean };

/**
 * Renderer-safe model profile using the redacted config view.
 * 使用脱敏配置视图的渲染进程安全模型档案。
 */
export interface AiModelProfileView {
  /** Unique profile identifier. / 档案唯一标识。 */
  id: string;
  /** Human-readable label. / 可读名称。 */
  label: string;
  /** Redacted provider config safe for the renderer. / 脱敏后可安全暴露给渲染进程的提供商配置。 */
  config: AiProviderConfigView;
}

/**
 * Persisted model settings as exposed after redaction (schema version 1).
 * 脱敏后暴露的持久化模型设置（schema 版本 1）。
 */
export interface AiModelSettings {
  /** Schema version for forward compatibility. / 用于前向兼容的 schema 版本。 */
  schemaVersion: 1;
  /** Id of the active profile. / 当前激活的档案标识。 */
  defaultProfileId: string;
  /** All configured model profiles (redacted). / 全部已配置的模型档案（脱敏后）。 */
  profiles: AiModelProfileView[];
}

/**
 * Validated model settings with full configs before redaction.
 * 脱敏前、含完整配置的已校验模型设置。
 */
export interface AiModelSettingsInput {
  /** Id of the active profile. / 当前激活的档案标识。 */
  defaultProfileId: string;
  /** All configured model profiles (with full credentials). / 全部已配置的模型档案（含完整凭据）。 */
  profiles: AiModelProfile[];
}

/**
 * Generation style hint a skill applies to assistant output.
 * 技能施加于助手输出的生成风格提示。
 * `factual` prioritizes precision, `balanced` mixes accuracy and variety, `creative` favors expressiveness.
 */
export type AiSkillGenerationStyle = 'factual' | 'balanced' | 'creative';

/**
 * Configured assistant skill: prompt constraints injected when the user enables it.
 * 已配置的助手技能：用户启用后注入的提示词约束。
 */
export interface AiSkill {
  /** Unique skill identifier. / 技能唯一标识。 */
  id: string;
  /** Human-readable skill name. / 可读的技能名称。 */
  name: string;
  /**
   * Short discovery text. The full instruction is injected only after selection.
   * 简短的发现文本；完整的 instruction 仅在选中后注入。
   */
  description: string;
  /** Full prompt constraint injected into the system message. / 注入系统消息的完整提示词约束。 */
  instruction: string;
  /** Generation style the skill applies. / 技能应用的生成风格。 */
  generationStyle: AiSkillGenerationStyle;
  /** Whether the skill is currently enabled. / 技能是否处于启用状态。 */
  enabled: boolean;
  /** Whether the skill is a built-in (system) skill. / 是否为内置（系统）技能。 */
  system: boolean;
}

/**
 * Management state for a directory-skill (AI-Skill/<name>/SKILL.md), keyed by frontmatter name.
 * 目录形态技能（AI-Skill/<name>/SKILL.md）的管理状态，按 frontmatter name 记录。
 */
export interface DirectorySkillOverride {
  /** Whether the directory skill is enabled. / 该目录技能是否启用。 */
  enabled: boolean;
  /**
   * 通过应用导入时记录的时间（ISO）；用户手动放置的技能没有该字段。
   * ISO timestamp recorded when the skill was imported via the app; absent for manually placed skills.
   */
  importedAt?: string;
}

/**
 * Persisted AI extension settings (schema version 1): skills and directory-skill overrides.
 * 持久化的 AI 扩展设置（schema 版本 1）：技能与目录技能覆盖。
 */
export interface AiExtensionsSettings {
  /** Schema version for forward compatibility. / 用于前向兼容的 schema 版本。 */
  schemaVersion: 1;
  /** Configured assistant skills. / 已配置的助手技能列表。 */
  skills: AiSkill[];
  /**
   * 目录技能启停/来源登记；字段缺省或名字不在表中时视为启用。
   * Directory skill enable/disable and import-state map; absent or unmapped entries are treated as enabled.
   */
  directorySkillOverrides?: Record<string, DirectorySkillOverride>;
}

/**
 * Source shape accepted when importing a skill: a folder, zip archive, or single markdown file.
 * 导入技能时接受的来源形态：文件夹、zip 压缩包或单个 markdown 文件。
 */
export type AiSkillImportKind = 'folder' | 'zip' | 'markdown';

/**
 * Result of importing a skill from an external source.
 * 从外部来源导入技能的结果。
 */
export interface SkillImportResult {
  /** Whether the import succeeded. / 导入是否成功。 */
  ok: boolean;
  /** Name of the imported skill. / 导入的技能名称。 */
  skillName?: string;
  /** Number of resource files bundled with the skill. / 技能附带的资源文件数量。 */
  resourceFileCount?: number;
  /**
   * 面向用户的中文失败原因；ok 为 false 时存在（用户取消对话框除外）。
   * User-facing failure reason in Chinese; present when ok is false (except when the user canceled the dialog).
   */
  error?: string;
}

/**
 * Form fields for creating a skill from the settings UI.
 * 设置界面创建技能的表单字段。
 */
export interface SkillFormCreateInput {
  /** Skill name. / 技能名称。 */
  name: string;
  /** Short discovery description. / 简短的发现描述。 */
  description: string;
  /** Full prompt instruction. / 完整的提示词指令。 */
  instruction: string;
}

/**
 * Result of updating a skill's SKILL.md document.
 * 更新技能 SKILL.md 文档的结果。
 */
export interface SkillDocumentUpdateResult {
  /** Whether the update succeeded. / 更新是否成功。 */
  ok: boolean;
  /** Error message when the update failed. / 更新失败时的错误消息。 */
  error?: string;
}

/**
 * Result of exporting a skill to a file.
 * 将技能导出到文件的结果。
 */
export interface SkillExportResult {
  /** Whether the export succeeded. / 导出是否成功。 */
  ok: boolean;
  /**
   * 用户在保存对话框中取消时为 true，不视为错误。
   * True when the user canceled the save dialog; not treated as an error.
   */
  canceled?: boolean;
  /** Error message when the export failed. / 导出失败时的错误消息。 */
  error?: string;
}

/**
 * Overview entry for a directory skill displayed in the settings page.
 * 设置页显示的目录技能总览条目。
 */
export interface DirectorySkillOverviewEntry {
  /** Directory-skill name from frontmatter. / 来自 frontmatter 的目录技能名称。 */
  name: string;
  /** Short discovery description. / 简短的发现描述。 */
  description: string;
  /**
   * SKILL.md 正文（供设置页查看；与 read_skill 加载内容一致）。
   * SKILL.md body text shown in settings; matches the content loaded by read_skill.
   */
  instruction: string;
  /** Number of additional text files in the skill directory. / 技能目录内附加文本文件数量。 */
  resourceFileCount: number;
  /** Whether the skill is enabled. / 技能是否启用。 */
  enabled: boolean;
  /** Whether the skill is a built-in system skill. / 是否为内置系统技能。 */
  system: boolean;
  /** ISO import timestamp, if imported via the app. / 导入时间 ISO 时间戳（通过应用导入时）。 */
  importedAt?: string;
}

/**
 * A directory skill problem: path and human-readable reason.
 * 目录技能问题：路径与可读原因。
 */
export interface DirectorySkillIssue {
  /** Path of the problematic skill directory. / 问题技能目录的路径。 */
  directory: string;
  /** Human-readable reason the skill was skipped or dropped. / 该技能被跳过或丢弃的可读原因。 */
  reason: string;
}

/**
 * Directory-skill overview for the settings page (loadDirectorySkills + store state projection).
 * 设置页「AI 助手技能」的目录技能总览（loadDirectorySkills + store 登记状态投影）。
 */
export interface AiSkillsOverview {
  /** Successfully loaded directory skills. / 成功加载的目录技能。 */
  directorySkills: DirectorySkillOverviewEntry[];
  /**
   * 校验失败/超限未加载的目录技能。
   * Directory skills that failed validation or exceeded limits and were not loaded.
   */
  skipped: DirectorySkillIssue[];
  /**
   * 与设置技能重名而被放弃并入的目录技能（运行期不生效）。
   * Directory skills that collided with a settings skill by name and were dropped (inactive at runtime).
   */
  nameConflicts: DirectorySkillIssue[];
}

/**
 * Lightweight model/skill options passed to the assistant UI for a turn.
 * 传给助手界面的轻量级模型/技能选项（每轮对话）。
 */
export interface AssistantAiOptions {
  /** Available model profiles for the picker. / 可供选择的模型档案。 */
  profiles: Array<Pick<AiModelProfileView, 'id' | 'label'> & { kind: AiProviderKind; provider?: AiRemoteProviderId; model?: string; contextWindowTokens?: number }>;
  /** Available skills for the turn. / 本轮可用的技能列表。 */
  skills: Array<Pick<AiSkill, 'id' | 'name' | 'description' | 'enabled' | 'system'>>;
  /** Profile to use when no explicit selection is made. / 未明确选择时使用的默认档案标识。 */
  defaultProfileId: string;
}
