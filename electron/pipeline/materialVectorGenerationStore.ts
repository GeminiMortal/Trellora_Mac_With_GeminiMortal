/**
 * SQLite persistence for material vector generations and the active-generation pointer.
 * 材料向量代际及其 active 指针的 SQLite 持久化。
 */

import Database from 'better-sqlite3';
import { createLockedMaterialEmbeddingProfile, type MaterialEmbeddingProfile } from './materialEmbeddingTypes.ts';
import type { MaterialVectorGeneration } from '../../shared/materialVectorGenerations.ts';

/**
 * One row of the material_vector_generations table.
 * material_vector_generations 表中的一行记录。
 */
export interface GenerationRow {
  /** Generation id (UUID hex or 'original') / 代际 ID（UUID hex 或 'original'） */
  id: string;
  /** Lifecycle state / 生命周期状态 */
  state: MaterialVectorGeneration['state'];
  /** Serialized locked embedding profile / 序列化的锁定嵌入配置 */
  profile_json: string;
  /** Name of the sqlite-vec table backing this generation / 承载该代际的 sqlite-vec 表名 */
  vector_table: string;
  /** Hash of the graph projection this generation was built from / 该代际所依据的图投影哈希 */
  projection_hash: string;
  /** Hash of the source material set / 源材料集合哈希 */
  sources_hash: string;
  /** Completed query evaluations / 已完成的查询评测数 */
  completed: number;
  /** Total query evaluations / 总查询评测数 */
  total: number;
  /** Evaluated query count / 已评测查询数 */
  evaluated_queries: number;
  /** Creation timestamp / 创建时间戳 */
  created_at: string;
  /** Error message when failed / 失败时的错误信息 */
  error: string | null;
}

/**
 * Creates the generation tables and active-generation pointer if missing.
 * Generation rows and the active pointer belong to the vector domain only;
 * they never mutate the original LOCKED singleton profile.
 * 如缺失则创建代际表与 active 指针表。代际记录与 active 指针只属于向量域，不修改原有 LOCKED 单例。
 *
 * @param database - SQLite database handle / SQLite 数据库句柄
 */
export function ensureMaterialVectorGenerationSchema(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS material_vector_generations (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, profile_json TEXT NOT NULL, vector_table TEXT NOT NULL,
    projection_hash TEXT NOT NULL, sources_hash TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, evaluated_queries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS material_vector_active_generation (singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), generation_id TEXT NOT NULL);`);
}

/**
 * Derives the vector table name for a generation id.
 * All dynamic SQL table names are derived from main-process UUIDs; arbitrary
 * database strings can never become SQL identifiers.
 * 由代际 ID 推导向量表名。所有动态 SQL 表名由主进程 UUID 派生；数据库内的任意字符串不能成为 SQL。
 *
 * @param id - Generation id / 代际 ID
 * @returns SQL table name for the generation / 该代际对应的 SQL 表名
 */
export function generationVectorTable(id: string): string {
  if (id === 'original') return 'material_chunk_vectors';
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error('向量索引代际 ID 无效。');
  return `material_chunk_vectors_g_${id}`;
}

/**
 * Loads the currently active generation row after integrity checks.
 * 经完整性校验后加载当前 active 代际行。
 *
 * @param database - SQLite database handle / SQLite 数据库句柄
 * @returns Active generation row, or undefined when none is set / active 代际行，未设置时为 undefined
 */
export function readActiveGeneration(database: Database.Database): GenerationRow | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='material_vector_active_generation'").get()) return undefined;
  const pointer = database.prepare('SELECT generation_id FROM material_vector_active_generation WHERE singleton_id=1').get() as { generation_id: string } | undefined;
  if (!pointer) return undefined;
  const row = database.prepare('SELECT * FROM material_vector_generations WHERE id=?').get(pointer.generation_id) as GenerationRow | undefined;
  if (!row || row.state !== 'ACTIVE' || row.vector_table !== generationVectorTable(row.id)) throw new Error('激活的向量索引代际损坏，语义检索已停用。');
  return row;
}

/**
 * Returns the vector table name used for semantic search right now.
 * 返回当前语义检索使用的向量表名。
 *
 * @param database - SQLite database handle / SQLite 数据库句柄
 * @returns Active generation table name, falling back to the original table / active 代际表名，缺失时回退原表
 */
export function getActiveMaterialVectorTable(database: Database.Database): string {
  return readActiveGeneration(database)?.vector_table ?? 'material_chunk_vectors';
}

/**
 * Parses and re-validates the locked embedding profile stored on a generation row.
 * 解析并重新校验代际行上存储的锁定嵌入配置。
 *
 * @param row - Generation row / 代际行
 * @returns Verified locked profile / 校验通过的锁定配置
 */
export function generationProfile(row: GenerationRow): MaterialEmbeddingProfile {
  const profile = JSON.parse(row.profile_json) as MaterialEmbeddingProfile;
  const expected = createLockedMaterialEmbeddingProfile({ candidate: profile, responseModel: profile.responseModel, vectorDimension: profile.vectorDimension, lockedAt: profile.lockedAt, appVersion: profile.appVersion });
  if (profile.state !== 'LOCKED' || profile.profileHash !== expected.profileHash) throw new Error('向量索引代际模型校验失败。');
  return expected;
}

/**
 * Maps a storage row to the shared MaterialVectorGeneration view model.
 * 将存储行映射为共享的 MaterialVectorGeneration 视图模型。
 *
 * @param row - Generation row / 代际行
 * @returns View model for UI and IPC / 供 UI 与 IPC 使用的视图模型
 */
export function generationView(row: GenerationRow): MaterialVectorGeneration {
  return { id: row.id, state: row.state, profile: generationProfile(row), completed: row.completed, total: row.total,
    evaluatedQueries: row.evaluated_queries, createdAt: row.created_at, ...(row.error ? { error: row.error } : {}) };
}
