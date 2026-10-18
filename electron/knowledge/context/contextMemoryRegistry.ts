/**
 * Registry that resolves route-scoped memory adapters and merges primary and
 * supplemental context results into a single unified output.
 * 本模块负责解析路由范围内记忆 Adapter，并将主结果与补充结果合并为统一输出。
 */
import { createHash } from 'node:crypto';
import type {
  ContextMemoryAdapter,
  ContextMemoryRequest,
  ContextMemoryResult,
  SupplementalContextAdapter,
} from './contextMemoryTypes.ts';

/**
 * Resolves one route-scoped memory adapter and combines it with the project
 * context adapter. It deliberately owns neither SQL nor Prompt rendering.
 * 解析一个路由范围内的记忆 Adapter，并将其与项目上下文 Adapter 合并。
 * 该注册器不负责 SQL 或 Prompt 渲染。
 */
export class ContextMemoryRegistry {
  constructor(
    private readonly projectAdapter: ContextMemoryAdapter,
    private readonly routeAdapters: readonly ContextMemoryAdapter[],
    private readonly supplementalAdapters: readonly SupplementalContextAdapter[] = [],
  ) {}

  /**
   * Loads memory materials from the project adapter, the matching route adapter,
   * and any supplemental adapters, then merges them into a single result.
   * 从项目 Adapter、匹配的路由 Adapter 以及各补充 Adapter 加载记忆材料，合并为单一结果。
   *
   * @param request - Memory load request with route, budgets, and optional project context / 包含路由、预算和可选项目上下文的记忆加载请求
   * @returns Merged materials, version hash, and aggregated diagnostics / 合并后的材料、版本哈希及汇总诊断信息
   */
  async load(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    const routeMatches = this.routeAdapters.filter((adapter) => adapter.supports(request));
    if (routeMatches.length !== 1) {
      throw new Error(`ContextMemoryRegistry 路由 ${request.route} 需要且只能命中一个记忆 Adapter，实际 ${routeMatches.length} 个。`);
    }
    const adapters = [this.projectAdapter, routeMatches[0]].filter((adapter) => adapter.supports(request));
    const primaryResults = await Promise.all(adapters.map((adapter) => adapter.load(request)));
    const supplementalResults = await Promise.all(this.supplementalAdapters.map(async (adapter) => {
      try {
        if (!adapter.supports(request)) return undefined;
        return await adapter.load(request);
      } catch {
        return unavailableSupplementalResult(adapter.id);
      }
    }));
    const results = [...primaryResults, ...supplementalResults.filter((result): result is ContextMemoryResult => Boolean(result))];
    const materials = results.flatMap((result) => result.materials);
    const materialIds = new Set<string>();
    for (const material of materials) {
      if (materialIds.has(material.id)) throw new Error(`ContextMemoryRegistry 检测到重复 Material：${material.id}`);
      materialIds.add(material.id);
    }
    return {
      materials,
      version: createHash('sha256').update(JSON.stringify(results.map((result) => result.version)), 'utf8').digest('hex'),
      diagnostics: {
        source: results.map((result) => result.diagnostics.source).join('+'),
        loadedTurns: results.reduce((sum, result) => sum + result.diagnostics.loadedTurns, 0),
        loadedSummaries: results.reduce((sum, result) => sum + result.diagnostics.loadedSummaries, 0),
        recalledTurns: results.reduce((sum, result) => sum + result.diagnostics.recalledTurns, 0),
        staleItems: results.reduce((sum, result) => sum + result.diagnostics.staleItems, 0),
      },
    };
  }
}

/**
 * Returns an empty result with an "unavailable" sentinel when a supplemental
 * adapter fails. This isolates supplemental failures from primary results.
 * 当补充 Adapter 失败时返回带 "unavailable" 标记的空结果，隔离补充失败不影响主结果。
 *
 * @param id - Identifier of the failed supplemental adapter / 失败的补充 Adapter 标识符
 * @returns Empty memory result with unavailable diagnostics / 带 unavailable 诊断的空记忆结果
 */
function unavailableSupplementalResult(id: string): ContextMemoryResult {
  return {
    materials: [],
    version: `${id}:unavailable`,
    diagnostics: {
      source: `${id}:unavailable`,
      loadedTurns: 0,
      loadedSummaries: 0,
      recalledTurns: 0,
      staleItems: 1,
    },
  };
}
