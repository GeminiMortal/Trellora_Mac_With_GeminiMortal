/**
 * Marked extension and KaTeX rendering helpers for inline and block math.
 * 用于行内与块级公式的 Marked 扩展及 KaTeX 渲染工具。
 */

import katex from 'katex';
import type { MarkedExtension, Tokens } from 'marked';

/**
 * Token carrying a math expression's source, delimiter and display mode.
 * 携带数学表达式源码、分隔符与显示模式的 token。
 */
export interface MarkdownMathToken extends Tokens.Generic {
  type: 'markdownMathBlock' | 'markdownMathInline';
  text: string;
  delimiter: '$' | '$$' | '\\(' | '\\[';
  displayMode: boolean;
}

/**
 * Tokenize math outside code/escaped text; both editor and preview use this contract.
 * 在代码/转义文本之外进行数学公式分词；编辑器和预览共用此约定。
 *
 * @param render - Callback converting a math token to HTML / 将数学 token 转换为 HTML 的回调
 * @returns Marked extension with block and inline math tokenizers and renderers / 含块级与行内数学分词器及渲染器的 Marked 扩展
 */
export function createMathMarkdownExtension(render: (token: MarkdownMathToken) => string): MarkedExtension {
  return {
    extensions: ['block', 'inline'].map((level) => ({
      name: level === 'block' ? 'markdownMathBlock' : 'markdownMathInline',
      level: level as 'block' | 'inline',
      start(src: string) {
        const candidates = level === 'block' ? /^(?:\$\$|\\\[)/gm : /\$|\\[([]/g;
        for (const match of src.matchAll(candidates)) {
          if (isEscaped(src, match.index)) continue;
          if (readMath(src.slice(match.index), level === 'block')) return match.index;
        }
        return undefined;
      },
      tokenizer(src: string) {
        return readMath(src, level === 'block');
      },
      renderer(token: Tokens.Generic) {
        return render(token as MarkdownMathToken);
      },
    })),
  };
}

/**
 * Render a math expression to HTML via KaTeX, suppressing errors gracefully.
 * 通过 KaTeX 将数学表达式渲染为 HTML，优雅地抑制错误。
 *
 * @param source - LaTeX source / LaTeX 源文本
 * @param displayMode - True for block display, false for inline / true 为块级显示，false 为行内
 * @returns KaTeX HTML string / KaTeX HTML 字符串
 */
export function renderMathHtml(source: string, displayMode: boolean): string {
  return katex.renderToString(source, {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
    maxExpand: 1000,
  });
}

/**
 * Try to read a delimited math expression at the start of `src`.
 * 尝试在 `src` 开头读取一个带分隔符的数学表达式。
 *
 * @param src - Source string starting at a delimiter candidate / 从分隔符候选位置开始的源字符串
 * @param block - Whether only block-level (`$$`/`\[`) delimiters are allowed / 是否只允许块级（`$$`/`\[`) 分隔符
 * @returns A math token or undefined when no valid expression is found / 数学 token；未找到有效表达式时返回 undefined
 */
function readMath(src: string, block: boolean): MarkdownMathToken | undefined {
  const delimiter = src.startsWith('$$') ? '$$'
    : src.startsWith('$') ? '$'
      : src.startsWith('\\(') ? '\\('
        : src.startsWith('\\[') ? '\\[' : undefined;
  if (!delimiter || (block && delimiter !== '$$' && delimiter !== '\\[')) return undefined;
  if (src[delimiter.length] === '$') return undefined;
  const closing = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
  let end = src.indexOf(closing, delimiter.length);
  while (end >= 0 && isEscaped(src, end)) end = src.indexOf(closing, end + closing.length);
  if (end < 0 || (closing.startsWith('$') && src[end + closing.length] === '$')) return undefined;
  const inner = src.slice(delimiter.length, end);
  if (!inner.trim() || (!block && /[\r\n`]/.test(inner))) return undefined;
  if (block && !/^[ \t]*(?:\r?\n|$)/.test(src.slice(end + closing.length))) return undefined;
  // Escaped Wiki links/footnotes are ordinary Markdown, not bracket-delimited TeX. / 转义的 Wiki 链接/脚注是普通 Markdown，不是方括号分隔的 TeX。
  if (delimiter === '\\[' && (
    /^(?:\[|\\\[|\^)/.test(inner)
    || (!block && !/(?:\\[A-Za-z]+|[_^]\{|[=+*/-])/.test(inner))
  )) return undefined;
  // Do not pair separate dollar prices as math, e.g. "$5 and $10" or "$20 USD $". / 不要把独立的货币金额配对为数学公式，例如 "$5 and $10" 或 "$20 USD $"。
  if (delimiter === '$' && /^\s*\d/.test(inner) && (
    /^\d/.test(src.slice(end + 1))
    || /^\s*\d[\d,.]*\s+[A-Za-z\u3400-\u9fff][^\\^_{}=+*/<>|]*$/.test(inner)
  )) return undefined;

  return {
    type: block ? 'markdownMathBlock' : 'markdownMathInline',
    raw: src.slice(0, end + closing.length),
    text: block
      ? inner.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '')
      : inner.trim(),
    delimiter,
    displayMode: delimiter === '$$' || delimiter === '\\[',
  };
}

/**
 * Count preceding backslashes to determine whether the character at `index` is escaped.
 * 统计前导反斜杠以判断 `index` 处的字符是否被转义。
 */
function isEscaped(src: string, index: number): boolean {
  let backslashes = 0;
  while (src[index - backslashes - 1] === '\\') backslashes += 1;
  return backslashes % 2 === 1;
}
