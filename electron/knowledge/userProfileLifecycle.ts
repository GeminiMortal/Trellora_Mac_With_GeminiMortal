/**
 * User profile lifecycle management: review scheduling and overdue detection.
 * 用户画像生命周期管理：审查排期与逾期检测。
 */

import type { UserProfileCategory, UserProfileItem, UserProfileReviewItem } from './userProfileTypes';

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

/** Review windows are limited to the non-sensitive categories approved by the v5 design. */
const reviewDaysByCategory: Partial<Record<UserProfileCategory, number>> = {
  professional: 180,
  goals: 120,
  interests: 180,
};

/**
 * Compute the next review-at timestamp for a user profile category.
 * 计算用户画像类别的下次审查时间。
 *
 * @param category - Profile category / 画像类别
 * @param from - Reference date (defaults to now) / 参考日期（默认当前）
 * @returns ISO timestamp or undefined / ISO 时间戳或 undefined
 */
export function getNextUserProfileReviewAt(category: UserProfileCategory, from = new Date()): string | undefined {
  const days = reviewDaysByCategory[category];
  if (!days) return undefined;
  return new Date(from.getTime() + days * millisecondsPerDay).toISOString();
}

/**
 * Collect user profile items whose review period has expired.
 * 收集审查期已过期的用户画像条目。
 *
 * @param items - Active profile items to check / 待检查的活跃画像条目
 * @param now - Current reference time / 当前参考时间
 * @returns Sorted list of overdue review items / 按时间排序的逾期审查条目列表
 */
export function collectUserProfileReviewDueItems(
  items: readonly UserProfileItem[],
  now = new Date(),
): UserProfileReviewItem[] {
  const nowMs = now.getTime();
  return items.flatMap((item) => {
    if (item.status !== 'active' || !item.expiresAt) return [];
    const dueMs = new Date(item.expiresAt).getTime();
    if (!Number.isFinite(dueMs) || dueMs > nowMs) return [];
    return [{
      item,
      dueAt: item.expiresAt,
      daysOverdue: Math.max(0, Math.floor((nowMs - dueMs) / millisecondsPerDay)),
    }];
  }).sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.item.itemId.localeCompare(right.item.itemId));
}
