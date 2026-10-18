/**
 * Marked extensions for frontmatter handling, wiki links, footnotes, callouts and relaxed bold.
 * 用于 frontmatter 处理、Wiki 链接、脚注、标注块与宽松加粗的 Marked 扩展。
 */

import type { MarkedExtension, Token, Tokens } from 'marked';
import { parseFrontmatterMapping } from '../../../shared/frontmatter.ts';

/**
 * How frontmatter is treated when preparing a document body.
 * 准备文档正文时对 frontmatter 的处理方式。
 */
export type MarkdownFrontmatterMode = 'preserve' | 'strip';

/**
 * A non-fatal document parsing diagnostic.
 * 非致命的文档解析诊断信息。
 */
export interface MarkdownDiagnostic {
  code: 'frontmatter-invalid' | 'frontmatter-unclosed';
  severity: 'warning';
  message: string;
}

/**
 * The result of preparing a Markdown document for rendering.
 * 为渲染准备 Markdown 文档后的结果。
 */
export interface PreparedMarkdownDocument {
  markdown: string;
  diagnostics: MarkdownDiagnostic[];
}

/**
 * Stored state for one footnote definition shared across reference tokens.
 * 供引用 token 共享的单个脚注定义的存储状态。
 */
interface FootnoteDefinition {
  id: string;
  domId: string;
  html: string;
  referenceIds: string[];
}

/**
 * Block token representing a `[^id]: ...` footnote definition.
 * 表示 `[^id]: ...` 脚注定义的块级 token。
 */
interface FootnoteDefinitionToken extends Tokens.Generic {
  type: 'footnoteDefinition';
  definitionId: string;
  primary: boolean;
  tokens: Token[];
}

/**
 * Inline token representing a `[^id]` footnote reference.
 * 表示 `[^id]` 脚注引用的行内 token。
 */
interface FootnoteReferenceToken extends Tokens.Generic {
  type: 'footnoteReference';
  definitionId: string;
}

/**
 * Block token representing a GitHub-style `> [!type]` callout.
 * 表示 GitHub 风格 `> [!type]` 标注块的块级 token。
 */
interface CalloutToken extends Tokens.Generic {
  type: 'callout';
  calloutType: string;
  titleTokens: Token[];
  tokens: Token[];
}

const frontmatterOpeningPattern = /^\uFEFF?---[ \t]*\r?\n/;
const frontmatterClosingPattern = /^---[ \t]*(?:\r?\n|$)/m;
const footnoteReferencePattern = /^\[\^([^\]\r\n]+)\]/;
const wikiLinkPattern = /^\[\[([^\]|\r\n]+?)(?:\|([^\]\r\n]+?))?\]\]/;
const supportedCalloutTypes = new Set([
  'note',
  'info',
  'tip',
  'warning',
  'danger',
  'todo',
  'question',
  'success',
  'failure',
  'bug',
  'example',
  'quote',
]);

/**
 * Split frontmatter from the document body, optionally stripping it with diagnostics.
 * 将 frontmatter 与文档正文分离；可选择剥离并返回诊断信息。
 *
 * @param markdown - Full note source / 完整笔记源文本
 * @param frontmatter - `preserve` keeps it in the body; `strip` removes it / `preserve` 保留在正文中；`strip` 将其移除
 * @returns Prepared body plus any parsing diagnostics / 预处理后的正文及解析诊断信息
 */
export function prepareMarkdownDocument(
  markdown: string,
  frontmatter: MarkdownFrontmatterMode = 'preserve',
): PreparedMarkdownDocument {
  if (frontmatter === 'preserve') return { markdown, diagnostics: [] };

  const opening = frontmatterOpeningPattern.exec(markdown);
  if (!opening) return { markdown, diagnostics: [] };

  const remaining = markdown.slice(opening[0].length);
  const closing = frontmatterClosingPattern.exec(remaining);
  if (!closing) {
    return {
      markdown,
      diagnostics: [{
        code: 'frontmatter-unclosed',
        severity: 'warning',
        message: 'Frontmatter 缺少闭合分隔符，已按原文显示。',
      }],
    };
  }

  const frontmatterSource = remaining.slice(0, closing.index);
  try {
    const parsed = parseFrontmatterMapping(frontmatterSource);
    if (parsed !== undefined && !isPlainRecord(parsed)) {
      throw new TypeError('Frontmatter root must be a mapping.');
    }

    return {
      markdown: remaining.slice(closing.index + closing[0].length),
      diagnostics: [],
    };
  } catch {
    return {
      markdown,
      diagnostics: [{
        code: 'frontmatter-invalid',
        severity: 'warning',
        message: 'Frontmatter 解析失败，已按原文显示。',
      }],
    };
  }
}

/**
 * Create a Marked extension tokenizing `[[target|alias]]` wiki links.
 * 创建一个 Marked 扩展，用于解析 `[[target|alias]]` Wiki 链接。
 *
 * @returns Marked extension with wiki-link tokenizer and renderer / 含 Wiki 链接分词器与渲染器的 Marked 扩展
 */
export function createWikiLinkExtension(): MarkedExtension {
  return {
    extensions: [{
      name: 'wikiLink',
      level: 'inline',
      start(src) {
        const index = src.indexOf('[[');
        return index >= 0 ? index : undefined;
      },
      tokenizer(src) {
        const match = wikiLinkPattern.exec(src);
        if (!match) return undefined;

        const target = match[1].trim();
        if (!target) return undefined;
        return {
          type: 'wikiLink',
          raw: match[0],
          target,
          alias: match[2]?.trim() || undefined,
        };
      },
      renderer(token) {
        const target = String(token.target);
        const alias = typeof token.alias === 'string' ? token.alias : undefined;
        const label = alias || target;
        return `<a href="menghan://wiki/${encodeURIComponent(target)}" data-wiki-link="${escapeHtmlAttribute(target)}"${alias ? ` data-wiki-alias="${escapeHtmlAttribute(alias)}"` : ''}>${escapeHtmlText(label)}</a>`;
      },
    }],
  };
}

/**
 * Accept AI emphasis with inner spaces or Chinese text next to a closing punctuation mark.
 * 接受带内部空格、或闭合标点旁紧邻中文文本的 AI 强调语法。
 *
 * @returns Marked extension with the relaxed strong tokenizer and renderer / 含宽松加粗分词器与渲染器的 Marked 扩展
 */
export function createRelaxedStrongExtension(): MarkedExtension {
  return {
    extensions: [{
      name: 'relaxedStrong',
      level: 'inline',
      start(src) {
        return /(?<![\\*])\*\*(?!\*)/.exec(src)?.index;
      },
      tokenizer(src) {
        if (!src.startsWith('**') || src.startsWith('***')) return undefined;
        // Skip escapes and complete code spans when looking for the closing marker. / 查找闭合标记时跳过转义序列与完整代码跨度。
        const candidate = /^\*\*((?:\\[^\r\n]|(`+)[^\r\n]*?\2(?!`)|[^\\`\r\n])*?)\*\*(?!\*)/.exec(src);
        if (!candidate || !candidate[1].trim() || candidate[1].startsWith('*')) return undefined;
        return {
          type: 'relaxedStrong',
          raw: candidate[0],
          tokens: this.lexer.inlineTokens(candidate[1]),
        };
      },
      renderer(token) {
        return `<strong>${this.parser.parseInline(token.tokens as Token[])}</strong>`;
      },
    }],
  };
}

/**
 * Create a Marked extension bundle for footnotes and GitHub-style callouts in previews.
 * 创建用于预览中脚注与 GitHub 风格标注块的 Marked 扩展集合。
 *
 * @returns Marked extension with footnote/callout tokenizers, renderers and a postprocess hook / 含脚注/标注分词器、渲染器与后处理钩子的 Marked 扩展
 */
export function createPreviewMarkdownExtension(): MarkedExtension {
  const definitions = new Map<string, FootnoteDefinition>();
  let nextDefinitionIndex = 1;

  return {
    extensions: [
      {
        name: 'footnoteDefinition',
        level: 'block',
        start(src) {
          const match = /\n\[\^[^\]\r\n]+\]:/.exec(src);
          return match ? match.index + 1 : undefined;
        },
        tokenizer(src) {
          const parsed = readFootnoteDefinition(src);
          if (!parsed) return undefined;

          const existing = definitions.get(parsed.id);
          const primary = !existing;
          if (primary) {
            definitions.set(parsed.id, {
              id: parsed.id,
              domId: createFootnoteDomId(parsed.id, nextDefinitionIndex, definitions),
              html: '',
              referenceIds: [],
            });
            nextDefinitionIndex += 1;
          }

          return {
            type: 'footnoteDefinition',
            raw: parsed.raw,
            definitionId: parsed.id,
            primary,
            tokens: this.lexer.blockTokens(parsed.markdown),
          } satisfies FootnoteDefinitionToken;
        },
        renderer(token) {
          const definitionToken = token as FootnoteDefinitionToken;
          const definition = definitions.get(definitionToken.definitionId);
          if (definition && definitionToken.primary) {
            definition.html = this.parser.parse(definitionToken.tokens);
          }
          return '';
        },
        childTokens: ['tokens'],
      },
      {
        name: 'callout',
        level: 'block',
        start(src) {
          const match = /\n {0,3}>[ \t]?\[![a-z]/i.exec(src);
          return match ? match.index + 1 : undefined;
        },
        tokenizer(src) {
          const parsed = readCallout(src);
          if (!parsed || !supportedCalloutTypes.has(parsed.type)) return undefined;
          return {
            type: 'callout',
            raw: parsed.raw,
            calloutType: parsed.type,
            titleTokens: this.lexer.inlineTokens(parsed.title || parsed.type.toUpperCase()),
            tokens: this.lexer.blockTokens(parsed.markdown),
          } satisfies CalloutToken;
        },
        renderer(token) {
          const calloutToken = token as CalloutToken;
          const title = this.parser.parseInline(calloutToken.titleTokens);
          const body = this.parser.parse(calloutToken.tokens);
          return `<div class="callout callout-${calloutToken.calloutType}"><div class="callout-title">${title}</div><div class="callout-content">${body}</div></div>\n`;
        },
        childTokens: ['titleTokens', 'tokens'],
      },
      {
        name: 'footnoteReference',
        level: 'inline',
        start(src) {
          const index = src.indexOf('[^');
          return index >= 0 ? index : undefined;
        },
        tokenizer(src) {
          const match = footnoteReferencePattern.exec(src);
          if (!match) return undefined;
          const id = match[1].trim();
          if (!definitions.has(id)) return undefined;
          return {
            type: 'footnoteReference',
            raw: match[0],
            definitionId: id,
          } satisfies FootnoteReferenceToken;
        },
        renderer(token) {
          const referenceToken = token as FootnoteReferenceToken;
          const definition = definitions.get(referenceToken.definitionId);
          if (!definition) return token.raw;

          const referenceSuffix = definition.referenceIds.length === 0
            ? ''
            : `-${definition.referenceIds.length + 1}`;
          const referenceId = `fnref-${definition.domId.slice(3)}${referenceSuffix}`;
          definition.referenceIds.push(referenceId);
          return `<sup id="${referenceId}" class="footnote-ref"><a href="#${definition.domId}">[${escapeHtmlText(definition.id)}]</a></sup>`;
        },
      },
    ],
    hooks: {
      postprocess(html) {
        if (definitions.size === 0) return html;
        const items = [...definitions.values()].map((definition) => {
          const backlinks = definition.referenceIds.map((referenceId, index) => (
            `<a href="#${referenceId}" class="footnote-backref" aria-label="返回脚注 ${escapeHtmlAttribute(definition.id)} 的第 ${index + 1} 个引用">↩</a>`
          )).join(' ');
          return `<li id="${definition.domId}">${definition.html}${backlinks ? `<span class="footnote-backrefs">${backlinks}</span>` : ''}</li>`;
        }).join('');
        return `${html}<section class="footnotes"><hr><ol>${items}</ol></section>`;
      },
    },
  };
}

/**
 * Parse one `[^id]:` footnote definition including indented continuation lines.
 * 解析单个 `[^id]:` 脚注定义，包含缩进的续行。
 */
function readFootnoteDefinition(src: string): { id: string; markdown: string; raw: string } | undefined {
  const first = readLine(src, 0);
  const match = /^\[\^([^\]\r\n]+)\]:[ \t]*(.*)$/.exec(first.line);
  if (!match) return undefined;

  const id = match[1].trim();
  if (!id) return undefined;
  const body = [match[2]];
  let offset = first.end;

  while (offset < src.length) {
    const current = readLine(src, offset);
    if (isIndentedContinuation(current.line)) {
      body.push(stripContinuationIndent(current.line));
      offset = current.end;
      continue;
    }

    if (/^[ \t]*$/.test(current.line)) {
      const next = readLine(src, current.end);
      if (current.end < src.length && isIndentedContinuation(next.line)) {
        body.push('');
        offset = current.end;
        continue;
      }
    }
    break;
  }

  return {
    id,
    markdown: body.join('\n').trimEnd(),
    raw: src.slice(0, offset),
  };
}

/**
 * Parse a blockquote callout starting with `> [!type]`, stripping quote markers from the body.
 * 解析以 `> [!type]` 开头的引用标注块，并去除正文中的引用标记。
 */
function readCallout(src: string): { type: string; title: string; markdown: string; raw: string } | undefined {
  const block = /^(?: {0,3}>[^\r\n]*(?:\r?\n|$))+/.exec(src);
  if (!block) return undefined;

  const lines = block[0].replace(/\r?\n$/, '').split(/\r?\n/);
  const marker = /^ {0,3}>[ \t]?\[!([a-z][\w-]*)\](?:[+-])?(?:[ \t]+(.*))?[ \t]*$/i.exec(lines[0]);
  if (!marker) return undefined;

  return {
    type: marker[1].toLowerCase(),
    title: marker[2]?.trim() ?? '',
    markdown: lines.slice(1).map((line) => line.replace(/^ {0,3}>[ \t]?/, '')).join('\n'),
    raw: block[0],
  };
}

/**
 * Read one line from a source offset, handling CRLF and end-of-input.
 * 从指定偏移读取一行，处理 CRLF 与输入末尾情况。
 */
function readLine(source: string, offset: number): { line: string; end: number } {
  const remainder = source.slice(offset);
  const newline = /\r?\n/.exec(remainder);
  if (!newline) return { line: remainder, end: source.length };
  return {
    line: remainder.slice(0, newline.index),
    end: offset + newline.index + newline[0].length,
  };
}

/**
 * Test whether a line is indented enough to continue a footnote definition.
 * 判断行缩进是否足以作为脚注定义的续行。
 */
function isIndentedContinuation(line: string): boolean {
  return /^(?: {2,}|\t)/.test(line);
}

/**
 * Remove up to four leading spaces (or one tab) from a footnote continuation line.
 * 去除脚注续行的最多四个前导空格（或一个制表符）。
 */
function stripContinuationIndent(line: string): string {
  if (line.startsWith('\t')) return line.slice(1);
  const spaces = /^ +/.exec(line)?.[0].length ?? 0;
  return line.slice(Math.min(spaces, spaces >= 4 ? 4 : 2));
}

/**
 * Check that a value is a plain object usable as a frontmatter mapping.
 * 判断取值是否为可用作 frontmatter 映射的普通对象。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Build a collision-free DOM id for a footnote definition.
 * 为脚注定义生成无冲突的 DOM id。
 */
function createFootnoteDomId(
  id: string,
  fallbackIndex: number,
  definitions: ReadonlyMap<string, FootnoteDefinition>,
): string {
  const normalized = id
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = `fn-${normalized || fallbackIndex}`;
  const occupied = new Set([...definitions.values()].map((definition) => definition.domId));
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Escape a value for safe use inside a double-quoted HTML attribute.
 * 转义取值以便安全用于双引号 HTML 属性中。
 */
function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

/**
 * Escape `&`, `<` and `>` for safe HTML text interpolation.
 * 转义 `&`、`<` 与 `>`，以便安全插入 HTML 文本。
 */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
