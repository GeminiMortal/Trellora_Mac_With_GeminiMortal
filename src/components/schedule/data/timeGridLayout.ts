/**
 * Time grid layout — compute overlap columns for week/day view blocks.
 * 时间格布局 — 计算周/日视图事件块的重叠列。
 */
import type { ScheduleOccurrence } from '../../../../shared/schedule.ts';

export interface TimeGridBlock {
  occurrence: ScheduleOccurrence;
  column: number;
  totalColumns: number;
  topMinutes: number;      // minutes from 00:00
  durationMinutes: number;
}

/**
 * Parse a naive ISO datetime to minutes from midnight.
 */
function minutesFromMidnight(iso: string): number {
  const timePart = iso.includes('T') ? iso.split('T')[1] : '00:00:00';
  const [h, m] = timePart.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Compute the duration in minutes between two ISO datetimes.
 */
function durationInMinutes(start: string, end: string): number {
  const s = minutesFromMidnight(start);
  const e = minutesFromMidnight(end);
  return Math.max(e - s, 15); // minimum 15 minutes
}

/**
 * Compute overlapping column layout for time grid blocks.
 * Sort by start time, then assign columns greedily.
 */
export function computeTimeGridLayout(occurrences: ScheduleOccurrence[]): TimeGridBlock[] {
  if (occurrences.length === 0) return [];

  // Build blocks
  const blocks: TimeGridBlock[] = occurrences.map(occ => ({
    occurrence: occ,
    column: 0,
    totalColumns: 1,
    topMinutes: minutesFromMidnight(occ.startAt),
    durationMinutes: durationInMinutes(occ.startAt, occ.endAt),
  }));

  // Sort by start time, then by duration (longer first)
  blocks.sort((a, b) => {
    const cmp = a.topMinutes - b.topMinutes;
    if (cmp !== 0) return cmp;
    return b.durationMinutes - a.durationMinutes;
  });

  // Greedy column assignment
  // Track column end times for overlapping clusters
  const columnEnds: number[] = []; // column index → end minute

  for (const block of blocks) {
    let col = 0;
    while (col < columnEnds.length && columnEnds[col] > block.topMinutes) {
      col++;
    }
    block.column = col;
    if (col >= columnEnds.length) {
      columnEnds.push(0);
    }
    columnEnds[col] = block.topMinutes + block.durationMinutes;
  }

  // Determine totalColumns for each overlapping cluster
  // Simple approach: for each block, find all overlapping blocks and set totalColumns
  for (let i = 0; i < blocks.length; i++) {
    let maxCol = blocks[i].column;
    for (let j = 0; j < blocks.length; j++) {
      if (i === j) continue;
      if (blocksOverlap(blocks[i], blocks[j])) {
        maxCol = Math.max(maxCol, blocks[j].column);
      }
    }
    blocks[i].totalColumns = maxCol + 1;
  }

  return blocks;
}

function blocksOverlap(a: TimeGridBlock, b: TimeGridBlock): boolean {
  const aEnd = a.topMinutes + a.durationMinutes;
  const bEnd = b.topMinutes + b.durationMinutes;
  return a.topMinutes < bEnd && b.topMinutes < aEnd;
}

/**
 * Get the hour labels for the time axis.
 * 获取时间轴的小时标签。
 */
export function getHourLabels(): Array<{ hour: number; label: string }> {
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: `${String(h).padStart(2, '0')}:00`,
  }));
}