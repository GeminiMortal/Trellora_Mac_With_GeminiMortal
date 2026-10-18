/**
 * Memory citation metadata stored with answers, and helpers to read it from metadata JSON.
 * 与回答一同存储的记忆引用元数据，以及从元数据 JSON 读取的辅助函数。
 */

import type { MemoryKind, MemoryOrigin } from '../electron/knowledge/memory/memoryConstants.ts';

/**
 * Citation metadata registered for one memory item used in an answer; stored with the answer, independently of the live memory item's lifecycle.
 * 回答中使用的单个记忆条目的引用元数据；随回答存储，与实时记忆条目的生命周期无关。
 */
export interface MemoryCitationMetadata {
  /** Id of the cited memory item. / 被引用记忆条目的 id。 */
  itemId: string;
  /** Display reference number within the answer. / 回答内的显示引用编号。 */
  reference: number;
  /** Topic of the cited memory. / 被引用记忆的主题。 */
  topic?: string;
  /** How the memory originated. / 记忆的产生方式。 */
  origin?: MemoryOrigin;
  /** Session that produced the memory. / 产生该记忆的会话。 */
  sourceSessionId?: string | null;
  /** Message that produced the memory. / 产生该记忆的消息。 */
  sourceMessageId?: string | null;
}

/**
 * Immutable content snapshot of a cited memory captured when the answer was produced.
 * 回答生成时捕获的被引用记忆的不可变内容快照。
 */
export interface MemoryCitationSnapshot extends Partial<Omit<MemoryCitationMetadata, 'itemId'>> {
  /** Id of the cited memory item. / 被引用记忆条目的 id。 */
  itemId: string;
  /** Kind of the memory item. / 记忆条目的类型。 */
  kind: MemoryKind;
  /** Memory content at citation time. / 引用时的记忆内容。 */
  contentSnapshot: string;
  /** ISO timestamp of when the memory was used. / 记忆被使用时的 ISO 时间戳。 */
  usedAt?: string;
}

/**
 * Availability of the original source text behind a citation.
 * 引用背后原始来源文本的可得性。
 */
export interface MemoryCitationSource {
  /** Whether the source is available, manual, or unavailable. / 来源是可用、手动还是不可用。 */
  status: 'available' | 'manual' | 'unavailable';
  /** Original user text when available. / 可用时的原始用户文本。 */
  userText?: string;
  /** ISO timestamp of the source message. / 来源消息的 ISO 时间戳。 */
  createdAt?: string;
}

/**
 * Read the citation metadata registered for one memory item from answer metadata JSON.
 * 从回答元数据 JSON 中读取为某个记忆条目注册的引用元数据。
 *
 * @param metadataJson - Serialized answer metadata JSON / 序列化的回答元数据 JSON
 * @param itemId - Memory item id to look up / 要查找的记忆条目 id
 * @returns Partial citation metadata; empty when unregistered or invalid / 部分引用元数据；未注册或无效时返回空对象
 */
// Old answers have no registered numbering; never infer it from their array order.
// 旧回答没有注册编号；绝不能从数组顺序推断编号。
export function readMemoryCitationMetadata(metadataJson: string | undefined, itemId: string): Partial<MemoryCitationMetadata> {
  try {
    const metadata: unknown = JSON.parse(metadataJson || '{}');
    if (!metadata || typeof metadata !== 'object' || !('memoryCitations' in metadata) || !Array.isArray(metadata.memoryCitations)) return {};
    const entry: unknown = metadata.memoryCitations.find((value: unknown) => value && typeof value === 'object' && 'itemId' in value && value.itemId === itemId);
    // The reference number must be a safe integer starting at 1; anything else means unregistered.
    // 引用编号必须是从 1 开始的安全整数；否则视为未注册。
    if (!entry || typeof entry !== 'object' || !('reference' in entry) || !Number.isSafeInteger(entry.reference) || Number(entry.reference) < 1) return {};
    const optionalText = (key: string) => key in entry && typeof (entry as Record<string, unknown>)[key] === 'string' ? (entry as Record<string, string>)[key] : undefined;
    const origin = optionalText('origin');
    return {
      reference: Number(entry.reference),
      ...(optionalText('topic') ? { topic: optionalText('topic') } : {}),
      ...(origin === 'manual' || origin === 'explicit' || origin === 'extracted' ? { origin } : {}),
      sourceSessionId: optionalText('sourceSessionId') ?? null,
      sourceMessageId: optionalText('sourceMessageId') ?? null,
    };
  } catch {
    return {};
  }
}
