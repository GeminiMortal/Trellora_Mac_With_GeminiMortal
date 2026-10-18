/**
 * Code-language options, alias normalization, and icon marks for code blocks.
 * 代码块的语言选项、别名归一化与图标标记。
 */

/**
 * Option entry for a code-language selector.
 * 代码语言选择器的选项条目。
 */
export interface CodeLanguageOption {
  value: string;
  label: string;
}

/**
 * Languages offered in the code-block language picker.
 * 代码块语言选择器提供的语言列表。
 */
export const CODE_LANGUAGE_OPTIONS: CodeLanguageOption[] = [
  { value: 'plaintext', label: '纯文本' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'json', label: 'JSON' },
  { value: 'bash', label: 'Bash' },
  { value: 'sql', label: 'SQL' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'yaml', label: 'YAML' },
  { value: 'xml', label: 'XML' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'csharp', label: 'C#' },
  { value: 'cpp', label: 'C++' },
  { value: 'mermaid', label: 'Mermaid' },
];

// Common aliases mapped to canonical language ids. / 常见别名到规范语言 id 的映射。
const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  '': 'plaintext',
  c: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  txt: 'plaintext',
  yml: 'yaml',
};

/**
 * Normalizes a language tag to its canonical id via the alias table.
 * 通过别名表将语言标识归一化为规范 id。
 *
 * @param value - Raw language tag / 原始语言标识
 * @returns Canonical language id / 规范语言 id
 */
export function normalizeCodeLanguage(value: string | null | undefined): string {
  const normalized = value?.trim().toLocaleLowerCase('en-US') ?? '';
  return CODE_LANGUAGE_ALIASES[normalized] ?? normalized;
}

/**
 * Converts a language tag for a fenced code block, treating plaintext as unset.
 * 转换为围栏代码块语言标识，纯文本视作未设置。
 *
 * @param value - Raw language tag / 原始语言标识
 * @returns Language id, or null when plaintext or empty / 语言 id；纯文本或空时返回 null
 */
export function toCodeBlockLanguage(value: string | null | undefined): string | null {
  const normalized = normalizeCodeLanguage(value);
  return normalized === 'plaintext' ? null : normalized || null;
}

/**
 * Short icon marks shown next to each language in the UI.
 * 界面中每种语言旁展示的短图标标记。
 */
export const CODE_LANGUAGE_ICON_MARKS: Record<string, string> = {
  plaintext: 'Aa',
  javascript: 'JS',
  typescript: 'TS',
  python: '🐍',
  java: '☕',
  json: '{}',
  bash: '>_',
  sql: 'DB',
  html: 'HTML',
  css: '#',
  markdown: 'M↓',
  yaml: 'YAML',
  xml: 'XML',
  go: 'GO',
  rust: '⚙',
  csharp: 'C#',
  cpp: 'C++',
  mermaid: '◇',
};
