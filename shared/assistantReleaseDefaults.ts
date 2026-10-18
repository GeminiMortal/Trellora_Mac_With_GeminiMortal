/**
 * Frozen default feature-mode flags applied uniformly across release builds.
 * 发行版统一应用的冻结功能模式默认开关。
 */

/**
 * Release-wide managed feature modes; the four long-term memory entry points are switched to canonical, while internal environment variables retain rollback ability.
 * 发行版统一管理的工程模式；长期记忆四入口已切 canonical，内部环境变量保留回滚能力。
 */
export const ASSISTANT_RELEASE_DEFAULTS = Object.freeze({
  /** Planner scope for the assistant. / 助手规划范围。 */
  assistantPlanMode: 'current-note',
  /** Adaptive context mode. / 自适应上下文模式。 */
  adaptiveContextMode: 'observe',
  /** Context runtime mode for the assistant. / 助手上下文运行时模式。 */
  assistantContextRuntimeMode: 'observe',
  /** Context runtime mode for chat scope. / 聊天范围的上下文运行时模式。 */
  assistantContextRuntimeChatMode: 'inherit',
  /** Context runtime mode for knowledge base scope. / 知识库范围的上下文运行时模式。 */
  assistantContextRuntimeKnowledgeBaseMode: 'inherit',
  /** Context runtime mode for direct current-note scope. / 当前笔记直连范围的上下文运行时模式。 */
  assistantContextRuntimeCurrentNoteDirectMode: 'inherit',
  /** Context runtime mode for ReAct current-note scope. / 当前笔记 ReAct 范围的上下文运行时模式。 */
  assistantContextRuntimeCurrentNoteReactMode: 'inherit',
  /** Memory projection mode for the assistant. / 助手记忆投影模式。 */
  assistantMemoryProjectionMode: 'canonical',
  /** Memory projection mode for chat scope. / 聊天范围的记忆投影模式。 */
  assistantMemoryProjectionChatMode: 'inherit',
  /** Memory projection mode for knowledge base scope. / 知识库范围的记忆投影模式。 */
  assistantMemoryProjectionKnowledgeBaseMode: 'inherit',
  /** Memory projection mode for direct current-note scope. / 当前笔记直连范围的记忆投影模式。 */
  assistantMemoryProjectionCurrentNoteDirectMode: 'inherit',
  /** Memory projection mode for ReAct current-note scope. / 当前笔记 ReAct 范围的记忆投影模式。 */
  assistantMemoryProjectionCurrentNoteReactMode: 'inherit',
} as const);
