/**
 * Shared knowledge-base data types: markdown facts, note records, index sync and vector entries.
 * 知识库共享数据类型：markdown 事实、笔记记录、索引同步与向量条目。
 */

/** A heading extracted from a markdown document. / 从 markdown 文档中提取的标题。 */
export interface KnowledgeHeading {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
  index: number;
}

/** A wiki-style link pointing to another note. / 指向另一篇笔记的 wiki 风格链接。 */
export interface KnowledgeWikiLink {
  target: string;
  alias?: string;
}

/** Structured knowledge facts extracted from one markdown note. / 从单篇 markdown 笔记中提取的结构化知识事实。 */
export interface MarkdownKnowledgeFacts {
  frontmatter: Record<string, unknown>;
  headings: KnowledgeHeading[];
  tags: string[];
  outgoingLinks: KnowledgeWikiLink[];
  plainText: string;
  contentHash: string;
}

/** A knowledge note as persisted in the materials library metadata store. / 资料库元数据存储中持久化的知识笔记记录。 */
export interface PersistedKnowledgeNote {
  path: string;
  relativePath: string;
  title: string;
  kind: string;
  extension: string;
  mtimeMs: number;
  facts: MarkdownKnowledgeFacts;
}

/** Summary counters returned by a knowledge index synchronization run. / 知识索引同步运行后返回的计数摘要。 */
export interface IndexSyncResult {
  indexed: number;
  skipped: number;
  removed: number;
}

/** A single record in the vector index. / 向量索引中的单条记录。 */
export interface VectorIndexEntry {
  notePath: string;
  contentHash: string;
  model: string;
  collection: string;
  pointId: string;
}
