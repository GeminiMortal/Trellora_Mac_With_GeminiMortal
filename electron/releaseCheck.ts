/**
 * Semver parsing/comparison and a bounded GitHub release checker for update notifications.
 * 语义化版本解析/比较，以及用于更新提示的受限 GitHub 发布检查器。
 */
import type { ReleaseCheckResult } from '../shared/releaseCheck.ts';
// Strict semver parse: rejects non-strict versions and unsafe integer components before comparison.
// 严格解析 semver：比较前拒绝非严格版本与不安全整数分量。
const parse = (value: string) => { const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value); if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))) return undefined; return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') }; };
/**
 * Compares two semver strings using precedence rules, including prerelease ordering.
 * 按语义化版本优先级规则比较两个版本字符串，包含预发布排序。
 *
 * @param left - First version string / 第一个版本字符串
 * @param right - Second version string / 第二个版本字符串
 * @returns 1 when left is newer, -1 when older, 0 when equal, undefined when either is invalid / 左新返回 1，左旧返回 -1，相等返回 0，任一无效返回 undefined
 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parse(left), b = parse(right); if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  // A version without prerelease outranks the same version with one, per semver precedence.
  // 依 semver 优先级：无预发布版本高于同号的预发布版本。
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  // Compare prerelease identifiers left to right: numeric pairs numerically, mixed pairs with numeric last.
  // 从左到右比较预发布标识：均为数字按数值比较，数字与非数字混排时数字在后。
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) { const x = a.prerelease[index], y = b.prerelease[index]; if (x === y) continue; if (x === undefined || y === undefined) return x === undefined ? -1 : 1; const numericX = /^\d+$/u.test(x), numericY = /^\d+$/u.test(y); if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1; if (numericX !== numericY) return numericX ? -1 : 1; return x > y ? 1 : -1; }
  return 0;
}
/**
 * User-triggered, bounded public metadata request; never receives application credentials or user content.
 * 由用户触发的、有界的公开元数据请求；绝不接收应用凭据或用户内容。
 */
export class ReleaseChecker {
  private inFlight?: Promise<ReleaseCheckResult>;
  private cache?: ReleaseCheckResult;
  /**
   * Creates a checker for one repository and app version.
   * 为指定仓库与应用版本创建检查器。
   *
   * @param options - Repository URL, current version, and optional fetch/clock injections for tests / 仓库 URL、当前版本，以及测试用的可选 fetch/时钟注入
   */
  constructor(private readonly options: { repositoryUrl: string; version: string; fetch?: typeof fetch; now?: () => number }) {}
  /**
   * Returns the latest release state, deduplicating concurrent calls and caching for five minutes.
   * 返回最新发布状态：并发调用去重，并缓存五分钟。
   *
   * @returns Promise resolving to the release check result / 解析为发布检查结果的 Promise
   */
  check(): Promise<ReleaseCheckResult> {
    if (this.inFlight) return this.inFlight;
    if (this.cache && (this.options.now?.() ?? Date.now()) - Date.parse(this.cache.checkedAt) < 5 * 60_000) return Promise.resolve({ ...this.cache, cached: true });
    const request = this.execute().then(result => { this.cache = result; return result; }).finally(() => { this.inFlight = undefined; }); this.inFlight = request; return request;
  }
  // Performs one bounded, validated GitHub request; every anomaly degrades to an "unavailable" result.
  // 执行一次有界且校验严格的 GitHub 请求；任何异常都降级为“不可用”结果。
  private async execute(): Promise<ReleaseCheckResult> {
    const checkedAt = new Date(this.options.now?.() ?? Date.now()).toISOString(); const base = { currentVersion: this.options.version, checkedAt };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // Only https://github.com owner/repo URLs are accepted; anything else is rejected before any fetch.
      // 仅接受 https://github.com 的 owner/repo URL；其他一律在请求前拒绝。
      const repository = new URL(this.options.repositoryUrl); const match = /^\/([\w.-]+)\/([\w.-]+)\/?$/u.exec(repository.pathname);
      if (repository.hostname !== 'github.com' || repository.protocol !== 'https:' || !match) throw new Error('INVALID_RELEASE');
      // redirect: 'error' blocks response redirection so metadata cannot be spoofed from another origin.
      // redirect: 'error' 阻止响应重定向，避免元数据被其他来源伪造。
      const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Trellora-release-check', 'X-GitHub-Api-Version': '2026-03-10' }, signal: controller.signal, redirect: 'error' });
      if (response.status === 404) return { ...base, state: 'unavailable', code: 'NO_RELEASE' };
      if ([403, 429].includes(response.status)) return { ...base, state: 'unavailable', code: 'RATE_LIMITED' };
      if (!response.ok || !response.body) throw new Error('NETWORK_ERROR');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      // Cap the body at 1 MiB while reading so a hostile response cannot exhaust memory.
      // 读取时将响应体限制在 1 MiB，防止恶意响应耗尽内存。
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 ** 2) throw new Error('INVALID_RELEASE'); chunks.push(part.value); } } finally { await reader.cancel().catch(() => undefined); }
      const release = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      // Require a published, non-prerelease stable tag; drafts and prereleases never notify users.
      // 要求已发布、非预发布的稳定标签；草稿与预发布版本不提示用户。
      if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || parse(release.tag_name)?.prerelease || typeof release.html_url !== 'string') throw new Error('INVALID_RELEASE');
      // The release URL must stay on github.com under the same repository path, without embedded credentials.
      // 发布 URL 必须保持在 github.com 同仓库路径下，且不得内嵌凭据。
      const comparison = compareVersions(release.tag_name, this.options.version), url = new URL(release.html_url);
      if (comparison === undefined || url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${match[1]}/${match[2]}/releases/tag/`) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_RELEASE');
      return { ...base, state: comparison > 0 ? 'available' : 'current', latestVersion: release.tag_name.replace(/^v/u, ''), releaseUrl: url.href };
    } catch (error) { return { ...base, state: 'unavailable', code: controller.signal.aborted ? 'TIMEOUT' : error instanceof Error && error.message === 'INVALID_RELEASE' ? 'INVALID_RELEASE' : 'NETWORK_ERROR' }; }
    finally { clearTimeout(timer); }
  }
}
