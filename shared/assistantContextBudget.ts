/**
 * Assistant context budget constants: window sizes, compaction ratio, and source budget.
 * 助手上下文预算常量：窗口大小、压缩比例与来源预算。
 */

/**
 * Legacy 128K baseline retained for older budgets and the explicit rollback profile.
 * 保留的 128K 旧基线，用于旧预算与显式回滚配置档。
 */
export const ASSISTANT_CONTEXT_BUDGET_TOKENS = 131_072;

/**
 * WeKnora-aligned L1 working-memory ceiling. Physical provider limits may be lower.
 * 与 WeKnora 对齐的 L1 工作记忆上限；实际供应商限制可能更低。
 */
export const ASSISTANT_WORKING_MEMORY_MAX_TOKENS = 200_000;

/**
 * Named large-window profiles used by runtime diagnostics and model settings.
 * 运行时诊断与模型设置使用的具名大窗口配置档。
 */
export const ASSISTANT_CONTEXT_RUNTIME_PROFILE_TOKENS = Object.freeze({
  /** 128K window profile. / 128K 窗口配置档。 */
  '128k': 131_072,
  /** 256K window profile. / 256K 窗口配置档。 */
  '256k': 262_144,
});

/**
 * Unknown models use the strict WeKnora-compatible 200K fallback.
 * 未知模型使用与 WeKnora 兼容的严格 200K 回退值。
 */
export const ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS = ASSISTANT_WORKING_MEMORY_MAX_TOKENS;

/**
 * Compact before the provider rejects a request; the remaining space is output/safety headroom.
 * 在供应商拒绝请求前触发压缩；剩余空间预留给输出与安全余量。
 */
export const ASSISTANT_AUTO_COMPACT_RATIO = 0.82;

/**
 * Leaves room for policy, question, short history, tool state, and output.
 * 为策略、提问、短历史、工具状态与输出预留空间。
 */
export const ASSISTANT_SOURCE_BUDGET_TOKENS = 20_000;
