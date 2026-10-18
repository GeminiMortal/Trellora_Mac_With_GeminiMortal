/**
 * Ambient typings for the js-yaml YAML parser.
 * js-yaml YAML 解析器的环境类型声明。
 */
declare module 'js-yaml' {
  /**
   * Parses a YAML document into a JavaScript value.
   * 将 YAML 文档解析为 JavaScript 值。
   *
   * @param source - YAML source text / YAML 源文本
   * @returns Parsed value / 解析结果
   */
  export function load(source: string): unknown;

  /**
   * Serializes a value to a YAML string.
   * 将值序列化为 YAML 字符串。
   *
   * @param value - Value to serialize / 要序列化的值
   * @param options - Output options / 输出选项
   * @returns YAML text / YAML 文本
   */
  export function dump(value: unknown, options?: { lineWidth?: number; noRefs?: boolean }): string;
}
