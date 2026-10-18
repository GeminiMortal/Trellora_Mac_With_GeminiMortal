/**
 * Per-document cloud authorization state for MinerU integration.
 * Each authorization is bound to a specific document content-hash revision,
 * never to a raw API key, and is persisted under the library's `.menghan-meta/`.
 * MinerU 集成的文档级云授权状态。
 * 每条授权绑定到特定文档内容哈希版本，不绑定原始 API Key，
 * 持久化在资料库 `.menghan-meta/` 目录下。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MaterialsDocument } from '../library/materialsLibrary.ts';
import { assertInsideDirectory } from '../files/pathGuards.ts';
import { atomicWriteJson } from './pathLayout.ts';

/**
 * Authorization belongs to one imported document revision, never to an API key.
 * 授权绑定到单个已导入文档版本，不绑定到 API Key。
 *
 * Methods: `has` checks if a document's revision is already authorized;
 * `authorize` persists authorization for one or more documents.
 * 方法：`has` 检查文档版本是否已授权；`authorize` 为一个或多个文档持久化授权。
 */
export class CloudAuthorization {
  private file(libraryPath: string): string {
    return assertInsideDirectory(path.join(libraryPath, '.menghan-meta', 'cloud-authorization.json'), libraryPath);
  }
  private read(libraryPath: string): Record<string, { contentHash: string; authorizedAt: string }> {
    try {
      const file = this.file(libraryPath);
      if (fs.statSync(file).size > 2 * 1024 * 1024) return {};
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value?.schemaVersion === 1 && value.documents && typeof value.documents === 'object' ? value.documents : {};
    } catch { return {}; }
  }
  /**
   * Check whether the given document's content-hash revision is already authorized.
   * 检查给定文档的内容哈希版本是否已授权。
   *
   * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
   * @param document - Document with at least `id` and `contentHash` / 至少包含 `id` 和 `contentHash` 的文档
   * @returns True if the exact content-hash revision is authorized / 当内容哈希版本匹配已授权记录时返回 true
   */
  has(libraryPath: string, document: Pick<MaterialsDocument, 'id' | 'contentHash'>): boolean {
    return this.read(libraryPath)[document.id]?.contentHash === document.contentHash;
  }
  /**
   * Persist authorization for one or more documents at their current content-hash revision.
   * 为一个或多个文档在当前内容哈希版本下持久化授权记录。
   *
   * @param libraryPath - Absolute path to the materials library / 资料库绝对路径
   * @param documents - Array of documents with `id` and `contentHash` / 包含 `id` 和 `contentHash` 的文档数组
   */
  authorize(libraryPath: string, documents: Array<Pick<MaterialsDocument, 'id' | 'contentHash'>>): void {
    const entries = this.read(libraryPath);
    for (const document of documents) entries[document.id] = { contentHash: document.contentHash, authorizedAt: new Date().toISOString() };
    const file = this.file(libraryPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJson(this.file(libraryPath), { schemaVersion: 1, documents: entries });
  }
}

/**
 * Standard IPC response sent when a pipeline stage requires cloud authorization
 * before the document can be processed.
 * 当流水线阶段需要云授权才能处理文档时，返回的标准 IPC 响应。
 */
export const cloudAuthorizationRequired = () => ({ code: 'CLOUD_AUTHORIZATION_REQUIRED', message: '文件已保存在本地。点击开始解析并确认上传至 MinerU 后继续。', retryable: false });
