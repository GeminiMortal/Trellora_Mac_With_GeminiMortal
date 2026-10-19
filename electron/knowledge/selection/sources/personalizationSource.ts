/**
 * Collects a deliberately narrow preference channel from the user profile for
 * selection editing. Only active, non-sensitive style/terminology items are
 * projected; the output is never factual evidence.
 * 为选区编辑收集刻意收窄的用户画像偏好通道。仅投影活跃、非敏感的风格与术语条目；
 * 输出绝不作为事实证据。
 */
import { isSensitiveProfileContent } from '../../userProfile/userProfileExtractor.ts';
import type { UserProfileContextSnapshot, UserProfileItem } from '../../userProfile/userProfileTypes.ts';

/**
 * Budget and allowlist for personalization projection: at most 8 items, each
 * value truncated to 160 characters, restricted to style/terminology categories.
 * 个性化投影的预算与白名单：最多 8 条，每条值截断到 160 字符，仅限风格/术语类目。
 */
const MAX_PERSONALIZATION_ITEMS = 8;
const MAX_PERSONALIZATION_VALUE_CHARS = 160;
const PERSONALIZATION_CATEGORIES = new Set<UserProfileItem['category']>([
  'communication',
  'professional',
  'expertise',
  'technical-environment',
]);

/**
 * Runtime dependency injected by Electron main: a frozen profile snapshot.
 * 由 Electron 主进程注入的运行时依赖：一份冻结的用户画像快照。
 */
export interface SelectionEditPersonalizationRuntime {
  snapshot: UserProfileContextSnapshot;
}

/**
 * Model-visible preference items plus a transparency receipt describing whether
 * personalization was requested and applied.
 * 模型可见的偏好条目，以及说明个性化是否被请求与实际应用的透明回执。
 */
export interface SelectionEditPersonalization {
  /**
   * Model-visible data is kept separate from factual evidence and citations.
   * 模型可见数据与事实证据和引用严格分离。
   */
  items: Array<{ fieldLabel: string; valueText: string }>;
  receipt: {
    requested: boolean;
    applied: boolean;
    itemCount: number;
    reason?: string;
  };
}

/**
 * Produces a deliberately narrow, untrusted preference channel. It never
 * reads conversation history, long-term memory retrieval, or profile evidence;
 * only active, non-sensitive profile items intended for style/terminology are
 * projected. The caller must still place the output outside Evidence Ledger.
 * 产出一条刻意收窄、不可信的偏好通道。它不读取对话历史、长期记忆检索或画像证据；
 * 仅投影用于风格/术语的活跃非敏感画像条目。调用方仍须将输出放在证据账本之外。
 *
 * @param runtime - Profile snapshot runtime, or undefined when unavailable / 画像快照运行时，不可用时为 undefined
 * @returns Preference items and an application receipt / 偏好条目与应用回执
 */
export function collectSelectionEditPersonalization(
  runtime: SelectionEditPersonalizationRuntime | undefined,
): SelectionEditPersonalization {
  if (!runtime) return emptyPersonalization('个性化资料未准备就绪。');
  const { settings } = runtime.snapshot;
  if (!settings.useInQaContext || !settings.allowKnowledgeBase) {
    return emptyPersonalization('个性化资料未在知识库编辑场景中获授权。');
  }
  const items = runtime.snapshot.items
    .filter((item) => item.status === 'active')
    .filter((item) => PERSONALIZATION_CATEGORIES.has(item.category))
    .filter((item) => !isSensitiveProfileContent(`${item.fieldLabel} ${item.valueText}`))
    // User-locked items first, then a stable zh-CN label order for reproducible output.
    // 用户锁定的条目优先，其次按 zh-CN 标签稳定排序以保证输出可复现。
    .sort((first, second) => Number(second.userLocked) - Number(first.userLocked)
      || first.fieldLabel.localeCompare(second.fieldLabel, 'zh-CN')
      || first.itemId.localeCompare(second.itemId))
    .slice(0, MAX_PERSONALIZATION_ITEMS)
    .map((item) => ({
      fieldLabel: normalizePreferenceText(item.fieldLabel),
      valueText: normalizePreferenceText(item.valueText).slice(0, MAX_PERSONALIZATION_VALUE_CHARS),
    }))
    .filter((item) => item.fieldLabel && item.valueText);
  if (items.length === 0) return emptyPersonalization('没有可用于写作风格或术语的非敏感个性化资料。');
  return {
    items,
    receipt: { requested: true, applied: true, itemCount: items.length },
  };
}

/**
 * Builds an empty result with a machine-readable non-application reason.
 * 构建空结果，并附带机器可读的未应用原因。
 */
function emptyPersonalization(reason: string): SelectionEditPersonalization {
  return {
    items: [],
    receipt: { requested: true, applied: false, itemCount: 0, reason },
  };
}

/**
 * NFKC-normalizes text and replaces control characters (except tab/LF/CR) with
 * spaces, so preference text cannot smuggle format escapes into the prompt.
 * 对文本做 NFKC 规范化，并把控制字符（制表符/换行/回车除外）替换为空格，
 * 防止偏好文本向提示词注入格式转义。
 */
function normalizePreferenceText(value: string): string {
  return [...value.normalize('NFKC')]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      // Replace DEL and most C0 controls; keep \t, \n, \r intact.
      // 替换 DEL 与大部分 C0 控制字符；保留 \t、\n、\r。
      return codePoint === 127 || codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13 ? ' ' : character;
    })
    .join('')
    .trim();
}
