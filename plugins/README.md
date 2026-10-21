# Trellora 插件开发指南

> 状态：`@experimental` —— 插件 API 在 1.4.0 冻结前可能变更。

## 1. 概述

Trellora 插件系统允许第三方扩展四大领域：

| 领域 | 扩展点 | 权限 |
|---|---|---|
| 文档导入/解析 | `pipeline.registerParsingRoute` | `pipeline:parse` |
| AI/LLM | `ai.registerProvider` | `ai:provider` |
| UI 命令/侧边栏按钮 | `ui.registerCommand` | `ui:command` |
| 数据源/检索 | `data.registerDataSource` | `data:source` |

## 2. 目录结构

```
my-plugin/
├── plugin.json       # 插件清单（必须）
├── main.js           # 入口模块（plugin.json 的 main 字段指向）
└── assets/           # 可选资源
```

## 3. plugin.json 清单

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does",
  "main": "main.js",
  "engine": { "trellora": ">=1.3.0" },
  "permissions": ["ui:command"],
  "activation": ["onStartup"],
  "contributes": {
    "uiCommands": [
      { "id": "my-plugin:hello", "title": "Hello", "panel": "sidebar" }
    ]
  }
}
```

**字段说明**：
- `id`：反向 DNS 唯一标识（如 `com.example.my-plugin`）
- `engine.trellora`：兼容的 Trellora 版本范围（semver range）
- `permissions`：所需权限，L2 权限（`system:*`）需要用户显式授权
- `activation`：激活时机（`onStartup` / `onParseRequest` / `onAiRequest` / `onUiCommand` / `*`）
- `contributes`：静态贡献声明（可选，与运行时注册互相印证）

完整 schema 见 [`sdk/plugin.schema.json`](sdk/plugin.schema.json)。

## 4. 入口模块

```javascript
// main.js
module.exports = {
  activate(context) {
    const { manifest, log, config, events, ui, pipeline, ai, data } = context;

    log.info(`activating ${manifest.id}`);

    // L1: 注册 UI 命令（需要 ui:command 权限）
    ui.registerCommand({
      id: 'my-plugin:hello',
      title: 'Hello',
      panel: 'sidebar',
      execute: (args) => {
        log.info(`Hello invoked via ${args.trigger}`);
      },
    });

    // L0: 事件总线
    events.on('host:parse-request', (payload) => {
      log.info('parse requested', payload);
    });
  },

  deactivate() {
    // 可选：清理资源（宿主会自动注销已注册的贡献点）
  },
};
```

TypeScript 用户可引入 SDK 类型：

```typescript
import type { TrelloraPlugin, PluginContext } from '../../plugins/sdk/trellora-plugin-sdk';

const plugin: TrelloraPlugin = {
  activate(context: PluginContext) {
    // ...
  },
};
export default plugin;
```

## 5. 权限模型

| 层级 | 权限 | 授权方式 |
|---|---|---|
| L0 核心 | — | 无需授权（`log` / `config` / `events`） |
| L1 能力 | `pipeline:parse` / `ai:provider` / `ui:command` / `data:source` | Manifest 声明，安装时可见 |
| L2 系统 | `system:file` / `system:network` / `system:subprocess` | 显式授权对话框 + 运行时拦截 |

**未授权调用会抛 `PluginPermissionDeniedError`。**

## 6. 安装与分发

### 从 GitHub 安装
1. 插件作者在 GitHub 仓库发布 `plugin.zip`（含 `plugin.json` + `main.js`）
2. Trellora 设置 → 插件 → **安装**
3. 输入 GitHub release URL 或拖入 `.zip`
4. 阅读权限声明 → 确认 → 自动激活

### 本地开发
将插件目录放入 `~/.trellora/plugins/<id>/`，重启 Trellora 或在插件管理中点击刷新。

## 7. 生命周期

```
安装 → 权限确认 → 注册 → 激活 → 运行 → 禁用/启用 → 升级 → 卸载
```

- **禁用/启用**：热切换，无需重启
- **升级**：覆盖插件目录，宿主重新加载
- **卸载**：删除插件目录

## 8. 校验清单

安装前用校验器检查 manifest：

```bash
node scripts/validate-plugin-manifest.mjs plugins/examples/hello-command
```

## 9. 稳定性承诺

- `@experimental` API 在 1.4.0 冻结前可能变更
- 非标记 API 遵循 semver
- 兼容窗口：至少 2 个 minor 版本

## 10. 安装与管理（实现细节）

### 10.1 安装来源
- **GitHub Release zip**：设置 → 插件管理 → 输入 URL → 安装
- **本地 zip**：`plugin:install-from-zip` IPC
- **开发模式**：把插件目录放入 `~/.trellora/plugins/<id>/`

### 10.2 安装安全流程
1. 下载 zip 到暂存目录（仅 https、禁止账号信息、SSRF 防护）
2. 解压到暂存目录（阻止 `../` 路径穿越条目）
3. 校验 `plugin.json`（schema + 引擎版本 semver 区间 + 入口路径不越界）
4. 原子移动到 `~/.trellora/plugins/<id>/`（覆盖即升级）
5. 注册到 PluginHost 并按 `activation` 事件激活

### 10.3 管理操作
| 操作 | IPC 通道 | 说明 |
|---|---|---|
| 列表 | `plugin:list` | 返回 manifest + 状态 + 错误 |
| 启用 | `plugin:enable` | 调用 `activate()`（L2 需授权） |
| 禁用 | `plugin:disable` | 调用 `deactivate()` 并清理贡献点 |
| 卸载 | `plugin:uninstall` | 禁用 + 删除目录 + 清除权限持久化 |

### 10.4 升级
覆盖安装即升级：下载新版 zip → 解压校验 → 原子替换旧目录 → 重新加载。

## 11. 校验与测试

```bash
# 校验 manifest（正反向）
pnpm run audit:plugin

# 插件系统单元校验（manifest/权限/生命周期/扩展点）
pnpm run verify:plugin-system
```

## 12. 示例

- [`examples/hello-command/`](examples/hello-command/)：最小 UI 命令插件
