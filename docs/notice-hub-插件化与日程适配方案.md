# notice-hub 插件化与日程适配方案（设计契约）

> 状态：已冻结（v1，实施基线）
> 唯一事实来源：<https://github.com/ExpertKT/notice-hub>（commit `4668ccafb8a1b37783204e649b4091e3908b2550`）
> 本文档是插件包、宿主扩展、UI 适配三线并行实施的**接口契约**。任何字段名、通道名、事件名的变更必须先改本文档再改代码。

---

## 1. 背景与目标

**notice-hub（群务台）**：从 QQ 群（及钉钉/微信/学习通）读取消息，过滤闲聊，提取通知、行动项与截止时间，生成待办与日历订阅（`.ics`）。Python 3.12+ 服务，Web 待办台默认端口 8766，数据默认仅存本机。

**目标**：把 notice-hub 封装为**可安装、可配置、可维护的 Trellora 插件**，并把其通知/待办/截止时间映射进 Trellora 日程界面（`src/components/schedule/`），使用户在 Trellora 日/周/月/年视图、待办面板与提醒体系中直接看到群通知衍生的日程。

**非目标（V1）**：
- 不改动、不复刻 notice-hub 的接收/提取/推送核心（NapCat 接入、LLM 提取、推送通道等仍在 notice-hub 服务内）。
- 不做双向回写（Trellora 内勾选完成 → 回写 notice-hub）；列入 V1.1 路线图。
- 不把 notice-hub 收件箱（待确认）导入日程（避免打扰）；列入 V1.1 路线图。

---

## 2. 仓库分析结论（依据真实代码）

### 2.1 notice-hub 侧

| 事实 | 证据 |
|---|---|
| Python 项目（无 package.json），核心包 `qq_live_digest/`（27 模块）+ `main.py` CLI | 仓库树 |
| 任务/待办存 SQLite `tasks` 表：`task_key, summary, action, category(urgent/action/academic/info), importance(1-5), deadline(ISO 文本), groups(JSON), sender, evidence, status(candidate/open/done/dismissed/expired), done_at, dismissed_at, pinned, snooze_until, urgent_override, updated_at…` | `qq_live_digest/store.py` SCHEMA |
| HTTP API（`webapp.py`，手写 dispatch）：`GET /api/tasks` 返回分组任务（candidates/today/week/later/done/pinned + stats），条目字段含 `id, task_key, summary, action, category, importance, deadline, groups[], sender, evidence, status, done, pinned, snooze_until, effective_urgent, overdue, updated_at…` | `webapp.py` L5332 |
| `GET /calendar.ics?token=<WEB_TOKEN>`：**仅带 deadline 的任务**生成 VEVENT；纯日期→全天、带时刻→起点事件（PT1H）；`UID=task-{id}@qq-live-digest`；`STATUS` dismissed/expired→CANCELLED，其余 CONFIRMED；无 VALARM | `qq_live_digest/ics.py` |
| `GET /api/notices` → `{items:[{id,kind,created_at,summary,body}]}`（最近 8 条摘要）；`GET /api/inbox` → 待确认消息 | `webapp.py` L5363 / L5184 |
| 鉴权：`X-Token` 请求头或 `?token=` 查询串（`hmac.compare_digest`）；**空 token 仅允许环回来源**；token 变量 `QQ_DIGEST_WEB_TOKEN` | `webapp.py` `_authorized` L4684 |
| 截止提醒语义：早 07:30 提醒「今天到期+逾期」，晚 21:00 提醒「明天到期」（≈提前 1 天） | `service.py` L535/L603 |
| 任务动作 API（V1.1 回写用）：`POST /api/tasks/<id>` body `{"action":"confirm|dismiss|done|reopen|snooze"}` | `webapp.py` L6168 |
| **许可证**：上游 wc985732-lang/qq-live-digest 部分 **MIT**（`LICENSE-UPSTREAM`）；ExpertKT 新增部分 **PolyForm Noncommercial 1.0.0**（`LICENSE`）；`NOTICE` 要求分发时附带条款与 `Required Notice:` 行；**商用需邮件授权** | `LICENSE`/`LICENSE-UPSTREAM`/`NOTICE` 原文 |

### 2.2 Trellora 侧

| 事实 | 证据 |
|---|---|
| 日程域完整：`shared/schedule.ts` 类型 + `electron/schedule/scheduleService.ts`（SQLite `<workspace>/.menghan-meta/schedule/schedule.db`）+ 渲染层 `src/components/schedule/`（日/周/月/年、TodoPanel、NotificationCenter、导入向导、提醒） | 见代码 |
| 写入走 `ScheduleService.createItem/updateItem/deleteItem` 会自动触发 `schedule:changed` → `ScheduleView` 自动刷新 | `electron/main.ts:5272` |
| 插件体系：`plugin.json` + `main.js`，L1 能力权限 + L2 系统权限（激活前用户显式授权）；host 与插件共享事件总线（进程内） | `electron/plugins/pluginHost.ts` |
| **现状缺口**：插件无写日程扩展点；`network.fetch` 仅放行公共 https（`parsePublicWebUrl` SSRF 守卫）；`context.config` 为空壳（返回 fallback） | `electron/plugins/pluginContext.ts` |
| 提醒语义：`fireAt = startMs − offsetMinutes×60000`（正偏移=提前），delivery ∈ system/in_app/both | `electron/schedule/scheduleReminderService.ts:78` |

---

## 3. 总体架构

```text
notice-hub 服务（http://127.0.0.1:8766，用户自行安装运行）
   │  GET /api/tasks、/api/notices、/calendar.ics（X-Token 鉴权）
   ▼
插件 com.expertkt.notice-hub（Electron 主进程内，plugins/notice-hub/）
   ├─ lib/client.js     HTTP 拉取（重试/退避/超时/token 注入，不出日志）
   ├─ lib/normalize.js  任务/公告 → 日程项（纯函数，见 §5 映射表）
   ├─ lib/ics.js        /calendar.ics 兜底解析（JSON API 不可用时）
   ├─ lib/cache.js      storageDir 快照缓存（断网降级、去重）
   ▼  context.schedule.upsertItems('notice-hub', items)   [L1 权限 schedule:write]
宿主扩展（electron/plugins/ + electron/schedule/）
   ├─ 外部 ID 映射表 schedule_external_items（幂等 upsert，不碰用户手建条目）
   └─ ScheduleService.createItem/updateItem → schedule.db → schedule:changed
   ▼
Trellora 日程界面（自动刷新，零额外刷新代码）
   ├─ 日/周/月/年视图：EventChip 来源徽标 + 分类「群务台」着色
   ├─ TodoPanel：待办分组（今天/本周/以后/无截止）+ 优先级
   └─ 提醒：按 reminderOffsetsMinutes（默认 提前1天 + 到点）触发
```

配置与状态流（事件总线 + IPC）：

```text
设置面板（渲染进程）
   │ notice-hub:set-config / get-config / get-status / sync-now   [IPC]
   ▼
Electron 主进程（配置持久化 userData/notice-hub.json + 状态缓存）
   │ events.emit('host:notice-hub:config' / 'host:notice-hub:sync-now')  [插件总线]
   ▼
插件 ──events.emit('plugin:notice-hub:status')──▶ 主进程 ──'notice-hub:status-changed'──▶ 渲染进程
```

---

## 4. 接口契约（冻结）

### 4.1 插件日程扩展点（新增，L1 权限 `schedule:write`）

`electron/plugins/pluginTypes.ts` 与 `plugins/sdk/trellora-plugin-sdk.d.ts` 同步新增：

```ts
/** 外部数据源日程项：ScheduleCreateRequest + 外部稳定 ID */
export interface PluginScheduleUpsertItem extends ScheduleCreateRequest {
  externalId: string;               // 插件内稳定 ID，如 "nh-task:manual:ab12"
}

export interface PluginScheduleApi {
  /** 幂等 upsert：按 (source, externalId) 映射到已有条目则更新，否则新建。 */
  upsertItems(source: string, items: PluginScheduleUpsertItem[]): Promise<{ upsertedIds: string[] }>;
  /** 删除本 source 下指定 externalId 的条目及其映射。 */
  removeItems(source: string, externalIds: string[]): Promise<{ removedIds: string[] }>;
  /** 列出本 source 的映射（供增量/裁剪决策）。 */
  listSource(source: string): Promise<Array<{ externalId: string; itemId: string; updatedAt: string }>>;
}
```

- `PluginContext` 增加 `readonly schedule: PluginScheduleApi`。
- 权限枚举新增 `'schedule:write'`（L1）：同步修改 `pluginTypes.ts` L1_PERMISSIONS、`plugins/sdk/plugin.schema.json` permissions enum、SDK `.d.ts`。
- 守卫：调用前 `guard('schedule:write')`；插件**不得**直接访问 SQLite。
- 持久化：新增表 `schedule_external_items(source TEXT NOT NULL, external_id TEXT NOT NULL, item_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(source, external_id))`，迁移进 `electron/schedule/scheduleDatabase.ts`。
- 语义约束：
  - `upsertItems` 只写映射表内的条目或新建映射，**绝不触碰无映射的用户条目**；
  - 更新时沿用 `ScheduleService.updateItem`（patch 语义），`todoStatus` 冲突时**以本地用户操作优先**（见 §5.4）；
  - 单次调用上限 500 条，超限抛错；所有字符串字段做长度截断（title≤200、description≤4000）；
  - 每次写入后由 ScheduleService 自动触发 `schedule:changed`（reason:'item'）。

### 4.2 网络策略调整（`pluginContext.network.fetch`）

现行为：仅公共 https（SSRF 守卫拦回环/内网）。调整为：

```text
允许：https://<公共域名/IP>（原行为不变）
新增：http(s)://127.0.0.0/8、http(s)://[::1]、http(s)://localhost、http(s)://*.localhost（仅环回）
拒绝：其余一切（内网段 10/172.16/192.168、链路本地、ULA、带凭据 URL、非法 IP）
```

- 实现：新增 `parsePluginServiceUrl(value)`（或扩展 `parsePublicWebUrl` 加显式 `allowLoopback` 选项），回环判定复用 `isBlockedHost` 的否定逻辑，**黑名单继续生效**。
- 重定向：`redirect: 'manual'` 不跟随；或跟随后**复检 `response.url`** 仍须落在允许集合内，否则抛错（防回环→内网跳转）。
- 超时维持 10s（可由调用方传 `AbortSignal` 覆盖）。
- 风险与缓解见 §7。

### 4.3 配置 / 状态 IPC（渲染进程 ↔ 主进程）

新增共享类型文件 `shared/noticeHub.ts`：

```ts
export interface NoticeHubConfig {
  enabled: boolean;                    // 默认 false：装完先配置再启用
  baseUrl: string;                     // 默认 "http://127.0.0.1:8766"（仅环回/https）
  token: string;                       // QQ_DIGEST_WEB_TOKEN；可空（空 token 仅环回可用）
  syncIntervalMinutes: number;         // 5–240，默认 15
  includeTodos: boolean;               // 默认 true
  includeNotices: boolean;             // 默认 false（公告进日历易打扰，默认关）
  pruneMissing: boolean;               // 默认 false（远端消失的条目不自动清理）
  categoryName: string;                // 默认 "群务台"
  reminderOffsetsMinutes: number[];    // 默认 [1440, 0]（提前 1 天 + 到点）
}

export interface NoticeHubStatus {
  state: 'disabled' | 'idle' | 'syncing' | 'ok' | 'error';
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;            // 面向用户的中文可操作错误
  counts: { todos: number; notices: number; skipped: number };
  serviceReachable: boolean | null;
  nextSyncAt: string | null;
}
```

IPC 通道（`electron/preload.ts` + `src/electron.d.ts` 声明，`window.electronAPI.noticeHub.*`）：

| 通道 | 方向 | 载荷/返回 |
|---|---|---|
| `notice-hub:get-config` | invoke | → `NoticeHubConfig` |
| `notice-hub:set-config` | invoke | `Partial<NoticeHubConfig>` → `NoticeHubConfig`（校验后持久化 `userData/notice-hub.json`） |
| `notice-hub:get-status` | invoke | → `NoticeHubStatus` |
| `notice-hub:sync-now` | invoke | → `{ ok: true }`（经总线请求插件立即同步） |
| `notice-hub:status-changed` | push（主→渲） | `NoticeHubStatus` |

### 4.4 事件总线消息（host ⇄ plugin）

| 事件 | 方向 | 载荷 | 时机 |
|---|---|---|---|
| `host:notice-hub:config` | host → plugin | `NoticeHubConfig` | 插件激活完成后立即发一次；每次 set-config 后再发 |
| `host:notice-hub:sync-now` | host → plugin | `null` | 用户点「立即同步」 |
| `plugin:notice-hub:status` | plugin → host | `NoticeHubStatus` | 每次同步开始/结束/失败后 |

### 4.5 插件 UI 命令

| 命令 ID | 标题 | 行为 |
|---|---|---|
| `notice-hub:sync-now` | 同步群务台 | 立即执行一次同步（失败不弹异常，状态进 NoticeHubStatus） |
| `notice-hub:reset-cache` | 重置群务台缓存 | 清 storageDir 缓存后全量重同步 |

（`plugin.json` 的 `contributes.uiCommands` 与运行时注册保持一致。）

---

## 5. 数据映射表（notice-hub → Trellora ScheduleItem，冻结）

### 5.1 任务（`GET /api/tasks` 条目）→ `PluginScheduleUpsertItem`

| notice-hub 字段 | Trellora 字段 | 规则 |
|---|---|---|
| `task_key`（缺省用 `id`） | `externalId` | `"nh-task:" + task_key`（稳定、幂等） |
| `summary` | `title` | 截断 200 字符 |
| `action` + `evidence` + `groups[]` + `sender` + `snooze_until` | `description` | 多行文本：`行动：…\n来源群：…\n发送者：…\n原文：…\n稍后提醒至：…`（空字段省略） |
| `deadline`（"YYYY-MM-DD HH:MM" 或 "YYYY-MM-DD"） | `kind='todo'`，见 5.2 | 无 deadline → 全部时间字段 null |
| `status` | `todoStatus` / `status` | 见 5.3 |
| `category` + `effective_urgent`/`urgent_override` + `importance` | `priority` | 见 5.4 |
| `groups[]`（群名） | `tags` | 追加每个群名 |
| 固定 | `tags` | 追加 `"notice-hub"`；`status==='candidate'` 追加 `"待确认"`；`pinned` 追加 `"置顶"` |
| 固定 | `category` | `config.categoryName`（默认「群务台」；宿主首次同步时 upsert 分类 + 默认色 `#0F766E`） |
| `done_at` | `completedAt` | 仅 `status==='done'` 时 |
| — | `color`/`recurrence`/`course`/`libraryPath`/`notePath` | `null` / `[]` |

### 5.2 时间映射（wall-clock 约定与 `shared/schedule.ts` 一致：无时区本地时间）

| deadline 形态 | startAt | endAt | allDay | dueAt |
|---|---|---|---|---|
| 带时刻（"YYYY-MM-DD HH:MM"） | `YYYY-MM-DDTHH:mm:ss`（秒补 :00） | 起点 +1 小时（对齐 ICS `DURATION:PT1H`） | false | 同 startAt |
| 纯日期（"YYYY-MM-DD"） | `YYYY-MM-DD` | —（全天） | true | `YYYY-MM-DD` |
| 无 | null | null | false | null |

提醒：`config.reminderOffsetsMinutes`（默认 `[1440, 0]` = 提前 1 天 + 到点，对齐 notice-hub「晚 21:00 提醒明天到期 / 早 07:30 提醒今天到期」的语义）→ `reminders: [{ offsetMinutes, delivery: 'both', enabled: true }]`，**仅对有 deadline 的条目**生成。

### 5.3 状态映射

| notice-hub `status` | `todoStatus` | `ScheduleItemStatus` |
|---|---|---|
| `open` | `pending` | `confirmed` |
| `candidate` | `pending` | `tentative` |
| `done` | `done` | `confirmed` |
| `dismissed` / `expired` | `cancelled` | `cancelled` |

### 5.4 优先级映射与冲突规则

| 条件 | `priority` |
|---|---|
| `effective_urgent` 为真（含 `urgent_override`）或 `category==='urgent'` | `urgent` |
| `category==='action'` | `high` |
| `category==='academic'` | `normal` |
| `category==='info'` | `low` |
| `pinned` 且上述低于 `high` | 升为 `high` |

**冲突规则（防回写覆盖用户操作）**：同步更新已有条目时，若本地 `todoStatus ∈ {done, cancelled}` 而远端仍为 open/candidate，**跳过该条目的状态字段**（其余字段照常更新）并在 `counts.skipped` 计数；远端状态变化（done/dismissed）正常写入。

### 5.5 公告（`GET /api/notices`，`includeNotices=true` 时）→ `PluginScheduleUpsertItem`

| notice-hub | Trellora |
|---|---|
| `id` | `externalId: "nh-notice:" + id` |
| `summary` | `title`（前缀「公告 · 」） |
| `body` | `description` |
| `created_at` 日期部分 | `kind='event'`、`allDay=true`、`startAt=YYYY-MM-DD` |
| 固定 | `tags: ["notice-hub","公告"]`、`category: config.categoryName`、`status:'confirmed'` |

### 5.6 ICS 兜底解析（`/calendar.ics`，仅当 `/api/tasks` 不可用时）

解析 RFC 5545 子集：行折叠还原、`BEGIN:VEVENT`…`END:VEVENT`、`UID/SUMMARY/DESCRIPTION/DTSTART/DTEND/DURATION/STATUS`（含 `;VALUE=DATE`、`;TZID=Asia/Shanghai` 参数形态）；`UID` 去前缀 `task-`、去后缀 `@qq-live-digest` 作为 `externalId` 的 `id` 部分（`"nh-task:" + id`）。映射同 §5.1–5.4（ICS 无 category/importance → priority=normal；STATUS:CANCELLED → todoStatus='cancelled'）。解析失败的事件跳过并计数，不中断整体同步。

---

## 6. 插件包设计（`plugins/notice-hub/`）

```text
plugins/notice-hub/
├── plugin.json            # 清单（见下）
├── main.js                # activate/deactivate：命令、定时器、事件订阅、同步编排
├── lib/
│   ├── client.js          # notice-hub HTTP 客户端（token 注入 X-Token、重试 3 次退避 2s/4s/8s、错误分类）
│   ├── normalize.js       # §5 映射（纯函数：task→item、notice→item、状态/优先级/时间）
│   ├── ics.js             # §5.6 兜底解析（纯函数）
│   ├── cache.js           # storageDir/notice-hub-cache.json 快照缓存（files API，system:file）
│   └── config.js          # 默认值 + host 下发配置合并、字段校验
├── LICENSE                # 原仓库逐字拷贝（PolyForm Noncommercial 1.0.0）— 不得修改
├── LICENSE-UPSTREAM       # 原仓库逐字拷贝（MIT, wc985732-lang）— 不得修改
├── NOTICE                 # 原仓库逐字拷贝 — 不得修改
└── README.md              # 安装/配置/使用/排障/署名与许可说明
```

`plugin.json`（要点）：

```json
{
  "id": "com.expertkt.notice-hub",
  "name": "群务台 · notice-hub 同步",
  "version": "1.0.0",
  "description": "把 notice-hub（群务台）的通知、待办与截止时间同步进 Trellora 日程。",
  "author": "ExpertKT（notice-hub 原作者）／Trellora 插件化适配",
  "license": "SEE LICENSE (PolyForm-Noncommercial-1.0.0 AND MIT)",
  "main": "main.js",
  "engine": { "trellora": ">=1.3.0" },
  "permissions": ["ui:command", "schedule:write", "system:network", "system:file"],
  "activation": ["onStartup"],
  "contributes": { "uiCommands": [
    { "id": "notice-hub:sync-now", "title": "同步群务台", "panel": "sidebar" },
    { "id": "notice-hub:reset-cache", "title": "重置群务台缓存", "panel": "sidebar" }
  ] }
}
```

行为要求：
- **激活**：读缓存与配置（默认配置 + `host:notice-hub:config`）→ 注册命令 → 按 `syncIntervalMinutes` 起定时器（`unref` 语义等价处理，`deactivate` 必须清理）。
- **同步**：串行互斥（同步中再触发则合并排队）；拉 `/api/tasks`（+ 可选 `/api/notices`）→ 归一化 → `schedule.upsertItems` →（`pruneMissing` 时）`listSource` 对比后 `removeItems` → 写缓存 → `plugin:notice-hub:status`。
- **降级**：网络失败→沿用缓存数据不删条目，state='error'，错误文案中文可操作（如「无法连接群务台（http://127.0.0.1:8766）：请确认群务台已启动」）；JSON 解析失败→尝试 ICS 兜底；两者都失败→报错不写库。
- **安全**：token 只经 `X-Token` 头传输，**禁止**写入日志、缓存文件、状态载荷；缓存文件不含 token。

---

## 7. 权限、安全与风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| 网络策略放宽（回环 http） | 插件可访问本机 http 服务，理论上可触达本机其他服务 | 仅环回地址；内网/公网 IP 的 http 仍拒绝；重定向后复检；10s 超时；`system:network` L2 用户显式授权 |
| Token 泄漏 | `QQ_DIGEST_WEB_TOKEN` 是订阅凭据 | 仅 `X-Token` 头；不落日志/缓存/状态；设置面板用 password 输入框 |
| 日程写入污染 | 插件写入可能覆盖用户手建日程 | 外部 ID 映射表隔离；只动自有条目；本地完成态优先（§5.4）；`removeItems` 只删映射条目 |
| 许可证合规 | PolyForm Noncommercial **禁止商用**；MIT 部分须保留版权声明 | 三份许可证原文随插件分发（已逐字拷贝）；README 与文档显著提示商用需授权（`jkl2755908073@qq.com`）；本插件适配代码独立声明，不修改原许可证 |
| 频率限制/打扰 | 轮询过密或公告进日历造成噪音 | 默认 15 分钟；`includeNotices` 默认关；`pruneMissing` 默认关 |
| notice-hub API 变更 | 原仓库演进导致字段变化 | 字段级容错（缺字段不崩溃、计 skipped）；ICS 兜底；版本探测失败给可操作错误 |
| 服务不可用 | 群务台未启动/未登录 | 缓存降级不删数据；错误文案直达修复动作；`serviceReachable` 状态展示 |
| 隐私 | 群消息内容进入日程库 | 数据仅存本机（`<workspace>/.menghan-meta/schedule/schedule.db`）；不外传；文档明示 |

---

## 8. 日程界面适配（UI）

1. **设置面板**（`src/components/settings/`）新增「群务台（notice-hub）」分组：
   - 连接：`enabled` 开关、`baseUrl`、`token`（password 型）、「立即同步」按钮；
   - 同步：`syncIntervalMinutes`、`includeTodos`、`includeNotices`、`pruneMissing`、`categoryName`、`reminderOffsetsMinutes`（简化为「提前 1 天 + 到点」开关或逗号分隔输入）；
   - 状态条：`state` 徽标、`lastSyncAt`、`counts`、`lastError`（红字 + 可操作提示）；
   - 说明文案：数据流向（仅本机）、权限说明、许可证提示。
2. **来源辨识**（零新增数据通道，复用 category/tags）：
   - `EventChip` / 待办行：`tags` 含 `"notice-hub"` 的条目显示小型来源徽标（铃铛/群图标，`title` 提示来源群），样式进 `src/styles/schedule.css`，沿用 design-system 变量；
   - 分类「群务台」默认色 `#0F766E`（宿主 upsert），侧栏分类筛选天然可分组。
3. **主题/响应式/无障碍**：跟随现有深浅主题变量；窄屏布局不破版；徽标加 `aria-label="来源：群务台"`。
4. **不改动**：日程增删改、导入、提醒等既有行为一律不动；notice-hub 条目可被用户正常编辑/删除（删除后下次同步 `pruneMissing=false` 不会重建，除非远端再次变化——映射表已删则重建，属预期）。

---

## 9. 实施分工（写入范围互斥）

| 线 | 负责范围（独占写） | 依赖 |
|---|---|---|
| 宿主扩展 | `electron/**`、`shared/noticeHub.ts`、`shared/schedule.ts`（如需类型补充）、`plugins/sdk/**`、`plugins/README.md`、`scripts/verify/verify-plugin-system.mjs`（补断言） | 本文档契约 |
| 插件包 | `plugins/notice-hub/**`（`LICENSE*`/`NOTICE` 只读保留）、`scripts/verify/verify-notice-hub-plugin.mjs` | 本文档契约 |
| UI 适配 | `src/components/**`、`src/styles/**`、`docs/notice-hub-使用与维护.md` | 本文档契约（IPC 形状） |
| 集成（Lead） | `package.json` scripts、全量测试、终审 diff、验收报告 | 三线完成 |

## 10. 测试与验收

1. `node scripts/validate-plugin-manifest.mjs plugins/notice-hub` → VALID。
2. `node scripts/verify/verify-notice-hub-plugin.mjs` → 归一化/ICS 解析/缓存/端到端（mock notice-hub 服务）全绿。
3. `pnpm run verify:plugin-system`（含新 `schedule:write` 扩展点断言）全绿。
4. `pnpm exec tsc -b`、`pnpm lint` 通过。
5. 手动验收：安装插件 → L2 授权 → 配置 → 同步 → 日/周/月/年视图出现条目、TodoPanel 分组正确、提醒按提前量触发、断网降级、`pruneMissing`、分类筛选、来源徽标、删除/编辑行为。
6. 合规核验：`plugins/notice-hub/` 内 `LICENSE`/`LICENSE-UPSTREAM`/`NOTICE` 与上游逐字一致（sha256 比对），README 含署名与商用授权提示。

## 11. 路线图（非 V1 承诺）

- V1.1：双向回写（Trellora 勾选完成 → `POST /api/tasks/<id>` `done/reopen`，opt-in）；
- V1.1：收件箱（待确认）侧栏面板（需新增宿主插件渲染通道）；
- V1.2：`context.config` 正式化（manifest `settings` schema + 用户覆盖）；
- V1.2：日历多来源过滤器（calendar list 概念）。
