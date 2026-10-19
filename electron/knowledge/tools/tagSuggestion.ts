/**
 * Tag suggestion application helpers: merge AI-suggested tags into note frontmatter.
 * 标签建议应用辅助：将 AI 建议的标签合并进笔记 frontmatter。
 */

import { parseNoteFrontmatter, stringifyNoteFrontmatter } from '../../../shared/frontmatter';

/**
 * Merge confirmed tags into the note markdown frontmatter, deduplicating against existing tags.
 * 将已确认的标签合并进笔记 markdown 的 frontmatter，与已有标签去重。
 *
 * @param markdown - Note markdown text with optional frontmatter / 含可选 frontmatter 的笔记 markdown
 * @param suggestedTags - Tags confirmed by the user / 用户确认的标签列表
 * @returns Updated markdown and final tag list / 更新后的 markdown 与最终标签列表
 */
export function applyConfirmedTags(markdown: string, suggestedTags: string[]): { markdown: string; tags: string[] } {
  const parsed = parseNoteFrontmatter(markdown);
  const existing = normalizeTags(parsed.data.tags);
  const tags = [...new Set([...existing, ...normalizeTags(suggestedTags)])];
  if (!tags.length || tags.length === existing.length) return { markdown, tags: existing };
  return { markdown: stringifyNoteFrontmatter(parsed.content, { ...parsed.data, tags }), tags };
}

function normalizeTags(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return candidates.flatMap((candidate) => {
    const tag = String(candidate).trim().replace(/^#/, '').slice(0, 80);
    return tag ? [tag] : [];
  });
}
