# notice-hub → Trellora 扩展移植说明（迁移文档）

> 面向开发者与维护者：本移植的源码分析结论、功能映射表、未移植项与原因、技术适配决策、测试说明与发布材料。
> 接口契约见 [notice-hub 插件化与日程适配方案](notice-hub-插件化与日程适配方案.md)（已冻结，字段/通道以其为准）；最终用户使用手册见 [notice-hub 使用与维护](notice-hub-使用与维护.md)。

---

## 1. 移植概览

| 项 | 值 |
|---|---|
| 上游仓库 | <https://github.com/ExpertKT/notice-hub>（原名 qq-live-digest） |
| 上游基线 | commit `4668ccafb8a1b37783204e649b4091e3908b2550`（`docs(readme): 指向 beta.2`） |
| 移植产物 | Trellora 插件 `com.expertkt.notice-hub`（**独立仓库** [Trellora/NoticHubPlugin](https://github.com/Trellora/NoticHubPlugin)，本地 `~/Desktop/Trellora1/NoticHubPlugin/`）+ 宿主日程扩展点 + 日程 UI 适配 |
| 移植形态 | **V1 单向同步**：notice-hub 服务（用户自行安装运行）→ 插件拉取 → Trellora 日程库 |
| 许可证 | 双许可：上游 MIT（© wc985732-lang）+ 新增 PolyForm Noncommercial 1.0.0（ExpertKT）；三份原文随插件包逐字分发 |

**移植原则**：
1. 以真实源码为准——所有 API 形状、字段名、时间语义均取自上游 `webapp.py` / `ics.py` / `store.py`，不臆造；
2. 功能对等优先——核心能力（通知→待办→日历→提醒）必须等价落地，缺失项逐条说明原因；
3. 可验证可复现——每项映射都有对应断言（`scripts/verify/verify-notice-hub-plugin.mjs`），打包输出确定性 sha256；
4. 不改、不删上游许可证与署名（`LICENSE` / `LICENSE-UPSTREAM` / `NOTICE` 与上游 sha256 全同）。

---

## 2. 上游源码分析结论

### 2.1 技术栈与形态

- **Python 3.12+ 服务**（无 package.json），核心包 `qq_live_digest/`（27 个模块）+ `main.py` CLI（`run/tick/preview/stats/show/tasks/catchup/doctor/send-test/attach-test`）。
- 消息来源：NapCat OneBot v11（QQ 群）、钉钉、微信、学习通接收器；闲聊降噪 + 待确认收件箱。
- 存储：SQLite `tasks` 表（`task_key, summary, action, category, importance, deadline, groups(JSON), sender, evidence, status, done_at, dismissed_at, pinned, snooze_until, urgent_override, updated_at` …）。
- Web 待办台：`webapp.py` 手写 dispatch，默认端口 **8766**；鉴权 `X-Token` 头或 `?token=` 查询串，空 token 仅允许环回。
- 提取：LLM（可选，`QQ_DIGEST_LLM_API_KEY`）或本地规则摘要（`summarizer.py`）。
- 提醒推送：早 07:30「今天到期+逾期」、晚 21:00「明天到期」；通道含微信/钉钉/企微/飞书/QQ 私聊。
- 分发：Windows 出货包（PyInstaller）、安卓 App、iPhone/安卓日历订阅（`.ics`）。

### 2.2 与移植相关的 API 面（事实来源 `webapp.py` / `ics.py`）

| 端点 | 形状 | 移植用途 |
|---|---|---|
| `GET /api/tasks` | 分组任务（candidates/today/week/later/done/pinned + stats），条目含 `id, task_key, summary, action, category, importance, deadline, groups[], sender, evidence, status, done, pinned, snooze_until, effective_urgent, overdue, updated_at` | 待办/日程同步主数据源 |
| `GET /api/notices` | `{items:[{id,kind,created_at,summary,body}]}`（最近 8 条） | 公告→全天事件（默认关） |
| `GET /calendar.ics?token=…` | RFC 5545 子集；仅带 deadline 的任务；纯日期→全天、带时刻→PT1H 起点事件；`UID=task-{id}@qq-live-digest`；STATUS dismissed/expired→CANCELLED | JSON API 不可用时的兜底源 |
| `GET /api/inbox` | 待确认消息 | **V1 不移植**（非目标，避免打扰） |
| `POST /api/tasks/<id>` | `{"action":"confirm\|dismiss\|done\|reopen\|snooze"}` | **V1 不移植**（V1.1 双向回写路线图） |

---

## 3. 功能映射表（notice-hub → Trellora）

### 3.1 核心能力对等

| # | notice-hub 能力 | Trellora 落地 | 实现位置 | 状态 |
|---|---|---|---|---|
| 1 | 群通知提取为待办（含截止时间/优先级/来源群/原文） | 同步为 Trellora 待办+日程条目 | `plugins/notice-hub/lib/normalize.js`（契约 §5.1–5.4） | ✅ 对等（提取仍在服务侧） |
| 2 | 任务状态机（candidate/open/done/dismissed/expired） | `todoStatus`/`ScheduleItemStatus` 映射（契约 §5.3） | `lib/normalize.js` | ✅ 对等 |
| 3 | 待办分组（今天/本周/以后/已完成） | Trellora 待办面板分组（已过期/今天/本周/无截止） | `src/components/schedule/todos/TodoPanel.tsx` | ✅ 对等（分组语义由 Trellora 日程域提供） |
| 4 | 完成/忽略/置顶/稍后提醒 | 状态映射（done/dismissed→完成/取消）、`置顶`/`待确认` 标签、`snooze_until` 写入描述 | `lib/normalize.js` | ✅ 对等（V1 仅展示，回写见 3.3） |
| 5 | 月历 + `.ics` 日历订阅 | 日/周/月/年视图 + 提醒体系 | `src/components/schedule/**` | ✅ 对等（Trellora 原生日程视图替代 .ics 订阅） |
| 6 | 截止提醒（早 07:30 今天到期 / 晚 21:00 明天到期） | `reminderOffsetsMinutes`（默认 `[1440, 0]`=提前 1 天+到点）→ `ScheduleReminderService` | 契约 §5.2；`electron/schedule/scheduleReminderService.ts` | ✅ 语义对等（时间点由 Trellora 提醒引擎决定） |
| 7 | 紧急事项直达 / 优先级 | `priority` 映射（urgent/high/normal/low + 置顶升级，契约 §5.4） | `lib/normalize.js` | ✅ 对等 |
| 8 | 任务去重与恢复（`task_key`） | 外部 ID 幂等 upsert（`nh-task:<task_key>` → `schedule_external_items`） | `electron/schedule/scheduleService.ts` | ✅ 对等 |
| 9 | Web 待办台（网页） | Trellora 设置面板 + 日程界面 | `src/components/settings/NoticeHubSettings.tsx` 等 | ✅ 替代（桌面原生 UI） |
| 10 | 公告/提醒消息展示 | 公告→全天事件（`includeNotices`，默认关） | 契约 §5.5 | ✅ 对等（按配置） |
| 11 | 本地优先、数据不出本机 | 同步数据写入 `<workspace>/.menghan-meta/schedule/schedule.db`，不外传 | 宿主日程域 | ✅ 对等 |
| 12 | `.ics` 日历源（作为数据源） | ICS 兜底解析器（JSON API 不可用时） | `plugins/notice-hub/lib/ics.js` | ✅ 对等 |

### 3.2 模块级映射（上游模块 → 移植产物）

| 上游模块 | 职责 | 移植去向 |
|---|---|---|
| `qq_live_digest/receiver.py` 等接收器 | QQ/钉钉/微信/学习通消息接收 | **留在 notice-hub 服务**（契约非目标） |
| `qq_live_digest/summarizer.py`、`llm_json.py` | 闲聊降噪、通知/行动项/截止提取 | **留在 notice-hub 服务**（LLM 与规则引擎不迁移） |
| `qq_live_digest/store.py`（SQLite `tasks`） | 任务存储/去重 | 映射进 `schedule_external_items` + `schedule.db`（`electron/schedule/`） |
| `qq_live_digest/webapp.py`（`/api/tasks`、`/api/notices`） | 任务/公告只读 API | 插件 `lib/client.js` 消费 |
| `qq_live_digest/ics.py`（`/calendar.ics`） | ICS 生成 | 服务侧保留；插件 `lib/ics.js` 反向解析兜底 |
| `qq_live_digest/service.py`（07:30/21:00 提醒调度） | 截止提醒 | Trellora `ScheduleReminderService` 替代 |
| `qq_live_digest/push.py`（微信/钉钉/企微/飞书/QQ） | 推送通道 | **留在 notice-hub 服务**（Trellora 系统通知替代日程提醒） |
| `qq_live_digest/inbox.py`（待确认） | 收件箱 | **V1 不移植**（V1.1 路线图） |
| `qq_live_digest/attachments.py` 等 | 附件解析、原文回溯 | **留在 notice-hub 服务** |
| `qq_live_digest/napcat_admin.py`、`hosting.py`、`pairing.py`、`qr.py` | NapCat 管理、手机配对、公网 | **留在 notice-hub 服务**（平台专属） |
| `qq_live_digest/updater.py` | 自更新 | **不移植**（Trellora 有自身更新机制） |
| `packaging/launcher.py`、出货脚本 | Windows 出货包 | **不移植**（Trellora 插件 zip 打包替代，见 §6） |

### 3.3 未移植项与原因（缺口清单）

| 缺口 | 原因 | 归属 |
|---|---|---|
| 消息接收（NapCat/钉钉/微信/学习通） | 契约非目标：不复刻接收/提取/推送核心 | notice-hub 服务侧 |
| LLM/规则提取、降噪、待确认收件箱 | 同上；且收件箱进日程易打扰 | notice-hub 服务侧；收件箱列 V1.1 |
| 双向回写（Trellora 勾选完成→`POST /api/tasks/<id>`） | V1 非目标；防状态竞争需先定冲突策略 | 路线图 V1.1 |
| 微信/钉钉等推送通道 | Trellora 提醒走系统通知+应用内提醒 | 不适用 |
| 手机 App、扫码配对、公网/Tailscale 访问 | 平台专属；Trellora 是桌面应用 | 不适用 |
| 附件解析、原文页面回溯 | 依赖服务侧文件管线 | notice-hub 服务侧 |
| 自更新（正式/测试通道） | Trellora 有自身发布/更新体系 | 不适用 |
| 多来源过滤器（calendar list） | 需要日程域新增概念 | 路线图 V1.2 |
| `context.config` 正式化（manifest settings schema） | 插件 API `@experimental`，V1 用宿主设置面板+事件下发 | 路线图 V1.2 |

---

## 4. 技术适配决策

| 决策点 | 上游 | Trellora 适配 | 理由 |
|---|---|---|---|
| 运行形态 | 独立 Python 服务 + Web UI | Electron 主进程内插件（CommonJS `main.js`）+ 宿主日程域 | 插件体系 L0–L2 权限模型天然匹配「读本机服务+写日程」；无需 Python 侧改动 |
| 数据落库 | SQLite `tasks` 表 | `ScheduleService` + `schedule_external_items` 外部映射表（契约 §4.1） | 幂等 upsert、不触碰用户手建条目、本地完成态优先 |
| 时间语义 | wall-clock 文本（`YYYY-MM-DD HH:MM`） | `shared/schedule.ts` 约定的无时区本地时间（契约 §5.2） | 两者都是本地墙钟，无时区转换损失 |
| 提醒 | 服务侧固定 07:30/21:00 调度 | `reminderOffsetsMinutes`（默认 1440,0）→ 提醒引擎 | 语义对等（提前 1 天 + 到点），且不受服务停机影响 |
| 网络访问 | 本机服务 | `pluginContext.network.fetch` 环回放行（契约 §4.2：仅 127.0.0.0/8、::1、localhost、*.localhost 的 http + 公共 https） | 插件最小网络面；内网/公网 http 仍拒绝，重定向复检 |
| 鉴权凭据 | `QQ_DIGEST_WEB_TOKEN` | 插件配置 `token`，仅经 `X-Token` 头 | 不落日志/缓存/状态载荷（契约 §7） |
| 降级 | — | JSON 失败→ICS 兜底；网络失败→缓存降级不删数据 | 服务升级/停机时数据不丢 |
| ICS | 服务端生成 | 插件端解析 RFC 5545 子集（`lib/ics.js`） | 兜底通道复用上游既有产物 |

---

## 5. 移植产物目录结构

> 2026-10-21 起插件包已迁出 Trellora 仓库，独立分发于 <https://github.com/Trellora/NoticHubPlugin>
> （本地 `~/Desktop/Trellora1/NoticHubPlugin/`，仓库根即插件包）。下方为插件仓库结构 + Trellora 侧保留的宿主/UI 改动。

```text
NoticHubPlugin/                     # 插件仓库（仓库根即插件包，发布 zip 的内容）
├── plugin.json                     # 清单：id=com.expertkt.notice-hub，权限 ui:command/schedule:write/system:network/system:file
├── main.js                         # 激活/停活：命令、定时器、事件订阅、同步编排（串行互斥）
├── lib/
│   ├── client.js                   # HTTP 客户端：X-Token 注入、重试 3 次退避 2s/4s/8s、错误分类
│   ├── normalize.js                # 契约 §5 映射（纯函数）+ 本地完成态优先冲突规则
│   ├── ics.js                      # RFC 5545 子集解析（兜底）
│   ├── cache.js                    # storageDir 快照缓存（不含 token）
│   └── config.js                   # 默认配置 + host 下发合并、字段校验
├── LICENSE / LICENSE-UPSTREAM / NOTICE   # 上游逐字拷贝（sha256 一致，禁止修改）
├── README.md                       # 插件开发/安装说明 + 署名与许可
└── scripts/                        # 自校验与发布（独立自足）
    ├── verify-notice-hub-plugin.mjs   # 92 断言验证套件
    ├── package-plugin.mjs             # 确定性发布 zip + 合规门 → dist/
    ├── validate-plugin-manifest.mjs   # 清单校验器
    └── plugin.schema.json             # Trellora 插件清单 schema

electron/plugins/                   # 宿主插件系统（插件宿主、权限、上下文、日程扩展点）
electron/noticeHub/                 # 宿主桥接：配置持久化 userData/notice-hub.json、状态缓存、事件桥、IPC
electron/schedule/                  # schedule_external_items 外部映射表 + 幂等 upsert
shared/noticeHub.ts                 # 配置/状态共享类型 + 通道名常量（契约 §4.3/§4.4）
src/components/settings/NoticeHubSettings.tsx   # 设置面板「群务台」分组
src/components/schedule/NoticeHubSourceBadge.tsx # 来源徽标（复用 tags，零新数据通道）
```

Trellora 仓库侧保留：宿主插件系统（`electron/plugins/`）、宿主桥接（`electron/noticeHub/`）、共享类型（`shared/noticeHub.ts`）、日程 UI 适配与本套文档。

---

## 6. 构建、发布与更新策略

### 6.1 打包（发布材料）

```bash
# 在插件仓库（~/Desktop/Trellora1/NoticHubPlugin）执行：
node scripts/package-plugin.mjs
# → dist/notice-hub-<version>.zip（含 plugin.json/main.js/lib//LICENSE*//NOTICE/README）
# → dist/notice-hub-<version>.zip.sha256（校验清单）
```

- **确定性输出**：条目排序 + 固定时间戳，同一输入任何机器 sha256 相同，便于发布校验与复现。
- **合规门**（打包即校验，失败非零退出）：清单 schema 校验、许可证三件套齐备、README 含署名/许可/商用授权关键词。
- zip 结构：`plugin.json` 在顶层（插件安装器同时兼容唯一子目录形态）。

### 6.2 发布与安装

1. GitHub Release 附 `notice-hub-<version>.zip` + `.sha256`；
2. 用户在 Trellora「设置 → 插件管理」粘贴 Release URL 安装（或本地 zip）；
3. 安装时展示权限声明（L1 披露 + L2 显式授权）→ 激活 → 配置 → 同步。

### 6.3 更新策略

- **插件升级**：覆盖安装即升级（下载新版 zip → 解压校验 → 原子替换插件目录 → 重新加载）；配置 `notice-hub.json` 与同步映射保留，跨版本字段变化由 `lib/config.js` 合并默认值兜底。
- **版本兼容**：`plugin.json` 的 `engine.trellora` semver 区间控制宿主兼容窗口；插件 API `@experimental`，1.4.0 冻结前升级需读变更日志。
- **上游追踪**：上游 API 形态变化由字段级容错 + ICS 兜底吸收；升级上游服务后建议先「立即同步」验证（见使用与维护 §8）。

---

## 7. 测试说明

| 层 | 命令 | 覆盖 |
|---|---|---|
| 清单合规 | `node scripts/validate-plugin-manifest.mjs .`（插件仓库内运行） | plugin.json schema、权限枚举、入口路径 |
| 插件功能 | `node scripts/verify-notice-hub-plugin.mjs`（插件仓库内运行） | 归一化（§5.1–5.5 逐条）、ICS 解析（§5.6）、缓存（无 token 泄漏）、客户端（鉴权/重试/错误分类）、端到端 mock 服务（upsert/prune/冲突规则/降级/状态流） |
| 插件系统 | `pnpm run verify:plugin-system` | manifest/权限分层/生命周期/扩展点（含 `schedule:write`） |
| 类型/风格 | `pnpm exec tsc -b`、`pnpm lint` | IPC 类型面、渲染层与主进程编译 |
| 合规 | verify-notice-hub-plugin 内合规断言 | LICENSE/NOTICE 与上游 sha256 一致、README 署名关键词 |

**手动验收清单**（发布前）：
1. 安装 zip → L2 授权 → 配置 → 「立即同步」→ 状态「正常」、计数非零；
2. 日/周/月/年视图出现条目（分类「群务台」），TodoPanel 分组正确，来源徽标可见（含读屏标签）；
3. 提醒按「提前 1 天 + 到点」触发（系统通知 + 应用内）；
4. 断开 notice-hub 服务 → 状态报中文可操作错误、条目不丢；恢复后自动同步；
5. `pruneMissing` 开/关行为符合预期；本地完成后远端 open 不覆盖本地状态（计 skipped）；
6. 删除/编辑同步条目行为正常，用户手建日程不受影响；
7. token 场景：填错 → 401 中文报错；留空 + 环回 → 正常；日志与缓存中检索不到 token。

---

## 8. 许可证合规核验

| 文件 | 内容 | 校验 |
|---|---|---|
| `plugins/notice-hub/LICENSE` | PolyForm Noncommercial 1.0.0（ExpertKT 新增部分） | 与上游 sha256 全同（`c0ea4a89…`） |
| `plugins/notice-hub/LICENSE-UPSTREAM` | MIT（© wc985732-lang） | 与上游 sha256 全同（`55e19ce1…`） |
| `plugins/notice-hub/NOTICE` | 双许可声明 + `Required Notice:` 行 | 与上游 sha256 全同（`d057b0d3…`） |

- 三份文件**逐字拷贝**，任何移植改动不得触碰；
- 商用需事先书面授权（`jkl2755908073@qq.com`），README 与使用文档均有显著提示；
- Trellora 侧适配代码（宿主扩展、UI、验证脚本）独立声明，不修改、不放宽上游许可证。

---

## 9. 变更日志（本移植）

### 1.0.0 — notice-hub 插件首发

> 发布仓库：<https://github.com/Trellora/NoticHubPlugin>

- 新增插件 `com.expertkt.notice-hub`：任务/公告 → Trellora 日程单向同步（契约 §5 映射全量）。
- 新增宿主日程扩展点 `PluginScheduleApi`（L1 权限 `schedule:write`，外部 ID 幂等 upsert，不触碰用户手建条目）。
- 新增插件网络策略环回放行（仅 127.0.0.0/8、::1、localhost、*.localhost 的 http + 公共 https，重定向复检）。
- 新增设置面板「群务台」分组、来源徽标、状态条与中文可操作错误。
- 新增 `notice-hub:get-config/set-config/get-status/sync-now` IPC 与 `notice-hub:status-changed` 推送。
- 新增验证脚本 `verify-notice-hub-plugin.mjs` 与发布打包 `package-notice-hub-plugin.mjs`（确定性 zip + 合规门）。
- 许可证：三份上游文件逐字随包分发；商用需授权提示进入 README 与文档。
