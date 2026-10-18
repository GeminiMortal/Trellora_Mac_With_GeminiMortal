/**
 * Graph vector index: builds cosine-distance vec0 virtual tables for entities
 * and communities in a graph projection, with incremental vector caching.
 * 图向量索引：在图谱投影中为实体和社区构建余弦距离 vec0 虚拟表，支持增量向量缓存。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { estimateTokenCount } from '../knowledge/model/tokenEstimator.ts';
import { sqliteVecPackagedExtensionPath } from '../loadSqliteVec.ts';
import { PipelineStageError } from './stageErrors.ts';
import { openGraphDatabase } from './graphProjection.ts';

const sqliteVec = require('sqlite-vec') as { load(database: Database.Database): void };

/** Schema version of the graph vector index format. / 图向量索引格式的 Schema 版本号。 */
export const GRAPH_VECTOR_SCHEMA_VERSION = 1;
/** Entity vector text = "mention" (type): description, truncated to token budget (same estimator as summary). / 实体向量文本 = 「mention」（type）：description，截断上限（与摘要同口径的 token 估算）。 */
export const GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS = 800;
/** Community vector text = summary; summary itself has a budget, but still truncated for embedding model context. / 社区向量文本 = 摘要文本；摘要本身有预算，但仍截断以适配 embedding 模型上下文。 */
export const GRAPH_COMMUNITY_VECTOR_TEXT_MAX_TOKENS = 800;
/** Batch size for embedding calls. / embedding 调用的批次大小。 */
const GRAPH_VECTOR_BATCH_SIZE = 16;

const entityVectorTableName = 'graph_entity_vec';
const communityVectorTableName = 'graph_community_vec';
/**
 * Vector reuse cache (optimization P1-5 minimal scenario): when a single document
 * re-parse triggers graph rebuild, unchanged entity/community vectors are reused
 * from cache; only changed items call embedding, avoiding full re-embedding.
 * Cache tables are plain (not vec0) and survive `replaceGraphProjection`; only cleared with projection cleanup.
 * 向量复用缓存（优化方案 P1-5 最小场景）：单文档重解析触发图重建时，
 * 未变化的实体/社区直接复用旧向量，只对变化项调 embedding，避免全量重嵌入。
 * 缓存是普通表，不随 replaceGraphProjection 的图重建清空；仅随投影清理删除。
 */
const entityVectorCacheTableName = 'graph_entity_vec_cache';
const communityVectorCacheTableName = 'graph_community_vec_cache';

/**
 * Input parameters for building the graph vector index.
 * 构建图向量索引的输入参数。
 */
export interface GraphVectorIndexBuildInput {
  libraryPath: string;
  graphKey: string;
  /** sha256(graphKey + model fingerprint); graph rebuild invalidates all, fingerprint change invalidates vectors only. / sha256(graphKey + 模型指纹)；图重建整体失效，模型指纹变化只失效向量。 */
  vectorKey: string;
  modelFingerprint: string;
  vectorDimension: number;
  /** Injected batch embedding function (same pattern as vector stage; Worker never holds the key). / 注入式批量 embedding（与向量阶段同模式，Worker 永不持钥）。 */
  callEmbed: (texts: string[]) => Promise<number[][]>;
  signal?: AbortSignal;
}

/**
 * Result returned after building the graph vector index.
 * 构建图向量索引后返回的结果。
 */
export interface GraphVectorIndexBuildResult {
  vectorKey: string;
  entityVectors: number;
  communityVectors: number;
  /** Vectors reused from cache (optimization P1-5); non-reused items actually called embedding. / 命中缓存复用的向量数（优化方案 P1-5）；未命中的才实际调 embedding。 */
  entityVectorsReused: number;
  communityVectorsReused: number;
  dimension: number;
  durationMs: number;
}

/**
 * Entity vector KNN neighbor result row, joining back entity metadata.
 * 实体向量 KNN 邻居结果行，回接实体元数据。
 */
/**
 * A nearby entity returned by entity vector KNN search.
 * 实体向量 KNN 检索返回的邻近实体。
 */
export interface GraphEntityVectorNeighbor {
  rowId: number;
  canonicalKey: string;
  mention: string;
  type: string;
  distance: number;
}

/**
 * Community vector KNN neighbor result row, joining back community metadata.
 * 社区向量 KNN 邻居结果行，回接社区元数据。
 */
/**
 * A nearby community returned by community vector KNN search.
 * 社区向量 KNN 检索返回的邻近社区。
 */
export interface GraphCommunityVectorNeighbor {
  rowId: number;
  communityId: string;
  level: number;
  distance: number;
}

/**
 * Compute the graph vector index key as sha256 of schemaVersion + graphKey + modelFingerprint.
 * Same hashing approach as summaryKey.
 * 计算图向量索引键：sha256(schemaVersion + graphKey + modelFingerprint)，与 summaryKey 同口径。
 *
 * @param input - Object containing graphKey and modelFingerprint / 包含 graphKey 和 modelFingerprint 的对象
 * @returns Hex hash key / 十六进制哈希键
 */
export function computeGraphVectorKey(input: { graphKey: string; modelFingerprint: string }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: GRAPH_VECTOR_SCHEMA_VERSION,
    graphKey: input.graphKey,
    modelFingerprint: input.modelFingerprint,
  })).digest('hex');
}

/**
 * Build the embedding text for an entity: "「mention」（type）：description", truncated to token budget.
 * 构建实体的嵌入文本：「mention」（type）：description，按 token 预算截断。
 *
 * @param input - Entity mention, type, and description / 实体提及、类型和描述
 * @returns Truncated embedding text / 截断后的嵌入文本
 */
/**
 * Build the entity vector text representation: 「mention」（type）：description, truncated to token budget.
 * 构建实体向量文本表示：「mention」（type）：description，截断到 token 预算内。
 *
 * @param input - Entity mention, type, and description / 实体提及、类型和描述
 * @returns Truncated entity vector text / 截断后的实体向量文本
 */
export function buildGraphEntityVectorText(input: { mention: string; type: string; description: string }): string {
  const text = `「${input.mention}」（${input.type}）：${input.description}`.trim();
  return truncateToTokenBudget(text, GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS);
}

/**
 * Cache check: vector index is current if the stored vectorKey matches and both vector tables exist.
 * 缓存判定：投影内向量键一致且两张向量表存在即命中（向量本体就在投影库内）。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @param vectorKey - Expected vector cache key / 预期的向量缓存键
 * @returns True if the existing vector index matches / 当现有向量索引匹配时返回 true
 */
export function isGraphVectorIndexCurrent(libraryPath: string, vectorKey: string): boolean {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return false;
  try {
    const storedKey = readGraphMetaValue(database, 'vectorKey');
    if (storedKey !== vectorKey || !storedKey) return false;
    return tableExists(database, entityVectorTableName) && tableExists(database, communityVectorTableName);
  } catch {
    return false;
  } finally {
    database.close();
  }
}

/**
 * Build (or rebuild) the graph vector index: read entities and communities from the projection,
 * batch-embed them, and create two vec0 virtual tables with cosine distance.
 * rowids align with graph_entities / graph_communities for alias-arbitration KNN joins.
 * 构建（或重建）图向量索引：从投影读取实体与社区（摘要非空），批量 embedding 后整体重建两张向量表。
 * rowid 与 graph_entities / graph_communities 对齐，供别名裁决召回做 KNN join。
 *
 * @param input - Build parameters including library path, vector key, model fingerprint, and embed function / 构建参数，含资料库路径、向量键、模型指纹和嵌入函数
 * @returns Build result with vector counts, reuse counts, dimension and duration / 构建结果，含向量计数、复用计数、维度与耗时
 */
export async function buildGraphVectorIndex(input: GraphVectorIndexBuildInput): Promise<GraphVectorIndexBuildResult> {
  const startedAt = Date.now();
  const database = openGraphDatabase(input.libraryPath, false);
  if (!database) {
    throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', '图谱投影缺失，无法建立图向量索引。', true);
  }
  try {
    if (!tableExists(database, 'graph_entities') || !tableExists(database, 'graph_communities')) {
      throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', '图谱投影表缺失，无法建立图向量索引。', true);
    }
    const entityRows = database.prepare(`
      SELECT rowid AS rowid, canonical_key, mention, type, description
      FROM graph_entities ORDER BY rowid
    `).all() as Array<{ rowid: number; canonical_key: string; mention: string; type: string; description: string }>;
    const communityRows = database.prepare(`
      SELECT rowid AS rowid, community_id, summary
      FROM graph_communities WHERE summary != '' ORDER BY rowid
    `).all() as Array<{ rowid: number; community_id: string; summary: string }>;

    const entityItems: Array<{ rowid: number; cacheKey: string; text: string }> = entityRows
      .map((row) => ({
        rowid: Number(row.rowid),
        cacheKey: row.canonical_key,
        text: buildGraphEntityVectorText({ mention: row.mention, type: row.type, description: row.description }),
      }))
      .filter((item) => item.cacheKey !== '' && item.text.length > 0);
    const communityItems: Array<{ rowid: number; cacheKey: string; text: string }> = communityRows
      .map((row) => ({
        rowid: Number(row.rowid),
        cacheKey: row.community_id,
        text: truncateToTokenBudget(String(row.summary).trim(), GRAPH_COMMUNITY_VECTOR_TEXT_MAX_TOKENS),
      }))
      .filter((item) => item.cacheKey !== '' && item.text.length > 0);

    // 增量复用（优化方案 P1-5 最小场景）：向量文本未变的实体/社区直接取缓存向量，
    // 单文档重解析触发的图重建只对变化项调 embedding。
    const expectedCacheBytes = input.vectorDimension * 4;
    const entityPlan = resolveVectorReuse(database, entityVectorCacheTableName, entityItems, expectedCacheBytes);
    const communityPlan = resolveVectorReuse(database, communityVectorCacheTableName, communityItems, expectedCacheBytes);
    const entityBuffers = await embedQueuedVectors(entityPlan.queue, entityPlan.buffers, input);
    const communityBuffers = await embedQueuedVectors(communityPlan.queue, communityPlan.buffers, input);

    loadGraphSqliteVec(database);
    // vec0 虚拟表的 CREATE/DROP 不支持在事务内执行；只有插入与 meta 写入走事务。
    database.exec(`DROP TABLE IF EXISTS ${entityVectorTableName}`);
    database.exec(`DROP TABLE IF EXISTS ${communityVectorTableName}`);
    database.exec(`CREATE VIRTUAL TABLE ${entityVectorTableName} USING vec0(embedding float[${input.vectorDimension}] distance_metric=cosine)`);
    database.exec(`CREATE VIRTUAL TABLE ${communityVectorTableName} USING vec0(embedding float[${input.vectorDimension}] distance_metric=cosine)`);
    database.exec(`CREATE TABLE IF NOT EXISTS ${entityVectorCacheTableName} (cache_key TEXT PRIMARY KEY, text_hash TEXT NOT NULL, embedding BLOB NOT NULL)`);
    database.exec(`CREATE TABLE IF NOT EXISTS ${communityVectorCacheTableName} (cache_key TEXT PRIMARY KEY, text_hash TEXT NOT NULL, embedding BLOB NOT NULL)`);
    database.transaction(() => {
      const insertEntity = database.prepare(`INSERT INTO ${entityVectorTableName}(rowid, embedding) VALUES (?, ?)`);
      // vec0 的 rowid 列要求整数主键：与 materialVectorCoordinator 同口径，用 BigInt 绑定。
      entityItems.forEach((item, index) => insertEntity.run(BigInt(item.rowid), entityBuffers[index]));
      const insertCommunity = database.prepare(`INSERT INTO ${communityVectorTableName}(rowid, embedding) VALUES (?, ?)`);
      communityItems.forEach((item, index) => insertCommunity.run(BigInt(item.rowid), communityBuffers[index]));
      writeVectorCache(database, entityVectorCacheTableName, entityItems, entityBuffers);
      writeVectorCache(database, communityVectorCacheTableName, communityItems, communityBuffers);
      upsertGraphMeta(database, 'vectorKey', input.vectorKey);
      upsertGraphMeta(database, 'vectorModelFingerprint', input.modelFingerprint);
      upsertGraphMeta(database, 'vectorDimension', String(input.vectorDimension));
      upsertGraphMeta(database, 'vectorEntityCoverage', String(entityItems.length));
      upsertGraphMeta(database, 'vectorCommunityCoverage', String(communityItems.length));
      upsertGraphMeta(database, 'vectorCoverage', String(entityItems.length + communityItems.length));
      upsertGraphMeta(database, 'vectorGeneratedAt', new Date().toISOString());
    })();

    return {
      vectorKey: input.vectorKey,
      entityVectors: entityItems.length,
      communityVectors: communityItems.length,
      entityVectorsReused: entityPlan.reused,
      communityVectorsReused: communityPlan.reused,
      dimension: input.vectorDimension,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', `图向量索引建立失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    database.close();
  }
}

/**
 * Entity vector KNN: join projection entity table to read back canonicalKey/mention/type.
 * Returns empty if the index is missing or dimension mismatches.
 * 实体向量 KNN：join 投影实体表回读 canonicalKey/mention/type；索引缺失或维度不符返回空。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @param queryVector - Float array to search against / 待搜索的浮点数组
 * @param limit - Maximum number of neighbors / 最大邻居数
 * @param profileHash - Optional model fingerprint to validate against / 可选的模型指纹校验值
 * @returns Array of entity vector neighbors / 实体向量邻居数组
 */
export function queryGraphEntityVectorNeighbors(libraryPath: string, queryVector: number[], limit: number, profileHash?: string): GraphEntityVectorNeighbor[] {
  return queryGraphVectorNeighbors(database => database.prepare(`
    SELECT v.rowid AS rowid, v.distance AS distance, e.canonical_key, e.mention, e.type
    FROM ${entityVectorTableName} v
    JOIN graph_entities e ON e.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
    LIMIT ?
  `), libraryPath, queryVector, limit, profileHash).map((row) => ({
    rowId: row.rowId,
    canonicalKey: String(row.canonical_key ?? ''),
    mention: String(row.mention ?? ''),
    type: String(row.type ?? ''),
    distance: row.distance,
  }));
}

/**
 * Community vector KNN: join projection community table to read back communityId/level.
 * Returns empty if the index is missing or dimension mismatches.
 * 社区向量 KNN：join 投影社区表回读 communityId/level；索引缺失或维度不符返回空。
 *
 * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
 * @param queryVector - Float array to search against / 待搜索的浮点数组
 * @param limit - Maximum number of neighbors / 最大邻居数
 * @param profileHash - Optional model fingerprint to validate against / 可选的模型指纹校验值
 * @returns Array of community vector neighbors / 社区向量邻居数组
 */
export function queryGraphCommunityVectorNeighbors(libraryPath: string, queryVector: number[], limit: number, profileHash?: string): GraphCommunityVectorNeighbor[] {
  return queryGraphVectorNeighbors(database => database.prepare(`
    SELECT v.rowid AS rowid, v.distance AS distance, c.community_id, c.level
    FROM ${communityVectorTableName} v
    JOIN graph_communities c ON c.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
    LIMIT ?
  `), libraryPath, queryVector, limit, profileHash).map((row) => ({
    rowId: row.rowId,
    communityId: String((row as Record<string, unknown>).community_id ?? ''),
    level: Number((row as Record<string, unknown>).level) || 0,
    distance: row.distance,
  }));
}

function queryGraphVectorNeighbors(
  prepareStatement: (database: Database.Database) => Database.Statement,
  libraryPath: string,
  queryVector: number[],
  limit: number,
  profileHash?: string,
): Array<{ rowId: number; distance: number } & Record<string, unknown>> {
  if (!Array.isArray(queryVector) || queryVector.length === 0 || !Number.isFinite(limit) || limit <= 0) return [];
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return [];
  try {
    if (profileHash && readGraphMetaValue(database, 'vectorModelFingerprint') !== profileHash) return [];
    if (Number(readGraphMetaValue(database, 'vectorDimension')) !== queryVector.length) return [];
    loadGraphSqliteVec(database);
    const rows = prepareStatement(database).all(toVectorBuffer(queryVector), Math.floor(limit), Math.floor(limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, rowId: Number(row.rowid), distance: Number(row.distance) }));
  } catch {
    return [];
  } finally {
    database.close();
  }
}

/**
 * Back-fill embedding queue: only call embedding for items that missed the cache;
 * results are written into the corresponding buffer slots.
 * 待嵌入队列回填：只对未命中缓存的项分批调 embedding，结果写回对应槽位。
 */
async function embedQueuedVectors(
  queue: Array<{ slot: number; item: { rowid: number; text: string } }>,
  buffers: Buffer[],
  input: GraphVectorIndexBuildInput,
): Promise<Buffer[]> {
  if (queue.length === 0) return buffers;
  const vectors = await embedItems(queue.map((entry) => ({ rowid: entry.item.rowid, text: entry.item.text })), input);
  queue.forEach((entry, index) => {
    buffers[entry.slot] = toVectorBuffer(vectors[index]);
  });
  return buffers;
}

async function embedItems(items: Array<{ rowid: number; text: string }>, input: GraphVectorIndexBuildInput): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < items.length; start += GRAPH_VECTOR_BATCH_SIZE) {
    if (input.signal?.aborted) throw new PipelineStageError('GRAPH_VECTOR_INDEX_CANCELLED', '图向量索引已取消。', true);
    const batch = items.slice(start, start + GRAPH_VECTOR_BATCH_SIZE);
    const batchVectors = await input.callEmbed(batch.map((item) => item.text));
    if (!Array.isArray(batchVectors) || batchVectors.length !== batch.length) {
      throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', `embedding 返回 ${Array.isArray(batchVectors) ? batchVectors.length : 0} 条向量，与批内 ${batch.length} 条文本不一致。`, true);
    }
    for (const vector of batchVectors) {
      if (!Array.isArray(vector) || vector.length !== input.vectorDimension
        || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', `embedding 返回维度错误或含非有限值（期望维度 ${input.vectorDimension}）。`, true);
      }
      vectors.push(vector);
    }
  }
  return vectors;
}

/**
 * Cache reuse split (optimization P1-5): items whose cacheKey matches and whose
 * text hash and byte-length match the current dimension are reused from cache;
 * everything else enters the embedding queue. Cache table corruption degrades silently to full embedding.
 * 缓存复用拆分（优化方案 P1-5）：cacheKey 命中且向量文本哈希一致、字节数与当前维度
 * 匹配才复用；其余进待嵌入队列。缓存表缺失/损坏时静默降级为全量嵌入。
 */
function resolveVectorReuse(
  database: Database.Database,
  cacheTableName: string,
  items: Array<{ cacheKey: string; text: string }>,
  expectedBytes: number,
): { buffers: Buffer[]; queue: Array<{ slot: number; item: { rowid: number; text: string } & { cacheKey: string } }>; reused: number } {
  const cache = readVectorCache(database, cacheTableName);
  const buffers: Buffer[] = new Array(items.length);
  const queue: Array<{ slot: number; item: { rowid: number; text: string } & { cacheKey: string } }> = [];
  let reused = 0;
  items.forEach((item, index) => {
    const cached = cache.get(item.cacheKey);
    const textHash = hashVectorText(item.text);
    if (cached && cached.textHash === textHash && Buffer.isBuffer(cached.embedding) && cached.embedding.byteLength === expectedBytes) {
      buffers[index] = cached.embedding;
      reused += 1;
      return;
    }
    queue.push({ slot: index, item: item as { rowid: number; text: string } & { cacheKey: string } });
  });
  return { buffers, queue, reused };
}

function readVectorCache(database: Database.Database, cacheTableName: string): Map<string, { textHash: string; embedding: Buffer }> {
  const cache = new Map<string, { textHash: string; embedding: Buffer }>();
  try {
    if (!tableExists(database, cacheTableName)) return cache;
    const rows = database.prepare(`SELECT cache_key AS cacheKey, text_hash AS textHash, embedding FROM ${cacheTableName}`).all() as Array<{ cacheKey: string; textHash: string; embedding: Buffer }>;
    for (const row of rows) {
      if (typeof row.cacheKey === 'string' && row.cacheKey && typeof row.textHash === 'string') {
        cache.set(row.cacheKey, { textHash: row.textHash, embedding: row.embedding });
      }
    }
  } catch {
    cache.clear();
  }
  return cache;
}

/**
 * Rewrite the entire vector cache in a transaction: aligns with the current index;
 * deleted entities/communities have their cached vectors discarded.
 * 事务内全量重写缓存：与当次索引内容对齐，已删除实体/社区的向量随之废弃。
 */
function writeVectorCache(
  database: Database.Database,
  cacheTableName: string,
  items: Array<{ cacheKey: string; text: string }>,
  buffers: Buffer[],
): void {
  database.prepare(`DELETE FROM ${cacheTableName}`).run();
  const insert = database.prepare(`INSERT INTO ${cacheTableName} (cache_key, text_hash, embedding) VALUES (?, ?, ?)`);
  items.forEach((item, index) => insert.run(item.cacheKey, hashVectorText(item.text), buffers[index]));
}

function hashVectorText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  // Iteratively shrink: estimate token count, compute ratio, and slice proportionally.
  // 迭代缩小：估算 token 数、计算比率并按比例截断。
  let slice = text;
  while (estimateTokenCount(slice) > maxTokens && slice.length > 0) {
    const ratio = maxTokens / Math.max(1, estimateTokenCount(slice));
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * ratio)));
  }
  return slice;
}

// Pack float array into a Buffer for sqlite-vec BLOB binding (4 bytes per float).
// 将浮点数组打包为 Buffer 供 sqlite-vec BLOB 绑定（每浮点 4 字节）。
function toVectorBuffer(values: number[]): Buffer {
  const floats = new Float32Array(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function loadGraphSqliteVec(database: Database.Database): void {
  // Prefer the packaged extension; fall back to the require-loaded copy.
  // 优先使用打包的扩展路径；回退到 require 加载的副本。
  const packagedExtensionPath = sqliteVecPackagedExtensionPath();
  if (packagedExtensionPath && fs.existsSync(packagedExtensionPath)) {
    database.loadExtension(packagedExtensionPath);
    return;
  }
  sqliteVec.load(database);
}

function tableExists(database: Database.Database, tableName: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type IN (?, ?) AND name = ?').get('table', 'view', tableName));
}

function readGraphMetaValue(database: Database.Database, key: string): string {
  if (!tableExists(database, 'graph_meta')) return '';
  const row = database.prepare('SELECT value FROM graph_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function upsertGraphMeta(database: Database.Database, key: string, value: string): void {
  database.prepare(`
    INSERT INTO graph_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
