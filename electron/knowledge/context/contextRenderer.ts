/**
 * Renders a ContextEnvelope into a ContextProjection by sorting materials into
 * channel-based prompts (system, user, tool), computing token estimates, and
 * producing a stable prefix fingerprint for cache eligibility.
 * 将 ContextEnvelope 渲染为 ContextProjection，按通道（system、user、tool）排序材料，
 * 计算 token 估算，并生成用于缓存资格判断的稳定前缀指纹。
 */
import { createHash } from 'node:crypto';
import { estimateTokenCount } from '../model/tokenEstimator.ts';
import { assertContextEnvelopeInvariants, assertContextProjectionInvariants } from './contextProjectionInvariants.ts';
import {
  CONTEXT_REQUEST_ENVELOPE_VERSION,
  type ContextChannel,
  type ContextEnvelope,
  type ContextMaterial,
  type ContextProjection,
  type ContextZone,
  type ProjectedContextMaterial,
} from './contextRuntimeTypes.ts';

const channelOrder: Record<ContextChannel, number> = { system: 0, user: 1, tool: 2 };
const zoneOrder: Record<ContextZone, number> = {
  'stable-policy': 10,
  'project-context': 20,
  'user-profile': 30,
  'long-term-memory': 35,
  'output-contract': 40,
  'agent-state': 50,
  'conversation-summary': 60,
  'conversation-hot': 70,
  'conversation-recall': 80,
  'note-capsule': 90,
  'dynamic-evidence': 100,
  'tool-observation': 110,
  'current-request': 120,
};

/**
 * Optional overrides for the envelope rendering process.
 * 信封渲染过程的可选覆盖参数。
 */
export interface RenderContextEnvelopeOptions {
  requestEnvelopeVersion?: string;
}

/**
 * Renders a ContextEnvelope into a ContextProjection. Materials are sorted by
 * channel then zone priority, split into system/user/tool prompts, and validated
 * against projection invariants before returning.
 * 将 ContextEnvelope 渲染为 ContextProjection。材料按通道和 zone 优先级排序，
 * 拆分为 system/user/tool prompt，并在返回前验证投影不变量。
 *
 * @param envelope - The context envelope to render / 需要渲染的上下文信封
 * @param options - Optional rendering overrides / 可选的渲染覆盖参数
 * @returns Validated context projection / 经过验证的上下文投影
 */
export function renderContextEnvelope(
  envelope: ContextEnvelope,
  options: RenderContextEnvelopeOptions = {},
): ContextProjection {
  assertContextEnvelopeInvariants(envelope);
  const requestEnvelopeVersion = options.requestEnvelopeVersion?.trim() || CONTEXT_REQUEST_ENVELOPE_VERSION;
  const ordered = [...envelope.materials].sort(compareContextMaterial);
  const systemMaterials = ordered.filter((material) => material.channel === 'system');
  const userMaterials = ordered.filter((material) => material.channel === 'user');
  const toolMaterials = ordered.filter((material) => material.channel === 'tool');
  const systemPrompt = joinMaterialContents(systemMaterials);
  const userPrompt = joinMaterialContents(userMaterials);
  const toolMessages = toolMaterials.map((material) => ({
    name: material.toolName?.trim() || material.source.kind,
    content: material.content,
  }));
  const serializedBudgetText = serializeContextRoleMessagesForBudget(systemPrompt, userPrompt, toolMessages);
  const included: ProjectedContextMaterial[] = ordered.map((material, order) => ({
    id: material.id,
    zone: material.zone,
    channel: material.channel,
    trust: material.trust,
    priority: material.priority,
    protected: material.protected,
    source: { ...material.source },
    estimatedTokens: estimateTokenCount(material.content),
    contentSha256: sha256(material.content),
    order,
  }));
  const projection: ContextProjection = {
    systemPrompt,
    userPrompt,
    ...(toolMessages.length ? { toolMessages } : {}),
    serializedBudgetText,
    requestEnvelopeVersion,
    pressureLevel: 0,
    included,
    omitted: [],
    stats: {
      candidateMaterials: envelope.materials.length,
      includedMaterials: included.length,
      omittedMaterials: 0,
      systemMaterials: systemMaterials.length,
      userMaterials: userMaterials.length,
      toolMaterials: toolMaterials.length,
      systemTokens: estimateTokenCount(systemPrompt),
      userTokens: estimateTokenCount(userPrompt),
      toolTokens: toolMessages.reduce((total, message) => total + estimateTokenCount(message.name) + estimateTokenCount(message.content), 0),
      serializedTokens: estimateTokenCount(serializedBudgetText),
    },
    stablePrefixFingerprint: createStablePrefixFingerprint(envelope, requestEnvelopeVersion),
  };
  assertContextProjectionInvariants(envelope, projection);
  return projection;
}

/**
 * Computes a SHA-256 fingerprint over all prefix-eligible stable materials in
 * normalized form, used for provider-side prompt caching.
 * 对所有前缀资格的稳定材料以规范化形式计算 SHA-256 指纹，用于 provider 端 prompt 缓存。
 *
 * @param envelope - The context envelope / 上下文信封
 * @param requestEnvelopeVersion - Envelope version string, defaults to current / 信封版本字符串，默认为当前版本
 * @returns Hex-encoded SHA-256 fingerprint / 十六进制编码的 SHA-256 指纹
 */
export function createStablePrefixFingerprint(envelope: ContextEnvelope, requestEnvelopeVersion = CONTEXT_REQUEST_ENVELOPE_VERSION): string {
  const stableMaterials = [...envelope.materials]
    .filter((material) => material.cache.prefixEligible)
    .sort(compareContextMaterial)
    .map((material) => ({
      id: material.id,
      zone: material.zone,
      channel: material.channel,
      sourceKind: material.source.kind,
      sourceId: material.source.id,
      sourceVersion: material.source.version,
      content: normalizeStableContent(material.content),
    }));
  return sha256(JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    requestEnvelopeVersion,
    materials: stableMaterials,
  }));
}

/**
 * Compares two ContextMaterials for deterministic ordering: channel first, then
 * zone priority, descending material priority, then lexicographic id and source id.
 * 比较两个 ContextMaterial 的确定性排序：先按通道，再按 zone 优先级，降序材料优先级，最后按字典序 id 和 source id。
 *
 * @param first - First material / 第一个材料
 * @param second - Second material / 第二个材料
 * @returns Negative, zero, or positive comparison result / 负、零或正的比较结果
 */
export function compareContextMaterial(first: ContextMaterial, second: ContextMaterial): number {
  return channelOrder[first.channel] - channelOrder[second.channel]
    || zoneOrder[first.zone] - zoneOrder[second.zone]
    || second.priority - first.priority
    || compareText(first.id, second.id)
    || compareText(first.source.id, second.source.id);
}

// Joins all material content strings with double newlines to form a single prompt body.
// 将所有材料内容字符串以双换行拼接，组成单一 prompt 正文。
function joinMaterialContents(materials: readonly ContextMaterial[]): string {
  return materials.map((material) => material.content).join('\n\n');
}

/**
 * Stable role serialization used by the scheduler, calibration key, and renderer.
 * 调度器、校准键和渲染器使用的稳定角色序列化。
 *
 * @param systemPrompt - System channel content / System 通道内容
 * @param userPrompt - User channel content / User 通道内容
 * @param toolMessages - Tool channel messages with name and content / Tool 通道消息，包含名称和内容
 * @returns Serialized role-prefixed prompt string / 带角色前缀的序列化 prompt 字符串
 */
export function serializeContextRoleMessagesForBudget(
  systemPrompt: string,
  userPrompt: string,
  toolMessages: readonly { name: string; content: string }[],
): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`[role:system]\n${systemPrompt}`);
  if (userPrompt) parts.push(`[role:user]\n${userPrompt}`);
  for (const message of toolMessages) parts.push(`[role:tool name=${message.name}]\n${message.content}`);
  return parts.join('\n\n');
}

// Normalizes line endings to LF, strips trailing whitespace per line, and trims.
// Used before hashing stable-prefix content for deterministic fingerprints.
// 将换行符规范化为 LF，去除每行尾部空白并 trim。用于哈希稳定前缀内容以生成确定性指纹。
function normalizeStableContent(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .trim();
}

function compareText(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
