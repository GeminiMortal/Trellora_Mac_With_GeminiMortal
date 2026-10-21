# notice-hub → Trellora 扩展移植验收报告

> 验收对象：插件 `com.expertkt.notice-hub` v1.0.0（`plugins/notice-hub/`）+ 宿主扩展（日程扩展点、网络策略、配置/状态桥）+ 日程 UI 适配。
> 基线：上游 <https://github.com/ExpertKT/notice-hub> commit `4668ccafb8a1b37783204e649b4091e3908b2550`；冻结契约 `docs/notice-hub-插件化与日程适配方案.md`。
> 验收执行：2026-10-21，仓库 `~/Desktop/Trellora1/trellora`（经用户确认的工作位置）。
> **验收后变更（2026-10-21）**：插件包连同验证/打包脚本迁至独立仓库 [Trellora/NoticHubPlugin](https://github.com/Trellora/NoticHubPlugin)（本地 `~/Desktop/Trellora1/NoticHubPlugin/`），迁移后在新仓库复跑验证套件 **92 断言全绿**、清单 VALID、确定性打包通过（sha256 `572415b0…59d679`）。

---

## 1. 自动化验证结果（全部通过）

| # | 验证项 | 命令 | 结果 |
|---|---|---|---|
| 1 | 插件清单合规 | `pnpm run audit:plugin`（hello-command + notice-hub） | ✅ 两份 VALID |
| 2 | 插件系统（manifest/权限分层/生命周期/扩展点含 `schedule:write`） | `node scripts/verify/verify-plugin-system.mjs` | ✅ ALL PASS |
| 3 | 插件功能套件（归一化 §5.1–5.5 / ICS §5.6 / 缓存 / 客户端 / e2e 场景 A–G / 令牌安全 / 合规） | 插件仓库 `node scripts/verify-notice-hub-plugin.mjs` | ✅ **92 通过，0 失败**（迁移前后各跑一次） |
| 4 | TypeScript 构建（IPC 类型面、渲染层、共享类型） | `tsc -b` | ✅ exit 0 |
| 5 | 全量 lint | `eslint .` | ✅ 0 错误 |
| 6 | IPC 发送方门禁覆盖 | `node scripts/audit-ipc-coverage.mjs` | ✅ PASS |
| 7 | 发布打包（确定性 zip + 合规门） | 插件仓库 `node scripts/package-plugin.mjs` | ✅ `dist/notice-hub-1.0.0.zip`（sha256 `572415b0…59d679`，两次构建一致；迁移前 monorepo 版 `847def07…`） |
| 8 | 宿主桥自测（子代理 A，配置校验/事件流/令牌掩码） | `/tmp/nh-selftest.ts`（21 断言） | ✅ 全绿 |

**e2e 覆盖要点**（mock 群务台服务 + fake 宿主 + 真实 `main.js`）：状态流 syncing→ok；§5 映射字段抽查；§5.4 冲突规则（本地 done 不被远端覆盖、`counts.skipped` 计数）；pruneMissing 开/关；`/api/tasks` 不可用→ICS 兜底（`nh-task:<UID>`）；JSON+ICS 全挂→报错不写库；服务不可达→中文可操作错误+缓存降级不删条目；620 条按 500 上限分批（500+120）；同步串行互斥；UI 命令注册与 reset-cache；**令牌安全总检**（全部日志/状态载荷/缓存文件不含 token）。

## 2. 契约逐条对照（摘要）

- **§4.1 日程扩展点**：`PluginScheduleApi`（`upsertItems`/`removeItems`/`listSource`）+ L1 权限 `schedule:write`（pluginTypes/SDK d.ts/JSON schema 三处同步）；`schedule_external_items` 映射表幂等 upsert；500/批上限；title≤200、description≤4000；本地完成态优先由宿主权威实现并回报 `skipped`；无映射的用户条目绝不触碰。✅
- **§4.2 网络策略**：`parsePluginServiceUrl` 放行公共 https + 环回 http（127.0.0.0/8、::1、localhost、*.localhost），内网/链路本地/凭据 URL 拒绝；`redirect: 'manual'` 不跟随（杜绝环回→内网跳转）；10s 超时。✅
- **§4.3 配置/状态 IPC**：4 个 invoke 通道 + `notice-hub:status-changed` 全窗口推送；配置持久化 `userData/notice-hub.json`（原子写入）；调用面与 `NoticeHubSettings.tsx` 一致。✅
- **§4.4 事件总线**：`host:notice-hub:config`（激活完成四触发器幂等 + set-config 后补发）、`host:notice-hub:sync-now`（载荷恒 null）、`plugin:notice-hub:status`（净化→缓存→转发）。✅
- **§5 数据映射**：92 断言逐条覆盖 5.1–5.6。✅
- **§7 安全**：令牌仅 `X-Token` 头；不落日志/缓存/状态；设置面板密码框。✅

## 3. 本次移植修复的缺陷

| 缺陷 | 影响 | 修复 |
|---|---|---|
| `appLogger.info/.error` 方法不存在（仓库既有 bug） | 插件首次打日志即抛 TypeError，notice-hub 插件激活必失败 | main.ts 改用 `logToWindow`（净减 2 错误、0 新增） |
| 插件 `counts.skipped` 丢弃宿主回报的冲突跳过数 | 状态条「跳过」计数漏记（契约 §5.4 计数不完整） | `main.js` 以宿主 `skipped` 为权威聚合，无回报时回退插件侧计数 |
| `NoticeHubSettings.tsx` 重复定义同步间隔常量 | lint 报错（未使用导入） | 改用 `shared/noticeHub.ts` 契约常量（单一事实源） |
| `pluginContext.ts` 未实现 `context.schedule`、网络未放行环回 | 插件同步必抛错、无法访问本机群务台 | 实现 schedule 子 API（`guard('schedule:write')`）+ `parsePluginServiceUrl` 环回放行 + `redirect:'manual'` |

## 4. 偏离与裁量记录（均不改契约通道名/载荷形状）

1. **令牌密文落盘**：`notice-hub.json` 位置不变，`token` 字段以 `enc:v1:` + safeStorage 加密；加密不可用拒存、解密失败回退空令牌。对齐仓库密钥惯例（AGENTS.md），文档已注明。
2. `baseUrl` 在 `parsePluginServiceUrl` 之外额外拒绝查询串/片段/内嵌凭据（防令牌拼进 URL）。
3. `reminderOffsetsMinutes` 钳制 [0,43200]、去重、>8 截断；`syncIntervalMinutes` 夹取 5–240；token/categoryName 超长拒绝而非截断；布尔白名单强转。
4. `PluginScheduleApi.upsertItems` 返回值增加 `skipped?: number` 附加字段（契约原文只列 `upsertedIds`），供 §5.4 计数聚合；SDK 类型已同步注释。

## 5. 发布物与合规

| 产物 | 位置 | 说明 |
|---|---|---|
| 插件安装包 | 插件仓库 `dist/notice-hub-1.0.0.zip`（GitHub Releases 发布物） | plugin.json + main.js + lib/×5 + LICENSE + LICENSE-UPSTREAM + NOTICE + README；确定性构建 |
| 校验清单 | `dist/notice-hub-1.0.0.zip.sha256` | `572415b0…59d679` |
| 许可证三件套 | 插件包内逐字拷贝 | 与上游 sha256 全同（verify 套件自动断言）；MIT（wc985732-lang）+ PolyForm Noncommercial 1.0.0（ExpertKT）；商用需授权 `jkl2755908073@qq.com` |

## 6. 手动验收清单（需桌面环境 + 运行中的群务台，发布前由人工执行）

1. 安装 zip → L2 授权（system:network / system:file）→ 配置 → 「立即同步」→ 状态「正常」、计数非零；
2. 日/周/月/年视图出现条目（分类「群务台」#0F766E），TodoPanel 分组正确，来源徽标可见（`aria-label="来源：群务台"`）；
3. 提醒按「提前 1 天 + 到点」触发（系统通知 + 应用内）；
4. 断开群务台 → 中文可操作错误、条目不丢；恢复后自动同步；
5. `pruneMissing` 开/关行为；本地完成后远端 open 不覆盖（计 skipped）；
6. 填错令牌 → 401 中文报错；留空 + 环回 → 正常；日志/缓存中检索不到令牌明文。

## 7. 遗留（非 V1 承诺，见契约 §11 路线图）

- V1.1：双向回写（`POST /api/tasks/<id>`）、收件箱（待确认）侧栏面板；
- V1.2：`context.config` 正式化、日历多来源过滤器；
- 仓库既有欠账：`electron/` 目录不在 `tsc -b` 覆盖内（esbuild 打包），500+ 既有类型告警未清（与本移植无关，本次净减 2）。
