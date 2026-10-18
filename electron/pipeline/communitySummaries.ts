import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokenCount } from '../knowledge/model/tokenEstimator.ts';
import { atomicWriteJson } from './pathLayout.ts';
import type { LibraryGraphEnhancementConfig } from './types.ts';

/**
 * Community summary generation (GraphRAG spec §3.3): after the library-level graph
 * assembly is committed, the Electron side issues batched small LLM calls to produce
 * structured summaries bottom-up. LLM calls are made through the injected callSummary
 * (the Worker never holds API keys); strict JSON failures fall back to lenient parsing,
 * and failed communities are recorded and skipped (best-effort, never blocks assembly).
 * 社区摘要生成（GraphRAG 方案 §3.3）：库级图装配提交后由 Electron 侧批量小调用
 * 自底向上生成结构化摘要。LLM 调用经注入的 callSummary 发起（Worker 永不持钥），
 * strict JSON 失败走宽松回退，失败社区记痕跳过（best-effort，不阻塞图装配）。
 */

/** Schema version identifier for community summary artifacts. / 社区摘要产物的 schema 版本标识。 */
export const COMMUNITY_SUMMARY_SCHEMA_VERSION = 'community-summary-v1';
/** File name of the per-community summary JSONL records. / 单社区摘要 JSONL 记录的文件名。 */
export const COMMUNITY_SUMMARIES_FILE_NAME = 'community-summaries.jsonl';
/** File name of the summary run report (cache key, counts, failures). / 摘要运行报告的文件名（缓存键、计数、失败清单）。 */
export const COMMUNITY_SUMMARY_REPORT_FILE_NAME = 'community-summary-report.json';
/**
 * Batch small-call concurrency cap (spec §3.3: concurrency ≤3).
 * 批量小调用并发上限（方案 §3.3：并发 ≤3）。
 */
export const SUMMARY_CALL_CONCURRENCY = 3;
const SUMMARY_KEY_POINTS_LIMIT = 6;
const SUMMARY_ENTITIES_LIMIT = 12;
const SUMMARY_TEXT_LIMIT = 1200;
const FAILURE_RAW_OUTPUT_LIMIT = 400;

/**
 * One community summary record persisted to community-summaries.jsonl.
 * 持久化到 community-summaries.jsonl 的单条社区摘要记录。
 */
export interface CommunitySummaryRecord {
  /** Id of the summarized community. / 被摘要社区的 id。 */
  communityId: string;
  /** Community hierarchy level (0 = top). / 社区层级（0 为顶层）。 */
  level: number;
  /** Structured summary text. / 结构化摘要文本。 */
  summary: string;
  /** Extracted key points (count-capped). / 提取的要点（数量有上限）。 */
  keyPoints: string[];
  /** Salient entity mentions (count-capped). / 突出实体提及（数量有上限）。 */
  entities: string[];
  /**
   * Estimated token count of the summary text (upper-level replacement and global-search windowing).
   * 摘要文本的估算 token 数（高层替换与全局检索装窗用）。
   */
  tokens: number;
  /**
   * Member-set fingerprint (spec §4.7 incremental inheritance key); may be missing on legacy artifacts.
   * 成员集合指纹（方案 §4.7 增量继承键）；旧产物可能缺失。
   */
  memberFingerprint?: string;
  /**
   * Inherited from the previous graph at rebuild time (communities with unchanged members reuse with zero LLM calls).
   * 重建时从旧图继承（成员未变的社区零调用复用）。
   */
  inherited?: boolean;
}

/**
 * A community whose summary call failed; recorded for inspection and skipped (best-effort).
 * 摘要调用失败的社区；记痕供排查并跳过（best-effort）。
 */
export interface CommunitySummaryFailure {
  /** Id of the failed community. / 失败社区的 id。 */
  communityId: string;
  /** Human-readable failure reason. / 可读的失败原因。 */
  reason: string;
  /** Truncated raw model output, when available. / 截断后的模型原始输出（若有）。 */
  rawOutput?: string;
}

/**
 * Run report written next to the summaries; its summaryKey drives cache-hit detection.
 * 与摘要产物一同落盘的运行报告；其 summaryKey 用于缓存命中判定。
 */
export interface CommunitySummaryReport {
  /** Artifact schema version. / 产物 schema 版本。 */
  schemaVersion: string;
  /** Cache key for this summary run (see computeCommunitySummaryKey). / 本次摘要运行的缓存键（见 computeCommunitySummaryKey）。 */
  summaryKey: string;
  /** Key of the source graph artifacts. / 源图产物的 graphKey。 */
  graphKey: string;
  /** Version of the summary prompt used. / 使用的摘要 prompt 版本。 */
  promptVersion: string;
  /** Model fingerprint (model/endpoint/consent). / 模型指纹（模型/endpoint/consent）。 */
  fingerprint: string;
  /** Per-community context budget in tokens. / 单社区上下文预算（token）。 */
  budgetTokens: number;
  /** counts: total / newly summarized / inherited / level count. / counts：总数 / 新生成 / 继承 / 层数。 */
  counts: { communities: number; summarized: number; inherited: number; levels: number };
  /** Communities that failed to summarize. / 摘要失败的社区清单。 */
  failures: CommunitySummaryFailure[];
  /** Wall-clock duration of the run. / 本次运行耗时。 */
  durationMs: number;
  /** ISO timestamp of generation. / 生成时间（ISO）。 */
  generatedAt: string;
}

/**
 * Inputs for generateCommunitySummaries.
 * generateCommunitySummaries 的输入。
 */
export interface GenerateCommunitySummariesInput {
  /**
   * Committed `.menghan-meta/graph/<graphKey>` directory.
   * 已提交的 `.menghan-meta/graph/<graphKey>` 目录。
   */
  graphDirectory: string;
  /** Graph artifact key. / 图产物键。 */
  graphKey: string;
  /** Library graph enhancement configuration. / 库图增强配置。 */
  config: LibraryGraphEnhancementConfig;
  /**
   * Model fingerprint (any change of model/endpoint/consent invalidates the cache, spec §3.1 cache-key rules).
   * 模型指纹（模型/endpoint/consent 任一变化即失效，方案 §3.1 缓存键口径）。
   */
  fingerprint: string;
  /**
   * Injected LLM call: takes the assembled community context text, returns raw model output.
   * 注入的 LLM 调用：输入装配好的社区上下文文本，返回模型原始输出。
   */
  callSummary: (text: string) => Promise<string>;
  /**
   * Summaries inherited from the previous graph (communities whose member fingerprint matched); inherited communities are not called again.
   * 重建时从旧图继承的摘要（成员指纹命中的社区）；已继承社区不再调用。
   */
  preloaded?: CommunitySummaryRecord[];
  /** Cancellation signal. / 取消信号。 */
  signal?: AbortSignal;
  /** Progress callback (completed, total). / 进度回调（已完成，总数）。 */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Result of generateCommunitySummaries: sorted summary records plus the run report.
 * generateCommunitySummaries 的结果：排序后的摘要记录与运行报告。
 */
export interface GenerateCommunitySummariesResult {
  /** Final summary records (including inherited ones). / 最终摘要记录（含继承记录）。 */
  summaries: CommunitySummaryRecord[];
  /** Run report persisted next to the artifacts. / 与产物一同落盘的运行报告。 */
  report: CommunitySummaryReport;
}

/**
 * Computes the summary cache key: hash(graphKey + summary prompt version + model fingerprint + budget);
 * leidenConfig changes propagate through graphKey.
 * summaryKey = hash(graphKey + 摘要 prompt 版本 + 模型指纹 + 预算)；leidenConfig 变化经 graphKey 传导。
 *
 * @param input - Cache key ingredients / 缓存键要素
 * @returns Hex-encoded SHA-256 summary key / 十六进制 SHA-256 的 summaryKey
 */
export function computeCommunitySummaryKey(input: { graphKey: string; promptVersion: string; fingerprint: string; budgetTokens: number }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: COMMUNITY_SUMMARY_SCHEMA_VERSION,
    graphKey: input.graphKey,
    promptVersion: input.promptVersion,
    fingerprint: input.fingerprint,
    budgetTokens: input.budgetTokens,
  })).digest('hex');
}

/**
 * Checks whether both the summaries JSONL and the run report exist on disk.
 * 检查摘要 JSONL 与运行报告是否都已存在于磁盘。
 *
 * @param graphDirectory - Committed graph artifact directory / 已提交的图产物目录
 * @returns True when both artifact files are present / 两个产物文件都存在时为 true
 */
export function communitySummaryArtifactsExist(graphDirectory: string): boolean {
  return fs.existsSync(path.join(graphDirectory, COMMUNITY_SUMMARIES_FILE_NAME))
    && fs.existsSync(path.join(graphDirectory, COMMUNITY_SUMMARY_REPORT_FILE_NAME));
}

/**
 * Member-set fingerprint = sha256(sorted memberKeys + level): communities whose members are unchanged after a graph rebuild can reuse the old summary (spec §4.7).
 * 成员集合指纹 = sha256(sorted memberKeys + level)：图重建后成员未变的社区可沿用旧摘要（方案 §4.7）。
 *
 * @param memberKeys - Canonical keys of community members / 社区成员的规范键
 * @param level - Community hierarchy level / 社区层级
 * @returns Hex-encoded SHA-256 member fingerprint / 十六进制 SHA-256 的成员指纹
 */
export function computeCommunityMemberFingerprint(memberKeys: readonly string[], level: number): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: COMMUNITY_SUMMARY_SCHEMA_VERSION,
    level,
    memberKeys: [...new Set(memberKeys)].sort(),
  })).digest('hex');
}

/**
 * Lightweight manifest of a community to summarize (id, level, members).
 * 待摘要社区的轻量清单（id、层级、成员）。
 */
export interface SummaryCommunityManifest {
  /** Id of the community. / 社区 id。 */
  communityId: string;
  /** Community hierarchy level. / 社区层级。 */
  level: number;
  /** Canonical keys of community members. / 社区成员的规范键。 */
  memberKeys: string[];
}

/**
 * Incremental inheritance: a new community whose member fingerprint exactly matches an old record reuses it
 * (keeps the original summary/tokens, marks inherited, remaps communityId to the new community); misses go to
 * the pending list (handed by the caller to generateCommunitySummaries). Old records without a fingerprint
 * (legacy artifacts) or with an empty summary do not participate; each old record is inherited at most once.
 * 增量继承：新社区的成员指纹精确命中旧记录 → 沿用（保留原 summary/tokens，标记 inherited，
 * communityId 重映射为新社区）；未命中进待生成清单（由调用方交给 generateCommunitySummaries）。
 * 旧记录缺指纹（存量产物）或空摘要不参与继承；一条旧记录最多被一个新社区继承。
 *
 * @param input - Old summary records and the new community manifests / 旧摘要记录与新社区清单
 * @returns Reusable preloaded records and communities still needing generation / 可复用的继承记录与待生成社区
 */
export function inheritReusableSummaries(input: {
  oldRecords: CommunitySummaryRecord[];
  newCommunities: SummaryCommunityManifest[];
}): { preloaded: CommunitySummaryRecord[]; pending: SummaryCommunityManifest[] } {
  const byFingerprint = new Map<string, CommunitySummaryRecord>();
  for (const record of input.oldRecords) {
    if (record.memberFingerprint && record.summary.trim()) byFingerprint.set(record.memberFingerprint, record);
  }
  const preloaded: CommunitySummaryRecord[] = [];
  const pending: SummaryCommunityManifest[] = [];
  for (const community of input.newCommunities) {
    const fingerprint = computeCommunityMemberFingerprint(community.memberKeys, community.level);
    const reusable = byFingerprint.get(fingerprint);
    if (reusable) {
      // Consume the matched record so each old summary is inherited at most once.
      // 命中即从表中移除，保证一条旧摘要最多被继承一次。
      byFingerprint.delete(fingerprint);
      preloaded.push({ ...reusable, communityId: community.communityId, level: community.level, memberFingerprint: fingerprint, inherited: true });
    } else {
      pending.push(community);
    }
  }
  return { preloaded, pending };
}

/**
 * Reads and defensively validates the summary run report; returns null on missing or malformed files.
 * 读取并防御性校验摘要运行报告；文件缺失或格式非法时返回 null。
 *
 * @param graphDirectory - Committed graph artifact directory / 已提交的图产物目录
 * @returns The parsed report, or null when unavailable / 解析后的报告，不可用时为 null
 */
export function readCommunitySummaryReport(graphDirectory: string): CommunitySummaryReport | null {
  const reportPath = path.join(graphDirectory, COMMUNITY_SUMMARY_REPORT_FILE_NAME);
  if (!fs.existsSync(reportPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as CommunitySummaryReport;
  } catch {
    return null;
  }
}

/**
 * Cache-hit check: artifacts are complete and the recorded summaryKey matches the expected one.
 * 缓存命中判定：summaryKey 一致且产物齐全。
 *
 * @param graphDirectory - Committed graph artifact directory / 已提交的图产物目录
 * @param expectedSummaryKey - Summary key computed for the current inputs / 当前输入计算出的 summaryKey
 * @returns True when the cached summaries are up to date / 缓存摘要为最新时为 true
 */
export function isCommunitySummaryCurrent(graphDirectory: string, expectedSummaryKey: string): boolean {
  if (!communitySummaryArtifactsExist(graphDirectory)) return false;
  const report = readCommunitySummaryReport(graphDirectory);
  return Boolean(report && report.summaryKey === expectedSummaryKey);
}

/**
 * Reads summary records from the JSONL artifact, skipping malformed lines and normalizing fields.
 * 从 JSONL 产物读取摘要记录，跳过非法行并规范化字段。
 *
 * @param graphDirectory - Committed graph artifact directory / 已提交的图产物目录
 * @returns Parsed summary records (empty when the file is absent) / 解析出的摘要记录（文件缺失时为空）
 */
export function readCommunitySummaryRecords(graphDirectory: string): CommunitySummaryRecord[] {
  const summariesPath = path.join(graphDirectory, COMMUNITY_SUMMARIES_FILE_NAME);
  if (!fs.existsSync(summariesPath)) return [];
  const records: CommunitySummaryRecord[] = [];
  for (const line of fs.readFileSync(summariesPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.communityId !== 'string' || typeof value.summary !== 'string') continue;
      records.push({
        communityId: value.communityId,
        level: typeof value.level === 'number' ? value.level : 0,
        summary: value.summary,
        keyPoints: toStringArray(value.keyPoints).slice(0, SUMMARY_KEY_POINTS_LIMIT),
        entities: toStringArray(value.entities).slice(0, SUMMARY_ENTITIES_LIMIT),
        tokens: typeof value.tokens === 'number' && Number.isFinite(value.tokens) ? Math.max(0, Math.floor(value.tokens)) : estimateTokenCount(value.summary),
        ...(typeof value.memberFingerprint === 'string' && value.memberFingerprint ? { memberFingerprint: value.memberFingerprint } : {}),
        ...(value.inherited === true ? { inherited: true } : {}),
      });
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * Generates all community summaries bottom-up and writes the artifacts. Leaf levels pack a budgeted
 * context from community edges (ordered by summed endpoint degree); upper levels first pack child
 * details and, when over budget, replace details with child summaries in descending token order (paper §3.1.5).
 * 自底向上生成全部社区摘要并落产物。叶级按边（两端 degree 和降序）装预算上下文；
 * 高层先装子社区明细，超预算时按 token 降序用子社区摘要替换（论文 §3.1.5）。
 *
 * @param input - Generation inputs (graph directory, config, injected LLM call, preloaded summaries) / 生成输入（图目录、配置、注入的 LLM 调用、继承摘要）
 * @returns Sorted summary records and the run report / 排序后的摘要记录与运行报告
 */
export async function generateCommunitySummaries(input: GenerateCommunitySummariesInput): Promise<GenerateCommunitySummariesResult> {
  const startedAt = Date.now();
  const graph = readGraphArtifactsForSummary(input.graphDirectory);
  const communities = readCommunitiesForSummary(input.graphDirectory);
  const summaryKey = computeCommunitySummaryKey({
    graphKey: input.graphKey,
    promptVersion: input.config.summaryPromptVersion,
    fingerprint: input.fingerprint,
    budgetTokens: input.config.summaryBudgetTokens,
  });

  const failures: CommunitySummaryFailure[] = [];
  const summaries = new Map<string, CommunitySummaryRecord>();
  // Inherited summaries enter the map first: later layers reference them as usual, with no new calls.
  // 继承的摘要先入表：后续层级装配照常引用，不再为其发起调用。
  for (const record of input.preloaded ?? []) {
    if (record.summary.trim()) summaries.set(record.communityId, record);
  }
  const levels = communities.length > 0 ? Math.max(...communities.map((community) => community.level)) : 0;
  const childrenByParent = groupChildren(communities);

  // Bottom-up: the finest (leaf) level runs first, aggregating up toward level 0.
  // 自底向上：最细层（叶）先行，逐层向 level 0 汇总。
  for (let level = levels; level >= 0; level -= 1) {
    const layer = communities
      .filter((community) => community.level === level && !summaries.has(community.communityId))
      .sort((first, second) => first.communityId.localeCompare(second.communityId));
    if (layer.length === 0) continue;
    const texts = layer.map((community) => ({
      community,
      text: level === levels
        ? assembleLeafContext(community, graph)
        : assembleUpperLevelContext(community, childrenByParent.get(community.communityId) ?? [], summaries, graph),
    }));
    const generated = await runSummaryCalls(texts, input);
    for (const item of generated) {
      if (item.record) {
        summaries.set(item.community.communityId, item.record);
      } else {
        failures.push({
          communityId: item.community.communityId,
          reason: item.reason,
          ...(item.rawOutput !== undefined ? { rawOutput: item.rawOutput.slice(0, FAILURE_RAW_OUTPUT_LIMIT) } : {}),
        });
      }
    }
  }

  const records = [...summaries.values()].sort((first, second) => first.communityId.localeCompare(second.communityId));
  const report: CommunitySummaryReport = {
    schemaVersion: COMMUNITY_SUMMARY_SCHEMA_VERSION,
    summaryKey,
    graphKey: input.graphKey,
    promptVersion: input.config.summaryPromptVersion,
    fingerprint: input.fingerprint,
    budgetTokens: input.config.summaryBudgetTokens,
    counts: {
      communities: communities.length,
      summarized: records.length,
      inherited: records.filter((record) => record.inherited === true).length,
      levels: communities.length > 0 ? levels + 1 : 0,
    },
    failures,
    durationMs: Math.max(0, Date.now() - startedAt),
    generatedAt: new Date().toISOString(),
  };
  writeSummaryArtifacts(input.graphDirectory, records, report);
  return { summaries: records, report };
}

// ---------------------------------------------------------------------------
// 上下文装配
// ---------------------------------------------------------------------------

interface SummaryGraphNode {
  canonicalKey: string;
  mention: string;
  type: string;
  description: string;
  degree: number;
}

interface SummaryGraphEdge {
  sourceKey: string;
  targetKey: string;
  weight: number;
  kinds: string[];
  description: string;
}

interface SummaryCommunity {
  communityId: string;
  level: number;
  parentId: string;
  memberKeys: string[];
}

/** 叶级上下文：社区内边按 (source.degree+target.degree) 降序装入预算（方案 §3.3）。 */
function assembleLeafContext(community: SummaryCommunity, graph: { nodes: Map<string, SummaryGraphNode>; edges: SummaryGraphEdge[] }): string {
  const members = new Set(community.memberKeys);
  const inner = graph.edges
    .filter((edge) => members.has(edge.sourceKey) && members.has(edge.targetKey))
    .map((edge) => ({ edge, rank: degreeOf(graph, edge.sourceKey) + degreeOf(graph, edge.targetKey) }))
    .sort((first, second) => second.rank - first.rank || first.edge.sourceKey.localeCompare(second.edge.sourceKey));
  const budgetLines: string[] = [];
  let tokens = 0;
  for (const { edge } of inner) {
    const line = describeEdge(edge, graph);
    const lineTokens = estimateTokenCount(line);
    if (budgetLines.length > 0 && tokens + lineTokens > 32_000) break;
    budgetLines.push(line);
    tokens += lineTokens;
  }
  // 无内部边的孤立成员社区：退化为成员描述清单，保证每层都有摘要素材。
  if (budgetLines.length === 0) {
    for (const key of community.memberKeys) {
      const node = graph.nodes.get(key);
      if (!node) continue;
      budgetLines.push(`实体「${node.mention}」（${node.type}）：${node.description || '无描述'}`);
    }
  }
  return budgetLines.join('\n');
}

/** 高层上下文：子社区明细装预算；超预算时按 token 降序用子社区摘要替换（论文 §3.1.5）。 */
function assembleUpperLevelContext(
  community: SummaryCommunity,
  children: SummaryCommunity[],
  summaries: Map<string, CommunitySummaryRecord>,
  graph: { nodes: Map<string, SummaryGraphNode>; edges: SummaryGraphEdge[] },
): string {
  const items = children
    .map((child) => ({
      child,
      detail: assembleLeafContext(child, graph),
      summary: summaries.get(child.communityId),
    }))
    .sort((first, second) => first.child.communityId.localeCompare(second.child.communityId));
  const budgetTokens = 32_000;
  const useSummary = new Set<string>();
  let total = 0;
  const entryTokens = items.map((item) => ({
    item,
    detailTokens: estimateTokenCount(item.detail),
    summaryTokens: item.summary ? item.summary.tokens : Number.POSITIVE_INFINITY,
  }));
  for (const entry of entryTokens) total += entry.detailTokens;
  // 超预算：按明细 token 降序，把最大的明细替换为子社区摘要，直至装下。
  const overflow = [...entryTokens].sort((first, second) => second.detailTokens - first.detailTokens);
  for (const entry of overflow) {
    if (total <= budgetTokens) break;
    if (!entry.item.summary || entry.summaryTokens >= entry.detailTokens) continue;
    total = total - entry.detailTokens + entry.summaryTokens;
    useSummary.add(entry.item.child.communityId);
  }
  return items.map((item) => {
    const body = useSummary.has(item.child.communityId) && item.summary ? `子社区摘要：${item.summary.summary}` : item.detail;
    return `【子社区 ${item.child.communityId}】\n${body}`;
  }).join('\n\n');
}

function describeEdge(edge: SummaryGraphEdge, graph: { nodes: Map<string, SummaryGraphNode> }): string {
  const source = graph.nodes.get(edge.sourceKey);
  const target = graph.nodes.get(edge.targetKey);
  const sourceText = source ? `「${source.mention}」（${source.type}）${source.description ? `：${source.description}` : ''}` : edge.sourceKey;
  const targetText = target ? `「${target.mention}」（${target.type}）${target.description ? `：${target.description}` : ''}` : edge.targetKey;
  const kinds = edge.kinds.length > 0 ? edge.kinds.join('/') : '关联';
  return `${sourceText} —[${kinds}，权重 ${edge.weight}]→ ${targetText}${edge.description ? `；${edge.description}` : ''}`;
}

function degreeOf(graph: { nodes: Map<string, SummaryGraphNode> }, key: string): number {
  return graph.nodes.get(key)?.degree ?? 0;
}

// ---------------------------------------------------------------------------
// LLM 调用与解析（限并发 ≤3；宽松回退 + 失败记痕）
// ---------------------------------------------------------------------------

async function runSummaryCalls(
  items: Array<{ community: SummaryCommunity; text: string }>,
  input: GenerateCommunitySummariesInput,
): Promise<Array<{ community: SummaryCommunity; record?: CommunitySummaryRecord; reason?: string; rawOutput?: string }>> {
  const results: Array<{ community: SummaryCommunity; record?: CommunitySummaryRecord; reason?: string; rawOutput?: string }> = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  const runOne = async (): Promise<void> => {
    while (cursor < items.length) {
      if (input.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (!item.text.trim()) {
        results[index] = { community: item.community, reason: '社区无可用上下文（空成员）。' };
        completed += 1;
        input.onProgress?.(completed, items.length);
        continue;
      }
      let rawOutput: string | undefined;
      try {
        rawOutput = await input.callSummary(item.text);
        const parsed = parseSummaryOutput(rawOutput);
        if (!parsed) {
          results[index] = { community: item.community, reason: '摘要输出无法解析为约定结构。', rawOutput };
        } else {
          const summaryText = parsed.summary.slice(0, SUMMARY_TEXT_LIMIT);
          results[index] = {
            community: item.community,
            record: {
              communityId: item.community.communityId,
              level: item.community.level,
              summary: summaryText,
              keyPoints: parsed.keyPoints,
              entities: parsed.entities,
              tokens: estimateTokenCount(summaryText),
              memberFingerprint: computeCommunityMemberFingerprint(item.community.memberKeys, item.community.level),
            },
          };
        }
      } catch (error) {
        if (input.signal?.aborted) return;
        results[index] = { community: item.community, reason: error instanceof Error ? error.message : String(error), ...(rawOutput !== undefined ? { rawOutput } : {}) };
      }
      completed += 1;
      input.onProgress?.(completed, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SUMMARY_CALL_CONCURRENCY, items.length) }, () => runOne()));
  if (input.signal?.aborted) throw new Error('STAGE_CANCELLED');
  return results;
}

/** strict JSON 优先；失败时宽松回退：剥代码围栏、截取首个花括号块（轻量 JSON 小调用开发模式）。 */
export function parseSummaryOutput(raw: string): { summary: string; keyPoints: string[]; entities: string[] } | null {
  const candidates: string[] = [raw];
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/u, '').trim();
  if (fenced !== raw) candidates.push(fenced);
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) candidates.push(raw.slice(braceStart, braceEnd + 1));
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summary) continue;
    return {
      summary,
      keyPoints: toStringArray(record.key_points ?? record.keyPoints).slice(0, SUMMARY_KEY_POINTS_LIMIT),
      entities: toStringArray(record.entities).slice(0, SUMMARY_ENTITIES_LIMIT),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 产物读写
// ---------------------------------------------------------------------------

function writeSummaryArtifacts(graphDirectory: string, records: CommunitySummaryRecord[], report: CommunitySummaryReport): void {
  const summariesPath = path.join(graphDirectory, COMMUNITY_SUMMARIES_FILE_NAME);
  const tempPath = `${summariesPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${records.map((record) => JSON.stringify(record)).join('\n')}${records.length > 0 ? '\n' : ''}`, 'utf8');
  fs.renameSync(tempPath, summariesPath);
  atomicWriteJson(path.join(graphDirectory, COMMUNITY_SUMMARY_REPORT_FILE_NAME), report);
}

function readGraphArtifactsForSummary(graphDirectory: string): { nodes: Map<string, SummaryGraphNode>; edges: SummaryGraphEdge[] } {
  const nodes = new Map<string, SummaryGraphNode>();
  const edges: SummaryGraphEdge[] = [];
  const graphPath = path.join(graphDirectory, 'graph.jsonl');
  if (!fs.existsSync(graphPath)) return { nodes, edges };
  for (const line of fs.readFileSync(graphPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (value.kind === 'node' && typeof value.canonicalKey === 'string') {
      nodes.set(value.canonicalKey, {
        canonicalKey: value.canonicalKey,
        mention: typeof value.mention === 'string' && value.mention ? value.mention : value.canonicalKey,
        type: typeof value.type === 'string' ? value.type : 'concept',
        description: typeof value.description === 'string' ? value.description : '',
        degree: typeof value.degree === 'number' ? value.degree : 0,
      });
    } else if (value.kind === 'edge' && typeof value.sourceKey === 'string' && typeof value.targetKey === 'string') {
      edges.push({
        sourceKey: value.sourceKey,
        targetKey: value.targetKey,
        weight: typeof value.weight === 'number' ? value.weight : 1,
        kinds: toStringArray(value.kinds),
        description: typeof value.description === 'string' ? value.description : '',
      });
    }
  }
  return { nodes, edges };
}

function readCommunitiesForSummary(graphDirectory: string): SummaryCommunity[] {
  const communities: SummaryCommunity[] = [];
  const communitiesPath = path.join(graphDirectory, 'communities.jsonl');
  if (!fs.existsSync(communitiesPath)) return communities;
  for (const line of fs.readFileSync(communitiesPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof value.communityId !== 'string') continue;
    communities.push({
      communityId: value.communityId,
      level: typeof value.level === 'number' ? value.level : 0,
      parentId: typeof value.parentId === 'string' ? value.parentId : '',
      memberKeys: toStringArray(value.memberKeys),
    });
  }
  return communities;
}

function groupChildren(communities: SummaryCommunity[]): Map<string, SummaryCommunity[]> {
  const children = new Map<string, SummaryCommunity[]>();
  for (const community of communities) {
    if (!community.parentId) continue;
    const list = children.get(community.parentId) ?? [];
    list.push(community);
    children.set(community.parentId, list);
  }
  return children;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
