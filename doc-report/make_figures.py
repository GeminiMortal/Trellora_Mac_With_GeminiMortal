# -*- coding: utf-8 -*-
"""生成实验报告插图（功能模块图、概要设计图、流程图）。"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.font_manager as fm

for name in ("PingFang SC", "Hiragino Sans GB", "Heiti SC", "Songti SC", "Arial Unicode MS"):
    if any(f.name == name for f in fm.fontManager.ttflist):
        plt.rcParams["font.family"] = name
        break
plt.rcParams["axes.unicode_minus"] = False

OUT = "/Users/geminimortal/Desktop/trellora/doc-report/figures"
BLUE = "#2F6FB2"
LIGHT = "#EAF1F8"
GREY = "#666666"


def box(ax, x, y, w, h, text, fc=LIGHT, ec=BLUE, fs=11, weight="bold"):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.008,rounding_size=0.012",
                                linewidth=1.4, edgecolor=ec, facecolor=fc))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fs, weight=weight)


def line(ax, x1, y1, x2, y2, style="-"):
    ax.plot([x1, x2], [y1, y2], style, color=GREY, linewidth=1.1, zorder=0)


def arrow(ax, x1, y1, x2, y2):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=12,
                                 color=GREY, linewidth=1.2, zorder=0))


# ---------------- 图1 功能模块图 ----------------
fig, ax = plt.subplots(figsize=(10.2, 6.0))
ax.set_xlim(0, 1)
ax.set_ylim(0, 1)
ax.axis("off")

TOP = 0.90
box(ax, 0.335, TOP, 0.33, 0.085, "Trellora 本地优先 AI 知识工作台", fc="#D7E5F3", fs=13)

modules = [
    ("笔记工作台", ["富文本/预览/源码", "标签·反向链接", "备份与导出"]),
    ("资料库", ["文档导入与预览", "解析流水线", "父子切块与索引"]),
    ("AI 助手", ["自由问答", "当前笔记问答", "知识库问答"]),
    ("Wiki 学习", ["章节目录", "节点分析", "派生节点"]),
    ("知识地图", ["实体图谱", "局部/全局检索", "社区摘要"]),
    ("日程与课表", ["事件/待办/课表", "重复规则与提醒", "课表导入"]),
    ("开发者工具", ["内置终端控制台", "多格式文件打开", "多格式文件创建"]),
]
x0s = [0.015, 0.345, 0.675]
y0s = [0.665, 0.385, 0.105]
for i, (title, subs) in enumerate(modules):
    x = x0s[i % 3]
    y = y0s[i // 3]
    line(ax, 0.5, TOP, x + 0.155, y + 0.075)
    box(ax, x, y, 0.31, 0.075, title, fc="#D7E5F3", fs=12)
    for j, s in enumerate(subs):
        box(ax, x, y - 0.082 * (j + 1), 0.31, 0.058, s, fc="white", fs=9.5, weight="normal")

# 第三行右侧：桌面与辅助能力（横跨两列）
box(ax, 0.345, y0s[2], 0.64, 0.075, "桌面与辅助能力", fc="#F2F2F2", fs=12)
ax.text(0.665, y0s[2] - 0.028,
        "主题·中英文界面·首次引导\n备份·恢复·存储迁移·诊断",
        ha="center", va="top", fontsize=9.5, color=GREY)
line(ax, 0.5, TOP, 0.345 + 0.32, y0s[2] + 0.075)

fig.tight_layout()
fig.savefig(f"{OUT}/fig1-modules.png", dpi=160, bbox_inches="tight")
plt.close(fig)

# ---------------- 图2 概要设计图 ----------------
fig, ax = plt.subplots(figsize=(9.2, 6.2))
ax.set_xlim(0, 1)
ax.set_ylim(0, 1)
ax.axis("off")

box(ax, 0.30, 0.90, 0.40, 0.075, "React 渲染进程（工作台与视图）", fc="#D7E5F3", fs=11.5)
box(ax, 0.28, 0.795, 0.44, 0.065, "Preload：window.electronAPI（contextBridge 受限桥接）", fc="#E8E3F5", fs=10.5)
box(ax, 0.24, 0.685, 0.52, 0.075, "Electron 主进程：IPC 校验 · 任务队列 · 生命周期 · 密钥边界", fc="#D7E5F3", fs=11.5)

subs = [
    ("笔记服务", 0.015), ("资料库服务", 0.205), ("PipelineOrchestrator", 0.395),
    ("知识/模型/Agent", 0.605), ("备份与恢复", 0.815),
]
for name, x in subs:
    box(ax, x, 0.565, 0.17, 0.07, name, fc="white", fs=9.5, weight="normal")

box(ax, 0.015, 0.435, 0.27, 0.07, "Mammoth Worker Thread", fc="#FBF0DC", fs=10)
box(ax, 0.365, 0.435, 0.27, 0.07, "Python Worker（NDJSON）", fc="#FBF0DC", fs=10)
box(ax, 0.715, 0.435, 0.27, 0.07, "外部服务（按同意访问）", fc="#FBF0DC", fs=10)

box(ax, 0.015, 0.30, 0.45, 0.075, "本地文件：Markdown · 资料原文 · 阶段 JSONL 产物", fc="#E3F0E3", fs=10)
box(ax, 0.535, 0.30, 0.45, 0.075, "SQLite / FTS5 / sqlite-vec · .menghan-meta/", fc="#E3F0E3", fs=10)

for x, label in ((0.06, "只读原文"), (0.395, "阶段产物"), (0.75, "检索投影")):
    box(ax, x, 0.185, 0.17, 0.06, label, fc="#F2F2F2", fs=9.5, weight="normal")

for x in (0.12, 0.5, 0.85):
    arrow(ax, x, 0.565, x, 0.512)
for x in (0.15, 0.85):
    arrow(ax, x, 0.435, x, 0.382)
arrow(ax, 0.5, 0.9, 0.5, 0.865)
arrow(ax, 0.5, 0.795, 0.5, 0.762)

ax.text(0.02, 0.09, "方向说明：渲染进程 → Preload → 主进程为受控调用链；Worker 与存储层只与主进程交互。",
        fontsize=9, color=GREY)
ax.text(0.02, 0.03, "安全边界：渲染进程无 fs/spawn 能力；Python Worker 不写应用 SQLite、不修改用户原文。",
        fontsize=9, color=GREY)

fig.tight_layout()
fig.savefig(f"{OUT}/fig2-overview.png", dpi=160, bbox_inches="tight")
plt.close(fig)

# ---------------- 图3 资料入库与问答交互流程图 ----------------
fig, ax = plt.subplots(figsize=(9.6, 3.4))
ax.set_xlim(0, 1)
ax.set_ylim(0, 1)
ax.axis("off")

steps = ["上传文档", "解析路由", "解析流水线", "FTS5/向量索引", "知识库问答", "引用定位"]
x = 0.01
for i, s in enumerate(steps):
    box(ax, x, 0.42, 0.145, 0.16, s, fc="#EAF1F8", fs=10.5)
    if i < len(steps) - 1:
        arrow(ax, x + 0.15, 0.5, x + 0.185, 0.5)
    x += 0.185

notes = ["PDF 经授权上传", "文本/DOCX 本地\nPDF 走 MinerU", "解析→行→信号→树\n→切块→关键词", "本地投影", "FTS/向量混合检索\nParent 提供上下文", "点击引用回到原文"]
x = 0.0
for s in notes:
    ax.text(x + 0.085, 0.28, s, ha="center", va="top", fontsize=8.5, color=GREY)
    x += 0.185

ax.text(0.01, 0.9, "用户操作主线", fontsize=10, weight="bold", color=BLUE)
ax.text(0.01, 0.12, "失败与取消：任一阶段可取消、失败可重试；缓存键变化时仅失效当前阶段及下游。",
        fontsize=9, color=GREY)

fig.tight_layout()
fig.savefig(f"{OUT}/fig3-flow.png", dpi=160, bbox_inches="tight")
plt.close(fig)

print("figures done")
