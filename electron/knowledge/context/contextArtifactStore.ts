/**
 * File-backed store for redacted tool observations kept outside prompts.
 * 管理脱敏后的工具观测内容的文件存储，这些内容保存在提示词之外。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Schema version of persisted context artifacts. 持久化上下文 Artifact 的 schema 版本。 */
export const CONTEXT_ARTIFACT_SCHEMA_VERSION = 1 as const;
/** Directory name holding context artifacts under ConversationMemory. ConversationMemory 下存放上下文 Artifact 的目录名。 */
export const CONTEXT_ARTIFACT_DIRECTORY_NAME = 'context-artifacts';
/** Workspace-relative directory name for conversation memory artifacts. 工作区下对话记忆产物的目录名。 */
export const CONTEXT_ARTIFACT_MEMORY_DIRECTORY_NAME = 'ConversationMemory';
/** Default byte cap for a single artifact. 单个 Artifact 的默认字节上限。 */
export const DEFAULT_CONTEXT_ARTIFACT_MAX_BYTES = 1_048_576;
/** Default total byte cap per turn. 单轮 Artifact 总量的默认字节上限。 */
export const DEFAULT_CONTEXT_ARTIFACT_MAX_TURN_BYTES = 8_388_608;

/**
 * On-disk representation of one context artifact with integrity metadata.
 * 单个上下文 Artifact 的磁盘记录，包含完整性元数据。
 */
export interface ContextArtifactRecord {
  schemaVersion: typeof CONTEXT_ARTIFACT_SCHEMA_VERSION;
  /** Unique content-derived artifact identifier. 基于内容派生的唯一 Artifact 标识。 */
  artifactId: string;
  sessionId: string;
  turnId: string;
  /** Name of the tool that produced the observation. 产生该观测的工具名称。 */
  sourceTool: string;
  mimeType: string;
  /** SHA-256 digest of the redacted content. 脱敏内容的 SHA-256 摘要。 */
  sha256: string;
  /** Byte length of the redacted content encoded as UTF-8. 脱敏内容以 UTF-8 编码后的字节长度。 */
  byteLength: number;
  createdAt: string;
  /** Redacted tool observation payload. 脱敏后的工具观测内容。 */
  content: string;
}

/**
 * Inputs for writing one redacted tool observation artifact.
 * 写入单个脱敏工具观测 Artifact 的输入。
 */
export interface WriteContextArtifactInput {
  sessionId: string;
  turnId: string;
  /** Material identifier used in the content-addressed artifact id hash. 用于内容寻址 Artifact 标识哈希的材料标识。 */
  materialId: string;
  /** Name of the tool that produced the observation. 产生该观测的工具名称。 */
  sourceTool: string;
  /** Raw tool observation content before redaction. 脱敏前的原始工具观测内容。 */
  content: string;
  /** MIME type of the artifact; defaults to text/plain. Artifact 的 MIME 类型；默认为 text/plain。 */
  mimeType?: string;
}

/**
 * Identifies a stored artifact for reading.
 * 定位待读取的已存 Artifact。
 */
export interface ReadContextArtifactInput {
  sessionId: string;
  turnId: string;
  artifactId: string;
}

/**
 * Optional size limits and clock override for the artifact store.
 * Artifact 存储的可选大小限制与时间源覆盖。
 */
export interface ContextArtifactStoreOptions {
  maxArtifactBytes?: number;
  maxTurnBytes?: number;
  /** Clock function override for deterministic tests. 时间源覆盖，用于确定性测试。 */
  now?: () => Date;
}

/**
 * Stores redacted tool observations outside prompts. Directory components are
 * hashes, never caller-controlled identifiers, and every read revalidates the
 * stored byte count and digest before returning content.
 * 在提示词之外存放脱敏后的工具观测。目录名使用哈希值，绝不使用调用方可控的标识符，
 * 且每次读取都会重新校验字节数与摘要后才返回内容。
 */
export class ContextArtifactStore {
  private readonly rootDirectory: string;
  private readonly maxArtifactBytes: number;
  private readonly maxTurnBytes: number;
  private readonly now: () => Date;

  /**
   * Creates a store rooted at `<workspacePath>/ConversationMemory/context-artifacts`.
   * 创建以 `<workspacePath>/ConversationMemory/context-artifacts` 为根目录的存储实例。
   *
   * @param workspacePath - Workspace root used to locate the artifact directory / 用于定位 Artifact 目录的工作区根路径
   * @param options - Optional size limits and clock override / 可选的大小限制与时间源覆盖
   */
  constructor(workspacePath: string, options: ContextArtifactStoreOptions = {}) {
    this.rootDirectory = path.resolve(
      workspacePath,
      CONTEXT_ARTIFACT_MEMORY_DIRECTORY_NAME,
      CONTEXT_ARTIFACT_DIRECTORY_NAME,
    );
    this.maxArtifactBytes = normalizePositiveInteger(
      options.maxArtifactBytes ?? DEFAULT_CONTEXT_ARTIFACT_MAX_BYTES,
      '单个上下文 Artifact 大小上限',
    );
    this.maxTurnBytes = normalizePositiveInteger(
      options.maxTurnBytes ?? DEFAULT_CONTEXT_ARTIFACT_MAX_TURN_BYTES,
      '单轮上下文 Artifact 大小上限',
    );
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Persists a redacted tool observation as a JSON artifact. Identical inputs
   * dedupe deterministically via a content-addressed artifact id.
   * 将脱敏后的工具观测持久化为 JSON Artifact。相同输入通过内容寻址标识确定性去重。
   *
   * @param input - Write parameters including raw content and identity fields / 写入参数，包含原始内容与身份字段
   * @returns The persisted artifact record / 持久化后的 Artifact 记录
   */
  write(input: WriteContextArtifactInput): ContextArtifactRecord {
    assertArtifactIdentity(input.sessionId, 'sessionId');
    assertArtifactIdentity(input.turnId, 'turnId');
    assertArtifactIdentity(input.materialId, 'materialId');
    if (!input.sourceTool.trim()) throw new Error('上下文 Artifact 缺少来源 Tool。');

    const content = redactToolObservation(input.content);
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > this.maxArtifactBytes) {
      throw new Error(`Tool Observation 超过单个 Artifact 上限（${this.maxArtifactBytes} bytes）。`);
    }
    const sha256 = sha256Text(content);
    // Artifact id is a hash of identity fields plus content digest, so identical writes dedupe.
    // Artifact 标识由身份字段与内容摘要哈希得到，相同写入可确定性去重。
    const artifactId = `context-artifact-${sha256Text(JSON.stringify({
      sessionId: input.sessionId,
      turnId: input.turnId,
      materialId: input.materialId,
      sourceTool: input.sourceTool,
      sha256,
    }))}`;
    const filePath = this.resolveArtifactPath(input.sessionId, input.turnId, artifactId);
    // Idempotent rewrite: an existing artifact is revalidated and returned instead of overwritten.
    // 幂等写入：已存在的 Artifact 会被重新校验后返回，而不是覆盖。
    if (fs.existsSync(filePath)) return this.read({ ...input, artifactId });

    const turnDirectory = path.dirname(filePath);
    fs.mkdirSync(turnDirectory, { recursive: true });
    const usedBytes = this.calculateTurnBytes(turnDirectory);
    if (usedBytes + byteLength > this.maxTurnBytes) {
      throw new Error(`本轮 Tool Observation Artifact 总量超过上限（${this.maxTurnBytes} bytes）。`);
    }

    const record: ContextArtifactRecord = {
      schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
      artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceTool: input.sourceTool.trim(),
      mimeType: input.mimeType?.trim() || 'text/plain; charset=utf-8',
      sha256,
      byteLength,
      createdAt: this.now().toISOString(),
      content,
    };
    // Write to a unique temp file, revalidate the parsed record, then rename atomically into place.
    // 先写入唯一临时文件，重新解析校验后原子改名到位。
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
      validateArtifactRecord(JSON.parse(fs.readFileSync(temporaryPath, 'utf8')) as unknown, record);
      fs.renameSync(temporaryPath, filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    return record;
  }

  /**
   * Reads and revalidates a stored artifact by its identity fields.
   * 通过身份字段读取并重新校验已存储的 Artifact。
   *
   * @param input - Identity fields to locate the artifact / 用于定位 Artifact 的身份字段
   * @returns The validated artifact record / 校验通过的 Artifact 记录
   */
  read(input: ReadContextArtifactInput): ContextArtifactRecord {
    assertArtifactIdentity(input.sessionId, 'sessionId');
    assertArtifactIdentity(input.turnId, 'turnId');
    if (!/^context-artifact-[a-f0-9]{64}$/u.test(input.artifactId)) throw new Error('上下文 Artifact 标识无效。');
    const filePath = this.resolveArtifactPath(input.sessionId, input.turnId, input.artifactId);
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const expected = {
      artifactId: input.artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    };
    return validateArtifactRecord(value, expected);
  }

  /**
   * Deletes all artifacts belonging to a session.
   * 删除属于指定会话的所有 Artifact。
   *
   * @param sessionId - Session identifier whose artifacts to remove / 要删除 Artifact 的会话标识
   * @returns void / 无返回值
   */
  deleteSession(sessionId: string): void {
    assertArtifactIdentity(sessionId, 'sessionId');
    const sessionDirectory = this.resolveInsideRoot(hashPathComponent(sessionId));
    fs.rmSync(sessionDirectory, { recursive: true, force: true });
  }

  private resolveArtifactPath(sessionId: string, turnId: string, artifactId: string): string {
    return this.resolveInsideRoot(
      hashPathComponent(sessionId),
      hashPathComponent(turnId),
      `${artifactId}.json`,
    );
  }

  private resolveInsideRoot(...segments: string[]): string {
    const resolved = path.resolve(this.rootDirectory, ...segments);
    const relative = path.relative(this.rootDirectory, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('上下文 Artifact 路径越界。');
    return resolved;
  }

  private calculateTurnBytes(turnDirectory: string): number {
    if (!fs.existsSync(turnDirectory)) return 0;
    return fs.readdirSync(turnDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .reduce((total, entry) => total + fs.statSync(path.join(turnDirectory, entry.name)).size, 0);
  }
}

/**
 * Redacts credential-like values from tool observation text before storage.
 * 在存储前对工具观测文本中的凭据类内容进行脱敏。
 *
 * @param value - Raw tool observation text / 原始工具观测文本
 * @returns Text with credential values replaced by [REDACTED] / 将凭据值替换为 [REDACTED] 后的文本
 */
export function redactToolObservation(value: string): string {
  // Covers HTTP-style header lines, bearer tokens, and key=value/JSON-style secret assignments.
  // 覆盖 HTTP 风格请求头、bearer 令牌，以及键值或 JSON 风格的密钥赋值。
  return value
    .replace(/(^|\n)(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, '$1$2: [REDACTED]')
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]{8,}/giu, '$1 [REDACTED]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\r\n]+)/giu, '$1[REDACTED]');
}

// Re-hashes content and compares stored length/digest to reject tampered or truncated records.
// 重新计算内容哈希并与存储的长度、摘要比对，拒绝被篡改或截断的记录。
function validateArtifactRecord(
  value: unknown,
  expected: Pick<ContextArtifactRecord, 'artifactId' | 'sessionId' | 'turnId'>,
): ContextArtifactRecord {
  if (!value || typeof value !== 'object') throw new Error('上下文 Artifact 内容无效。');
  const record = value as Partial<ContextArtifactRecord>;
  if (record.schemaVersion !== CONTEXT_ARTIFACT_SCHEMA_VERSION
    || record.artifactId !== expected.artifactId
    || record.sessionId !== expected.sessionId
    || record.turnId !== expected.turnId
    || typeof record.sourceTool !== 'string'
    || typeof record.mimeType !== 'string'
    || typeof record.sha256 !== 'string'
    || typeof record.byteLength !== 'number'
    || typeof record.createdAt !== 'string'
    || typeof record.content !== 'string') {
    throw new Error('上下文 Artifact 元数据校验失败。');
  }
  const actualBytes = Buffer.byteLength(record.content, 'utf8');
  const actualHash = sha256Text(record.content);
  if (actualBytes !== record.byteLength || actualHash !== record.sha256) {
    throw new Error('上下文 Artifact 完整性校验失败。');
  }
  return record as ContextArtifactRecord;
}

function assertArtifactIdentity(value: string, label: string): void {
  if (!value.trim() || value.length > 240) throw new Error(`上下文 Artifact ${label} 无效。`);
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
  return value;
}

function hashPathComponent(value: string): string {
  return sha256Text(value);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
