/**
 * Selection snapshot capture, writeback capability gating, and popup layout
 * helpers shared by AI rewrite/expand actions around the Tiptap editor.
 * Tiptap 编辑器 AI 改写/扩写操作共用的选区快照采集、写回能力判定与弹层布局辅助。
 */
import type { Editor } from '@tiptap/core';
import { getNoteViewportRect } from './editorCoordinates.ts';
import { DOMParser as ProseMirrorDOMParser, DOMSerializer, Fragment, Slice, type Mark, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { contentToEditorHtml, htmlToMarkdown } from '../../utils/markdown/markdown.ts';
import { normalizeSelectionProjection } from '../../../shared/selectionExpansionPolicy.ts';
import type { SelectionLocatorCapture } from '../../../shared/selectionLocatorTypes.ts';
import { hasExpansionRawHtml } from '../../../shared/selectionExpansionMarkdown.ts';

/**
 * Axis-aligned rectangle in note viewport coordinates.
 * 笔记视口坐标系中的轴对齐矩形。
 */
export interface FloatingRect {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

/**
 * Contiguous block range with its ProseMirror node type name.
 * 连续块区间及其 ProseMirror 节点类型名。
 */
export interface BlockRange {
    from: number;
    to: number;
    type: string;
}

/**
 * A block range plus its plain text and on-screen rectangle.
 * 块区间，附带纯文本内容与屏幕矩形。
 */
export interface BlockSnapshot extends BlockRange {
    text: string;
    rect: FloatingRect;
}

/**
 * A generated plain-text suggestion may only replace a simple text selection.
 * Cross-block expansion may use the constrained Markdown-to-Slice writer;
 * all other rich selections stay review/copy-only.
 * 生成的纯文本建议只能替换简单文本选区；跨块扩写可走受限的
 * Markdown-to-Slice 写回器，其余富选区仅支持查看/复制。
 */
export type SelectionWritebackMode = 'inline-text' | 'block-markdown' | 'copy-only';

/**
 * Stable reason codes explaining why a selection is limited to copy-only.
 * 选区被限制为仅复制时的稳定原因码。
 */
export type SelectionWritebackBlockCode =
    | 'cross-block-selection'
    | 'inline-structure'
    | 'mixed-marks'
    | 'slice-roundtrip-failed'
    | 'snapshot-structure-changed';

/**
 * Writeback decision for a selection, with an optional block code and a
 * user-facing message.
 * 选区的写回决策，附带可选原因码与面向用户的提示信息。
 */
export interface SelectionWritebackCapability {
    mode: SelectionWritebackMode;
    code?: SelectionWritebackBlockCode;
    message: string;
}

/**
 * Serializable mark record (type + attrs) used to restore formatting.
 * 可序列化的标记记录（类型 + 属性），用于恢复文字格式。
 */
export interface SelectionMarkSnapshot {
    type: string;
    attrs?: Record<string, unknown>;
}

/**
 * Heading breadcrumb anchor above the selection, used for context prompts.
 * 选区上方的标题面包屑锚点，用于生成上下文提示。
 */
export interface SelectionHeadingLocator {
    id: string;
    level: number;
    text: string;
    from: number;
}

/**
 * Renderer-side structural receipt captured with the legacy selection
 * snapshot. It is deliberately serializable so SE-3 can promote it into the
 * main-process SelectionSnapshotV2 after the saved-note locator is available.
 * 随旧版选区快照采集的渲染进程侧结构凭据。刻意保持可序列化，
 * 以便 SE-3 在笔记定位信息可用后升级为主进程 SelectionSnapshotV2。
 */
export interface SelectionStructureSnapshot {
    version: 1;
    selectionKind: 'single-textblock' | 'cross-block';
    sliceJson: unknown;
    canonicalSliceJson: string;
    markdownFragment: string;
    blockKinds: string[];
    headingPath: SelectionHeadingLocator[];
    selectedStructureSignature: string;
    documentStructureSignature: string;
    preservedMarks: SelectionMarkSnapshot[];
    writeback: SelectionWritebackCapability;
    plainTextWriteback?: SelectionWritebackCapability;
}

/**
 * Full renderer-side record of the user's selection for AI actions.
 * AI 操作所需的用户选区完整渲染进程侧记录。
 */
export interface SelectionSnapshot {
    editorSessionId: string;
    currentPath: string;
    from: number;
    to: number;
    selectedText: string;
    docRevision: number;
    block: BlockSnapshot;
    rect: FloatingRect;
    structure: SelectionStructureSnapshot;
    /** Local-only projection; never send full editor text through IPC. / 仅本地投影；不得经 IPC 发送完整编辑器文本。 */
    locatorSeed?: { documentText: string; textOffset: number };
}

/**
 * Block types the floating toolbar can convert the current block into.
 * 浮动工具栏可将当前块转换成的块类型。
 */
export type BlockTransform =
    | 'paragraph'
    | 'heading-1'
    | 'heading-2'
    | 'heading-3'
    | 'heading-4'
    | 'heading-5'
    | 'heading-6'
    | 'blockquote'
    | 'bullet-list'
    | 'ordered-list'
    | 'task-list'
    | 'code-block';

/**
 * Resolved top-left coordinates for a floating popup.
 * 浮动弹层最终的左上角坐标。
 */
export interface PopupPosition {
    left: number;
    top: number;
}

/**
 * Pointer coordinates used to anchor context-menu style popups.
 * 用于锚定右键菜单式弹层的指针坐标。
 */
export interface PointerAnchor {
    x: number;
    y: number;
}

const horizontalInset = 8;
const verticalInset = 8;
const supportedBlockMarkdownNodes = new Set([
    'paragraph',
    'heading',
    'blockquote',
    'bulletList',
    'orderedList',
    'listItem',
    'taskList',
    'taskItem',
    'codeBlock',
    // Table family: GFM round-trip already has dedicated serialization (turndown tiptapTable + marked gfm);
    // structural stability is backstopped by parseBlockMarkdownSlice's canonical round-trip. / 表格族：GFM 往返已有专用序列化（turndown tiptapTable + marked gfm），结构稳定性由 parseBlockMarkdownSlice 的 canonical round-trip 兜底。
    'table',
    'tableRow',
    'tableHeader',
    'tableCell',
]);
const supportedBlockMarkdownMarks = new Set(['bold', 'italic', 'strike', 'code', 'link']);

/**
 * Resolve the block range at a position, preferring list items.
 * 解析位置处的块区间，列表项优先。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param position - Document position to inspect / 待检查的文档位置
 * @returns The block range, or null when none can be resolved / 块区间；无法解析时返回 null
 */
export function findBlockRange(editor: Editor, position: number): BlockRange | null {
    const { doc } = editor.state;
    const safePosition = Math.max(1, Math.min(position, Math.max(1, doc.content.size)));
    const $pos = doc.resolve(safePosition);
    let fallback: BlockRange | null = null;

    // Walk outward; return early on listItem so list actions hit the whole item. / 向外遍历；命中 listItem 时立即返回，使列表操作作用于整个列表项。
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const node = $pos.node(depth);
        const from = $pos.before(depth);
        const to = $pos.after(depth);
        const candidate = { from, to, type: node.type.name };
        if (node.type.name === 'listItem') return candidate;
        // Keep the innermost textblock/block as a fallback while scanning outward. / 向外扫描时保留最内层 textblock/block 作为回退。
        if (!fallback && (node.isTextblock || node.isBlock)) fallback = candidate;
    }

    return fallback;
}

/**
 * Union of the viewport rects at two document positions.
 * 合并两个文档位置的视口矩形。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param from - Start position / 起始位置
 * @param to - End position / 结束位置
 * @returns Union rectangle / 合并后的矩形
 */
export function getFloatingRect(editor: Editor, from: number, to: number): FloatingRect {
    const maxPosition = Math.max(1, editor.state.doc.content.size);
    const start = getNoteViewportRect(editor.view.coordsAtPos(Math.max(1, Math.min(from, maxPosition))), editor.view.dom);
    const end = getNoteViewportRect(editor.view.coordsAtPos(Math.max(1, Math.min(to, maxPosition))), editor.view.dom);
    return {
        top: Math.min(start.top, end.top),
        right: Math.max(start.right, end.right),
        bottom: Math.max(start.bottom, end.bottom),
        left: Math.min(start.left, end.left),
    };
}

/**
 * Snapshot the block containing a position with its text and rect.
 * 采集包含指定位置的块及其文本与矩形快照。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param position - Position inside the target block / 目标块内的位置
 * @returns Block snapshot or null when unresolvable / 块快照；无法解析时返回 null
 */
export function createBlockSnapshot(editor: Editor, position: number): BlockSnapshot | null {
    const range = findBlockRange(editor, position);
    if (!range) return null;
    return {
        ...range,
        text: editor.state.doc.textBetween(range.from, range.to, '\n').trim(),
        rect: getFloatingRect(editor, Math.min(range.from + 1, range.to), range.to),
    };
}

/**
 * Capture a snapshot for a non-empty selection inside a single textblock.
 * 为单文本块内的非空选区采集快照。
 *
 * @param input - Editor context and document revision / 编辑器上下文与文档修订号
 * @returns Snapshot or null when the selection is not capturable / 快照；选区不可采集时返回 null
 */
export function createSelectionSnapshot(input: {
    editor: Editor;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
}): SelectionSnapshot | null {
    const { editor, editorSessionId, currentPath, docRevision } = input;
    const { from, to, empty, $from, $to } = editor.state.selection;
    // Cross-block selections must go through the expansion snapshot path. / 跨块选区必须走扩写快照路径。
    if (empty || !$from.parent.isTextblock || $from.parent !== $to.parent) return null;
    const selectedText = editor.state.doc.textBetween(from, to, '\n');
    if (!selectedText.trim()) return null;
    const block = createBlockSnapshot(editor, from);
    if (!block) return null;
    return createStructuredSelectionSnapshot({ editor, editorSessionId, currentPath, docRevision, from, to, selectedText, block });
}

/**
 * Allows cross-paragraph selections; rewrite results are written back through
 * the constrained Markdown-to-Slice writer for body text, headings, quotes,
 * lists, links, and code blocks. Tables, images, formulas and other complex
 * structures stay copy-only to avoid data loss on cross-block writeback.
 * 允许跨段落选择；扩写结果会通过受限 Markdown-to-Slice 写回器替换
 * 正文、标题、引用、列表、链接和代码块。表格、图片和公式等复杂结构仍
 * 保持仅复制，避免跨块写回造成数据丢失。
 *
 * @param input - Editor context and document revision / 编辑器上下文与文档修订号
 * @returns Snapshot or null when the selection is not capturable / 快照；选区不可采集时返回 null
 */
export function createSelectionExpansionSnapshot(input: {
    editor: Editor;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
}): SelectionSnapshot | null {
    const { editor, editorSessionId, currentPath, docRevision } = input;
    const { from, to, empty } = editor.state.selection;
    if (empty) return null;
    const selectedText = editor.state.doc.textBetween(from, to, '\n');
    if (!selectedText.trim()) return null;
    const block = createBlockSnapshot(editor, from);
    if (!block) return null;
    return createStructuredSelectionSnapshot({
        editor,
        editorSessionId,
        currentPath,
        docRevision,
        from,
        to,
        selectedText,
        block,
        allowBlockMarkdownWriteback: true,
    });
}

/**
 * Whether a snapshot still matches the live document text and structure.
 * 快照是否仍与当前文档的文本及结构一致。
 *
 * @param input - Live editor state plus the snapshot to verify / 实时编辑器状态与待校验快照
 * @returns True when the snapshot is still valid / 快照仍有效时返回 true
 */
export function isSelectionSnapshotCurrent(input: {
    editor: Editor;
    snapshot: SelectionSnapshot;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
}): boolean {
    const { editor, snapshot, editorSessionId, currentPath, docRevision } = input;
    if (snapshot.editorSessionId !== editorSessionId || snapshot.currentPath !== currentPath || snapshot.docRevision !== docRevision) return false;
    if (snapshot.from < 1 || snapshot.to > editor.state.doc.content.size || snapshot.from >= snapshot.to) return false;
    // Text must match exactly; marks and inline atoms are verified below. / 文本须完全一致；标记与内联原子在下方校验。
    if (editor.state.doc.textBetween(snapshot.from, snapshot.to, '\n') !== snapshot.selectedText) return false;
    return isSelectionStructureCurrent(editor, snapshot);
}

/**
 * Collect bounded same-block context text before and after the selection.
 * 采集选区前后受限长度的同块上下文文本。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param snapshot - Selection snapshot / 选区快照
 * @param maxCharacters - Total context budget in characters / 上下文总字符预算
 * @returns Before/after context strings / 前后上下文字符串
 */
export function getSameBlockContext(editor: Editor, snapshot: SelectionSnapshot, maxCharacters = 400): { before: string; after: string } {
    // Split the budget: half for the prefix, the remainder for the suffix. / 预算对半分配：前半给前缀，其余给后缀。
    const before = editor.state.doc.textBetween(snapshot.block.from, snapshot.from, '\n').slice(-Math.floor(maxCharacters / 2));
    const after = editor.state.doc.textBetween(snapshot.to, snapshot.block.to, '\n').slice(0, maxCharacters - before.length);
    return { before, after };
}

/**
 * Exposes the captured decision to preview surfaces without duplicating schema checks.
 * 将采集到的写回决策暴露给预览界面，避免重复执行结构校验。
 *
 * @param snapshot - Selection snapshot / 选区快照
 * @param formatted - Use the formatted capability (default) or the plain-text one / 使用格式化能力（默认）或纯文本能力
 * @returns The writeback capability / 写回能力
 */
export function getSelectionWritebackCapability(snapshot: SelectionSnapshot, formatted = true): SelectionWritebackCapability {
    return formatted ? snapshot.structure.writeback : snapshot.structure.plainTextWriteback ?? snapshot.structure.writeback;
}

/**
 * Build a serializable Slice receipt and determine whether a plain-text result
 * can be written without changing the document's block/mark structure.
 * 构建可序列化的 Slice 凭据，并判定纯文本结果能否在不改变文档块/标记结构的前提下写回。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param from - Selection start / 选区起点
 * @param to - Selection end / 选区终点
 * @param allowBlockMarkdownWriteback - Allow the constrained block-Markdown path / 是否允许受限块 Markdown 写回
 * @returns Structural snapshot with the writeback decision / 含写回决策的结构快照
 */
export function createSelectionStructureSnapshot(
    editor: Editor,
    from: number,
    to: number,
    allowBlockMarkdownWriteback = false,
): SelectionStructureSnapshot {
    const slice = editor.state.doc.slice(from, to);
    const sliceJson = slice.toJSON();
    const canonicalSliceJson = stableJson(sliceJson);
    const { $from, $to } = editor.state.selection;
    const sameTextblock = $from.parent.isTextblock && $from.parent === $to.parent;
    const inlinePlan = resolveInlineWritebackPlan(slice, sameTextblock, allowBlockMarkdownWriteback);
    const roundTripValid = isSliceRoundTripValid(editor, sliceJson, canonicalSliceJson);
    // A failed round-trip downgrades the whole snapshot to copy-only. / 往返校验失败时，整个快照降级为仅复制。
    const writeback = !roundTripValid
        ? copyOnly('slice-roundtrip-failed', '原始选区结构无法校验，请复制建议后手动处理。')
        : inlinePlan.writeback;

    return {
        version: 1,
        selectionKind: sameTextblock ? 'single-textblock' : 'cross-block',
        sliceJson,
        canonicalSliceJson,
        markdownFragment: sliceToMarkdown(editor, slice),
        blockKinds: collectBlockKinds(slice),
        headingPath: collectHeadingPath(editor.state.doc, from),
        selectedStructureSignature: createSliceStructureSignature(slice),
        documentStructureSignature: createDocumentStructureSignature(editor.state.doc),
        preservedMarks: inlinePlan.preservedMarks,
        writeback,
        plainTextWriteback: resolveInlineWritebackPlan(slice, sameTextblock, false).writeback,
    };
}

/**
 * Performs a canonical Slice round-trip and compares the current selection
 * structure, not merely its text. This catches same-text mark and inline-node
 * changes that `doc.textBetween()` cannot see.
 * 执行规范化 Slice 往返并比较当前选区结构，而非仅比较文本；
 * 从而捕获 `doc.textBetween()` 无法发现的同文标记与内联节点变化。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param snapshot - Snapshot to verify / 待校验快照
 * @returns True when the structure is unchanged / 结构未变化时返回 true
 */
export function isSelectionStructureCurrent(editor: Editor, snapshot: SelectionSnapshot): boolean {
    try {
        const restored = Slice.fromJSON(editor.schema, snapshot.structure.sliceJson as never);
        if (stableJson(restored.toJSON()) !== snapshot.structure.canonicalSliceJson) return false;
        const currentSlice = editor.state.doc.slice(snapshot.from, snapshot.to);
        if (stableJson(currentSlice.toJSON()) !== snapshot.structure.canonicalSliceJson) return false;
        return createDocumentStructureSignature(editor.state.doc) === snapshot.structure.documentStructureSignature;
    } catch {
        return false;
    }
}

/**
 * Structural signature excludes text content but retains blocks, attrs, marks, and inline atoms.
 * 结构签名不含文本内容，但保留块、属性、标记与内联原子。
 *
 * @param doc - Document node / 文档节点
 * @returns Structural signature string / 结构签名字符串
 */
export function createDocumentStructureSignature(doc: ProseMirrorNode): string {
    return createNodeStructureSignature(doc);
}

/**
 * Assemble a SelectionSnapshot with rect, structure receipt, and locator seed.
 * 组装含矩形、结构凭据与定位种子的 SelectionSnapshot。
 */
function createStructuredSelectionSnapshot(input: {
    editor: Editor;
    editorSessionId: string;
    currentPath: string;
    docRevision: number;
    from: number;
    to: number;
    selectedText: string;
    block: BlockSnapshot;
    allowBlockMarkdownWriteback?: boolean;
}): SelectionSnapshot {
    const { editor, editorSessionId, currentPath, docRevision, from, to, selectedText, block, allowBlockMarkdownWriteback } = input;
    return {
        editorSessionId,
        currentPath,
        from,
        to,
        selectedText,
        docRevision,
        block,
        rect: getFloatingRect(editor, from, to),
        structure: createSelectionStructureSnapshot(editor, from, to, allowBlockMarkdownWriteback),
        locatorSeed: {
            // Normalized projection keeps the locator hash stable across whitespace variants. / 规范化投影使定位哈希在空白差异下保持稳定。
            documentText: normalizeSelectionProjection(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')),
            textOffset: normalizeSelectionProjection(editor.state.doc.textBetween(0, from, '\n')).length,
        },
    };
}

/**
 * Freeze the actual selected occurrence without exporting the full editor text.
 * 固化实际选中的出现位置，同时不导出完整编辑器文本。
 *
 * @param snapshot - Selection snapshot carrying the locator seed / 携带定位种子的选区快照
 * @returns Serializable locator capture / 可序列化的定位凭据
 */
export async function createSelectionLocatorCapture(snapshot: SelectionSnapshot): Promise<SelectionLocatorCapture> {
    if (!snapshot.locatorSeed) throw new Error('选区定位信息已失效，请重新选择文字。');
    const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return {
        editorSessionId: snapshot.editorSessionId, docRevision: snapshot.docRevision, from: snapshot.from, to: snapshot.to,
        textOffset: snapshot.locatorSeed.textOffset, documentTextHash: await hash(snapshot.locatorSeed.documentText),
        selectedTextHash: await hash(snapshot.selectedText), canonicalSliceJson: snapshot.structure.canonicalSliceJson,
        markdownFragment: snapshot.structure.markdownFragment, selectionStructureSignature: snapshot.structure.selectedStructureSignature,
        documentStructureSignature: snapshot.structure.documentStructureSignature,
        blockKinds: [...snapshot.structure.blockKinds], rect: { ...snapshot.rect },
    };
}

/**
 * Serialize a Slice to Markdown via DOM + turndown for receipts and prompts.
 * 经由 DOM + turndown 将 Slice 序列化为 Markdown，用于凭据与提示词。
 */
function sliceToMarkdown(editor: Editor, slice: Slice): string {
    if (typeof document === 'undefined') return '';
    const container = document.createElement('div');
    const serializer = DOMSerializer.fromSchema(editor.schema);
    container.appendChild(serializer.serializeFragment(slice.content));
    return htmlToMarkdown(wrapDetachedTableRows(container.innerHTML)).trim();
}

/**
 * Table slices with openStart/openEnd make DOMSerializer emit bare <tr> rows;
 * outside a <table> turndown's table rule never fires and the model sees
 * flattened paragraph text. Re-wrap the rows so table rewrites are based on
 * real GFM structure.
 * 表格切片的 openStart/openEnd 会让 DOMSerializer 只输出裸 <tr>，脱离 <table> 后
 * turndown 的表格规则不触发，交给模型的原文就退化成压扁的段落文本。补回包裹，
 * 使表格选区的改写建立在真实 GFM 结构上。
 */
function wrapDetachedTableRows(html: string): string {
    const trimmed = html.trim();
    if (!/^<(tr|td|th)\b/iu.test(trimmed)) return html;
    return `<table><tbody>${trimmed}</tbody></table>`;
}

/**
 * Replace the selection with plain text while preserving its uniform marks.
 * 用纯文本替换选区，同时保留其统一标记。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param snapshot - Captured selection snapshot / 采集的选区快照
 * @param text - Suggested plain text / 建议的纯文本
 * @returns Nothing; throws when the writeback is unsafe / 无返回值；写回不安全时抛出异常
 */
export function replaceSelectionWithText(editor: Editor, snapshot: SelectionSnapshot, text: string): void {
    const capability = getSelectionWritebackCapability(snapshot);
    if (!isSelectionStructureCurrent(editor, snapshot)) {
        throw new Error('原文结构已变化，请重新选择文字后再生成。');
    }

    if (capability.mode === 'block-markdown') {
        replaceSelectionWithBlockMarkdown(editor, snapshot, text);
        return;
    }
    if (capability.mode !== 'inline-text') throw new Error(capability.message);

    const inlineText = normalizeInlineText(text);
    if (!inlineText) throw new Error('建议内容为空，无法替换。');

    const marks = restorePreservedMarks(editor, snapshot.structure.preservedMarks);
    const replacement = new Slice(Fragment.from(editor.schema.text(inlineText, marks)), 0, 0);
    const transaction = editor.state.tr.replace(snapshot.from, snapshot.to, replacement).scrollIntoView();
    // Recompute the signature on the replaced doc so structural damage is caught before dispatch. / 替换后重算文档签名，在 dispatch 前拦截结构性破坏。
    if (createDocumentStructureSignature(transaction.doc) !== snapshot.structure.documentStructureSignature) {
        throw new Error('替换会改变标题、列表、引用、代码或标记结构，已改为仅可复制。');
    }
    if (!transaction.docChanged) throw new Error('建议内容未产生可写入的变更。');
    editor.view.dispatch(transaction);
}

/**
 * Parse expansion Markdown without flattening its marks or block structure.
 * 解析扩写 Markdown，不压平其标记或块结构。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param snapshot - Captured selection snapshot / 采集的选区快照
 * @param markdown - Expansion Markdown / 扩写 Markdown 内容
 * @returns Nothing; throws when the writeback is unsafe / 无返回值；写回不安全时抛出异常
 */
export function replaceSelectionWithMarkdown(editor: Editor, snapshot: SelectionSnapshot, markdown: string): void {
    if (!isSelectionStructureCurrent(editor, snapshot)) throw new Error('原文结构已变化，请重新选择文字后再生成。');
    const capability = getSelectionWritebackCapability(snapshot);
    if (capability.mode === 'copy-only') throw new Error(capability.message);
    let replacement = parseBlockMarkdownSlice(editor, markdown);
    const $from = editor.state.doc.resolve(snapshot.from);
    const $to = editor.state.doc.resolve(snapshot.to);
    // Single-textblock replacements are spliced inline; nested parents stay block-level. / 单文本块替换走行内拼接；嵌套父节点保持块级替换。
    if ($from.sameParent($to) && $from.parent.isTextblock && replacement.content.childCount === 1) {
        const block = replacement.content.firstChild!;
        if (block.isTextblock) {
            if ($from.parent.type.name === 'codeBlock') {
                // Strip the trailing newline the Markdown parser adds inside fences. / 去掉 Markdown 解析器在围栏内附加的结尾换行。
                const code = block.type.name === 'codeBlock' ? block.textContent.replace(/\n$/u, '') : block.textContent;
                if (!code) throw new Error('代码内容为空，无法替换。');
                replacement = new Slice(Fragment.from(editor.schema.text(code)), 0, 0);
            } else {
                // Merge the parsed block content with the snapshot's preserved marks. / 将解析出的块内容与快照保留的标记合并。
                const inherited = restorePreservedMarks(editor, snapshot.structure.preservedMarks);
                const nodes: ProseMirrorNode[] = [];
                block.content.forEach((node) => {
                    let marks = node.marks;
                    for (const mark of inherited) if (!marks.some((item) => item.type === mark.type)) marks = mark.addToSet(marks);
                    nodes.push(node.mark(marks));
                });
                replacement = new Slice(Fragment.fromArray(nodes), 0, 0);
            }
        }
    } else if ($from.sameParent($to) && $from.depth > 1) {
        // Deeply nested parents (list items, quotes, cells) need inline-safe content. / 深层父节点（列表项、引用、单元格）要求行内安全的内容。
        throw new Error('列表项、引用或表格单元格内请使用行内格式，或重新选中完整块后替换。');
    }
    const transaction = editor.state.tr.replace(snapshot.from, snapshot.to, replacement).scrollIntoView();
    transaction.doc.check();
    if (!transaction.docChanged) throw new Error('建议内容未产生可写入的变更。');
    editor.view.dispatch(transaction);
}

/**
 * Insert Markdown after the last selected top-level block, including a whole list.
 * 在选中内容最后一个顶层块之后插入 Markdown，可完整插入列表。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param snapshot - Captured selection snapshot / 采集的选区快照
 * @param markdown - Markdown to insert / 待插入的 Markdown
 * @returns Nothing; throws when the snapshot is stale or the Markdown is invalid / 无返回值；快照过期或 Markdown 非法时抛出异常
 */
export function insertMarkdownBelowSelection(editor: Editor, snapshot: SelectionSnapshot, markdown: string): void {
    if (!isSelectionStructureCurrent(editor, snapshot)) throw new Error('原文结构已变化，请重新选择文字后再生成。');
    const replacement = parseBlockMarkdownSlice(editor, markdown);
    const $end = editor.state.doc.resolve(snapshot.to);
    // after(1) inserts below the enclosing top-level block, not inside it. / after(1) 插入到所在顶层块之后，而非块内。
    const position = $end.depth ? $end.after(1) : snapshot.to;
    const transaction = editor.state.tr.insert(position, replacement.content).scrollIntoView();
    transaction.doc.check();
    editor.view.dispatch(transaction);
}

/**
 * Write a parsed block Markdown slice over the selection, rejecting results
 * that fail the document structure check.
 * 以解析后的块 Markdown Slice 覆盖选区，拒绝未通过文档结构校验的结果。
 */
function replaceSelectionWithBlockMarkdown(editor: Editor, snapshot: SelectionSnapshot, text: string): void {
    const replacement = parseBlockMarkdownSlice(editor, text);
    const transaction = editor.state.tr.replace(snapshot.from, snapshot.to, replacement).scrollIntoView();
    try {
        transaction.doc.check();
    } catch {
        throw new Error('扩写结果无法保持文档结构，请复制建议后手动处理。');
    }
    if (!transaction.docChanged) throw new Error('建议内容未产生可写入的变更。');
    editor.view.dispatch(transaction);
}

/**
 * Parse Markdown into a validated Slice, rejecting raw HTML, unsupported
 * nodes, and round-trip-unstable structures.
 * 将 Markdown 解析为已校验的 Slice，拒绝原始 HTML、不支持的节点与往返不稳定的结构。
 */
function parseBlockMarkdownSlice(editor: Editor, value: string): Slice {
    const markdown = value.replace(/\r\n?/g, '\n').trim();
    if (!markdown) throw new Error('建议内容为空，无法替换。');
    if (hasExpansionRawHtml(markdown)) {
        throw new Error('扩写结果包含不支持的 HTML，请复制建议后手动处理。');
    }
    if (typeof document === 'undefined') throw new Error('当前环境不支持结构化扩写写回。');

    const container = document.createElement('div');
    container.innerHTML = contentToEditorHtml(markdown);
    const parser = ProseMirrorDOMParser.fromSchema(editor.schema);
    const replacement = parser.parseSlice(container);
    if (!isSupportedBlockMarkdownSlice(replacement)) {
        throw new Error('扩写结果包含表格、图片、公式或其他不支持的结构，请复制建议后手动处理。');
    }

    // Serialize back to Markdown and re-parse; any drift means the writeback is unsafe. / 再序列化为 Markdown 并重新解析；出现漂移即视为写回不安全。
    const canonicalMarkdown = sliceToMarkdown(editor, replacement);
    const canonicalContainer = document.createElement('div');
    canonicalContainer.innerHTML = contentToEditorHtml(canonicalMarkdown);
    const canonical = parser.parseSlice(canonicalContainer);
    if (stableJson(canonical.toJSON()) !== stableJson(replacement.toJSON())) {
        throw new Error('扩写结果结构无法稳定解析，请复制建议后手动处理。');
    }
    return replacement;
}

/**
 * Insert plain paragraphs right after a block (used for follow-up prompts).
 * 在块之后插入纯文本段落（用于追问提示）。
 *
 * @param editor - Tiptap editor instance / Tiptap 编辑器实例
 * @param block - Target block range / 目标块区间
 * @param text - Paragraph text; blank lines split paragraphs / 段落文本；空行分段
 * @returns Nothing; throws when there is nothing to insert / 无返回值；无可插入内容时抛出异常
 */
export function insertTextBelowBlock(editor: Editor, block: BlockRange, text: string): void {
    const paragraphs = normalizeParagraphs(text);
    if (paragraphs.length === 0) throw new Error('建议内容为空，无法插入。');
    const paragraphType = editor.schema.nodes.paragraph;
    if (!paragraphType) throw new Error('当前编辑器不支持插入正文块。');
    const nodes = paragraphs.map((paragraph) => paragraphType.create(null, paragraph ? editor.schema.text(paragraph) : undefined));
    editor.view.dispatch(editor.state.tr.insert(block.to, Fragment.fromArray(nodes)).scrollIntoView());
}

/**
 * Center a popup on an anchor rect, preferring the space above it.
 * 将弹层水平居中于锚点矩形，优先显示在上方。
 *
 * @param anchor - Anchor rectangle / 锚点矩形
 * @param width - Popup width / 弹层宽度
 * @param height - Popup height / 弹层高度
 * @param preferAbove - Prefer above the anchor when space allows / 空间足够时优先显示在上方
 * @returns Popup top-left position / 弹层左上角坐标
 */
export function positionPopup(anchor: FloatingRect, width: number, height: number, preferAbove = true): PopupPosition {
    const viewportWidth = typeof window === 'undefined' ? width + horizontalInset * 2 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? height + verticalInset * 2 : window.innerHeight;
    const desiredLeft = anchor.left + (anchor.right - anchor.left) / 2 - width / 2;
    const left = Math.max(horizontalInset, Math.min(desiredLeft, viewportWidth - width - horizontalInset));
    const above = anchor.top - height - 8;
    const below = anchor.bottom + 8;
    // Prefer above when it fits; otherwise clamp the below-position into the viewport. / 上方放得下时优先上方；否则把下方位置钳制进视口。
    const top = preferAbove && above >= verticalInset
        ? above
        : Math.max(verticalInset, Math.min(below, viewportHeight - height - verticalInset));
    return { left, top };
}

/**
 * Place a popup next to the pointer, flipping to the left near the right edge.
 * 将弹层放在指针旁，接近右边缘时翻转到左侧。
 *
 * @param anchor - Pointer coordinates / 指针坐标
 * @param width - Popup width / 弹层宽度
 * @param height - Popup height / 弹层高度
 * @returns Popup top-left position / 弹层左上角坐标
 */
export function positionPopupAtPointer(anchor: PointerAnchor, width: number, height: number): PopupPosition {
    const viewportWidth = typeof window === 'undefined' ? width + horizontalInset * 2 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? height + verticalInset * 2 : window.innerHeight;
    const rightSide = anchor.x + 12;
    const preferredLeft = rightSide + width <= viewportWidth - horizontalInset
        ? rightSide
        : anchor.x - width - 12;
    return {
        left: Math.max(horizontalInset, Math.min(preferredLeft, viewportWidth - width - horizontalInset)),
        top: Math.max(verticalInset, Math.min(anchor.y - 16, viewportHeight - height - verticalInset)),
    };
}

/**
 * Place a popup beside an anchor rect, preferring its right side.
 * 将弹层放在锚点矩形旁，优先右侧。
 *
 * @param anchor - Anchor rectangle / 锚点矩形
 * @param width - Popup width / 弹层宽度
 * @param height - Popup height / 弹层高度
 * @returns Popup top-left position / 弹层左上角坐标
 */
export function positionPopupBeside(anchor: FloatingRect, width: number, height: number): PopupPosition {
    const viewportWidth = typeof window === 'undefined' ? width + horizontalInset * 2 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? height + verticalInset * 2 : window.innerHeight;
    const rightSide = anchor.right + 6;
    const preferredLeft = rightSide + width <= viewportWidth - horizontalInset
        ? rightSide
        : anchor.left - width - 6;
    return {
        left: Math.max(horizontalInset, Math.min(preferredLeft, viewportWidth - width - horizontalInset)),
        top: Math.max(verticalInset, Math.min(anchor.top - 7, viewportHeight - height - verticalInset)),
    };
}

/**
 * Collapse newlines and runs of spaces so text can safely replace an inline run.
 * 折叠换行与连续空格，使文本可安全替换行内片段。
 */
function normalizeInlineText(value: string): string {
    return value.replace(/\r\n?/g, '\n').replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Split text on blank lines and soft-wrap breaks into trimmed paragraphs.
 * 按空行与软换行切分为修剪后的段落数组。
 */
function normalizeParagraphs(value: string): string[] {
    return value
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean);
}

/**
 * Decide the writeback mode: inline text needs uniform text-only content;
 * cross-block or structured slices fall back to block Markdown or copy-only.
 * 判定写回模式：行内文本要求纯文本且标记一致；跨块或含结构的切片
 * 回退到块 Markdown 或仅复制。
 */
function resolveInlineWritebackPlan(slice: Slice, sameTextblock: boolean, allowBlockMarkdownWriteback: boolean): {
    preservedMarks: SelectionMarkSnapshot[];
    writeback: SelectionWritebackCapability;
} {
    if (!sameTextblock) {
        if (allowBlockMarkdownWriteback && isSupportedBlockMarkdownSlice(slice)) {
            return {
                preservedMarks: [],
                writeback: { mode: 'block-markdown', message: '可将扩写结果按 Markdown 块结构写回选区。' },
            };
        }
        return {
            preservedMarks: [],
            writeback: copyOnly('cross-block-selection', allowBlockMarkdownWriteback
                ? '跨块选区包含表格、图片、公式或其他复杂结构，请复制建议后手动处理。'
                : '跨块选区暂不支持纯文本替换，请复制建议后手动处理。'),
        };
    }

    const textNodes: ProseMirrorNode[] = [];
    let containsInlineStructure = false;
    visitFragment(slice.content, (node) => {
        if (node.isText) {
            textNodes.push(node);
            return;
        }
        containsInlineStructure = true;
    });

    if (containsInlineStructure || textNodes.length === 0) {
        if (allowBlockMarkdownWriteback && isSupportedBlockMarkdownSlice(slice)) return {
            preservedMarks: [],
            writeback: { mode: 'block-markdown', message: '可按 Markdown 保留选区的文字格式和换行。' },
        };
        return {
            preservedMarks: [],
            writeback: copyOnly('inline-structure', '选区包含换行、图片或其他内联结构，请复制建议后手动处理。'),
        };
    }

    // Inline replacement only when every text node shares one mark signature. / 仅当所有文本节点共享同一标记签名时才允许行内替换。
    const firstMarks = textNodes[0]?.marks ?? [];
    const markSignature = createMarksSignature(firstMarks);
    if (textNodes.some((node) => createMarksSignature(node.marks) !== markSignature)) {
        if (allowBlockMarkdownWriteback && isSupportedBlockMarkdownSlice(slice)) return {
            preservedMarks: [],
            writeback: { mode: 'block-markdown', message: '可按 Markdown 保留选区的文字格式。' },
        };
        return {
            preservedMarks: [],
            writeback: copyOnly('mixed-marks', '选区混合了不同链接或文字标记，请复制建议后手动处理。'),
        };
    }

    return {
        preservedMarks: firstMarks.map(toMarkSnapshot),
        writeback: { mode: 'inline-text', message: '可安全替换选区。' },
    };
}

/**
 * Whitelist check over block nodes, marks, and link schemes before writeback.
 * 写回前对块节点、标记与链接协议做白名单校验。
 */
function isSupportedBlockMarkdownSlice(slice: Slice): boolean {
    if (slice.content.size === 0) return false;
    let supported = true;
    visitFragment(slice.content, (node) => {
        if (node.isBlock && !supportedBlockMarkdownNodes.has(node.type.name)) {
            supported = false;
            return;
        }
        if (!node.isBlock && !node.isText && node.type.name !== 'hardBreak') {
            supported = false;
            return;
        }
        if (node.isText && node.marks.some((mark) => !supportedBlockMarkdownMarks.has(mark.type.name))) {
            supported = false;
        }
        // Only http(s)/mailto/tel link schemes survive writeback. / 写回仅放行 http(s)/mailto/tel 链接协议。
        if (node.marks.some((mark) => mark.type.name === 'link'
            && /^[a-z][a-z\d+.-]*:/iu.test(String(mark.attrs.href))
            && !/^(https?|mailto|tel):/iu.test(String(mark.attrs.href)))) supported = false;
    });
    return supported;
}

/**
 * Shorthand for a copy-only capability with a stable code and message.
 * 构造带稳定原因码与提示信息的仅复制能力。
 */
function copyOnly(code: SelectionWritebackBlockCode, message: string): SelectionWritebackCapability {
    return { mode: 'copy-only', code, message };
}

/**
 * Verify the Slice survives JSON round-trip without structural drift.
 * 校验 Slice 经 JSON 往返后结构无漂移。
 */
function isSliceRoundTripValid(editor: Editor, sliceJson: unknown, canonicalSliceJson: string): boolean {
    try {
        const restored = Slice.fromJSON(editor.schema, sliceJson as never);
        return stableJson(restored.toJSON()) === canonicalSliceJson;
    } catch {
        return false;
    }
}

/**
 * Recreate live marks from serializable snapshots on the current schema.
 * 在当前 schema 上由可序列化快照重建活动标记。
 */
function restorePreservedMarks(editor: Editor, markSnapshots: SelectionMarkSnapshot[]): Mark[] {
    return markSnapshots.map((mark) => {
        const markType = editor.schema.marks[mark.type];
        if (!markType) throw new Error(`当前编辑器不支持恢复 ${mark.type} 标记。`);
        return markType.create(mark.attrs ?? null);
    });
}

/**
 * Serialize a mark to a plain {type, attrs} snapshot.
 * 将标记序列化为 {type, attrs} 纯对象快照。
 */
function toMarkSnapshot(mark: Mark): SelectionMarkSnapshot {
    const serialized = mark.toJSON();
    return serialized.attrs ? { type: serialized.type, attrs: { ...serialized.attrs } } : { type: serialized.type };
}

/**
 * Collect distinct block type names contained in a Slice.
 * 收集 Slice 内出现的块类型名集合。
 */
function collectBlockKinds(slice: Slice): string[] {
    const kinds = new Set<string>();
    visitFragment(slice.content, (node) => {
        if (node.isBlock) kinds.add(node.type.name);
    });
    return [...kinds];
}

/**
 * Build the heading breadcrumb trail active at a selection position.
 * 构建选区位置处生效的标题面包屑路径。
 */
function collectHeadingPath(doc: ProseMirrorNode, selectionFrom: number): SelectionHeadingLocator[] {
    const headings = new Map<number, SelectionHeadingLocator>();
    doc.forEach((node, from) => {
        if (from > selectionFrom || node.type.name !== 'heading') return;
        const level = Number(node.attrs.level);
        if (!Number.isInteger(level) || level < 1 || level > 6) return;
        // A heading replaces every deeper-or-equal entry, keeping the trail monotonic. / 新标题替换所有同级或更深条目，保持路径层级单调。
        for (const existingLevel of headings.keys()) {
            if (existingLevel >= level) headings.delete(existingLevel);
        }
        headings.set(level, {
            id: `pm-heading-${from}`,
            level,
            text: node.textContent,
            from,
        });
    });
    return [...headings.values()].sort((left, right) => left.level - right.level);
}

/**
 * Signature string for a Slice including its open boundaries.
 * 生成包含开放边界的 Slice 结构签名。
 */
function createSliceStructureSignature(slice: Slice): string {
    const children: string[] = [];
    slice.content.forEach((node) => appendStructureSignature(children, node));
    return `slice(${slice.openStart},${slice.openEnd})[${children.join(',')}]`;
}

/**
 * Recursive structural signature: node type, attrs, marks, and child shapes.
 * 递归结构签名：节点类型、属性、标记与子节点形态。
 */
function createNodeStructureSignature(node: ProseMirrorNode): string {
    if (node.isText) return `text<${createMarksSignature(node.marks)}>`;
    const children: string[] = [];
    node.forEach((child) => appendStructureSignature(children, child));
    return `${node.type.name}${stableJson(node.attrs)}[${children.join(',')}]`;
}

/**
 * Append a node signature, merging runs of identical adjacent text nodes.
 * 追加节点签名，合并相邻的同构文本节点片段。
 */
function appendStructureSignature(target: string[], node: ProseMirrorNode): void {
    const signature = createNodeStructureSignature(node);
    if (node.isText && target[target.length - 1] === signature) return;
    target.push(signature);
}

/**
 * Stable signature of a mark set for structure comparison.
 * 用于结构比较的稳定标记集签名。
 */
function createMarksSignature(marks: readonly Mark[]): string {
    return marks.map((mark) => stableJson(mark.toJSON())).join('|');
}

/**
 * Depth-first visit over every node in a Fragment.
 * 深度优先遍历 Fragment 中的每个节点。
 */
function visitFragment(fragment: Fragment, visitor: (node: ProseMirrorNode) => void): void {
    fragment.forEach((node) => {
        visitor(node);
        if (!node.isText) visitFragment(node.content, visitor);
    });
}

/**
 * JSON stringify with sorted object keys so signatures compare deterministically.
 * 按键名排序的 JSON 序列化，使签名比较结果确定。
 */
function stableJson(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
