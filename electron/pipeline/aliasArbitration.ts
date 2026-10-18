/**
 * Alias arbitration for the entity graph: filters vector-similarity candidates, arbitrates merges through an LLM under a strict JSON contract, and applies the resulting alias map to per-document entity artifacts.
 * 实体图别名裁决：过滤向量相似度候选、按严格 JSON 契约调用 LLM 裁决合并，并把得到的别名映射应用到各文档实体产物。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GraphEntityVectorNeighbor } from './graphVectorIndex.ts';

/** Schema version of the alias arbitration artifacts. / 别名裁决产物的结构版本。 */
export const ALIAS_ARBITRATION_SCHEMA_VERSION = 1;
/**
 * Cosine similarity threshold (1 - cosine distance); candidates below it never enter arbitration (plan §4.6: recall first, then arbitrate).
 * 余弦相似度阈值：1 - cosine distance；低于该值不进入裁决（方案 §4.6 先召回后裁决）。
 */
export const ARBITRATION_COSINE_THRESHOLD = 0.86;
/**
 * Maximum number of candidates kept per entity under arbitration.
 * 每个待判定实体的候选上限。
 */
export const ARBITRATION_MAX_CANDIDATES = 5;
/**
 * Decisions below this confidence are not merged and go to the pending list.
 * 低于该置信度的裁决不合并，写入 pending 清单。
 */
export const ARBITRATION_MIN_CONFIDENCE = 70;

/** File name of the JSONL arbitration decision details. / 裁决明细 JSONL 的文件名。 */
export const ALIAS_DECISIONS_FILE_NAME = 'alias-decisions.jsonl';
/** File name of the effective alias map JSON. / 生效别名映射 JSON 的文件名。 */
export const ALIAS_MAP_FILE_NAME = 'alias-map.json';
/**
 * The arbitration cache is a plain file in the graph root directory: commitLibraryGraph only cleans directories, so this file survives graph rebuilds.
 * 裁决缓存放图根目录的普通文件：commitLibraryGraph 只清理目录，文件可跨图重建存活。
 */
export const ALIAS_ARBITRATION_CACHE_FILE_NAME = 'alias-arbitration-cache.jsonl';

/**
 * Basic profile of an entity mention considered for alias merging.
 * 参与别名合并判定的实体提及的基础画像。
 */
export interface AliasEntityProfile {
  /** Surface form of the mention. / 提及的表面写法。 */
  mention: string;
  /** Entity type; only same-type entities may be merged. / 实体类型；仅同类型实体可合并。 */
  type: string;
  /** Description shown to the LLM during arbitration. / 裁决时展示给模型的描述。 */
  description: string;
}

/**
 * A merge candidate for a source entity, produced by vector-neighbor filtering.
 * 源实体的合并候选，由向量邻居过滤产生。
 */
export interface AliasCandidate extends AliasEntityProfile {
  /** Canonical key of the candidate entity. / 候选实体的规范键。 */
  candidateKey: string;
  /** Cosine similarity to the source entity (1 - distance). / 与源实体的余弦相似度（1 - 距离）。 */
  similarity: number;
}

/**
 * One arbitration unit: a source entity together with its merge candidates.
 * 一个裁决单元：源实体及其合并候选。
 */
export interface AliasArbitrationGroup {
  /** Canonical key of the entity being decided. / 待判定实体的规范键。 */
  sourceKey: string;
  /** Profile of the source entity. / 源实体的画像。 */
  source: AliasEntityProfile;
  /** Merge candidates for the source entity. / 源实体的合并候选。 */
  candidates: AliasCandidate[];
}

/**
 * A single LLM merge decision for one candidate.
 * 针对单个候选的一条模型合并裁决。
 */
export interface AliasDecision {
  /** Candidate entity key the decision refers to. / 裁决所针对的候选实体键。 */
  candidateKey: string;
  /** Whether the candidate should be merged into canonicalKey. / 是否应把该候选合并进 canonicalKey。 */
  merge: boolean;
  /** Canonical key to merge into; must belong to the group. / 合并目标规范键；必须属于本组。 */
  canonicalKey: string;
  /** Confidence on a 0–100 scale. / 置信度，取值 0–100。 */
  confidence: number;
  /** Human-readable rationale from the model. / 模型给出的可读理由。 */
  reason: string;
}

/**
 * Persisted arbitration record, one per group; serves as audit trail and cache entry.
 * 每个裁决组一条的持久化记录，用作审计轨迹与缓存项。
 */
export interface AliasDecisionRecord {
  /** Record schema version. / 记录结构版本。 */
  schemaVersion: 1;
  /** Cache key derived from group and model fingerprints. / 由组指纹与模型指纹推出的缓存键。 */
  cacheKey: string;
  /** Graph identifier this decision belongs to. / 该裁决所属图标识。 */
  graphKey: string;
  /** Canonical key of the source entity. / 源实体规范键。 */
  sourceKey: string;
  /** Candidates considered at decision time. / 裁决时考虑的候选。 */
  candidates: AliasCandidate[];
  /** Raw per-candidate decisions from the model. / 模型给出的逐候选裁决。 */
  decisions: AliasDecision[];
  /** Outcome: merged into canonicalKey, pending human review, or failed contract checks. / 结论：已合并、待人工复核，或契约校验失败。 */
  status: 'merged' | 'pending' | 'failed';
  /** Merged canonical key when status is 'merged'. / status 为 merged 时的合并目标键。 */
  canonicalKey: string;
  /** Outcome explanation for audit and UI. / 供审计与界面展示的结果说明。 */
  reason: string;
  /** Fingerprint of the model/prompt used. / 所用模型/提示的指纹。 */
  modelFingerprint: string;
  /**
   * Decision reused from cache (the model was not called again on this rebuild).
   * 从缓存复用的裁决（本次重建未再调用模型）。
   */
  reused?: boolean;
  /** ISO timestamp of the decision. / 裁决时间的 ISO 时间戳。 */
  decidedAt: string;
}

/**
 * Aggregate outcome of arbitrating many groups.
 * 批量裁决的聚合结果。
 */
export interface AliasArbitrateResult {
  /** All decision records, in group order. / 全部裁决记录，按组顺序。 */
  records: AliasDecisionRecord[];
  /** Map of source canonical key → merged canonical key. / 源规范键 → 合并目标规范键 的映射。 */
  aliasMap: Record<string, string>;
}

/**
 * Candidate filtering: excludes self, different-type, and below-threshold neighbors; sorts by similarity descending and keeps at most the configured limit.
 * 候选过滤：排除自身、类型不同、相似度不足者；按相似度降序取上限内。
 *
 * @param neighbors - Vector neighbors of the source entity / 源实体的向量邻居
 * @param input - Source entity key and type / 源实体键与类型
 * @returns Filtered and ranked merge candidates / 过滤并排序后的合并候选
 */
export function filterAliasCandidates(
  neighbors: GraphEntityVectorNeighbor[],
  input: { sourceKey: string; type: string },
): AliasCandidate[] {
  return neighbors
    .filter((neighbor) => neighbor.canonicalKey !== input.sourceKey && neighbor.type === input.type)
    .map((neighbor) => ({
      candidateKey: neighbor.canonicalKey,
      mention: neighbor.mention,
      type: neighbor.type,
      description: '',
      // Convert cosine distance to cosine similarity. / 把余弦距离转换为余弦相似度。
      similarity: 1 - neighbor.distance,
    }))
    .filter((candidate) => candidate.similarity >= ARBITRATION_COSINE_THRESHOLD)
    .sort((first, second) => second.similarity - first.similarity)
    .slice(0, ARBITRATION_MAX_CANDIDATES);
}

/**
 * Computes a stable SHA-256 fingerprint of a group (source + candidates sorted by key) for cache identity.
 * 计算裁决组的稳定 SHA-256 指纹（源实体 + 按键排序的候选），用作缓存标识。
 *
 * @param group - Arbitration group / 裁决组
 * @returns Hex SHA-256 fingerprint / 十六进制 SHA-256 指纹
 */
export function computeAliasGroupFingerprint(group: AliasArbitrationGroup): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: ALIAS_ARBITRATION_SCHEMA_VERSION,
    sourceKey: group.sourceKey,
    source: group.source,
    candidates: [...group.candidates].sort((first, second) => first.candidateKey.localeCompare(second.candidateKey)),
  })).digest('hex');
}

/**
 * Cache key = sha256(group fingerprint + model fingerprint): already-arbitrated groups are not re-run on rebuild.
 * 缓存键 = sha256(候选组指纹 + 模型指纹)：已裁决组重建时不重复调用。
 *
 * @param input - Group and model fingerprints / 候选组指纹与模型指纹
 * @returns Hex SHA-256 cache key / 十六进制 SHA-256 缓存键
 */
export function computeAliasGroupCacheKey(input: { groupFingerprint: string; modelFingerprint: string }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: ALIAS_ARBITRATION_SCHEMA_VERSION,
    groupFingerprint: input.groupFingerprint,
    modelFingerprint: input.modelFingerprint,
  })).digest('hex');
}

/**
 * Arbitration request text: structured JSON; the model output contract is defined by the graph-alias-arbitration prompt in pipelineLlmCoordinator.
 * 裁决请求文本：结构化 JSON，模型输出契约见 pipelineLlmCoordinator 的 graph-alias-arbitration prompt。
 *
 * @param group - Arbitration group / 裁决组
 * @returns JSON payload string for the LLM / 提供给模型的 JSON 载荷字符串
 */
export function buildArbitrationPayload(group: AliasArbitrationGroup): string {
  return JSON.stringify({
    source: { key: group.sourceKey, ...group.source },
    candidates: group.candidates.map((candidate) => ({ key: candidate.candidateKey, mention: candidate.mention, type: candidate.type, description: candidate.description, similarity: Number(candidate.similarity.toFixed(4)) })),
  });
}

/**
 * Strict contract: only accepts strict JSON; returns null on structural or field validation failure (the group is recorded as skipped — no lenient fallback, because results hit the graph store).
 * 强契约：只接受严格 JSON；结构或字段校验失败返回 null（该组记痕跳过，不做宽松回退，因影响落库）。
 *
 * @param rawOutput - Raw model output text / 模型原始输出文本
 * @returns Parsed decisions, or null when the contract is violated / 解析出的裁决；违反契约时返回 null
 */
export function parseArbitrationOutput(rawOutput: string): AliasDecision[] | null {
  let value: unknown;
  try {
    value = JSON.parse(rawOutput.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const decisions = (value as Record<string, unknown>).decisions;
  if (!Array.isArray(decisions)) return null;
  const parsed: AliasDecision[] = [];
  for (const item of decisions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.candidateKey !== 'string' || !candidate.candidateKey) return null;
    if (typeof candidate.merge !== 'boolean') return null;
    if (typeof candidate.canonicalKey !== 'string' || !candidate.canonicalKey) return null;
    if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 100) return null;
    parsed.push({
      candidateKey: candidate.candidateKey,
      merge: candidate.merge,
      canonicalKey: candidate.canonicalKey,
      confidence: Math.floor(candidate.confidence),
      reason: typeof candidate.reason === 'string' ? candidate.reason : '',
    });
  }
  return parsed;
}

/**
 * Derives the merge conclusion from decisions: canonicalKey must fall on a group key; low confidence or no merge → pending.
 * 从裁决结果解析合并结论：canonicalKey 必须落在组内键上；低置信或无合并 → pending。
 *
 * @param group - Arbitration group / 裁决组
 * @param decisions - Parsed model decisions / 已解析的模型裁决
 * @returns Final status, canonical key, and reason / 最终状态、规范键与理由
 */
export function resolveAliasDecision(group: AliasArbitrationGroup, decisions: AliasDecision[]): { status: AliasDecisionRecord['status']; canonicalKey: string; reason: string } {
  const validKeys = new Set([group.sourceKey, ...group.candidates.map((candidate) => candidate.candidateKey)]);
  const merges = decisions
    .filter((decision) => decision.merge && decision.canonicalKey && validKeys.has(decision.canonicalKey)
      && (decision.canonicalKey === group.sourceKey || group.candidates.some((candidate) => candidate.candidateKey === decision.candidateKey)))
    .sort((first, second) => second.confidence - first.confidence);
  const best = merges[0];
  if (!best) return { status: 'pending', canonicalKey: '', reason: '裁决未给出有效合并决定' };
  if (best.confidence < ARBITRATION_MIN_CONFIDENCE) {
    return { status: 'pending', canonicalKey: '', reason: `置信度 ${best.confidence} 低于 ${ARBITRATION_MIN_CONFIDENCE}，待人工复核` };
  }
  return { status: 'merged', canonicalKey: best.canonicalKey, reason: best.reason };
}

/**
 * Input for batch alias arbitration.
 * 批量别名裁决的输入。
 */
export interface ArbitrateAliasGroupsInput {
  /** Groups to arbitrate, processed serially. / 待裁决的组，串行处理。 */
  groups: AliasArbitrationGroup[];
  /** Graph identifier recorded on every result. / 记录到每条结果上的图标识。 */
  graphKey: string;
  /** Model/prompt fingerprint used for cache keying. / 用于缓存键的模型/提示指纹。 */
  modelFingerprint: string;
  /** Invokes the LLM with the arbitration payload and returns raw output. / 以裁决载荷调用模型并返回原始输出。 */
  callArbitrate: (text: string) => Promise<string>;
  /**
   * Existing arbitration cache (cacheKey → record); cache-hit groups skip the model call.
   * 已有裁决缓存（cacheKey → record）；命中的组不再调用模型。
   */
  existingCache?: Map<string, AliasDecisionRecord>;
  /** Optional abort signal to stop between groups. / 可选中止信号，用于在组之间停止。 */
  signal?: AbortSignal;
}

/**
 * Arbitrates groups one by one: cache hits are reused; parse failures are recorded and skipped; low confidence goes to pending. Serial LLM calls keep the audit order deterministic.
 * 逐组裁决：缓存命中复用；解析失败记痕跳过；低置信进 pending。串行调用，保证审计顺序确定。
 *
 * @param input - Groups, cache, and LLM callback / 组列表、缓存与模型回调
 * @returns All records, newly decided records, and the effective alias map / 全部记录、本次新裁决记录与生效别名映射
 */
export async function arbitrateAliasGroups(input: ArbitrateAliasGroupsInput): Promise<{ result: AliasArbitrateResult; newRecords: AliasDecisionRecord[] }> {
  const records: AliasDecisionRecord[] = [];
  const newRecords: AliasDecisionRecord[] = [];
  const aliasMap: Record<string, string> = {};
  for (const group of input.groups) {
    if (input.signal?.aborted) break;
    const cacheKey = computeAliasGroupCacheKey({ groupFingerprint: computeAliasGroupFingerprint(group), modelFingerprint: input.modelFingerprint });
    const cached = input.existingCache?.get(cacheKey);
    if (cached) {
      records.push({ ...cached, graphKey: input.graphKey, reused: true });
      // Only real merges enter the alias map; self-mappings are skipped. / 只把真实合并写进别名映射，跳过自映射。
      if (cached.status === 'merged' && cached.canonicalKey && cached.canonicalKey !== group.sourceKey) {
        aliasMap[group.sourceKey] = cached.canonicalKey;
      }
      continue;
    }
    let rawOutput = '';
    try {
      rawOutput = await input.callArbitrate(buildArbitrationPayload(group));
    } catch {
      rawOutput = '';
    }
    const decisions = rawOutput ? parseArbitrationOutput(rawOutput) : null;
    const resolved = decisions ? resolveAliasDecision(group, decisions) : { status: 'failed' as const, canonicalKey: '', reason: '裁决输出不符合严格 JSON 契约，已跳过' };
    const record: AliasDecisionRecord = {
      schemaVersion: ALIAS_ARBITRATION_SCHEMA_VERSION,
      cacheKey,
      graphKey: input.graphKey,
      sourceKey: group.sourceKey,
      candidates: group.candidates,
      decisions: decisions ?? [],
      status: resolved.status,
      canonicalKey: resolved.canonicalKey,
      reason: resolved.reason,
      modelFingerprint: input.modelFingerprint,
      decidedAt: new Date().toISOString(),
    };
    records.push(record);
    newRecords.push(record);
    if (record.status === 'merged' && record.canonicalKey && record.canonicalKey !== group.sourceKey) {
      aliasMap[group.sourceKey] = record.canonicalKey;
    }
  }
  return { result: { records, aliasMap }, newRecords };
}

/** 读取追加式裁决缓存；坏行跳过（缓存缺失只导致重复裁决，不影响正确性）。 */
export function readAliasArbitrationCache(cachePath: string): Map<string, AliasDecisionRecord> {
  const cache = new Map<string, AliasDecisionRecord>();
  if (!fs.existsSync(cachePath)) return cache;
  for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as AliasDecisionRecord;
      if (record && typeof record.cacheKey === 'string' && record.cacheKey) cache.set(record.cacheKey, record);
    } catch {
      continue;
    }
  }
  return cache;
}

/**
 * Append new alias decision records to the JSONL cache file.
 * 将新的别名裁决记录追加到 JSONL 缓存文件。
 *
 * @param cachePath - Absolute path to the JSONL cache file / JSONL 缓存文件绝对路径
 * @param records - Decision records to append / 要追加的裁决记录
 */
export function appendAliasArbitrationCache(cachePath: string, records: AliasDecisionRecord[]): void {
  if (records.length === 0) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.appendFileSync(cachePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

/** 审计产物：裁决明细（含候选、理由、模型指纹）+ 本次生效的别名映射。 */
export function writeAliasArtifacts(directory: string, records: AliasDecisionRecord[], aliasMap: Record<string, string>): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ALIAS_DECISIONS_FILE_NAME), records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(directory, ALIAS_MAP_FILE_NAME), JSON.stringify(aliasMap, null, 2), 'utf8');
}

/** 读取各 entities 产物，按 canonicalKey 去重聚合（与 graph_stage 的首见语义对齐：保留首条 mention/type）。 */
export function loadEntitiesFromArtifactDirs(entries: ReadonlyArray<{ documentId: string; directory: string }>): Map<string, AliasEntityProfile> {
  const entities = new Map<string, AliasEntityProfile>();
  for (const entry of entries) {
    const entitiesPath = path.join(entry.directory, 'entities.jsonl');
    if (!fs.existsSync(entitiesPath)) continue;
    for (const line of fs.readFileSync(entitiesPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const canonicalKey = typeof row.canonicalKey === 'string' ? row.canonicalKey.trim() : '';
      if (!canonicalKey || entities.has(canonicalKey)) continue;
      entities.set(canonicalKey, {
        mention: typeof row.mention === 'string' && row.mention ? row.mention : canonicalKey,
        type: typeof row.type === 'string' && row.type ? row.type : 'concept',
        description: typeof row.description === 'string' ? row.description : '',
      });
    }
  }
  return entities;
}

/**
 * Electron 侧预映射（Python 侧零改动）：把 aliasMap 应用到各文档的 entities/relations 产物，
 * 写入临时目录后把临时目录交给图阶段。映射后自环边直接丢弃，重复键交由 graph_stage 归并。
 */
export function applyAliasMapToEntitiesDirs(input: {
  entries: ReadonlyArray<{ documentId: string; directory: string }>;
  aliasMap: Record<string, string>;
  stagingRoot: string;
}): string[] {
  const resolveKey = (key: string): string => input.aliasMap[key] ?? key;
  const directories: string[] = [];
  for (const entry of input.entries) {
    const targetDirectory = path.join(input.stagingRoot, entry.documentId || `dir-${directories.length}`);
    fs.mkdirSync(targetDirectory, { recursive: true });
    const entityLines: string[] = [];
    for (const row of readJsonl(path.join(entry.directory, 'entities.jsonl'))) {
      const canonicalKey = typeof row.canonicalKey === 'string' ? row.canonicalKey : '';
      entityLines.push(JSON.stringify({ ...row, canonicalKey: resolveKey(canonicalKey) }));
    }
    fs.writeFileSync(path.join(targetDirectory, 'entities.jsonl'), entityLines.join('\n') + (entityLines.length ? '\n' : ''), 'utf8');
    const relationLines: string[] = [];
    for (const row of readJsonl(path.join(entry.directory, 'relations.jsonl'))) {
      const sourceKey = resolveKey(typeof row.sourceKey === 'string' ? row.sourceKey : '');
      const targetKey = resolveKey(typeof row.targetKey === 'string' ? row.targetKey : '');
      if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
      relationLines.push(JSON.stringify({ ...row, sourceKey, targetKey }));
    }
    fs.writeFileSync(path.join(targetDirectory, 'relations.jsonl'), relationLines.join('\n') + (relationLines.length ? '\n' : ''), 'utf8');
    const reportPath = path.join(entry.directory, 'extraction-report.json');
    if (fs.existsSync(reportPath)) fs.copyFileSync(reportPath, path.join(targetDirectory, 'extraction-report.json'));
    directories.push(targetDirectory);
  }
  return directories;
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return rows;
}
