/**
 * Onboarding flow types, state, and bundled sample notes for the first-run experience.
 * 新手引导流程的类型、状态及内置示例笔记。
 */

/**
 * Steps of the onboarding flow.
 * 新手引导流程的步骤。
 */
export type OnboardingStep = 'menus' | 'ai' | 'question';

/**
 * Overall status of the onboarding flow.
 * 新手引导流程的总体状态。
 */
export type OnboardingStatus = 'pending' | 'active' | 'deferred' | 'completed' | 'dismissed';

/**
 * User actions that drive onboarding transitions.
 * 驱动新手引导状态迁移的用户操作。
 */
export type OnboardingAction = 'start' | 'acknowledge-menus' | 'skip-ai' | 'defer' | 'resume' | 'dismiss' | 'finish' | 'show-ai' | 'show-question';

/**
 * Persisted onboarding progress; only tutorial progress is persisted while credentials and answers stay in their existing stores.
 * 持久化的新手引导进度；只持久化教程进度，凭据与回答仍保存在原有存储中。
 */
export interface OnboardingProgress {
  /** Progress record schema version. / 进度记录结构版本。 */
  version: 2;
  /** Version of the onboarding flow definition. / 新手引导流程定义的版本。 */
  flowVersion: 1;
  /** Optimistic concurrency revision. / 乐观并发修订号。 */
  revision: number;
  /** Overall flow status. / 流程总体状态。 */
  status: OnboardingStatus;
  /** Step currently being shown. / 当前展示的步骤。 */
  currentStep: OnboardingStep;
  /** Per-step completion state. / 各步骤的完成状态。 */
  progress: { menus: 'pending' | 'done'; ai: 'pending' | 'skipped' | 'done'; question: 'pending' | 'done' };
  /** Model profile selected during onboarding. / 新手引导中选择的模型档案。 */
  selectedProfileId?: string;
  /** Practice chat session id. / 练习聊天会话 id。 */
  practiceSessionId?: string;
  /** Id of the first successful practice request. / 首次成功练习请求的 id。 */
  successfulRequestId?: string;
  /** Whether the bundled sample notes were imported. / 是否已导入内置示例笔记。 */
  sampleImported: boolean;
  /** ISO timestamp of the last progress update. / 最近一次进度更新的 ISO 时间戳。 */
  updatedAt: string;
  /** ISO timestamp of completion, when finished. / 完成时的 ISO 时间戳。 */
  completedAt?: string;
}

/**
 * State of the AI connection check during onboarding.
 * 新手引导期间 AI 连接检查的状态。
 */
export interface OnboardingConnection {
  /** Selected model profile id, or null when none is chosen. / 选择的模型档案 id；未选择时为 null。 */
  profileId: string | null;
  /** Connection state. / 连接状态。 */
  state: 'missing' | 'saved-unverified' | 'tested' | 'failed';
  /** Whether a connection test has been attempted. / 是否已尝试过连接测试。 */
  testAttempted: boolean;
}

/**
 * Full onboarding state combining progress with workspace and connection context.
 * 结合进度与工作区、连接上下文的完整新手引导状态。
 */
export interface OnboardingState extends OnboardingProgress {
  /** Absolute workspace path. / 工作区绝对路径。 */
  workspacePath: string;
  /** Active library path, or null when none is active. / 当前资料库路径；无时为 null。 */
  libraryPath: string | null;
  /** AI connection check state. / AI 连接检查状态。 */
  connection: OnboardingConnection;
}

/**
 * Request to advance the onboarding flow with optimistic concurrency control.
 * 在乐观并发控制下推进新手引导流程的请求。
 */
export interface OnboardingUpdate {
  /** Action to apply. / 要应用的操作。 */
  action: OnboardingAction;
  /** Revision the client expects to update. / 客户端期望更新的修订号。 */
  expectedRevision: number;
}

/**
 * Binding of a practice chat session to a model profile.
 * 练习聊天会话与模型档案的绑定。
 */
export interface OnboardingPracticeBinding {
  /** Model profile used for practice. / 用于练习的模型档案。 */
  profileId: string;
  /** Practice chat session id. / 练习聊天会话 id。 */
  sessionId: string;
  /** Revision the client expects to update. / 客户端期望更新的修订号。 */
  expectedRevision: number;
}

/**
 * Sample question the user practices with during onboarding.
 * 新手引导中用户练习使用的示例问题。
 */
export const ONBOARDING_QUESTION = '请用 3 个步骤教我整理一次项目会议纪要。';

/**
 * Bundled, fictional examples; importing uses exclusive creation and preserves user edits.
 * 内置的虚构示例；导入采用排他创建并保留用户编辑。
 */
export const ONBOARDING_SAMPLES = [
  { name: '欢迎使用 Trellora.md', content: '# 欢迎使用 Trellora\n\n这是一份可编辑的示例笔记。所有人物与项目均为虚构。\n\n## 先从本地开始\n\n修改这一段并等待保存。无需配置模型，也能编辑、保存和搜索关键词。\n\n## 连接笔记\n\n阅读 [[项目资料示例]]，尝试搜索“项目验收”。\n\n## 可选智能回答\n\n在设置中配置语言模型并检测连接后，可以让助手总结笔记。资料语义检索需要单独配置向量模型；PDF 云解析需要 MinerU。\n' },
  { name: '项目资料示例.md', content: '---\ntitle: 项目资料示例\ntags: [示例, 项目管理]\n---\n\n# 项目资料示例\n\n澄川科技的内部知识整理试点（虚构）由林晓负责。\n\n## 项目验收\n\n- 完成 20 份培训材料整理。\n- 用关键词检索“项目验收”，确认能找到本笔记。\n- 原始文件保存在所选笔记库中。\n\n## 待办\n\n- [ ] 编辑一次笔记并确认保存。\n- [ ] 回到 [[欢迎使用 Trellora]]。\n' },
];
