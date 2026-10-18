/**
 * Ambient typings for the turndown-plugin-gfm Markdown rules.
 * turndown-plugin-gfm Markdown 规则的环境类型声明。
 */
declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';

  /**
   * Registers all GFM conversion rules on a Turndown service.
   * 在 Turndown 服务上注册全部 GFM 转换规则。
   *
   * @param service - Turndown service instance / Turndown 服务实例
   * @returns Nothing / 无返回值
   */
  export function gfm(service: TurndownService): void;

  /**
   * Registers table conversion rules.
   * 注册表格转换规则。
   *
   * @param service - Turndown service instance / Turndown 服务实例
   * @returns Nothing / 无返回值
   */
  export function tables(service: TurndownService): void;

  /**
   * Registers strikethrough conversion rules.
   * 注册删除线转换规则。
   *
   * @param service - Turndown service instance / Turndown 服务实例
   * @returns Nothing / 无返回值
   */
  export function strikethrough(service: TurndownService): void;

  /**
   * Registers task-list item conversion rules.
   * 注册任务列表项转换规则。
   *
   * @param service - Turndown service instance / Turndown 服务实例
   * @returns Nothing / 无返回值
   */
  export function taskListItems(service: TurndownService): void;
}
