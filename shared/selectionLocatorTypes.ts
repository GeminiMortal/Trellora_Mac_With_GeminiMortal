/**
 * IPC-safe selection locator capture describing a text selection without shipping full editor text.
 * 跨 IPC 的选区定位捕获：描述文本选区但不传输完整编辑器文本。
 */

/**
 * Structural snapshot of a text selection sent over IPC; only identity and selection structure cross IPC, full editor text stays local.
 * 通过 IPC 发送的文本选区结构快照；只有身份与选区结构跨 IPC，完整编辑器文本留在本地。
 */
export interface SelectionLocatorCapture {
  /** Editor session the selection belongs to. / 选区所属的编辑器会话。 */
  editorSessionId: string;
  /** Document revision at capture time. / 捕获时的文档修订号。 */
  docRevision: number;
  /** Selection start offset. / 选区起始偏移。 */
  from: number;
  /** Selection end offset. / 选区结束偏移。 */
  to: number;
  /** Offset of the selection within the surrounding text. / 选区在所在文本中的偏移。 */
  textOffset: number;
  /** Hash of the full document text for change detection. / 用于变更检测的完整文档文本哈希。 */
  documentTextHash: string;
  /** Hash of the selected text for change detection. / 用于变更检测的选中文本哈希。 */
  selectedTextHash: string;
  /** Canonical JSON slice of the selection for stable comparison. / 用于稳定比较的选区规范化 JSON 切片。 */
  canonicalSliceJson: string;
  /** Markdown fragment of the selection. / 选区的 Markdown 片段。 */
  markdownFragment: string;
  /** Signature over the selection's structure. / 选区结构的签名。 */
  selectionStructureSignature: string;
  /** Signature over the document's structure. / 文档结构的签名。 */
  documentStructureSignature: string;
  /** Kinds of blocks touched by the selection. / 选区覆盖的块类型。 */
  blockKinds: string[];
  /** On-screen bounding rectangle of the selection. / 选区在屏幕上的外接矩形。 */
  rect: { left: number; top: number; right: number; bottom: number };
}
