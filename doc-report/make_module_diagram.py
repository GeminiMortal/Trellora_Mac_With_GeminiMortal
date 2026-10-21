# -*- coding: utf-8 -*-
"""生成功能模块图（基于代码结构，不含 Word 信息）。

模块来源：
- src/components/navigation/NavRail.tsx（主导航：助手/笔记/文档库/Wiki/知识图谱/日程/终端 + 笔记库/设置）
- src/components/settings/SettingsPanel.tsx（设置分组：工作区配置/文档处理/AI 设置/系统）
- electron/（主进程领域模块）：files/ documents/ note/ library/ pipeline/ knowledge/ wiki/ schedule/ terminal/ backup/ plugins/ websearch/ workspace/ onboarding/
- pipeline-python/pipeline_worker/（结构化阶段）
- src/editor/（编辑器行为与节点视图）
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import matplotlib.font_manager as fm

for name in ("PingFang SC", "Hiragino Sans GB", "Heiti SC", "Songti SC", "Arial Unicode MS"):
    if any(f.name == name for f in fm.fontManager.ttflist):
        plt.rcParams["font.family"] = name
        break
plt.rcParams["axes.unicode_minus"] = False

OUT = "/Users/geminimortal/Desktop/trellora/doc-report/figures"
BLUE = "#2F6FB2"
LIGHT_BLUE = "#EAF1F8"
MID_BLUE = "#D7E5F3"
WHITE = "#FFFFFF"
GREEN = "#E3F0E3"
ORANGE = "#FBF0DC"
GREY = "#666666"


def box(ax, x, y, w, h, text, fc=WHITE, ec=BLUE, fs=10, weight="bold", wrap=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                                boxstyle="round,pad=0.006,rounding_size=0.012",
                                linewidth=1.3, edgecolor=ec, facecolor=fc))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, weight=weight, linespacing=1.35)


fig, ax = plt.subplots(figsize=(13, 9.5))
ax.set_xlim(0, 1)
ax.set_ylim(0, 1)
ax.axis("off")

# ── 顶层：Trellora ─────────────────────────────────────────
box(ax, 0.355, 0.925, 0.29, 0.055, "Trellora 本地优先 AI 知识工作台",
    fc=MID_BLUE, fs=14)

# ── 二级导航（NavRail 三大分组） ─────────────────────────────
NAV_Y = 0.845
NAV_H = 0.055
nav_groups = [
    ("核心", 0.02),
    ("知识", 0.345),
    ("工具", 0.67),
]
for label, x in nav_groups:
    box(ax, x, NAV_Y, 0.31, NAV_H, f"导航 · {label}",
        fc=LIGHT_BLUE, fs=11)

# ── 三级模块（对应 NavRail items） ───────────────────────────
MOD_H = 0.05
MOD_Y = 0.765

def module_row(x, y, w, h, items, title=None, title_fc=LIGHT_BLUE):
    if title:
        box(ax, x, y, w, h, title, fc=title_fc, fs=10.5)
        y -= 0.06
    for it in items:
        box(ax, x, y, w, h, it, fc=WHITE, fs=9, weight="normal")
        y -= 0.055

# 核心：助手 / 笔记
box(ax, 0.02, MOD_Y, 0.31, MOD_H, "助手（AI 问答）", fc=WHITE, fs=9.5, weight="normal")
box(ax, 0.02, MOD_Y - 0.055, 0.31, MOD_H, "笔记（Markdown 工作台）", fc=WHITE, fs=9.5, weight="normal")

# 知识：文档库 / Wiki / 知识图谱
box(ax, 0.345, MOD_Y, 0.31, MOD_H, "文档库（资料）", fc=WHITE, fs=9.5, weight="normal")
box(ax, 0.345, MOD_Y - 0.055, 0.31, MOD_H, "Wiki（章节学习）", fc=WHITE, fs=9.5, weight="normal")
box(ax, 0.345, MOD_Y - 0.110, 0.31, MOD_H, "知识图谱（地图）", fc=WHITE, fs=9.5, weight="normal")

# 工具：日程 / 终端
box(ax, 0.67, MOD_Y, 0.31, MOD_H, "日程（课表/提醒）", fc=WHITE, fs=9.5, weight="normal")
box(ax, 0.67, MOD_Y - 0.055, 0.31, MOD_H, "终端（内置控制台）", fc=WHITE, fs=9.5, weight="normal")

# ── 主进程领域模块（第三层） ─────────────────────────────────
DOM_Y = 0.585
DOM_H = 0.05
ROW = 0.058

domains = [
    ("笔记与文件", [
        "文件类型识别（Markdown/文本/代码）",
        "笔记保存 / 备份 / 导出",
        "独立文件会话 / 草稿恢复",
    ]),
    ("文档流水线", [
        "解析（文本 / Mammoth / MinerU）",
        "逻辑行 → 结构信号 → 结构树",
        "父子切块 → 关键词 → 向量 → 实体",
    ]),
    ("AI 知识与检索", [
        "关键词 / 语义 / 混合检索（RRF）",
        "ReAct Agent / 工具注册表",
        "上下文压缩 / 记忆召回",
    ]),
    ("AI 模型与扩展", [
        "模型接入（Ollama / OpenAI / Anthropic / Gemini）",
        "AI Skill（加载 / 导入 / 导出）",
        "联网搜索（智谱 / DuckDuckGo / Tavily / 百度）",
    ]),
]

y = DOM_Y
for group_title, items in domains:
    box(ax, 0.02, y, 0.21, DOM_H, group_title, fc=LIGHT_BLUE, fs=10.5)
    for j, it in enumerate(items):
        box(ax, 0.25, y - 0.058 * j, 0.73, 0.05, it,
            fc=WHITE, fs=9, weight="normal")
    y -= 0.058 * len(items) + 0.02

# ── 底部：Python Worker 与数据存储 ──────────────────────────
BOT_Y = 0.06
BOT_H = 0.052
bot = [
    ("Python Sidecar Worker", 0.02),
    ("SQLite / FTS5 / sqlite-vec", 0.345),
    (".menghan-meta/ 阶段产物", 0.67),
]
for label, x in bot:
    box(ax, x, BOT_Y, 0.31, BOT_H, label, fc=ORANGE, fs=10)

fig.tight_layout()
fig.savefig(f"{OUT}/fig1-modules.png", dpi=220, bbox_inches="tight")
plt.close(fig)
print("done")
