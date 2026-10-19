/**
 * Low-level web_fetch scraping client (web search design §4.3 / §3.3).
 * Only accepts http/https URLs from the current search results (whitelist is enforced at the tool layer),
 * then performs lightweight content extraction: strip script/style/nav tags → textify → truncate.
 * web_fetch 底层抓取客户端（联网搜索设计方案 §4.3 / §3.3）。
 * 仅接受本轮搜索结果内的 http/https URL（白名单在工具层校验），
 * 抓取后做轻量正文抽取：去脚本/样式/导航标签 → 文本化 → 截断。
 */
import { net } from 'electron';

/**
 * Page fetch timeout in milliseconds; search timeout lives in webSearchTypes.WEB_SEARCH_TIMEOUT_MS.
 * 抓取超时（毫秒）；搜索超时见 webSearchTypes.WEB_SEARCH_TIMEOUT_MS。
 */
export const WEB_FETCH_TIMEOUT_MS = 15_000;
/**
 * Cap on extracted body text per page; the observation budget truncates again before rendering.
 * 单页正文抽取后的上限；进观察前还会再过观察预算截断。
 */
export const WEB_FETCH_MAX_CHARS = 12_000;

/**
 * Outcome of fetching and extracting a single web page.
 * 抓取并抽取单个网页后的结果。
 */
export interface WebFetchOutcome {
  title?: string;
  /** Extracted plain-text body, truncated to WEB_FETCH_MAX_CHARS / 抽取后的正文纯文本（已截断至 WEB_FETCH_MAX_CHARS） */
  text: string;
  /** True when extraction yields no body (e.g. JS-only pages); callers degrade as a failure / 正文抽取为空（如纯 JS 渲染页）时为 true；调用方按失败降级处理 */
  empty: boolean;
}

/**
 * Fetch a public web page and extract readable text content.
 * 抓取公开网页并抽取可读正文内容。
 *
 * @param input - Target URL and caller abort signal / 目标 URL 与调用方取消信号
 * @returns Extracted title/text outcome / 抽取后的标题与正文结果
 */
export async function fetchWebPage(input: { url: string; signal: AbortSignal }): Promise<WebFetchOutcome> {
  const parsed = parsePublicWebUrl(input.url);
  const timeout = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
  const response = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
    signal: AbortSignal.any([input.signal, timeout]),
  });
  if (!response.ok) throw new Error(`网页请求失败（HTTP ${response.status}）。`);
  // Only accept document-like content types; binary/media payloads are rejected before the body is read.
  // 仅接受文档类内容类型；二进制/媒体载荷在读取正文前直接拒绝。
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(contentType)) {
    throw new Error(`网页返回了不支持的内容类型（${contentType.split(';')[0]}）。`);
  }
  const html = await response.text();
  return extractReadableContent(html);
}

/**
 * Prevent search results or redirect chains from using the fetch tool to reach localhost, intranet, or credentialed URLs.
 * Whether the URL came from the current search remains the caller's responsibility; this function only enforces the network target boundary.
 * 防止搜索结果或重定向链借由抓取工具访问本机、内网和带凭据的地址。
 * URL 是否来自本轮搜索仍由调用方负责；本函数只负责网络目标边界。
 *
 * @param value - Candidate URL string / 候选 URL 字符串
 * @returns Validated public http(s) URL / 校验通过的公开 http(s) URL
 */
export function parsePublicWebUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL 格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http/https 网页。');
  if (parsed.username || parsed.password) throw new Error('网页 URL 不能包含账号信息。');
  if (isPrivateHostname(parsed.hostname)) throw new Error('不允许抓取本机或内网地址。');
  return parsed;
}

/** SSRF guard: true for localhost/loopback/link-local/ULA/private-range hosts; invalid IPv4 fails closed / SSRF 防护：本机、回环、链路本地、ULA、私网段主机返回 true；非法 IPv4 一律拦截 */
function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

/**
 * Fetch via Electron net module — uses Chromium's network stack for TLS/proxy/cert compatibility.
 * 通过 Electron net 模块抓取 — 使用 Chromium 网络栈，兼容 TLS/代理/证书。
 *
 * Use this for URLs that fail with Node.js fetch (e.g. educational system sites with strict TLS).
 * 对 Node.js fetch 失败的 URL（如严格 TLS 的教务系统网站）使用此函数。
 *
 * @param input - Target URL and caller abort signal / 目标 URL 与调用方取消信号
 * @returns Extracted title/text outcome / 抽取后的标题与正文结果
 */
export function fetchWebPageViaNet(input: { url: string; signal: AbortSignal }): Promise<WebFetchOutcome> {
  const parsed = parsePublicWebUrl(input.url);
  const MAX_REDIRECTS = 5;

  return new Promise((resolve, reject) => {
    let redirectCount = 0;
    let currentUrl = parsed.toString();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const doRequest = (url: string) => {
      const request = net.request({
        url,
        method: 'GET',
        redirect: 'manual',
        session: undefined, // Use default session for cert/proxy settings
      });

      let delivered = false;
      let body = '';

      const cleanup = () => {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
        input.signal.removeEventListener('abort', onAbort);
      };

      const settle = () => { if (!delivered) { delivered = true; cleanup(); } };

      // Timeout guard
      timeoutId = setTimeout(() => {
        request.abort();
        settle();
        reject(new Error('网页请求超时。'));
      }, WEB_FETCH_TIMEOUT_MS);

      const onAbort = () => {
        request.abort();
        settle();
        reject(new Error('网络请求已取消。'));
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) { onAbort(); return; }

      // Handle redirects manually to stay within Chromium's network stack
      request.on('redirect', (status, _method, redirectUrl) => {
        request.abort();
        if (redirectCount >= MAX_REDIRECTS) {
          if (!delivered) { delivered = true; cleanup(); reject(new Error('重定向次数过多。')); }
          return;
        }
        redirectCount++;
        // Clear current timeout before following redirect
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
        input.signal.removeEventListener('abort', onAbort);
        // Follow the redirect with a new net.request
        doRequest(redirectUrl);
      });

      request.on('response', (response) => {
        // Check content type before reading body
        const contentType = response.headers['content-type'] ?? '';
        const contentTypeStr = Array.isArray(contentType) ? contentType.join(', ') : contentType;
        if (contentTypeStr && !/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(contentTypeStr)) {
          request.abort();
          if (!delivered) { delivered = true; cleanup(); reject(new Error(`网页返回了不支持的内容类型（${contentTypeStr.split(';')[0]}）。`)); }
          return;
        }

        if (response.statusCode && response.statusCode >= 400) {
          request.abort();
          if (!delivered) { delivered = true; cleanup(); reject(new Error(`网页请求失败（HTTP ${response.statusCode}）。`)); }
          return;
        }

        response.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8'); });
        response.on('end', () => {
          cleanup();
          if (!delivered) { delivered = true; resolve(extractReadableContent(body)); }
        });
        response.on('error', (err: Error) => {
          cleanup();
          if (!delivered) { delivered = true; reject(err); }
        });
      });

      request.on('error', (err: Error) => {
        cleanup();
        if (!delivered) { delivered = true; reject(err); }
      });

      request.end();
    };

    doRequest(currentUrl);
  });
}

/**
 * Lightweight content extraction: dependency-free regex cleanup covering common page structures.
 * 轻量正文抽取：无外部依赖的正则式清洗，覆盖常见网页结构。
 *
 * @param html - Raw HTML (or plain text/XML) body / 原始 HTML（或纯文本/XML）正文
 * @returns Extracted title/text outcome / 抽取后的标题与正文结果
 */
export function extractReadableContent(html: string): WebFetchOutcome {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop non-content blocks (script/style/noscript/comments/chrome-like regions/SVG) before textification.
  // 文本化前去除脚本、样式、noscript、注释、页头页尾导航表单、SVG 等非正文块。
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(header|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  // Turn block-level boundaries into newlines, strip remaining tags, decode entities, then collapse whitespace.
  // 将块级边界转为换行、去剩余标签、解码实体并折叠空白。
  const text = stripped
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    ...(title ? { title } : {}),
    text: text.slice(0, WEB_FETCH_MAX_CHARS),
    empty: text.trim().length < 40,
  };
}
