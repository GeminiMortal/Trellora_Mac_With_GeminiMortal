/**
 * Release metadata shared by the About page and the main process.
 * 关于页与主进程共用的发布元数据。
 */

import { author, build, homepage, version } from '../package.json';

/**
 * Release metadata sourced from package.json, shared by the About page and the main process so development builds never fall back to the Electron version.
 * 来自 package.json 的发布元数据，由关于页与主进程共用，避免开发模式误用 Electron 的版本。
 */
export const APP_INFO = {
  /** Product display name. / 产品显示名称。 */
  name: build.productName,
  /** Application version. / 应用版本号。 */
  version,
  /** Package author. / 包作者。 */
  author,
  /** Repository homepage URL. / 仓库主页链接。 */
  repositoryUrl: homepage,
};
