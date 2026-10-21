/**
 * NoticeHubSourceBadge —— 群务台（notice-hub）来源徽标。
 * NoticeHub source badge for schedule items and todo rows.
 *
 * 判定与来源群名复用 `noticeHubSource.ts`（tags 零新增数据通道，契约 §8.2）。
 */
import { Bell } from 'lucide-react';

interface NoticeHubSourceBadgeProps {
  /** 来源群名（可选）：用于 title 提示来源群。 */
  groupNames?: string[];
}

/**
 * 小型来源徽标：铃铛图标，`aria-label="来源：群务台"`，title 提示来源群。
 * Small source badge: bell icon, accessible label, tooltip naming the source group.
 */
export default function NoticeHubSourceBadge({ groupNames = [] }: NoticeHubSourceBadgeProps) {
  const groupHint = groupNames.length > 0 ? ` · 来源群：${groupNames.join('、')}` : '';
  return (
    <span
      className="schedule-source-badge"
      role="img"
      aria-label="来源：群务台"
      title={`来源：群务台${groupHint}`}
    >
      <Bell size={10} strokeWidth={2.2} aria-hidden="true" />
    </span>
  );
}
