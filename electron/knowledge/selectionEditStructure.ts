/** 选区含这些块类型时，交给模型的原文必须是 Markdown 而非压扁纯文本。 */
const structuralBlockKinds = new Set([
  'table', 'tableRow', 'tableHeader', 'tableCell',
  'taskList', 'taskItem',
  'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'heading',
]);

/**
 * 判定选区是否携带 Markdown 结构：块类型属于结构族，且序列化结果与纯文本不同。
 * 普通段落两者一致，仍走原有纯文本链路，避免给模型多余的结构约束。
 */
export function structuredSelectionMarkdown(snapshot: {
  blockKinds: readonly string[];
  selectedText: string;
  markdownFragment?: string;
}): string | null {
  const markdown = snapshot.markdownFragment?.trim();
  if (!markdown) return null;
  if (!snapshot.blockKinds.some((kind) => structuralBlockKinds.has(kind))) return null;
  const compact = (value: string) => value.replace(/\s+/gu, '');
  return compact(markdown) === compact(snapshot.selectedText) ? null : (snapshot.markdownFragment ?? null);
}
