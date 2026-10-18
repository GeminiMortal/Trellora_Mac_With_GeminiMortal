/**
 * YAML frontmatter parsing and serialization for notes, with size and structure safety limits.
 * 笔记的 YAML Frontmatter 解析与序列化，附带大小与结构安全限制。
 */

import { dump, load } from 'js-yaml';

/**
 * Maximum accepted frontmatter size in bytes.
 * 接受的 Frontmatter 最大字节大小。
 */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

/**
 * Parsed note: frontmatter data plus the remaining Markdown body.
 * 解析后的笔记：Frontmatter 数据与剩余 Markdown 正文。
 */
export interface NoteFrontmatter {
  /** Key-value data from the frontmatter block. / Frontmatter 块中的键值数据。 */
  data: Record<string, unknown>;
  /** Markdown body after the frontmatter block. / Frontmatter 块之后的 Markdown 正文。 */
  content: string;
}

/**
 * Parse the frontmatter block of a note into data and body; parse data only, executable language headers are never dispatched to an engine.
 * 将笔记的 Frontmatter 块解析为数据与正文；只解析数据，可执行的语言头部绝不会交给引擎执行。
 *
 * @param markdown - Full note text including optional frontmatter / 含可选 Frontmatter 的完整笔记文本
 * @returns Parsed frontmatter data and Markdown body / 解析出的 Frontmatter 数据与 Markdown 正文
 * @throws Error on unsupported language headers or missing closing delimiter / 语言头不受支持或缺少闭合分隔符时抛出异常
 */
export function parseNoteFrontmatter(markdown: string): NoteFrontmatter {
  const opening = /^\uFEFF?---([^\r\n]*)\r?\n/.exec(markdown);
  if (!opening) return { data: {}, content: markdown };
  // Only data languages (YAML/JSON) are accepted; executable engines are rejected.
  // 只接受数据型语言（YAML/JSON）；可执行引擎一律拒绝。
  const language = opening[1].trim().toLowerCase();
  if (!['', 'yaml', 'yml', 'json'].includes(language)) throw new Error('不支持的 Frontmatter 格式。');
  const remaining = markdown.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remaining);
  if (!closing) throw new Error('Frontmatter 缺少闭合分隔符。');
  const source = remaining.slice(0, closing.index);
  return { data: parseFrontmatterMapping(source, language === 'json'), content: remaining.slice(closing.index + closing[0].length) };
}

/**
 * Parse a frontmatter mapping with bounded metadata size and expansion before recursive consumers see YAML aliases.
 * 解析 Frontmatter 映射：在递归消费方看到 YAML 别名之前限制元数据大小与展开规模。
 *
 * @param source - Frontmatter body text / Frontmatter 主体文本
 * @param json - Whether to parse as JSON instead of YAML / 是否按 JSON 而非 YAML 解析
 * @returns Validated plain-object mapping / 校验通过的纯对象映射
 * @throws Error when oversized, non-object, cyclic, or containing forbidden keys / 超大、非对象、含循环引用或含禁止字段时抛出异常
 */
export function parseFrontmatterMapping(source: string, json = false): Record<string, unknown> {
  if (new TextEncoder().encode(source).byteLength > MAX_FRONTMATTER_BYTES) throw new Error('Frontmatter 超过 64 KB 上限。');
  const parsed: unknown = json ? JSON.parse(source) : load(source);
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed instanceof Date) throw new Error('Frontmatter 必须是键值对象。');
  // Walk the structure to reject cycles, prototype pollution keys, and pathological depth/node counts.
  // 遍历结构以拒绝循环引用、原型污染键以及过深/过多节点的病态结构。
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const validate = (value: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32) throw new Error('Frontmatter 结构过于复杂。');
    if (!value || typeof value !== 'object' || value instanceof Date) return;
    if (ancestors.has(value)) throw new Error('Frontmatter 不能包含循环引用。');
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Frontmatter 包含不允许的字段。');
      validate(child, depth + 1);
    }
    ancestors.delete(value);
  };
  validate(parsed, 0);
  return parsed as Record<string, unknown>;
}

/**
 * Serialize metadata with the YAML data engine while preserving body bytes as text.
 * 使用 YAML 数据引擎序列化元数据，同时以文本形式保留正文。
 *
 * @param content - Markdown body without frontmatter / 不含 Frontmatter 的 Markdown 正文
 * @param data - Frontmatter mapping to serialize / 要序列化的 Frontmatter 映射
 * @returns Full note text with serialized frontmatter / 含序列化 Frontmatter 的完整笔记文本
 */
export function stringifyNoteFrontmatter(content: string, data: Record<string, unknown>): string {
  // noRefs keeps output alias-free so re-parsing stays simple and safe.
  // noRefs 保证输出不含别名，使重新解析保持简单安全。
  return `---\n${dump(data, { lineWidth: -1, noRefs: true }).trimEnd()}\n---\n${content}`;
}
