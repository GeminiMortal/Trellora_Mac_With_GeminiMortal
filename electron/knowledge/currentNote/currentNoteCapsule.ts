/**
 * Builds a deterministic, model-free descriptor (capsule) of the current note.
 * 构建当前笔记的确定性、无模型描述符（capsule）。
 */
import type { CurrentNoteSnapshot } from './currentNoteSnapshot.ts';

/** Schema version constant for the note capsule format. 笔记 capsule 格式的模式版本常量。 */
export const CURRENT_NOTE_CAPSULE_SCHEMA_VERSION = 1;

/** Lightweight structural descriptor of a note, used when the full markdown is too large for direct injection. 笔记的轻量结构描述符，在完整 markdown 过大无法直接注入时使用。 */
export interface NoteCapsule {
  schemaVersion: typeof CURRENT_NOTE_CAPSULE_SCHEMA_VERSION;
  title: string;
  contentHash: string;
  lineCount: number;
  headings: Array<{ id: string; path: string[]; lineFrom: number; lineTo: number }>;
  tags: string[];
  wikiLinks: string[];
  topTerms: string[];
  structuralStats: Record<string, number>;
}

const MAX_CAPSULE_HEADINGS = 120;
const MAX_CAPSULE_TAGS = 40;
const MAX_CAPSULE_WIKI_LINKS = 40;
const MAX_CAPSULE_TOP_TERMS = 20;

/**
 * Builds a local, repeatable note descriptor. It never asks a model to summarize.
 * 构建本地可重复的笔记描述符。不调用模型进行摘要。
 *
 * @param snapshot - The immutable note snapshot to extract capsule data from / 用于提取 capsule 数据的不可变笔记快照
 * @returns A NoteCapsule with headings, tags, links, terms, and structural stats / 包含标题、标签、链接、术语和结构统计的 NoteCapsule
 */
export function createNoteCapsule(snapshot: CurrentNoteSnapshot): NoteCapsule {
  const structuralCounts = new Map<string, number>();
  const termCounts = new Map<string, number>();
  for (const block of snapshot.blocks) {
    structuralCounts.set(block.kind, (structuralCounts.get(block.kind) ?? 0) + 1);
    for (const term of block.normalizedTerms) {
      if (term.length < 2) continue;
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }
  const headings = snapshot.headings.slice(0, MAX_CAPSULE_HEADINGS).map((heading) => ({
    id: heading.headingId,
    path: [...heading.path],
    lineFrom: heading.lineFrom,
    lineTo: heading.lineTo,
  }));
  const structuralStats = Object.fromEntries([
    ...structuralCounts.entries(),
    ['headingsTotal', snapshot.headings.length],
    ['headingsIncluded', headings.length],
    ['headingsTruncated', snapshot.headings.length > headings.length ? 1 : 0],
  ].sort(([first], [second]) => compareText(first, second)));
  const topTerms = [...termCounts.entries()]
    .sort(([firstTerm, firstCount], [secondTerm, secondCount]) => secondCount - firstCount || compareText(firstTerm, secondTerm))
    .slice(0, MAX_CAPSULE_TOP_TERMS)
    .map(([term]) => term);
  return {
    schemaVersion: CURRENT_NOTE_CAPSULE_SCHEMA_VERSION,
    title: snapshot.title,
    contentHash: snapshot.contentHash,
    lineCount: snapshot.lineCount,
    headings,
    tags: extractTags(snapshot.markdown).slice(0, MAX_CAPSULE_TAGS),
    wikiLinks: extractWikiLinks(snapshot.markdown).slice(0, MAX_CAPSULE_WIKI_LINKS),
    topTerms,
    structuralStats,
  };
}

/**
 * Fixed field order and newlines make this safe to use in a cacheable prefix.
 * 固定字段顺序和换行符使其可安全用于可缓存的前缀。
 *
 * @param capsule - The NoteCapsule to serialize / 要序列化的 NoteCapsule
 * @returns Deterministic string representation suitable for prompt prefix caching / 适合提示前缀缓存的确定性字符串表示
 */
export function serializeNoteCapsule(capsule: NoteCapsule): string {
  return [
    `schemaVersion: ${capsule.schemaVersion}`,
    `title: ${JSON.stringify(capsule.title)}`,
    `contentHash: ${capsule.contentHash}`,
    `lineCount: ${capsule.lineCount}`,
    'headings:',
    ...capsule.headings.map((heading) => `- ${JSON.stringify({ id: heading.id, path: heading.path, lineFrom: heading.lineFrom, lineTo: heading.lineTo })}`),
    `tags: ${JSON.stringify(capsule.tags)}`,
    `wikiLinks: ${JSON.stringify(capsule.wikiLinks)}`,
    `topTerms: ${JSON.stringify(capsule.topTerms)}`,
    `structuralStats: ${JSON.stringify(capsule.structuralStats)}`,
  ].join('\n');
}

function extractTags(markdown: string): string[] {
  const values = new Set<string>();
  for (const match of markdown.matchAll(/(?:^|[\s(（])#([\p{L}\p{N}_/-]{1,48})/gmu)) values.add(match[1]);
  return [...values].sort(compareText);
}

function extractWikiLinks(markdown: string): string[] {
  const values = new Set<string>();
  for (const match of markdown.matchAll(/!?\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]+)?(?:\|[^\]\r\n]+)?\]\]/gu)) {
    const target = match[1].replace(/\s+/gu, ' ').trim();
    if (target) values.add(target);
  }
  return [...values].sort(compareText);
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
