/**
 * Parsing of pipeline stage artifacts into structured preview items for the UI.
 * 将流水线阶段产物解析为 UI 可用的结构化预览项。
 */

/** Rendering modes available for an artifact preview. / 产物预览可用的渲染模式。 */
export type ArtifactPreviewMode = 'structured' | 'text' | 'json';

/** One raw source line of an artifact file. / 产物文件的一行原始源文本。 */
export interface ArtifactPreviewSourceRow {
  /** 1-based line number / 从 1 开始的行号 */
  lineNumber: number;
  /** Raw line text / 原始行文本 */
  text: string;
}

/** Discriminator for the artifact record shape. / 产物记录形态的判别类型。 */
export type ArtifactPreviewItemKind = 'tree' | 'parent' | 'child' | 'raw';

/**
 * A single artifact record normalized for preview rendering.
 * 归一化后用于预览渲染的单条产物记录。
 */
export interface ArtifactPreviewItem {
  /** Source line number / 源行号 */
  lineNumber: number;
  /** Untouched raw line text / 未加工的原始行文本 */
  rawText: string;
  /** Pretty-printed JSON, or raw text when unparsable / 美化后的 JSON；无法解析时为原始文本 */
  prettyJson: string;
  /** Parsed JSON object, or null / 解析出的 JSON 对象；失败时为 null */
  record: Record<string, unknown> | null;
  /** Resolved record shape / 归一化后的记录形态 */
  kind: ArtifactPreviewItemKind;
  /** Primary identifier depending on kind / 依形态而定的主标识 */
  id: string | null;
  /** Parent node/chunk identifier / 父节点/父块标识 */
  parentId: string | null;
  /** Structural type label / 结构类型标签 */
  type: string | null;
  /** Display text chosen per kind / 按形态选取的展示文本 */
  text: string;
  /** Tree depth, when present / 树深度（若有） */
  depth: number | null;
  /** Sibling order, when present / 同级序号（若有） */
  ordinal: number | null;
  /** Character count of the text / 文本字符数 */
  charCount: number | null;
  /** Number of child chunks / 子块数量 */
  childCount: number | null;
  /** First source line covered / 覆盖的起始源行 */
  firstLineNo: number | null;
  /** Last source line covered / 覆盖的结束源行 */
  lastLineNo: number | null;
  /** Segmentation confidence score / 切分置信度 */
  confidence: number | null;
  /** Reason recorded for a boundary decision / 边界决策的记录原因 */
  boundaryReason: string | null;
  /** Overlap size with the neighbor chunk / 与相邻块的重叠字符数 */
  overlapChars: number | null;
  /** Surrounding section context / 所属章节上下文 */
  sectionContext: string | null;
  /** Labels along the section path / 章节路径上的标签列表 */
  sectionPath: string[];
}

const STRUCTURED_TREE_FILES = new Set(['structure.jsonl']);
const STRUCTURED_CHUNK_FILES = new Set(['parents.jsonl', 'children.jsonl', 'chunks.jsonl']);

/**
 * Lists the preview modes supported for a given stage artifact.
 * 列出指定阶段产物支持的预览模式。
 *
 * @param stage - Pipeline stage name / 流水线阶段名
 * @param fileName - Artifact file name / 产物文件名
 * @returns Supported modes in preference order / 按优先级排列的可用模式
 */
export function getArtifactPreviewModes(stage: string, fileName: string): ArtifactPreviewMode[] {
  if (supportsStructuredArtifactPreview(stage, fileName)) return ['structured', 'text', 'json'];
  return /\.jsonl?$/i.test(fileName) ? ['json'] : ['text'];
}

/**
 * Picks the default preview mode for a stage artifact.
 * 为阶段产物选取默认预览模式。
 *
 * @param stage - Pipeline stage name / 流水线阶段名
 * @param fileName - Artifact file name / 产物文件名
 * @returns First supported mode / 首个可用模式
 */
export function getDefaultArtifactPreviewMode(stage: string, fileName: string): ArtifactPreviewMode {
  return getArtifactPreviewModes(stage, fileName)[0];
}

/**
 * Whether a stage artifact has a dedicated structured view.
 * 指定阶段产物是否具有专用结构化视图。
 *
 * @param stage - Pipeline stage name / 流水线阶段名
 * @param fileName - Artifact file name / 产物文件名
 * @returns True when structured preview applies / 适用结构化预览时为 true
 */
export function supportsStructuredArtifactPreview(stage: string, fileName: string): boolean {
  const normalizedName = fileName.toLowerCase();
  return (stage === 'tree' && STRUCTURED_TREE_FILES.has(normalizedName))
    || (stage === 'chunks' && STRUCTURED_CHUNK_FILES.has(normalizedName));
}

/**
 * Converts raw artifact rows into normalized preview items.
 * 将原始产物行转换为归一化的预览项。
 *
 * @param rows - Source rows with line numbers / 带行号的源行
 * @param fileName - Artifact file name used for kind resolution / 用于判定形态的产物文件名
 * @returns Preview items, one per row / 每行对应的预览项
 */
export function buildArtifactPreviewItems(rows: ArtifactPreviewSourceRow[], fileName: string): ArtifactPreviewItem[] {
  return rows.map((row) => buildArtifactPreviewItem(row, fileName));
}

/**
 * Normalizes one artifact row, picking per-kind id and text fields.
 * 归一化单行产物，并按形态选取 id 与文本字段。
 */
function buildArtifactPreviewItem(row: ArtifactPreviewSourceRow, fileName: string): ArtifactPreviewItem {
  const parsed = parseJsonRecord(row.text);
  const record = parsed.record;
  const kind = resolveItemKind(record, fileName);
  const sourceText = stringField(record, 'sourceText');
  const renderedText = stringField(record, 'text');
  return {
    lineNumber: row.lineNumber,
    rawText: row.text,
    prettyJson: parsed.prettyJson,
    record,
    kind,
    // Tree/parent/child records name their identity differently. / tree/parent/child 记录的标识字段各不相同。
    id: kind === 'tree'
      ? stringField(record, 'nodeId')
      : kind === 'parent'
        ? stringField(record, 'parentId')
        : stringField(record, 'chunkId') ?? stringField(record, 'childId'),
    parentId: kind === 'tree' ? stringField(record, 'parentId') : stringField(record, 'parentChunkId'),
    type: stringField(record, 'type'),
    // Chunks prefer the original sourceText; tree nodes prefer the rendered text. / 块记录优先取原始 sourceText，树节点优先取渲染 text。
    text: (kind === 'parent' || kind === 'child' ? sourceText ?? renderedText : renderedText ?? sourceText) ?? row.text,
    depth: numberField(record, 'depth'),
    ordinal: numberField(record, 'ordinal'),
    charCount: numberField(record, 'charCount'),
    childCount: numberField(record, 'childCount'),
    firstLineNo: numberField(record, 'firstLineNo'),
    lastLineNo: numberField(record, 'lastLineNo'),
    confidence: numberField(record, 'confidence'),
    boundaryReason: stringField(record, 'boundaryReason'),
    overlapChars: numberField(record, 'overlapChars'),
    sectionContext: stringField(record, 'sectionContext'),
    sectionPath: sectionPathLabels(record?.sectionPath),
  };
}

/**
 * Parses a line as JSON and pretty-prints it, tolerating non-JSON lines.
 * 将行解析为 JSON 并美化输出；容忍非 JSON 行。
 */
function parseJsonRecord(rawText: string): { record: Record<string, unknown> | null; prettyJson: string } {
  try {
    const value: unknown = JSON.parse(rawText);
    return {
      record: isRecord(value) ? value : null,
      prettyJson: JSON.stringify(value, null, 2),
    };
  } catch {
    return { record: null, prettyJson: rawText };
  }
}

/**
 * Infers the record shape from the file name and identifying fields.
 * 根据文件名与标识字段推断记录形态。
 */
function resolveItemKind(record: Record<string, unknown> | null, fileName: string): ArtifactPreviewItemKind {
  const normalizedName = fileName.toLowerCase();
  if (normalizedName === 'structure.jsonl' || stringField(record, 'nodeId')) return 'tree';
  if (normalizedName === 'parents.jsonl') return 'parent';
  if (normalizedName === 'children.jsonl' || normalizedName === 'chunks.jsonl' || stringField(record, 'chunkId')) return 'child';
  return 'raw';
}

/**
 * Extracts text labels from a sectionPath array of records.
 * 从 sectionPath 记录数组中提取文本标签。
 */
function sectionPathLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const label = stringField(item, 'text');
    return label ? [label] : [];
  });
}

/**
 * Reads a non-empty string field from a record. / 从记录中读取非空字符串字段。 */
function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Reads a finite number field from a record. / 从记录中读取有限数值字段。 */
function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Type guard for plain JSON objects. / 普通 JSON 对象的类型守卫。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
