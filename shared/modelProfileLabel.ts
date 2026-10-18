/**
 * Default label generation and detection for AI model profiles.
 * AI 模型档案默认标签的生成与识别。
 */

/**
 * Configuration describing a model profile when deriving its default label.
 * 推导模型档案默认标签时描述档案的配置。
 */
export interface ModelProfileLabelConfig {
  /** Whether the profile targets Ollama or an OpenAI-compatible API. / 档案面向 Ollama 还是 OpenAI 兼容 API。 */
  kind: 'ollama' | 'openai-compatible';
  /** Provider key used for the label. / 用于标签的供应商键。 */
  provider?: string;
  /** Generation model name. / 生成模型名称。 */
  model?: string;
  /** Embedding model name. / 嵌入模型名称。 */
  embeddingModel?: string;
}

/**
 * Display names for known providers.
 * 已知供应商的显示名称。
 */
const providerLabels: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI',
  qwen: '通义千问（百炼）',
  zhipu: '智谱 AI',
  siliconflow: 'SiliconFlow',
  openrouter: 'OpenRouter',
  custom: '自定义 API',
};

/**
 * Labels that count as auto-generated and may be replaced on reconfiguration.
 * 视为自动生成、可在重新配置时替换的标签集合。
 */
const generatedProfileLabels = new Set(['新模型档案', '远程默认模型', '本地默认模型']);

/**
 * Build the default display label for a model profile, capped at 60 characters.
 * 构建模型档案的默认显示标签，最长 60 个字符。
 *
 * @param config - Profile configuration to label / 要生成标签的档案配置
 * @returns Display label in the form Provider_Model / 形如 供应商_模型 的显示标签
 */
export function getDefaultModelProfileLabel(config: ModelProfileLabelConfig): string {
  const provider = config.kind === 'ollama' ? 'Ollama' : providerLabels[config.provider ?? 'custom'] ?? '自定义 API';
  const version = config.model?.trim() || config.embeddingModel?.trim() || '未配置';
  // Character-level truncation keeps the label short for CJK names without cutting surrogate pairs.
  // 按字符截断以缩短含中文名称的标签，且不会切断代理对。
  return Array.from(`${provider}_${version}`).slice(0, 60).join('');
}

/**
 * Whether a label is empty or one of the auto-generated defaults.
 * 标签是否为空，或属于自动生成的默认标签。
 *
 * @param label - Label to test / 要判断的标签
 * @returns True when the label is empty or auto-generated / 标签为空或为自动生成时返回 true
 */
export function isGeneratedModelProfileLabel(label: string | undefined): boolean {
  const normalized = label?.trim() ?? '';
  return !normalized || generatedProfileLabels.has(normalized);
}
