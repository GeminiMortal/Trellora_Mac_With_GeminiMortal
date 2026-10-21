# Trellora 设计系统规范

> 本规范覆盖视觉 token、组件状态、间距规则、深浅主题对照和可访问性要求。
> 新增组件必须遵循本规范，禁止硬编码颜色/间距。

---

## 1. 视觉 Token（`src/styles/variables.css` + `src/styles/theme.css`）

### 1.1 间距（4px 基准）

| Token | 值 | 用途 |
|---|---|---|
| `--spacing-2xs` | 2px | 图标/文字微间距 |
| `--spacing-xs` | 4px | 紧凑元素内部间距 |
| `--spacing-sm` | 8px | 按钮内边距、小卡片 |
| `--spacing-md` | 12px | 表单字段、列表项 |
| `--spacing-lg` | 16px | 标准组件间距 |
| `--spacing-xl` | 24px | 区块间距 |
| `--spacing-2xl` | 32px | 大段落/面板内边距 |
| `--spacing-3xl` | 48px | 页面级留白 |

### 1.2 圆角

| Token | 值 | 用途 |
|---|---|---|
| `--radius-xs` | 2px | 代码高亮、小标签 |
| `--radius-sm` | 4px | 按钮、输入框 |
| `--radius-md` | 6px | 卡片 |
| `--radius-lg` | 8px | 弹窗、下拉 |
| `--radius-xl` | 12px | 大面板 |
| `--radius-full` | 9999px | 胶囊、圆形头像 |

### 1.3 阴影

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-xs` | 0 1px 2px | 按钮 hover |
| `--shadow-sm` | 0 1px 3px | 卡片 |
| `--shadow-md` | 0 4px 6px | 下拉菜单 |
| `--shadow-lg` | 0 8px 16px | 弹窗 |
| `--shadow-xl` | 0 16px 32px | 强调浮层、Toast |

### 1.4 层级（z-index）

| Token | 值 | 用途 |
|---|---|---|
| `--z-base` | 0 | 常规内容 |
| `--z-dropdown` | 1000 | 下拉、Popover |
| `--z-sticky` | 1100 | 粘性头部 |
| `--z-overlay` | 1300 | 蒙层 |
| `--z-modal` | 1400 | 弹窗 |
| `--z-toast` | 1500 | 通知 |

### 1.5 过渡

| Token | 值 | 用途 |
|---|---|---|
| `--transition-fast` | 120ms | hover/active 状态 |
| `--transition-normal` | 200ms | 展开/折叠、Modal |
| `--transition-slow` | 320ms | 页面切换、大面板 |

---

## 2. 色彩系统（`src/styles/theme.css`）

### 2.1 主色（绿系 accent）

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--accent-primary` | `#26745b` | `#83c8a5` | 主按钮、链接、选中 |
| `--accent-fill` | `#26745b` | `#337c60` | 填充按钮背景 |
| `--accent-focus` | `#3e8c6f` | `#96d7b7` | focus 环、hover |

### 2.2 语义色

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--accent-slate` | `#607b8d` | `#a1b8c9` | 次级强调 |
| `--accent-coral` | `#aa7162` | `#d5a495` | 标签、点缀 |
| `--accent-violet` | `#7b6aa0` | `#b6a6d3` | 知识图谱节点 |
| `--accent-knowledge` | `#b98532` | `#d7b36c` | 知识库相关 |
| `--accent-ai` | `#3d7388` | `#8fbccb` | AI 助手相关 |

### 2.3 状态色

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--status-success` | `#26745b` | `#62a985` | 成功 |
| `--status-warning` | `#b98532` | `#d19a55` | 警告 |
| `--status-danger` | `#c94a4a` | `#d87770` | 错误、危险操作 |

### 2.4 文字

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--text-primary` | `#1a1a1a` | `#e8f0ea` | 标题、正文 |
| `--text-secondary` | `#555` | `#b2c5b8` | 说明、辅助 |
| `--text-tertiary` | `#888` | `#95a99c` | 占位符、禁用 |

---

## 3. 反馈机制（统一使用 `feedback.ts`）

### 3.1 Toast（`showToast`）

替代 `window.alert`。**禁止再使用 `window.alert`**。

```ts
import { showToast } from '@/utils/ui/feedback';

showToast({ type: 'success', message: '保存成功' });
showToast({ type: 'error', message: '加载失败：' + err.message });
showToast({ type: 'warning', message: '图片超过 5MB，已跳过', autoClose: 8000 });
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `type` | `info\|success\|warning\|error` | `info` | 决定左边框色与标题 |
| `title` | `string` | 按 type 推断 | 标题 |
| `message` | `string` | 必填 | 正文 |
| `autoClose` | `number\|false` | 5000 | ms 或 false 不自动关闭 |

### 3.2 确认框（`showConfirm`）

替代 `window.confirm`。**禁止再使用 `window.confirm`**。

```ts
import { showConfirm } from '@/utils/ui/feedback';

const ok = await showConfirm({
  title: '删除文件',
  message: '确定要删除此文件吗？它将被移入回收站。',
  detail: filePath,
  danger: true,
  confirmText: '删除',
});
if (!ok) return;
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `title` | `string?` | 标题（默认"确认"） |
| `message` | `string` | 主体 |
| `detail` | `string?` | 补充说明（如路径） |
| `danger` | `boolean?` | 红色危险按钮 |
| `confirmText` / `cancelText` | `string?` | 按钮文字 |

---

## 4. 组件规范

### 4.1 按钮

| 变体 | 用途 | 间距 | 字号 |
|---|---|---|---|
| `variant="filled"` | 主操作（每屏仅 1 个） | `padding: var(--spacing-sm) var(--spacing-lg)` | 14px |
| `variant="light"` | 次级操作 | 同上 | 14px |
| `variant="subtle"` | 三级操作、工具栏 | 同上 | 13px |
| `variant="danger"` | 危险（删除） | 同上 | 14px |

### 4.2 表单

- Label 置于输入框上方，`margin-bottom: var(--spacing-xs)`
- 帮助文字用 `--text-secondary`，错误用 `--status-danger`
- 错误信息须 `aria-describedby` 关联输入框 id

### 4.3 Modal

- 统一使用 `components/ui/ConfirmModal.tsx` 或 Mantine `<Modal>`
- 危险操作必须使用 `variant="danger"`（红色确认按钮）
- 标题用 `--text-primary`，正文用 `--text-secondary`

### 4.4 导航

- 主导航（NavRail）分组：核心 / 知识 / 工具
- 分组间距：`var(--spacing-md)`，分隔线：`1px solid var(--border-subtle)`
- 当前项须有 `aria-current="page"`

---

## 5. 可访问性（a11y）

### 5.1 对比度

- 正文文字：≥ 4.5:1（WCAG AA）
- 大字（≥18px）：≥ 3:1
- 状态色（成功/警告/错误）：须与背景 ≥ 4.5:1

### 5.2 键盘操作

- 所有可交互元素须 `tabIndex={0}` 或为原生可聚焦元素
- 必须有 `:focus-visible` 可见焦点环（不得完全移除）
- Modal 打开时焦点须被锁定在内（Mantine Modal 默认处理）

### 5.3 语义化

- 图标按钮必须有 `aria-label`
- 表单错误：`aria-invalid="true"` + `aria-describedby="error-id"`
- 动态更新区域：`aria-live="polite"`（或 `role="status"`）
- 禁用项：`aria-disabled="true"`（保留 tab 聚焦但不可操作）

### 5.4 运行时验证

```bash
# Chrome DevTools → Lighthouse → Accessibility
# 或安装 axe DevTools 扫描
```

---

## 6. 响应式

- 窗口宽度 < 1280px：侧边栏可折叠
- 窗口宽度 < 900px：隐藏副面板
- 最小窗口尺寸：1024 × 640

---

## 7. 禁止事项

- ❌ 硬编码颜色（用 `--accent-*` / `--text-*`）
- ❌ 硬编码间距（用 `--spacing-*`）
- ❌ `window.alert` / `window.confirm` / `window.prompt`
- ❌ 移除 `:focus-visible` 样式
- ❌ 图标按钮无 `aria-label`
- ❌ 裸 `<div onClick>`（用 `<button>` 或加 `role="button"` + `tabIndex`）
