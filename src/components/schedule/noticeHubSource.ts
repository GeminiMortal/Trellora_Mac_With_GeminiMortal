/**
 * noticeHubSource —— 群务台（notice-hub）来源辨识辅助。
 * NoticeHub source detection helpers (zero extra data channels).
 *
 * 零新增数据通道（契约 §8.2）：仅依据 `tags` 含 "notice-hub" 判定来源；
 * 来源群名同样复用 tags（映射表 §5.1 把群名追加进 tags）。
 */

/** 来源标记标签：notice-hub 同步的条目固定携带（契约 §5.1 / §5.5）。 */
export const NOTICE_HUB_TAG = 'notice-hub';

/** 映射表写入 tags 的非群名标记，展示来源群时排除。 */
const NON_GROUP_TAGS = new Set([NOTICE_HUB_TAG, '待确认', '置顶', '公告']);

/** 判断条目是否来自群务台（tags 含 "notice-hub"）。 */
export function hasNoticeHubSource(tags: readonly string[] | null | undefined): boolean {
  return Array.isArray(tags) && tags.includes(NOTICE_HUB_TAG);
}

/** 从 tags 还原来源群名（去掉固定标记后剩余的群名标签）。 */
export function noticeHubGroupNames(tags: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag) => !NON_GROUP_TAGS.has(tag));
}
