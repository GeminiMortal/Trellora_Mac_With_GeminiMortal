#!/usr/bin/env python3
"""Add bilingual JSDoc comments to electron/main.ts without modifying code lines."""
import re

FILE = 'electron/main.ts'

with open(FILE, 'r') as f:
    lines = f.readlines()

# Build list of insertions: (line_number_0based, jsdoc_text)
# Each insertion inserts BEFORE the target line.
insertions = []

def add(line, jsdoc):
    """Insert jsdoc text before line (1-based)."""
    insertions.append((line - 1, jsdoc + '\n'))

# ============================================================
# MODULE HEADER (before line 1)
# ============================================================
add(1, '''/**
 * Electron main process entry: application lifecycle, window creation, IPC surface,
 * AI/knowledge orchestration, pipeline sidecars, and workspace backup/restore.
 * Electron 主进程入口：应用生命周期、窗口创建、IPC 面、AI/知识编排、流水线 Sidecar 与工作区备份/恢复。
 */''')

# ============================================================
# FIND ALL FUNCTION/CONST DECLARATIONS BY LINE
# ============================================================

# Helper: find the exact line number of a regex pattern
def find(pattern, start=0, end=None):
    if end is None:
        end = len(lines)
    for i in range(start, end):
        if re.search(pattern, lines[i]):
            return i
    return -1

def find_exact(text, start=0):
    for i in range(start, len(lines)):
        if text in lines[i]:
            return i
    return -1

# ============================================================
# COMMENTS AND JSDOC BLOCKS
# ============================================================

# --- Line: // CJS Imports ---
cjs_line = find(r'^// CJS Imports')
if cjs_line >= 0:
    add(cjs_line + 1, '// CJS 导入（为兼容此处将 electron-store 降级到 8.1.0）。')

# --- SE-7 cancellation registry comment (existing) ---
se7_line = find(r'SE-7 keeps one cancellation registry')
if se7_line >= 0:
    # The existing comment block ends with */ — add Chinese line inside
    # Find the closing */ of that block
    close = find(r'\*/', se7_line)
    if close >= 0:
        # Insert Chinese lines before closing */
        insertions.append((close, ' * SE-7 为统一路由与两个兼容路由共用同一取消注册表。旧通道在观测期内仍可用，\n * 但不能拥有独立的任务生命周期。\n'))

# --- Global state section ---
store_line = find(r'^let store: any;')
if store_line >= 0:
    add(store_line + 1, '''// Main-process singleton state shared by IPC handlers and background services.
// 主进程单例状态，供 IPC 处理器与后台服务共享。''')

# --- getDocumentAiService ---
l = find(r'^function getDocumentAiService\(')
if l >= 0:
    add(l + 1, '''/**
 * Lazily create the document AI service used for document-level AI drafting.
 * 延迟创建文档级 AI 起草所用的文档 AI 服务。
 *
 * @returns The shared DocumentAiService instance / 共享的 DocumentAiService 实例
 */''')

# --- getDocumentSessionService (with existing comment) ---
l = find(r'^function getDocumentSessionService\(')
if l >= 0:
    add(l + 1, '''/**
 * Lazily create the document session service managing external document windows.
 * 延迟创建管理外部文档窗口的文档会话服务。
 *
 * @returns The shared DocumentSessionService instance / 共享的 DocumentSessionService 实例
 */''')
    # Also extend existing Chinese comment above
    existing_cn = find(r'独立文件只占用文件级数据锁', max(0, l - 5))
    if existing_cn >= 0:
        add(existing_cn + 1, '/** Standalone files only take a file-level data lock; in-library copies still go through the structure queue and incremental index commit. */')

# --- registerAppHandler ---
l = find(r'^function registerAppHandler\(')
if l >= 0:
    add(l + 1, '''/**
 * Register an ipcMain handler wrapped with migration/maintenance gating.
 * 注册带迁移/维护门控的 ipcMain 处理器。
 *
 * @param channel - IPC channel name / IPC 通道名
 * @param handler - Underlying invoke handler / 底层 invoke 处理器
 */''')

# --- migrationRecoveryReadChannels ---
l = find(r'^const migrationRecoveryReadChannels')
if l >= 0:
    add(l + 1, '''// Read-only channels still reachable while a workspace-migration recovery is pending.
// 工作区迁移恢复挂起期间仍可访问的只读通道。''')

# --- getWindowIconPath ---
l = find(r'^const getWindowIconPath')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the application window icon path for packaged or dev runs.
 * 解析打包或开发运行时的应用窗口图标路径。
 *
 * @returns Absolute icon file path / 图标文件绝对路径
 */''')

# --- ExternalWebNavigationAction type ---
l = find(r'^type ExternalWebNavigationAction')
if l >= 0:
    add(l + 1, '''/**
 * Navigation actions supported by external web viewer windows.
 * 外部网页查看窗口支持的导航动作。
 */''')

# --- isExternalWebUrl ---
l = find(r'^function isExternalWebUrl\(')
if l >= 0:
    add(l + 1, '''/**
 * Check whether a URL is a plain http(s) web page.
 * 判断 URL 是否为普通 http(s) 网页。
 *
 * @param rawUrl - Candidate URL string / 候选 URL 字符串
 * @returns True when the URL parses as http/https / URL 可解析为 http/https 时为 true
 */''')

# --- isExternalSystemUrl ---
l = find(r'^function isExternalSystemUrl\(')
if l >= 0:
    add(l + 1, '''/**
 * Check whether a URL is a mailto/tel link handled by system apps.
 * 判断 URL 是否为由系统应用处理的 mailto/tel 链接。
 *
 * @param rawUrl - Candidate URL string / 候选 URL 字符串
 * @returns True when the URL parses as mailto/tel / URL 可解析为 mailto/tel 时为 true
 */''')

# --- isExternalWebNavigationAction ---
l = find(r'^function isExternalWebNavigationAction\(')
if l >= 0:
    add(l + 1, '''/**
 * Narrow an unknown IPC payload to a supported navigation action.
 * 将未知的 IPC 载荷收窄为受支持的导航动作。
 *
 * @param value - Untrusted payload from the renderer / 来自渲染进程的不可信载荷
 * @returns True for back/forward/reload/close / 为 back/forward/reload/close 时为 true
 */''')

# --- emitExternalWebNavigationState ---
l = find(r'^function emitExternalWebNavigationState\(')
if l >= 0:
    add(l + 1, '''/**
 * Publish back/forward availability of an external web window to its renderer.
 * 将外部网页窗口的前进/后退可用状态发布给其渲染进程。
 *
 * @param webContents - Target external web contents / 目标外部 webContents
 */''')

# --- isExternalWebNavigationAborted ---
l = find(r'^function isExternalWebNavigationAborted\(')
if l >= 0:
    add(l + 1, '''/**
 * Detect superseded navigations reported as ERR_ABORTED during page load.
 * 识别页面加载期间被替换导航所产生的 ERR_ABORTED 报告。
 *
 * @param error - Load error thrown by Electron / Electron 抛出的加载错误
 * @returns True when the abort is a benign URL replacement / 中止属于良性 URL 替换时为 true
 */''')

# --- openExternalWebWindow (extend existing JSDoc) ---
l = find(r'^function openExternalWebWindow\(')
if l >= 0:
    # Find the existing JSDoc block above
    jsdoc_start = find(r'/\*\*', max(0, l - 10), l)
    if jsdoc_start >= 0:
        # Already has JSDoc — extend with Chinese
        close = find(r'\*/', jsdoc_start, l)
        if close >= 0:
            insertions.append((close, ' * 外部页面绝不能运行应用 preload：它为笔记渲染进程暴露了受信任的本地文件 IPC。\n * 网页浏览必须放在独立沙箱窗口中，仅提供其 preload 提供的导航控件。'))
    else:
        add(l + 1, '''/**
 * External pages must never run the application preload: it exposes trusted
 * local-file IPC for the Notes renderer. Keep web browsing in a separate,
 * sandboxed window with only the navigation controls supplied by its preload.
 * 外部页面绝不能运行应用 preload：它为笔记渲染进程暴露了受信任的本地文件 IPC。
 * 网页浏览必须放在独立沙箱窗口中，仅提供其 preload 提供的导航控件。
 *
 * @param rawUrl - http(s) URL to open / 要打开的 http(s) URL
 */''')

# Inline comment: target="_blank"
l = find(r'A target=.*_blank.*page cannot create', 0)
if l >= 0:
    add(l + 1, '// target="_blank" 页面不能创建无防护的 Electron 窗口。')

# Inline comment: ERR_ABORTED
l = find(r'Search engines may replace the initial URL', 0)
if l >= 0:
    add(l + 3, '// 搜索引擎可能在加载过程中替换初始 URL。Electron 会将被替换的导航报告为\n// ERR_ABORTED，而窗口实际仍在加载替换后的页面。')

# --- openExternalWebUrl ---
l = find(r'^function openExternalWebUrl\(')
if l >= 0:
    add(l + 1, '''/**
 * Open an external web link in the in-app viewer or the system browser.
 * 在应用内查看器或系统浏览器中打开外部网页链接。
 *
 * @param rawUrl - http(s) URL to open / 要打开的 http(s) URL
 */''')

# --- openAllowedExternalUrl ---
l = find(r'^function openAllowedExternalUrl\(')
if l >= 0:
    add(l + 1, '''/**
 * Open a URL after validating it is an allowed web or system link.
 * 校验 URL 为允许的网页或系统链接后再打开。
 *
 * @param rawUrl - Untrusted URL string / 不可信的 URL 字符串
 */''')

# --- configureMainWindowExternalNavigation ---
l = find(r'^function configureMainWindowExternalNavigation\(')
if l >= 0:
    add(l + 1, '''/**
 * Redirect main-window external navigations to guarded external windows.
 * 将主窗口的外部导航重定向到受防护的外部窗口。
 *
 * @param window - Main application window / 主应用窗口
 */''')
    # Inline comment: Markdown links
    ml = find(r'Markdown links without target', l)
    if ml >= 0:
        add(ml + 1, '// 无 target="_blank" 的 Markdown 链接若不拦截会替换整个笔记界面。')

# --- handleExternalWebNavigation ---
l = find(r'^function handleExternalWebNavigation\(')
if l >= 0:
    add(l + 1, '''/**
 * Handle navigation control events coming from external web windows.
 * 处理来自外部网页窗口的导航控件事件。
 *
 * @param event - IPC event whose sender must be an external window / IPC 事件，其发送者必须是外部窗口
 * @param action - Requested navigation action / 请求的导航动作
 */''')

# --- logToWindow ---
l = find(r'^function logToWindow\(')
if l >= 0:
    add(l + 1, '''/**
 * Forward a log line to the main window and the app log file.
 * 将日志行转发到主窗口与应用日志文件。
 *
 * @param args - Values to log; objects are JSON-serialized / 要记录的值；对象会 JSON 序列化
 */''')

# --- assertInternalRenderer ---
l = find(r'^function assertInternalRenderer\(')
if l >= 0:
    add(l + 1, '''/**
 * Reject IPC calls that do not originate from the trusted app renderer.
 * 拒绝并非来自受信任应用渲染进程的 IPC 调用。
 *
 * @param event - IPC invoke event to validate / 需要校验的 IPC invoke 事件
 */''')
    # Inline security comment
    sl = find(r'const senderUrl = event.senderFrame.url', l)
    if sl >= 0:
        add(sl + 1, '// Security guard: external pages must never reach privileged handlers.\n    // 安全防护：外部页面绝不能触达特权处理器。')

# --- selectionTaskKey ---
l = find(r'^function selectionTaskKey\(')
if l >= 0:
    add(l + 1, '''/**
 * Build a per-sender task key for cancellation registries.
 * 构建用于取消注册表的按发送者任务键。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 * @param requestId - Client request id / 客户端请求 id
 * @returns Composite key `senderId:requestId` / 组合键 `senderId:requestId`
 */''')

# --- emitSelectionExpansionEvent ---
l = find(r'^function emitSelectionExpansionEvent\(')
if l >= 0:
    add(l + 1, '''/**
 * Send a selection-expansion progress event to its requesting renderer.
 * 向请求方渲染进程发送选区扩展进度事件。
 *
 * @param event - IPC event of the requester / 请求方的 IPC 事件
 * @param payload - Event payload / 事件载荷
 */''')

# --- isSelectionExpansionStaleError ---
l = find(r'^function isSelectionExpansionStaleError\(')
if l >= 0:
    add(l + 1, '''/**
 * Detect stale-selection errors that should not surface as hard failures.
 * 识别不应作为硬失败展示的选区过期错误。
 *
 * @param error - Error thrown during selection processing / 选区处理中抛出的错误
 * @returns True when the message marks a stale selection / 消息表示选区过期时为 true
 */''')

# --- cancelSelectionExpansionTasksForSender ---
l = find(r'^function cancelSelectionExpansionTasksForSender\(')
if l >= 0:
    add(l + 1, '''/**
 * Abort all selection-expansion tasks owned by a sender, optionally keeping one.
 * 中止某发送者的所有选区扩展任务，可选择保留其中一个。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 * @param exceptKey - Task key to keep running / 保持运行的任务键
 */''')

# --- cancelSelectionTransformTasksForSender ---
l = find(r'^function cancelSelectionTransformTasksForSender\(')
if l >= 0:
    add(l + 1, '''/**
 * Abort all selection-transform/edit tasks owned by a sender.
 * 中止某发送者的所有选区变换/编辑任务。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 */''')

# --- resolveSelectionEditCurrentNoteSource ---
l = find(r'^function resolveSelectionEditCurrentNoteSource\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve a verifiable snapshot of the current note for selection-edit context.
 * 为选区编辑上下文解析当前笔记的可核验快照。
 *
 * @param request - Selection request carrying path, text, and optional locator / 携带路径、文本与可选定位器的选区请求
 * @returns Snapshot with currency check, or undefined when out of scope / 带时效校验的快照，超出范围时为 undefined
 */''')

# --- cancelSelectionEditTask ---
l = find(r'^function cancelSelectionEditTask\(')
if l >= 0:
    add(l + 1, '''/**
 * Cancel one selection-edit task by request id.
 * 按请求 id 取消单个选区编辑任务。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 * @param requestId - Request id to cancel / 要取消的请求 id
 * @returns True when a task was cancelled / 成功取消任务时为 true
 */''')

# --- emitAssistantTurnEvent ---
l = find(r'^function emitAssistantTurnEvent\(')
if l >= 0:
    add(l + 1, '''/**
 * Emit an assistant-turn event while buffering streamed output for recovery.
 * 发出助手轮次事件，同时缓存流式输出以便恢复。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 * @param payload - Turn event payload / 轮次事件载荷
 */''')

# --- getAssistantTurnPartialText ---
l = find(r'^function getAssistantTurnPartialText\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the partial streamed answer text buffered for a request.
 * 返回某请求已缓存的部分流式回答文本。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 * @param requestId - Request id to inspect / 要查看的请求 id
 * @returns Buffered text when non-empty, otherwise undefined / 非空时返回缓存文本，否则为 undefined
 */''')

# --- toPublicCurrentNoteSearchScope (extend existing comment) ---
l = find(r'^function toPublicCurrentNoteSearchScope\(')
if l >= 0:
    add(l + 1, '''/**
 * Strip internal provenance from a search scope before sending it to the renderer.
 * 在发送给渲染进程前剥离搜索作用域的内部来源信息。
 *
 * @param scope - Internal scope description / 内部作用域描述
 * @returns Public scope projection / 对外作用域投影
 */''')
    # Extend existing comment
    existing = find(r'Keep internal scope provenance', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** 内部作用域来源与覆盖账本细节保留在主进程内。 */')

# --- toPublicCurrentNoteSearchCoverage (extend existing comment) ---
l = find(r'^function toPublicCurrentNoteSearchCoverage\(')
if l >= 0:
    add(l + 1, '''/**
 * Project coverage summary to the bounded fields the UI is allowed to see.
 * 将覆盖摘要投影为 UI 允许查看的有界字段。
 *
 * @param coverage - Internal coverage ledger summary / 内部覆盖账本摘要
 * @returns Public coverage counts and status / 对外的覆盖计数与状态
 */''')
    existing = find(r'Expose only the bounded', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** 仅暴露既有 UI 追踪所需的、来自账本的有界计数。 */')

# --- cancelAssistantTurnsForSender ---
l = find(r'^function cancelAssistantTurnsForSender\(')
if l >= 0:
    add(l + 1, '''/**
 * Abort all assistant-turn tasks owned by a sender, optionally keeping one.
 * 中止某发送者的所有助手轮次任务，可选择保留其中一个。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 * @param exceptKey - Task key to keep running / 保持运行的任务键
 */''')

# --- Global error handler ---
l = find(r'^// Global Error Handler for startup')
if l >= 0:
    add(l + 1, '// 启动阶段全局异常捕获')

# --- initAndCreate ---
l = find(r'^async function initAndCreate\(\)')
if l >= 0:
    add(l + 1, '''/**
 * Bootstrap the app: initialize store, migrations, protocols, pipeline, and create the window.
 * 引导应用：初始化存储、迁移、协议、流水线并创建窗口。
 */''')
    # Inline: Pipeline startup may enqueue
    pl = find(r'Pipeline startup may enqueue persisted', l)
    if pl >= 0:
        add(pl + 1, '    // 流水线启动时可能立即入队已持久化的文档。先配置主进程独占的 AI 客户端，\n    // 使 LLM 切块能看到实际的 Provider 配置。')

# --- getWindowBackgroundColor ---
l = find(r'^function getWindowBackgroundColor\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the themed window background color from persisted appearance.
 * 从持久化外观主题解析窗口背景色。
 *
 * @returns Hex color string for BrowserWindow backgroundColor / 用于 BrowserWindow backgroundColor 的十六进制颜色字符串
 */''')

# --- createWindow ---
l = find(r'^const createWindow = ')
if l >= 0:
    add(l + 1, '''/**
 * Create the main BrowserWindow and wire all window-lifecycle behaviors.
 * 创建主 BrowserWindow 并接线所有窗口生命周期行为。
 */''')

# --- getConfiguredEmbeddingModel ---
l = find(r'^function getConfiguredEmbeddingModel\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the embedding model identifier configured in the store.
 * 返回存储中配置的 embedding 模型标识符。
 *
 * @returns Embedding model name / embedding 模型名称
 */''')

# --- syncLegacyGenerationConfig ---
l = find(r'^function syncLegacyGenerationConfig\(')
if l >= 0:
    add(l + 1, '''/**
 * Sync the legacy aiProvider store key so older runtime consumers see model-hub settings.
 * 同步旧版 aiProvider 存储键，使旧运行时消费者能看到模型中枢设置。
 *
 * @param targetStore - electron-store instance to write / 要写入的 electron-store 实例
 * @param configureRuntime - Whether to also reconfigure the AI provider runtime / 是否同时重新配置 AI Provider 运行时
 */''')

# --- syncModelHubGeneration ---
l = find(r'^function syncModelHubGeneration\(')
if l >= 0:
    add(l + 1, '''/**
 * Sync the model-hub language-generation slot from the legacy provider config.
 * 将模型中枢的语言生成槽位同步自旧版 Provider 配置。
 *
 * @param config - AI provider configuration / AI Provider 配置
 * @param targetStore - electron-store instance to write / 要写入的 electron-store 实例
 */''')

# --- getErrorMessage ---
l = find(r'^function getErrorMessage\(')
if l >= 0:
    add(l + 1, '''/**
 * Safely extract a human-readable message from an unknown error.
 * 从未知错误中安全提取面向用户的可读消息。
 *
 * @param error - Any thrown value / 任意抛出值
 * @returns Error message string / 错误消息字符串
 */''')

# --- getLibraryTagVocabulary ---
l = find(r'^function getLibraryTagVocabulary\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the distinct tag names present in the note index.
 * 返回笔记索引中的不同标签名列表。
 *
 * @returns Array of unique tag names / 去重后的标签名数组
 */''')

# --- refreshLibraryIndex ---
l = find(r'^function refreshLibraryIndex\(')
if l >= 0:
    add(l + 1, '''/**
 * Rebuild the note index projection from disk without a full re-scan.
 * 从磁盘重建笔记索引投影，无需完整重新扫描。
 *
 * @returns Updated note array or null when no index exists / 更新后的笔记数组，索引不存在时为 null
 */''')
    # Extend existing comment
    existing = find(r'Ordinary reads return the live projection', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** 普通读取返回实时投影；仅启动/库激活时执行完整扫描。 */')

# --- initializeLibraryIndex ---
l = find(r'^async function initializeLibraryIndex\(')
if l >= 0:
    add(l + 1, '''/**
 * Scan and rebuild the note index for the current library path.
 * 扫描并重建当前笔记库路径的笔记索引。
 */''')

# --- getCurrentLibraryPath ---
l = find(r'^function getCurrentLibraryPath\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the active note library path, or null when none is configured.
 * 返回当前活动笔记库路径，未配置时为 null。
 *
 * @returns Library path string or null / 库路径字符串或 null
 */''')

# --- getDefaultWorkspacePath ---
l = find(r'^function getDefaultWorkspacePath\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the default workspace path based on the platform userData directory.
 * 返回基于平台 userData 目录的默认工作区路径。
 *
 * @returns Default workspace path / 默认工作区路径
 */''')

# --- getConfiguredWorkspacePath ---
l = find(r'^function getConfiguredWorkspacePath\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the configured workspace path from the store.
 * 从存储中返回已配置的工作区路径。
 *
 * @returns Workspace path string / 工作区路径字符串
 */''')

# --- setConfiguredWorkspacePath ---
l = find(r'^function setConfiguredWorkspacePath\(')
if l >= 0:
    add(l + 1, '''/**
 * Persist a new workspace path to the store.
 * 将新工作区路径持久化到存储。
 *
 * @param workspacePath - New workspace path to save / 要保存的新工作区路径
 * @returns The persisted workspace path / 已持久化的工作区路径
 */''')

# --- activateLibraryPath ---
l = find(r'^async function activateLibraryPath\(')
if l >= 0:
    add(l + 1, '''/**
 * Activate a library path: set it as current, optionally register, and rebuild the index.
 * 激活笔记库路径：设为当前库、可选注册并重建索引。
 *
 * @param libraryPath - Path to activate / 要激活的路径
 * @param register - Whether to also register in the library list / 是否同时注册到库列表
 * @param alias - Optional friendly name for the library / 可选的库友好名称
 * @returns The activated library path / 已激活的库路径
 */''')

# --- requireCurrentLibraryPath ---
l = find(r'^function requireCurrentLibraryPath\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the current library path or throw if none is configured.
 * 返回当前库路径，未配置时抛出异常。
 *
 * @returns Current library path / 当前库路径
 */''')

# --- requireRegisteredMaterialsLibrary ---
l = find(r'^function requireRegisteredMaterialsLibrary\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate that a path is a registered materials library and return it.
 * 校验路径为已注册资料库并返回。
 *
 * @param libraryPath - Candidate materials library path / 候选资料库路径
 * @returns Validated library path / 校验通过的资料库路径
 */''')

# --- resolveMaterialEmbeddingProbe ---
l = find(r'^function resolveMaterialEmbeddingProbe\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve and validate a material embedding probe request from IPC input.
 * 从 IPC 输入解析并校验素材 embedding 探针请求。
 *
 * @param candidateInput - Raw IPC payload / 原始 IPC 载荷
 * @returns Valid probe descriptor with path, profile, and adapter / 有效的探针描述符，含路径、Profile 与适配器
 */''')

# --- resolveLockedMaterialEmbeddingAdapter ---
l = find(r'^function resolveLockedMaterialEmbeddingAdapter\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the locked embedding adapter for a material embedding profile.
 * 返回已锁定的素材 embedding Profile 对应的嵌入适配器。
 *
 * @param profile - Material embedding profile / 素材 embedding Profile
 * @returns Locked embedding adapter / 锁定的嵌入适配器
 */''')

# --- getVectorGenerationService ---
l = find(r'^function getVectorGenerationService\(')
if l >= 0:
    add(l + 1, '''/**
 * Lazily create the material vector generation service.
 * 延迟创建素材向量生成服务。
 *
 * @returns Shared MaterialVectorGenerationService instance / 共享的 MaterialVectorGenerationService 实例
 */''')

# --- isPipelineStageId ---
l = find(r'^function isPipelineStageId\(')
if l >= 0:
    add(l + 1, '''/**
 * Type guard: check whether a string is a valid pipeline stage id.
 * 类型守卫：判断字符串是否为有效的流水线阶段 id。
 *
 * @param value - Candidate string / 候选字符串
 * @returns True when value is a PipelineStageId / 为 PipelineStageId 时为 true
 */''')

# --- runKeywordSearchAgent ---
l = find(r'^function runKeywordSearchAgent\(')
if l >= 0:
    add(l + 1, '''/**
 * Run a lexical keyword search across the current note index.
 * 对当前笔记索引运行词法关键词搜索。
 *
 * @param query - Search query text / 搜索查询文本
 * @returns KeywordSearchOutcome with ranked matches / 含排序匹配结果的 KeywordSearchOutcome
 */''')

# --- requireRegisteredNoteLibrary ---
l = find(r'^function requireRegisteredNoteLibrary\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate that a path is a registered note library and return it.
 * 校验路径为已注册笔记库并返回。
 *
 * @param libraryPath - Candidate note library path / 候选笔记库路径
 * @returns Validated library path / 校验通过的笔记库路径
 */''')

# --- searchNoteLibraryForAssistant ---
l = find(r'^function searchNoteLibraryForAssistant\(')
if l >= 0:
    add(l + 1, '''/**
 * Search the note index for assistant context retrieval.
 * 搜索笔记索引以供助手上下文检索。
 *
 * @param libraryPath - Note library path / 笔记库路径
 * @param query - Search query / 搜索查询
 * @returns Live index and keyword search outcome / 实时索引与关键词搜索结果
 */''')

# --- prepareMaterialSearchContext (extend existing) ---
l = find(r'^async function prepareMaterialSearchContext\(')
if l >= 0:
    add(l + 1, '''/**
 * Prepare material search context: validate paths, tokenize query, and lock embedding adapter.
 * 准备素材搜索上下文：校验路径、查询分词与锁定 embedding 适配器。
 *
 * @param libraryPath - Materials library path / 资料库路径
 * @param query - Raw search query / 原始搜索查询
 * @param options - Tokenization options / 分词选项
 * @returns MaterialSearchContext ready for retrieval / 可用于检索的 MaterialSearchContext
 */''')
    existing = find(r'资料库检索的统一准备', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** Unified preparation for materials library retrieval: path validation, Jieba query tokenization, locked embedding adapter with error degradation. */')

# --- searchKnowledgeBaseForAssistant ---
l = find(r'^async function searchKnowledgeBaseForAssistant\(')
if l >= 0:
    add(l + 1, '''/**
 * Search the materials library for assistant knowledge-base retrieval.
 * 搜索资料库以供助手知识库检索。
 *
 * @param libraryPath - Materials library path / 资料库路径
 * @param query - Search query / 搜索查询
 * @param options - Search mode and limit options / 搜索模式与数量选项
 * @returns Material chunk search results / 素材分块搜索结果
 */''')

# --- tokenizeMaterialSearchQuery ---
l = find(r'^async function tokenizeMaterialSearchQuery\(')
if l >= 0:
    add(l + 1, '''/**
 * Tokenize a query using Jieba for materials library search.
 * 使用 Jieba 分词对查询进行分词，用于资料库搜索。
 *
 * @param libraryPath - Materials library path / 资料库路径
 * @param query - Raw query string / 原始查询字符串
 * @returns Tokenized terms or error message / 分词后的词项或错误消息
 */''')

# --- createSourceSnippet ---
l = find(r'^function createSourceSnippet\(')
if l >= 0:
    add(l + 1, '''/**
 * Create a short source snippet by centering around the first query match.
 * 通过围绕首个查询匹配创建简短的来源摘录。
 *
 * @param content - Full content text / 完整内容文本
 * @param query - Query to locate a match / 用于定位匹配的查询
 * @returns Truncated snippet string / 截断的摘录字符串
 */''')

# --- getAssistantMemoryRepository ---
l = find(r'^function getAssistantMemoryRepository\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the assistant memory repository for a given note library.
 * 返回指定笔记库的助手记忆存储库。
 *
 * @param libraryPath - Note library path / 笔记库路径
 * @returns AssistantMemoryRepository instance / AssistantMemoryRepository 实例
 */''')

# --- getNoteDerivedDigestRepository ---
l = find(r'^function getNoteDerivedDigestRepository\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the note-derived digest repository for assistant memory.
 * 返回助手记忆的笔记衍生摘要存储库。
 *
 * @param libraryPath - Note library path / 笔记库路径
 * @param memoryRepository - Optional memory repository override / 可选的记忆存储库覆盖
 * @returns NoteDerivedDigestRepository instance / NoteDerivedDigestRepository 实例
 */''')

# --- getQaMemoryOrchestrator ---
l = find(r'^function getQaMemoryOrchestrator\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the QA memory orchestrator for the current workspace.
 * 返回或延迟创建当前工作区的 QA 记忆编排器。
 *
 * @returns QaMemoryOrchestrator instance / QaMemoryOrchestrator 实例
 */''')

# --- resolveActiveLongTermMemoryScope (extend existing) ---
l = find(r'^function resolveActiveLongTermMemoryScope\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the active long-term memory scope for the current workspace.
 * 解析当前工作区的活跃长期记忆作用域。
 *
 * @returns Object containing workspaceId, principalId, and scope descriptor / 包含 workspaceId、principalId 和 scope 描述符的对象
 */''')
    existing = find(r'The renderer never provides workspaceId', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** 渲染进程不提供 L4 记忆的 workspaceId/principalId。 */')

# --- tryResolveConversationArchiveScope ---
l = find(r'^function tryResolveConversationArchiveScope\(')
if l >= 0:
    add(l + 1, '''/**
 * Try to resolve the conversation archive scope; returns undefined when unavailable.
 * 尝试解析对话归档作用域；不可用时返回 undefined。
 *
 * @returns Archive scope or undefined / 归档作用域或 undefined
 */''')

# --- getMemoryWriteService ---
l = find(r'^function getMemoryWriteService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the memory write service for the current workspace.
 * 返回或延迟创建当前工作区的记忆写入服务。
 *
 * @returns MemoryWriteService instance / MemoryWriteService 实例
 */''')

# --- resolveMemoryEmbeddingRuntime ---
l = find(r'^function resolveMemoryEmbeddingRuntime\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the memory embedding runtime configuration.
 * 解析记忆 embedding 运行时配置。
 *
 * @returns Runtime config or undefined when embedding is unavailable / 运行时配置，embedding 不可用时为 undefined
 */''')

# --- getMemoryRecallService ---
l = find(r'^function getMemoryRecallService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the memory recall service.
 * 返回或延迟创建记忆召回服务。
 *
 * @returns MemoryRecallService instance / MemoryRecallService 实例
 */''')

# --- getMemoryConditioningService ---
l = find(r'^function getMemoryConditioningService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the memory conditioning service.
 * 返回或延迟创建记忆调节服务。
 *
 * @returns MemoryConditioningService instance / MemoryConditioningService 实例
 */''')

# --- getMemoryAffinityService ---
l = find(r'^function getMemoryAffinityService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the memory affinity service.
 * 返回或延迟创建记忆亲和力服务。
 *
 * @returns MemoryAffinityService instance / MemoryAffinityService 实例
 */''')

# --- getMemoryConsolidationService ---
l = find(r'^function getMemoryConsolidationService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the memory consolidation service.
 * 返回或延迟创建记忆合并服务。
 *
 * @param storagePath - Workspace storage path override / 工作区存储路径覆盖
 * @returns MemoryConsolidationService instance / MemoryConsolidationService 实例
 */''')

# --- getMemoryTopicService ---
l = find(r'^function getMemoryTopicService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the memory topic service.
 * 返回或延迟创建记忆主题服务。
 *
 * @returns MemoryTopicService instance / MemoryTopicService 实例
 */''')

# --- resolveDocumentAffinityFactors ---
l = find(r'^function resolveDocumentAffinityFactors\(')
if l >= 0:
    add(l + 1, '''/**
 * Compute document affinity factors for memory recall weighting.
 * 计算文档亲和力因子用于记忆召回加权。
 *
 * @param scope - Active memory scope / 活跃记忆作用域
 * @returns Document affinity factor map / 文档亲和力因子映射
 */''')

# --- getConversationSearchService ---
l = find(r'^function getConversationSearchService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the conversation search service.
 * 返回或延迟创建对话搜索服务。
 *
 * @returns ConversationSearchService instance / ConversationSearchService 实例
 */''')

# --- resolveConversationSearchRuntime (extend existing) ---
l = find(r'^function resolveConversationSearchRuntime\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the conversation search runtime for the current session.
 * 为当前会话解析对话搜索运行时。
 *
 * @param currentSessionId - Active session id or null / 活跃会话 id 或 null
 * @returns SearchConversationsToolRuntime or undefined / SearchConversationsToolRuntime 或 undefined
 */''')
    existing = find(r'L3 availability is independent', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** L3 可用性独立于 L4 的 enabled/principal/agent 开关。 */')

# --- recallLongTermMemory ---
l = find(r'^async function recallLongTermMemory\(')
if l >= 0:
    add(l + 1, '''/**
 * Recall long-term memory items relevant to a query.
 * 召回与查询相关的长期记忆项。
 *
 * @param query - Memory recall query text / 记忆召回查询文本
 * @returns Recall results and the resolved scope / 召回结果与解析出的作用域
 */''')

# --- appendLongTermMemoryContext ---
l = find(r'^function appendLongTermMemoryContext\(')
if l >= 0:
    add(l + 1, '''/**
 * Append recalled long-term memory items to the context memory result.
 * 将召回的长期记忆项附加到上下文记忆结果中。
 *
 * @param contextMemory - Current context memory accumulator / 当前上下文记忆累加器
 * @param recall - Recall results to merge / 要合并的召回结果
 * @param scope - Memory scope / 记忆作用域
 * @returns Updated ContextMemoryResult / 更新后的 ContextMemoryResult
 */''')

# --- createMemoryCutoverContext ---
l = find(r'^function createMemoryCutoverContext\(')
if l >= 0:
    add(l + 1, '''/**
 * Create a ContextMemoryResult seeded with memory cutover report materials.
 * 创建以记忆切换报告素材初始化的 ContextMemoryResult。
 *
 * @param materials - Context materials from cutover report / 来自切换报告的上下文素材
 * @returns Initialized ContextMemoryResult / 初始化的 ContextMemoryResult
 */''')

# --- getMemoryExtractionService ---
l = find(r'^function getMemoryExtractionService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return or lazily create the memory extraction service.
 * 返回或延迟创建记忆提取服务。
 *
 * @returns MemoryExtractionService instance / MemoryExtractionService 实例
 */''')

# --- completeTurnPostProcess (extend existing) ---
l = find(r'^function completeTurnPostProcess\(')
if l >= 0:
    add(l + 1, '''/**
 * Post-process an assistant turn: extract memories, update QA context, and handle follow-ups.
 * 后处理助手轮次：提取记忆、更新 QA 上下文并处理后续建议。
 *
 * @param input - Turn completion payload with result, context, and controller / 含结果、上下文和控制器的轮次完成载荷
 */''')

# --- parseManualMemoryInput ---
l = find(r'^function parseManualMemoryInput\(')
if l >= 0:
    add(l + 1, '''/**
 * Parse and validate a manual memory input from IPC payload.
 * 从 IPC 载荷解析并校验手动记忆输入。
 *
 * @param value - Raw IPC payload / 原始 IPC 载荷
 * @returns Validated ManualMemoryInput / 校验通过的 ManualMemoryInput
 */''')

# --- parseMemoryItemPatch ---
l = find(r'^function parseMemoryItemPatch\(')
if l >= 0:
    add(l + 1, '''/**
 * Parse and validate a memory item patch from IPC payload.
 * 从 IPC 载荷解析并校验记忆项补丁。
 *
 * @param value - Raw IPC payload / 原始 IPC 载荷
 * @returns Validated MemoryItemPatch / 校验通过的 MemoryItemPatch
 */''')

# --- parseMemoryProposalReview ---
l = find(r'^function parseMemoryProposalReview\(')
if l >= 0:
    add(l + 1, '''/**
 * Parse and validate a memory proposal review decision from IPC payload.
 * 从 IPC 载荷解析并校验记忆提案审核决策。
 *
 * @param value - Raw IPC payload / 原始 IPC 载荷
 * @returns Validated review or undefined / 校验通过的审核或 undefined
 */''')

# --- resolveUserProfileProviderId ---
l = find(r'^function resolveUserProfileProviderId\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the user-profile provider id from an AI config.
 * 从 AI 配置中解析用户 Profile 的 Provider id。
 *
 * @param config - AI provider configuration / AI Provider 配置
 * @returns Provider id string / Provider id 字符串
 */''')

# --- resolveMemoryExtractionModel ---
l = find(r'^async function resolveMemoryExtractionModel\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the model configuration for memory extraction.
 * 解析记忆提取的模型配置。
 *
 * @param job - Memory extraction job record / 记忆提取任务记录
 * @param workspaceConfig - Workspace memory configuration / 工作区记忆配置
 * @returns Model resolution for extraction / 提取的模型解析结果
 */''')

# --- resolveManualMemoryConsolidationModel ---
l = find(r'^async function resolveManualMemoryConsolidationModel\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the model configuration for manual memory consolidation.
 * 解析手动记忆合并的模型配置。
 *
 * @param scope - Active memory scope / 活跃记忆作用域
 * @returns Model resolution for consolidation / 合并的模型解析结果
 */''')

# --- resolveQaCompressionModel ---
l = find(r'^function resolveQaCompressionModel\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the QA compression model from the store.
 * 从存储中解析 QA 压缩模型。
 *
 * @returns Model id or undefined / 模型 id 或 undefined
 */''')

# --- getCurrentNoteSnapshotForAssistantMemory ---
l = find(r'^function getCurrentNoteSnapshotForAssistantMemory\(')
if l >= 0:
    add(l + 1, '''/**
 * Build a note snapshot for assistant memory from a note path.
 * 从笔记路径构建用于助手记忆的笔记快照。
 *
 * @param libraryPath - Note library path / 笔记库路径
 * @param notePath - Note file path / 笔记文件路径
 * @returns Current note snapshot / 当前笔记快照
 */''')

# --- resolvePersistentAssistantSessionScope ---
l = find(r'^function resolvePersistentAssistantSessionScope\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve or reuse a persistent assistant session scope for memory binding.
 * 解析或复用持久助手会话作用域以绑定记忆。
 *
 * @param event - IPC event for sender identity / 用于标识发送者的 IPC 事件
 * @param repository - Assistant memory repository / 助手记忆存储库
 * @param snapshot - Current note snapshot / 当前笔记快照
 * @param sessionId - Optional explicit session id / 可选的显式会话 id
 * @returns AssistantSessionScope / AssistantSessionScope
 */''')

# --- getAssistantMemoryMode ---
l = find(r'^function getAssistantMemoryMode\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the assistant memory mode from the repository.
 * 从存储库返回助手记忆模式。
 *
 * @param repository - Assistant memory repository / 助手记忆存储库
 * @returns AssistantMemoryMode / AssistantMemoryMode
 */''')

# --- getAssistantMemoryIpcContext ---
l = find(r'^function getAssistantMemoryIpcContext\(')
if l >= 0:
    add(l + 1, '''/**
 * Build the IPC context for assistant memory operations.
 * 构建助手记忆操作的 IPC 上下文。
 *
 * @param event - IPC event / IPC 事件
 * @param notePath - Note path from the renderer / 来自渲染进程的笔记路径
 * @returns Memory IPC context object / 记忆 IPC 上下文对象
 */''')

# --- getAuthorizedAssistantMemoryScope ---
l = find(r'^function getAuthorizedAssistantMemoryScope\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate and return the authorized assistant memory scope for an IPC call.
 * 校验并返回 IPC 调用授权的助手记忆作用域。
 *
 * @param event - IPC event / IPC 事件
 * @param notePath - Note path from the renderer / 来自渲染进程的笔记路径
 * @param sessionId - Optional session id / 可选会话 id
 * @returns Authorized memory scope descriptor / 授权的记忆作用域描述符
 */''')

# --- validateAssistantCitationForCurrentNote ---
l = find(r'^function validateAssistantCitationForCurrentNote\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate an assistant evidence citation against the current note snapshot.
 * 将助手证据引注与当前笔记快照进行校验。
 *
 * @param citation - Citation to validate / 要校验的引注
 * @returns Citation validation result / 引注校验结果
 */''')

# --- runAssistantTurn ---
l = find(r'^async function runAssistantTurn\(')
if l >= 0:
    add(l + 1, '''/**
 * Execute a full assistant turn: context assembly, model call, streaming, memory, and post-processing.
 * 执行完整助手轮次：上下文组装、模型调用、流式输出、记忆与后处理。
 *
 * @param event - IPC event identifying the sender / 标识发送者的 IPC 事件
 * @param request - Validated assistant turn request / 已校验的助手轮次请求
 * @param controller - AbortController for cancellation / 用于取消的 AbortController
 */''')

# --- runDedicatedKnowledgeBaseRagTurn ---
l = find(r'^async function runDedicatedKnowledgeBaseRagTurn\(')
if l >= 0:
    add(l + 1, '''/**
 * Execute a dedicated knowledge-base RAG turn with its own context assembly.
 * 执行专用知识库 RAG 轮次，拥有独立的上下文组装流程。
 *
 * @param input - RAG turn input with event, request, controller, and source / 含事件、请求、控制器和来源的 RAG 轮次输入
 */''')

# --- resolveQaContextRuntimeMode ---
l = find(r'^function resolveQaContextRuntimeMode\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the QA context runtime mode for a given route.
 * 为给定路由解析 QA 上下文运行时模式。
 *
 * @param route - QA route ('chat' or 'knowledge-base') / QA 路由（'chat' 或 'knowledge-base'）
 * @returns AssistantContextRuntimeMode / AssistantContextRuntimeMode
 */''')

# --- resolveAssistantContextRuntimeMode ---
l = find(r'^function resolveAssistantContextRuntimeMode\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the assistant context runtime mode for a given route.
 * 为给定路由解析助手上下文运行时模式。
 *
 * @param route - Assistant route identifier / 助手路由标识符
 * @param environmentRouteOverride - Optional environment override / 可选环境覆盖
 * @returns AssistantContextRuntimeMode / AssistantContextRuntimeMode
 */''')

# --- resolveAssistantMemoryProjectionMode ---
l = find(r'^function resolveAssistantMemoryProjectionMode\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the memory projection mode for a given assistant route.
 * 为给定助手路由解析记忆投影模式。
 *
 * @param route - Assistant route identifier / 助手路由标识符
 * @returns MemoryProjectionMode / MemoryProjectionMode
 */''')

# --- combineAssistantRolePrompts ---
l = find(r'^function combineAssistantRolePrompts\(')
if l >= 0:
    add(l + 1, '''/**
 * Combine system and user role prompts into a single prompt string.
 * 将系统与用户角色提示组合为单个提示字符串。
 *
 * @param systemPrompt - System-level prompt / 系统级提示
 * @param userPrompt - User-level prompt / 用户级提示
 * @returns Combined prompt string / 组合后的提示字符串
 */''')

# --- recordQaContextRuntimeObservation ---
l = find(r'^function recordQaContextRuntimeObservation\(')
if l >= 0:
    add(l + 1, '''/**
 * Record a context runtime observation into the detailed trace sink.
 * 将上下文运行时观测记录写入详细追踪接收器。
 *
 * @param trace - Detailed trace sink / 详细追踪接收器
 * @param report - Observation report to record / 要记录的观测报告
 */''')

# --- getAssistantScopeLabel ---
l = find(r'^function getAssistantScopeLabel\(')
if l >= 0:
    add(l + 1, '''/**
 * Compute a human-readable label for an assistant turn scope.
 * 为助手轮次作用域计算人类可读的标签。
 *
 * @param request - Assistant turn request / 助手轮次请求
 * @returns Scope label string / 作用域标签字符串
 */''')

# --- getAssistantModel ---
l = find(r'^async function getAssistantModel\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the assistant model id from the AI provider config.
 * 从 AI Provider 配置中解析助手模型 id。
 *
 * @param config - AI provider configuration / AI Provider 配置
 * @returns Model identifier / 模型标识符
 */''')

# --- resolveAssistantContextWindow ---
l = find(r'^async function resolveAssistantContextWindow\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the effective context window for a model from its provider config.
 * 从 Provider 配置中解析模型的有效上下文窗口。
 *
 * @param config - AI provider configuration / AI Provider 配置
 * @param model - Model identifier / 模型标识符
 * @returns EffectiveContextWindow / EffectiveContextWindow
 */''')

# --- resolveConfiguredAssistantContextWindow ---
l = find(r'^function resolveConfiguredAssistantContextWindow\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the configured context window without querying the remote model.
 * 在不查询远程模型的情况下解析已配置的上下文窗口。
 *
 * @param config - AI provider configuration / AI Provider 配置
 * @returns EffectiveContextWindow / EffectiveContextWindow
 */''')

# --- runAssistantPublicTool ---
l = find(r'^async function runAssistantPublicTool\(')
if l >= 0:
    add(l + 1, '''/**
 * Run a public assistant tool with progress events and trace logging.
 * 运行公共助手工具，发送进度事件并记录追踪。
 *
 * @param tool - Tool identifier / 工具标识符
 * @param startedMessage - Message shown when tool starts / 工具启动时显示的消息
 * @param action - Synchronous or async tool action / 同步或异步的工具动作
 * @param completedMessage - Message factory on completion / 完成时的消息工厂
 * @param onToolEvent - Optional tool event listener / 可选工具事件监听器
 * @param onDetailedTrace - Optional detailed trace sink / 可选详细追踪接收器
 * @param detailedInput - Optional input for tracing / 可选用于追踪的输入
 * @param detailedOutput - Optional output factory for tracing / 可选用于追踪的输出工厂
 * @returns Tool result / 工具结果
 */''')

# --- resolveAssistantAnswerContext ---
l = find(r'^async function resolveAssistantAnswerContext\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the full answer context: sources, memory, and knowledge retrieval.
 * 解析完整回答上下文：来源、记忆与知识检索。
 *
 * @param libraryPath - Note library path or null / 笔记库路径或 null
 * @param request - Assistant turn request / 助手轮次请求
 * @param signal - Abort signal for cancellation / 用于取消的中止信号
 * @param assistantMineru - Optional MinerU runtime config / 可选 MinerU 运行时配置
 * @param onToolEvent - Optional tool event listener / 可选工具事件监听器
 * @param onDetailedTrace - Optional detailed trace sink / 可选详细追踪接收器
 * @param options - Retrieval options / 检索选项
 * @returns Assembled context with sources and memory / 包含来源和记忆的组装上下文
 */''')

# --- throwIfAssistantCancelled ---
l = find(r'^function throwIfAssistantCancelled\(')
if l >= 0:
    add(l + 1, '''/**
 * Throw if the given signal has been aborted.
 * 若给定信号已被中止则抛出异常。
 *
 * @param signal - AbortSignal to check / 要检查的 AbortSignal
 */''')

# --- searchKeywordCandidates ---
l = find(r'^function searchKeywordCandidates\(')
if l >= 0:
    add(l + 1, '''/**
 * Search the note index for keyword-based candidates.
 * 搜索笔记索引以获取基于关键词的候选结果。
 *
 * @param query - Search query / 搜索查询
 * @param limit - Maximum results to return / 最大返回结果数
 * @returns Array of SearchCandidate / SearchCandidate 数组
 */''')

# --- createKeywordCandidates ---
l = find(r'^function createKeywordCandidates\(')
if l >= 0:
    add(l + 1, '''/**
 * Build search candidates from indexed entries matched against a query.
 * 从与查询匹配的索引条目构建搜索候选结果。
 *
 * @param entries - Indexed entries to search / 要搜索的索引条目
 * @param query - Search query / 搜索查询
 * @param libraryPath - Library path for linking / 用于链接的库路径
 * @param scopedIndex - Optional scoped note index / 可选的限定范围笔记索引
 * @param limit - Maximum results / 最大结果数
 * @returns Array of SearchCandidate / SearchCandidate 数组
 */''')

# --- readSearchTerms ---
l = find(r'^function readSearchTerms\(')
if l >= 0:
    add(l + 1, '''/**
 * Parse and validate an array of search terms from IPC input.
 * 从 IPC 输入解析并校验搜索词数组。
 *
 * @param value - Raw IPC payload / 原始 IPC 载荷
 * @returns Validated search terms array / 校验通过的搜索词数组
 */''')

# --- searchNotesUnified ---
l = find(r'^async function searchNotesUnified\(')
if l >= 0:
    add(l + 1, '''/**
 * Unified note search: keyword candidates plus optional lexical index search.
 * 统一笔记搜索：关键词候选加可选词法索引搜索。
 *
 * @param query - Search query text / 搜索查询文本
 * @returns UnifiedSearchOutcome combining both search strategies / 结合两种搜索策略的 UnifiedSearchOutcome
 */''')

# --- readAiProviderConfig ---
l = find(r'^function readAiProviderConfig\(')
if l >= 0:
    add(l + 1, '''/**
 * Read the current AI provider configuration from the store.
 * 从存储中读取当前 AI Provider 配置。
 *
 * @returns AiProviderConfig or undefined / AiProviderConfig 或 undefined
 */''')

# --- resolveAiApiKey ---
l = find(r'^function resolveAiApiKey\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the API key for an AI provider, falling back to the previous config.
 * 解析 AI Provider 的 API 密钥，回退到先前配置。
 *
 * @param config - Current AI provider config / 当前 AI Provider 配置
 * @param previous - Previous config for fallback / 用于回退的先前配置
 * @returns API key string or undefined / API 密钥字符串或 undefined
 */''')

# --- readAiModelSettingsInput ---
l = find(r'^function readAiModelSettingsInput\(')
if l >= 0:
    add(l + 1, '''/**
 * Read AI model settings input from the store, with optional migration persistence.
 * 从存储中读取 AI 模型设置输入，可选迁移持久化。
 *
 * @param persistMigration - Whether to persist migration results / 是否持久化迁移结果
 * @returns AiModelSettingsInput / AiModelSettingsInput
 */''')

# --- getAiModelSettings ---
l = find(r'^function getAiModelSettings\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the current AI model settings.
 * 返回当前 AI 模型设置。
 *
 * @returns AiModelSettings / AiModelSettings
 */''')

# --- prepareAiModelSettings ---
l = find(r'^function prepareAiModelSettings\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate and normalize AI model settings input from IPC.
 * 从 IPC 校验并规范化 AI 模型设置输入。
 *
 * @param value - Raw IPC payload / 原始 IPC 载荷
 * @returns Validated AiModelSettingsInput / 校验通过的 AiModelSettingsInput
 */''')

# --- isMemoryExtractionRouteEnabled ---
l = find(r'^function isMemoryExtractionRouteEnabled\(')
if l >= 0:
    add(l + 1, '''/**
 * Check whether memory extraction is enabled for a given route and agent.
 * 检查给定路由和代理是否启用了记忆提取。
 *
 * @param route - Extraction route identifier / 提取路由标识符
 * @param agentId - Agent identifier / 代理标识符
 * @returns True when extraction is enabled / 提取启用时为 true
 */''')

# --- recordModelSaveAudit (extend existing) ---
l = find(r'^function recordModelSaveAudit\(')
if l >= 0:
    add(l + 1, '''/**
 * Record a model configuration save audit entry for diagnostics.
 * 记录模型配置保存审计条目以用于诊断。
 *
 * @param change - The configuration change attempted / 尝试的配置变更
 * @param result - Save result or undefined on failure / 保存结果，失败时为 undefined
 * @param failure - Thrown error if save failed / 保存失败时的抛出错误
 */''')
    existing = find(r'模型保存审计', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** Model save audit: only record structure, slot origin, and whether a key exists — never record key content. */')

# --- saveModelConfiguration (extend existing) ---
l = find(r'^function saveModelConfiguration\(')
if l >= 0:
    add(l + 1, '''/**
 * Save a model configuration change with audit and runtime sync.
 * 通过审计和运行时同步保存模型配置变更。
 *
 * @param change - Configuration change descriptor / 配置变更描述符
 * @param confirmationToken - Optional confirmation token for destructive changes / 破坏性变更的可选确认令牌
 * @returns ModelConfigurationSaveResult / ModelConfigurationSaveResult
 */''')
    existing = find(r'所有模型保存入口复用', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** All model save entry points share the same commit gate; runtime updates only after the configuration is persisted as a whole. */')

# --- requireSavedModelConfiguration (extend existing) ---
l = find(r'^function requireSavedModelConfiguration\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate that a save result was committed, throwing otherwise.
 * 校验保存结果已提交，否则抛出异常。
 *
 * @param result - Save result to validate / 要校验的保存结果
 */''')
    existing = find(r'兼容 IPC 也不能直接覆盖', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** IPC compatibility also cannot directly overwrite a referenced address; interactive confirmation is done through the unified save interface. */')

# --- saveAiModelSettings ---
l = find(r'^function saveAiModelSettings\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate, save, and sync AI model settings from IPC input.
 * 从 IPC 输入校验、保存并同步 AI 模型设置。
 *
 * @param value - Raw IPC payload / 原始 IPC 载荷
 * @returns Updated AiModelSettings / 更新后的 AiModelSettings
 */''')

# --- readAiExtensionsSettings (extend existing) ---
l = find(r'^function readAiExtensionsSettings\(')
if l >= 0:
    add(l + 1, '''/**
 * Read the AI extensions settings from the store.
 * 从存储中读取 AI 扩展设置。
 *
 * @returns AiExtensionsSettings / AiExtensionsSettings
 */''')
    existing = find(r'读取技能配置', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** Read skill configuration and clean up legacy connection fields from older versions. */')

# --- saveAiExtensionsSettings ---
l = find(r'^function saveAiExtensionsSettings\(')
if l >= 0:
    add(l + 1, '''/**
 * Validate and save AI extensions settings from IPC input.
 * 从 IPC 输入校验并保存 AI 扩展设置。
 *
 * @param value - Raw IPC payload / 原始 IPC 载荷
 * @returns Updated AiExtensionsSettings / 更新后的 AiExtensionsSettings
 */''')

# --- updateDirectorySkillOverride (extend existing) ---
l = find(r'^function updateDirectorySkillOverride\(')
if l >= 0:
    add(l + 1, '''/**
 * Update a directory skill override in the store.
 * 更新存储中的目录技能覆盖。
 *
 * @param name - Skill name / 技能名称
 * @param patch - Fields to update / 要更新的字段
 * @returns Updated AiExtensionsSettings / 更新后的 AiExtensionsSettings
 */''')
    existing = find(r'目录技能登记的内存写入', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** In-memory directory skill registry write; callers guarantee name has passed runtime scan (real skill). */')

# --- findDirectorySkillOverride ---
l = find(r'^function findDirectorySkillOverride\(')
if l >= 0:
    add(l + 1, '''/**
 * Find a directory skill override by name from the store.
 * 从存储中按名称查找目录技能覆盖。
 *
 * @param name - Skill name / 技能名称
 * @returns DirectorySkillOverride or undefined / DirectorySkillOverride 或 undefined
 */''')

# --- findDirectorySkillEntry ---
l = find(r'^function findDirectorySkillEntry\(')
if l >= 0:
    add(l + 1, '''/**
 * Find a directory skill entry by name from the skill directory loader.
 * 从技能目录加载器中按名称查找目录技能条目。
 *
 * @param name - Skill name / 技能名称
 * @returns DirectorySkillEntry / DirectorySkillEntry
 */''')

# --- getAssistantAiOptions ---
l = find(r'^function getAssistantAiOptions\(')
if l >= 0:
    add(l + 1, '''/**
 * Assemble the full assistant AI options payload for the renderer.
 * 为渲染进程组装完整的助手 AI 选项载荷。
 *
 * @param _requestedProfileId - Optional profile id (unused currently) / 可选 Profile id（当前未使用）
 * @returns AssistantAiOptions / AssistantAiOptions
 */''')

# --- resolveAssistantProfile ---
l = find(r'^function resolveAssistantProfile\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the AI model profile by id, falling back to the default profile.
 * 按 id 解析 AI 模型 Profile，回退到默认 Profile。
 *
 * @param profileId - Profile identifier or undefined / Profile 标识符或 undefined
 * @returns AiModelProfile / AiModelProfile
 */''')

# --- getBundledAiSkillsPath (extend existing) ---
l = find(r'^function getBundledAiSkillsPath\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the absolute path to the bundled AI skills directory.
 * 返回打包 AI 技能目录的绝对路径。
 *
 * @returns Absolute path to bundled skills / 打包技能的绝对路径
 */''')
    existing = find(r'开发与发布使用同一组技能资源', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** Dev and release use the same bundled skill resources; release does not depend on project or user workspace. */')

# --- readAssistantSkills (extend existing) ---
l = find(r'^function readAssistantSkills\(')
if l >= 0:
    add(l + 1, '''/**
 * Read and return the combined list of assistant skills.
 * 读取并返回合并后的助手技能列表。
 *
 * @returns Combined assistant skills array / 合并后的助手技能数组
 */''')
    existing = find(r'先补齐内置资源', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** Ensure bundled resources first, then read user enabled state, shared by menu and request validation. */')

# --- attachProfileSecrets ---
l = find(r'^function attachProfileSecrets\(')
if l >= 0:
    add(l + 1, '''/**
 * Attach decrypted profile secrets to model settings before persistence.
 * 在持久化前将解密的 Profile 密钥附加到模型设置。
 *
 * @param settings - Model settings to augment / 要补充的模型设置
 * @returns Settings with attached secrets / 附加了密钥的设置
 */''')

# --- persistAiModelSettings ---
l = find(r'^function persistAiModelSettings\(')
if l >= 0:
    add(l + 1, '''/**
 * Persist AI model settings to the store, encrypting secrets.
 * 将 AI 模型设置持久化到存储，加密密钥。
 *
 * @param settings - Model settings to persist / 要持久化的模型设置
 * @param targetStore - electron-store instance to write / 要写入的 electron-store 实例
 */''')

# --- readAiProfileSecrets ---
l = find(r'^function readAiProfileSecrets\(')
if l >= 0:
    add(l + 1, '''/**
 * Read and decrypt AI profile secrets from the store.
 * 从存储中读取并解密 AI Profile 密钥。
 *
 * @returns Decrypted profile secrets map / 解密后的 Profile 密钥映射
 */''')

# --- decryptAiSecret ---
l = find(r'^function decryptAiSecret\(')
if l >= 0:
    add(l + 1, '''/**
 * Decrypt a single encrypted AI secret using Electron safeStorage.
 * 使用 Electron safeStorage 解密单个加密 AI 密钥。
 *
 * @param encrypted - Encrypted secret string / 加密的密钥字符串
 * @returns Decrypted plaintext or undefined / 解密后的明文或 undefined
 */''')

# --- resolveProfileApiKey ---
l = find(r'^function resolveProfileApiKey\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the API key for a profile, falling back to the previous profile.
 * 解析 Profile 的 API 密钥，回退到先前 Profile。
 *
 * @param profile - Current AI model profile / 当前 AI 模型 Profile
 * @param previous - Previous profile for fallback / 用于回退的先前 Profile
 * @returns API key string or undefined / API 密钥字符串或 undefined
 */''')

# --- syncLegacyDefaultProfile ---
l = find(r'^function syncLegacyDefaultProfile\(')
if l >= 0:
    add(l + 1, '''/**
 * Sync the legacy default profile from the old provider config to the model hub.
 * 将旧版 Provider 配置中的默认 Profile 同步到模型中枢。
 *
 * @param config - Legacy AI provider config / 旧版 AI Provider 配置
 * @param targetStore - electron-store instance to write / 要写入的 electron-store 实例
 */''')

# --- backupContext ---
l = find(r'^function backupContext\(')
if l >= 0:
    add(l + 1, '''/**
 * Build the backup context descriptor for the current workspace.
 * 为当前工作区构建备份上下文描述符。
 *
 * @returns BackupConfiguration for the workspace / 工作区的 BackupConfiguration
 */''')
    # Extend existing IPC Handlers comment
    existing = find(r'^// IPC Handlers')
    if existing >= 0:
        add(existing + 1, '// IPC 处理器')

# --- initializeWorkspaceBackupService ---
l = find(r'^function initializeWorkspaceBackupService\(')
if l >= 0:
    add(l + 1, '''/**
 * Initialize the workspace backup service and schedule periodic snapshots.
 * 初始化工作区备份服务并调度定期快照。
 */''')

# --- desktopText ---
l = find(r'^function desktopText\(')
if l >= 0:
    add(l + 1, '''/**
 * Translate a desktop translation key with optional interpolation values.
 * 使用可选插值值翻译桌面翻译键。
 *
 * @param source - Translation key / 翻译键
 * @param values - Interpolation values / 插值
 * @returns Translated string / 翻译后的字符串
 */''')

# --- stopWorkspaceMemory (extend existing) ---
l = find(r'^async function stopWorkspaceMemory\(')
if l >= 0:
    add(l + 1, '''/**
 * Release all old workspace memory owners before activation; the schema and memory algorithms stay unchanged.
 * 激活前释放所有旧工作区记忆持有者；schema 与记忆算法保持不变。
 */''')
    existing = find(r'Release all old workspace memory', max(0, l - 3))
    if existing >= 0:
        # Already has English; add Chinese
        pass

# --- activateWorkspaceRuntime ---
l = find(r'^async function activateWorkspaceRuntime\(')
if l >= 0:
    add(l + 1, '''/**
 * Activate the workspace runtime: start watching, rebuild index, and initialize pipeline.
 * 激活工作区运行时：开始监听、重建索引并初始化流水线。
 */''')

# --- resumeWorkspaceBackground ---
l = find(r'^function resumeWorkspaceBackground\(')
if l >= 0:
    add(l + 1, '''/**
 * Resume workspace background services after a migration or restore completes.
 * 在迁移或恢复完成后恢复工作区后台服务。
 */''')

# --- migratedWorkspaceConfig (extend existing) ---
l = find(r'^function migratedWorkspaceConfig\(')
if l >= 0:
    add(l + 1, '''/**
 * Preserve globals and external-library registrations; publish related path fields in one electron-store write.
 * 保留全局项与外部库注册；在一个 electron-store 写入中发布相关路径字段。
 *
 * @param operationId - Migration operation identifier / 迁移操作标识符
 * @param context - Physical restore context with old and new paths / 含新旧路径的物理恢复上下文
 * @returns Migrated config object / 迁移后的配置对象
 */''')
    existing = find(r'Preserve globals and external-library', max(0, l - 3))
    if existing >= 0:
        pass  # Already has English

# --- initializeWorkspaceMigrationService ---
l = find(r'^function initializeWorkspaceMigrationService\(')
if l >= 0:
    add(l + 1, '''/**
 * Initialize the workspace migration service with recovery and commit callbacks.
 * 使用恢复和提交回调初始化工作区迁移服务。
 */''')

# --- requireMigrationService ---
l = find(r'^function requireMigrationService\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the workspace migration service or throw if not initialized.
 * 返回工作区迁移服务，未初始化时抛出异常。
 *
 * @returns WorkspaceMigrationService instance / WorkspaceMigrationService 实例
 */''')

# --- hasOnboardingUsage (extend existing) ---
l = find(r'^function hasOnboardingUsage\(')
if l >= 0:
    add(l + 1, '''/**
 * Check persisted usage before creating defaults; preferences alone are not prior use.
 * 在创建默认值前检查持久化使用记录；仅偏好设置不构成先前使用。
 *
 * @returns True when prior usage detected / 检测到先前使用时为 true
 */''')
    existing = find(r'Inspect persisted usage before', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** 在创建默认值前检查持久化使用记录；仅偏好设置不构成先前使用。 */')

# --- initializeOnboarding (extend existing) ---
l = find(r'^function initializeOnboarding\(')
if l >= 0:
    add(l + 1, '''/**
 * One local-profile service owns progress; it never writes to a selected library.
 * 一个本地 Profile 服务拥有进度；它从不写入选定的库。
 *
 * @returns OnboardingService instance / OnboardingService 实例
 */''')
    existing = find(r'One local-profile service owns', max(0, l - 3))
    if existing >= 0:
        add(existing + 1, '/** 一个本地 Profile 服务拥有进度；它从不写入选定的库。 */')

# --- getOnboardingState ---
l = find(r'^function getOnboardingState\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the current onboarding state.
 * 返回当前引导状态。
 *
 * @returns OnboardingState / OnboardingState
 */''')

# --- readCurrentWikiDocumentOutline ---
l = find(r'^async function readCurrentWikiDocumentOutline\(')
if l >= 0:
    add(l + 1, '''/**
 * Read and construct the document outline for a wiki document.
 * 读取并构造 Wiki 文档的文档大纲。
 *
 * @param targetPath - Materials library path / 资料库路径
 * @param documentId - Document identifier / 文档标识符
 * @returns WikiDocumentOutline / WikiDocumentOutline
 */''')

# --- resolveWikiNodeQuestionsViaIpc ---
l = find(r'^async function resolveWikiNodeQuestionsViaIpc\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve wiki node questions for a specific node, via IPC from the renderer.
 * 通过渲染进程 IPC 解析特定 Wiki 节点的问题。
 *
 * @param libraryPath - Materials library path / 资料库路径
 * @param documentId - Document identifier / 文档标识符
 * @param nodeId - Wiki node identifier / Wiki 节点标识符
 * @param refresh - Force re-resolution / 强制重新解析
 * @returns WikiNodeQuestionsResult / WikiNodeQuestionsResult
 */''')

# --- confirmCloudDocument ---
l = find(r'^async function confirmCloudDocument\(')
if l >= 0:
    add(l + 1, '''/**
 * Confirm a cloud document exists in the materials library; prompt user if missing.
 * 确认资料库中存在云文档；缺失时提示用户。
 *
 * @param libraryPath - Materials library path / 资料库路径
 * @param documentId - Document identifier / 文档标识符
 * @returns True when the document is confirmed / 文档确认存在时为 true
 */''')

# --- assertNoteWindow ---
l = find(r'^function assertNoteWindow\(')
if l >= 0:
    add(l + 1, '''/**
 * Assert that an IPC event comes from a valid note window with a saved note path.
 * 断言 IPC 事件来自具有已保存笔记路径的有效笔记窗口。
 *
 * @param event - IPC event to validate / 要校验的 IPC 事件
 */''')

# --- documentSaveAsRequests ---
l = find(r'^const documentSaveAsRequests')
if l >= 0:
    add(l + 1, '''/**
 * Deduplication map for document save-as requests to avoid concurrent saves.
 * 文档另存为请求的去重映射，避免并发保存。
 */''')

# --- capabilityContext ---
l = find(r'^function capabilityContext\(')
if l >= 0:
    add(l + 1, '''/**
 * Build the capability context descriptor for the current user and app state.
 * 为当前用户与应用状态构建能力上下文描述符。
 *
 * @param request - Optional capability probe request / 可选能力探针请求
 * @returns CapabilitySnapshot / CapabilitySnapshot
 */''')

# --- createSafeDiagnostics ---
l = find(r'^function createSafeDiagnostics\(')
if l >= 0:
    add(l + 1, '''/**
 * Create a redacted diagnostics object safe for external sharing.
 * 创建对外分享安全的脱敏诊断对象。
 *
 * @returns Sanitized diagnostics object / 脱敏后的诊断对象
 */''')

# --- resolveWebSearchRuntime ---
l = find(r'^function resolveWebSearchRuntime\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the web search runtime configuration for a request.
 * 为请求解析 Web 搜索运行时配置。
 *
 * @param request - Request with optional webSearch toggle / 含可选 webSearch 开关的请求
 * @returns WebSearch context for the tool / 工具的 WebSearch 上下文
 */''')

# --- resolveAssistantMineruRuntimeConfig ---
l = find(r'^function resolveAssistantMineruRuntimeConfig\(')
if l >= 0:
    add(l + 1, '''/**
 * Resolve the MinerU runtime configuration for assistant use.
 * 为助手使用解析 MinerU 运行时配置。
 *
 * @returns MineruRuntimeConfig or undefined / MineruRuntimeConfig 或 undefined
 */''')

# --- collectAssistantAttachmentsFromPaths ---
l = find(r'^function collectAssistantAttachmentsFromPaths\(')
if l >= 0:
    add(l + 1, '''/**
 * Collect assistant attachments from local file paths with size/type validation.
 * 从本地文件路径收集助手附件，进行大小/类型校验。
 *
 * @param filePaths - Absolute file paths to attach / 要附加的绝对文件路径
 * @returns Array of validated AssistantAttachment / 校验后的 AssistantAttachment 数组
 */''')

# --- getNoteAnalysisRepository ---
l = find(r'^function getNoteAnalysisRepository\(')
if l >= 0:
    add(l + 1, '''/**
 * Return the note analysis batch repository for the current workspace.
 * 返回当前工作区的笔记分析批量存储库。
 *
 * @returns NoteAnalysisBatchRepository instance / NoteAnalysisBatchRepository 实例
 */''')

# --- isNoteAnalysisSourceCurrent ---
l = find(r'^function isNoteAnalysisSourceCurrent\(')
if l >= 0:
    add(l + 1, '''/**
 * Check whether a note analysis source hash matches the current note content.
 * 检查笔记分析源哈希是否匹配当前笔记内容。
 *
 * @param libraryPath - Note library path / 笔记库路径
 * @param notePath - Note file path / 笔记文件路径
 * @param sourceHash - Source hash to compare / 要比较的源哈希
 * @returns True when source is current / 源为最新时为 true
 */''')

# --- exposeNoteAnalysisRun ---
l = find(r'^function exposeNoteAnalysisRun\(')
if l >= 0:
    add(l + 1, '''/**
 * Expose a note analysis run detail, stripping internal fields for the renderer.
 * 暴露笔记分析运行详情，为渲染进程剥离内部字段。
 *
 * @param repository - Analysis repository / 分析存储库
 * @param run - Run detail or null / 运行详情或 null
 * @returns Sanitized run detail or null / 脱敏后的运行详情或 null
 */''')

# --- getNoteAnalysisConfig ---
l = find(r'^function getNoteAnalysisConfig\(')
if l >= 0:
    add(l + 1, '''/**
 * Read the AI provider config for note analysis.
 * 读取笔记分析的 AI Provider 配置。
 *
 * @returns AiProviderConfig / AiProviderConfig
 */''')

# --- startNoteAnalysis ---
l = find(r'^function startNoteAnalysis\(')
if l >= 0:
    add(l + 1, '''/**
 * Start a note analysis run for a given file.
 * 为给定文件启动笔记分析运行。
 *
 * @param filePath - Note file to analyze / 要分析的笔记文件
 * @param selectedModel - Optional model override / 可选模型覆盖
 * @returns NoteAnalysisRunDetail / NoteAnalysisRunDetail
 */''')

# --- changeEntryPath ---
l = find(r'^async function changeEntryPath\(')
if l >= 0:
    add(l + 1, '''/**
 * Change an entry's path in the library: move, rename, and update index.
 * 更改库中条目的路径：移动、重命名并更新索引。
 *
 * @param oldPath - Current entry path / 当前条目路径
 * @param move - Async function that performs the move / 执行移动的异步函数
 * @returns New path or null on failure / 新路径，失败时为 null
 */''')

# --- trashEntry ---
l = find(r'^async function trashEntry\(')
if l >= 0:
    add(l + 1, '''/**
 * Move an entry to the system trash and remove it from the library index.
 * 将条目移至系统回收站并从库索引中移除。
 *
 * @param entryPath - Entry path to trash / 要移入回收站的条目路径
 * @returns True when successfully trashed / 成功移入回收站时为 true
 */''')

# --- toEditorImageBuffer ---
l = find(r'^function toEditorImageBuffer\(')
if l >= 0:
    add(l + 1, '''/**
 * Convert a raw IPC value to a validated image Buffer for the editor.
 * 将原始 IPC 值转换为经校验的编辑器图像 Buffer。
 *
 * @param value - Raw IPC payload (base64 or buffer) / 原始 IPC 载荷（base64 或 buffer）
 * @returns Image Buffer / 图像 Buffer
 */''')

# --- sanitizeFileName ---
l = find(r'^function sanitizeFileName\(')
if l >= 0:
    add(l + 1, '''/**
 * Sanitize a file name by removing invalid path characters and control characters.
 * 通过移除无效路径字符和控制字符来清理文件名。
 *
 * @param fileName - Raw file name / 原始文件名
 * @returns Sanitized file name / 清理后的文件名
 */''')

# --- isInsideDirectory ---
l = find(r'^function isInsideDirectory\(')
if l >= 0:
    add(l + 1, '''/**
 * Check whether a candidate path is inside a parent directory.
 * 检查候选路径是否在父目录内。
 *
 * @param candidatePath - Path to check / 要检查的路径
 * @param parentPath - Parent directory path / 父目录路径
 * @returns True when candidate is inside parent / 候选在父目录内时为 true
 */''')

# ============================================================
# Apply insertions (process in reverse to preserve line numbers)
# ============================================================
insertions.sort(key=lambda x: x[0], reverse=True)

for line_idx, text in insertions:
    lines.insert(line_idx, text)

with open(FILE, 'w') as f:
    f.writelines(lines)

print(f"Applied {len(insertions)} insertions to {FILE}")
print(f"New line count: {len(lines)}")