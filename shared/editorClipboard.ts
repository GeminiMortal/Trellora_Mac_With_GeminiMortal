/**
 * Shared clipboard payload shape used when copying content out of the editor.
 * 从编辑器复制内容时使用的共享剪贴板负载结构。
 */

/**
 * Clipboard content with plain text, HTML, and an optional PNG image.
 * 包含纯文本、HTML 和可选 PNG 图片的剪贴板内容。
 */
export interface EditorClipboardContent {
  /** Plain-text representation of the copied content. / 所复制内容的纯文本表示。 */
  text: string;
  /** HTML representation preserving inline formatting. / 保留内联格式的 HTML 表示。 */
  html: string;
  /** Optional PNG bytes when an image is part of the copy. / 复制包含图片时的可选 PNG 字节。 */
  imagePng?: Uint8Array;
}
