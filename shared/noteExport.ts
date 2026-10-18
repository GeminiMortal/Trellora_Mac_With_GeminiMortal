/**
 * Shared request types for exporting the current note to file formats.
 * 将当前笔记导出为文件格式的共享请求类型。
 */

/**
 * Supported note export formats.
 * 受支持的笔记导出格式。
 */
export type NoteExportFormat = 'md' | 'html' | 'pdf';

/**
 * Request to export the current editor content.
 * 导出当前编辑内容的请求。
 */
export interface NoteExportRequest {
  /** Target export format. / 目标导出格式。 */
  format: NoteExportFormat;
  /** Suggested file name without extension. / 建议的文件名（不含扩展名）。 */
  defaultName: string;
  /** Editor content to export. / 要导出的编辑器内容。 */
  content: string;
  /**
   * Path of the original note; used only to protect that file and never written by the exporter.
   * 原笔记路径；仅用于保护原笔记，不由导出器写入。
   */
  sourcePath: string;
}
