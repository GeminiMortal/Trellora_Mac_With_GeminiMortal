/**
 * Heuristics for picking embedding model names from a provider's /models list.
 * 从提供商 /models 列表中挑选嵌入模型名的启发式规则。
 */

// Name patterns that indicate an embedding/vector model. / 表明是嵌入/向量模型的名称特征。
const EMBEDDING_NAME_PATTERNS = [
  /embed(?:ding)?/iu,
  /(?:^|[-_/.])(?:bge|e5|gte|m3e)(?:$|[-_/.]|\d)/iu,
  /(?:^|[-_/.])(?:jina[-_]?embeddings|nomic[-_]?embed|sentence[-_]?transformers?)(?:$|[-_/.])/iu,
];

// Name patterns that indicate a non-embedding model. / 表明不是嵌入模型的名称特征。
const NON_EMBEDDING_NAME_PATTERNS = [
  /(?:^|[-_/.])(?:rerank|ranker|cross[-_]?encoder)(?:$|[-_/.])/iu,
  /(?:image|vision|\bvl\b|chat|instruct|coder|completion|reason)/iu,
];

/**
 * OpenAI-compatible /models only guarantees model names, so the client cannot
 * ask every provider for a reliable task type. Keep only names that clearly
 * indicate embedding/vector usage and leave unknown names to the custom input.
 * OpenAI 兼容的 /models 只保证返回模型名，客户端无法向所有提供商询问可靠的任务类型。
 * 因此只保留名称明显指向嵌入/向量用途的模型，未知名称留给自定义输入。
 *
 * @param models - Raw model names from the provider / 提供商返回的原始模型名
 * @param presets - Preset names always kept / 始终保留的预设模型名
 * @returns Filtered embedding model names / 过滤后的嵌入模型名
 */
export function selectEmbeddingModelNames(models: string[], presets: string[] = []): string[] {
  const presetNames = new Set(presets.map((model) => model.trim().toLocaleLowerCase()).filter(Boolean));
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)))
    .filter((model) => {
      const normalized = model.toLocaleLowerCase();
      if (NON_EMBEDDING_NAME_PATTERNS.some((pattern) => pattern.test(model))) return false;
      return presetNames.has(normalized) || EMBEDDING_NAME_PATTERNS.some((pattern) => pattern.test(model));
    });
}
