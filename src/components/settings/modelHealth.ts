import type { AiModelSettings, ModelHub } from '../../electron';

export interface ModelHealthItem {
  key: 'generation' | 'embedding' | 'rerank';
  label: string;
  ok: boolean;
  reason: string | null;
  /** 修复入口对应的类别；生成模型走档案列表，嵌入/重排走中枢面板。 */
  fixCategory: 'generation' | 'embedding' | 'rerank';
}

/** 生成模型的可用性：默认档案存在、有连接方式、且选了模型。 */
function evaluateGeneration(settings: AiModelSettings): ModelHealthItem {
  const profile = settings.profiles.find((entry) => entry.id === settings.defaultProfileId) ?? settings.profiles[0] ?? null;
  if (!profile) return { key: 'generation', label: '生成模型', ok: false, reason: '还没有配置任何语言模型连接', fixCategory: 'generation' };
  if (profile.config.kind === 'openai-compatible' && !profile.config.model && !profile.config.hasApiKey) {
    return { key: 'generation', label: '生成模型', ok: false, reason: `默认连接「${profile.label || '未命名连接'}」还没有选择模型和 API Key`, fixCategory: 'generation' };
  }
  if (!profile.config.model) {
    return { key: 'generation', label: '生成模型', ok: false, reason: `默认连接「${profile.label || '未命名连接'}」还没有选择模型`, fixCategory: 'generation' };
  }
  return { key: 'generation', label: '生成模型', ok: true, reason: profile.config.model, fixCategory: 'generation' };
}

/** 槽位可用性：未启用视为"不需要"，未选模型给出缺失原因。 */
function evaluateSlot(hub: ModelHub, key: 'embedding' | 'rerank', label: string): ModelHealthItem {
  const slot = hub.slots[key];
  if (slot.source === 'none') return { key, label, ok: true, reason: '未启用', fixCategory: key };
  if (!slot.model) return { key, label, ok: false, reason: `${label}已启用但没有选择模型`, fixCategory: key };
  return { key, label, ok: true, reason: slot.model, fixCategory: key };
}

/** 三类模型职责的健康状态；全部就绪时面板折叠为一行确认。 */
export function evaluateModelHealth(settings: AiModelSettings, hub: ModelHub): ModelHealthItem[] {
  return [evaluateGeneration(settings), evaluateSlot(hub, 'embedding', '嵌入模型'), evaluateSlot(hub, 'rerank', '重排模型')];
}

/** 扫描自动迁移生成的空档案（未选模型的 Ollama 且非默认），支持一键清理。 */
export function findZombieProfiles(settings: AiModelSettings): string[] {
  return settings.profiles
    .filter((profile) => profile.id !== settings.defaultProfileId)
    .filter((profile) => profile.config.kind === 'ollama' && !profile.config.model && (profile.config.availableModels?.length ?? 0) === 0)
    .map((profile) => profile.id);
}
