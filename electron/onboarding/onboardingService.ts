/**
 * Onboarding course state machine: step progress, AI connection readiness checks and practice-request tracking.
 * 引导课程状态机：步骤进度、AI 连接就绪检查与练习请求跟踪。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AiModelProfile, AiProviderConfig } from '../knowledge/ai/aiTypes.ts';
import type { OnboardingAction, OnboardingPracticeBinding, OnboardingProgress, OnboardingState, OnboardingUpdate } from '../../shared/onboarding.ts';

/** Ports injected by the host process for persistence, profiles and notifications / 宿主进程注入的持久化、配置与通知端口 */
interface OnboardingPorts {
  /** Read the persisted onboarding value / 读取已持久化的引导数据 */
  read: () => unknown;
  /** Persist the onboarding progress / 持久化引导进度 */
  write: (progress: OnboardingProgress) => void;
  /** Whether the app already has AI usage on record / 应用是否已有 AI 使用记录 */
  hasUsage: () => boolean;
  /** All saved AI model profiles / 所有已保存的 AI 模型配置 */
  profiles: () => AiModelProfile[];
  /** Identifier of the default model profile / 默认模型配置的标识 */
  defaultProfileId: () => string;
  /** Current workspace and library paths / 当前工作区与资料库路径 */
  paths: () => { workspacePath: string; libraryPath: string | null };
  /** Notify the renderer of a state change / 将状态变化通知渲染进程 */
  notify: (state: OnboardingState) => void;
}

/** Process-local record of a connection test / 连接测试的进程内记录 */
interface TestRecord {
  /** Token identifying this test / 标识本次测试的令牌 */
  token: string;
  /** Config fingerprint the test was started with / 发起测试时的配置指纹 */
  fingerprint: string;
  /** Test outcome once known / 测试结果（得知后填充） */
  available?: boolean;
}

/** Process-local record of a bound practice request / 已绑定练习请求的进程内记录 */
interface PracticeRequest {
  /** Sending window identifier / 发送方窗口标识 */
  senderId: number;
  /** Bound practice session identifier / 绑定的练习会话标识 */
  sessionId: string;
  /** Model profile used for the request / 请求使用的模型配置 */
  profileId: string;
  /** Config fingerprint frozen at send time / 发送时冻结的配置指纹 */
  fingerprint: string;
}

const actions: readonly OnboardingAction[] = ['start', 'acknowledge-menus', 'skip-ai', 'defer', 'resume', 'dismiss', 'finish', 'show-ai', 'show-question'];
const statuses = ['pending', 'active', 'deferred', 'completed', 'dismissed'];
const steps = ['menus', 'ai', 'question'];

/**
 * Migrate once without turning legacy completion into completion of the new course.
 * 一次性迁移旧数据，但不把旧版完成状态当作新课程已完成。
 *
 * @param value - Persisted onboarding value of unknown shape / 形状未知的已持久化引导数据
 * @param hasUsage - Whether the app already recorded AI usage / 应用是否已记录 AI 使用
 * @returns Migrated progress state / 迁移后的进度状态
 */
export function migrateOnboarding(value: unknown, hasUsage: boolean): OnboardingProgress {
  const previous = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (previous.version === 2) {
    const progress = previous.progress as OnboardingProgress['progress'] | undefined;
    // Invalid v2 documents fail loudly instead of silently resetting user progress.
    // 无效的 v2 文档会显式报错，而不是静默重置用户进度。
    if (!statuses.includes(String(previous.status)) || !steps.includes(String(previous.currentStep))
      || !Number.isSafeInteger(previous.revision) || Number(previous.revision) < 0
      || !progress || !['pending', 'done'].includes(progress.menus)
      || !['pending', 'skipped', 'done'].includes(progress.ai) || !['pending', 'done'].includes(progress.question)) {
      throw new Error('引导状态无效，请从设置中重试。');
    }
    // Whitelist persisted fields, including when reading an older renderer's result.
    // 只保留白名单字段持久化，读取旧渲染进程的结果时同样如此。
    return {
      version: 2, flowVersion: 1, revision: Number(previous.revision),
      status: previous.status as OnboardingProgress['status'], currentStep: previous.currentStep as OnboardingProgress['currentStep'],
      progress: { ...progress }, sampleImported: Boolean(previous.sampleImported),
      updatedAt: typeof previous.updatedAt === 'string' ? previous.updatedAt : new Date().toISOString(),
      ...(typeof previous.selectedProfileId === 'string' ? { selectedProfileId: previous.selectedProfileId } : {}),
      ...(typeof previous.practiceSessionId === 'string' ? { practiceSessionId: previous.practiceSessionId } : {}),
      ...(typeof previous.successfulRequestId === 'string' ? { successfulRequestId: previous.successfulRequestId } : {}),
      ...(typeof previous.completedAt === 'string' ? { completedAt: previous.completedAt } : {}),
    };
  }
  // Legacy v1 data only ever dismisses the new course; it never marks the new course completed.
  // 旧版 v1 数据只会让新课程显示为已关闭，绝不会标记新课程为已完成。
  const legacyPending = previous.version === 1 && previous.status === 'pending';
  const legacyEnded = previous.version === 1 && ['skipped', 'completed'].includes(String(previous.status));
  return {
    version: 2, flowVersion: 1, revision: 0,
    status: legacyEnded || (!legacyPending && (hasUsage || previous.sampleImported)) ? 'dismissed' : 'pending',
    currentStep: 'menus', progress: { menus: 'pending', ai: 'pending', question: 'pending' },
    sampleImported: Boolean(previous.sampleImported), updatedAt: new Date().toISOString(),
  };
}

/**
 * Tests and request attestations remain process-local and never contain a plaintext key.
 * 测试与请求凭据仅保留在进程内，绝不包含明文密钥。
 */
export class OnboardingService {
  private progress?: OnboardingProgress;
  private readonly salt = randomBytes(32);
  private readonly tests = new Map<string, TestRecord>();
  private readonly requests = new Map<string, PracticeRequest>();
  private readonly bindings = new Map<number, { sessionId: string; profileId: string }>();
  private readonly savedFingerprints = new Map<string, string>();

  /**
   * Create the service over the given host ports.
   * 基于给定的宿主端口创建服务。
   *
   * @param ports - Persistence, profile and notification callbacks / 持久化、配置与通知回调
   */
  constructor(private readonly ports: OnboardingPorts) {}

  /**
   * Load or migrate persisted progress and seed saved profile fingerprints.
   * 加载或迁移已持久化的进度，并记录各模型配置的指纹。
   *
   * @returns The current onboarding state / 当前引导状态
   */
  initialize(): OnboardingState {
    const value = this.ports.read();
    const progress = migrateOnboarding(value, value ? false : this.ports.hasUsage());
    if (!value || (value as { version?: unknown }).version !== 2) this.ports.write(progress);
    this.progress = progress;
    for (const profile of this.ports.profiles()) this.savedFingerprints.set(profile.id, this.fingerprint(profile.config));
    return this.get();
  }

  /**
   * The saved connection is rechecked each read; a historical check is not runtime readiness.
   * 每次读取都会重新检查已保存的连接；历史检查结果不代表运行时就绪。
   *
   * @returns Current onboarding state including connection status / 含连接状态的当前引导状态
   */
  get(): OnboardingState {
    if (!this.progress) return this.initialize();
    const profiles = this.ports.profiles();
    const selectedId = this.progress.selectedProfileId ?? this.ports.defaultProfileId();
    // Fall back from the preferred profile to any configured one before reporting missing.
    // 报告“缺失”之前，从首选配置回退到任意已配置的连接。
    const preferred = profiles.find(item => item.id === selectedId);
    const profile = preferred && this.isConfigured(preferred.config) ? preferred
      : profiles.find(item => item.id === this.ports.defaultProfileId() && this.isConfigured(item.config))
        ?? profiles.find(item => this.isConfigured(item.config)) ?? preferred;
    const configured = profile && this.isConfigured(profile.config);
    const record = profile ? this.tests.get(profile.id) : undefined;
    // Only a test that matches the current config fingerprint counts toward readiness.
    // 只有与当前配置指纹一致的测试才计入就绪状态。
    const matches = profile && record?.fingerprint === this.fingerprint(profile.config);
    const state = !configured ? 'missing' : matches && record?.available === true ? 'tested'
      : matches && record?.available === false ? 'failed' : 'saved-unverified';
    return { ...this.progress, progress: { ...this.progress.progress }, ...this.ports.paths(),
      connection: { profileId: profile?.id ?? null, state, testAttempted: Boolean(matches && record?.available !== undefined) } };
  }

  /**
   * Apply a user action to the onboarding state machine.
   * 将用户操作应用到引导状态机。
   *
   * @param input - Action plus expected revision for optimistic concurrency / 操作及用于乐观并发的期望修订号
   * @returns Updated onboarding state / 更新后的引导状态
   */
  update(input: OnboardingUpdate): OnboardingState {
    if (!input || !actions.includes(input.action)) throw new Error('引导操作无效。');
    this.checkRevision(input.expectedRevision);
    const state = this.get();
    if (state.status === 'completed') {
      if (input.action === 'finish') return state;
      throw new Error('引导已完成，请使用重新查看入口。');
    }
    // Each transition re-validates prerequisites so out-of-order UI events cannot skip steps.
    // 每次迁移都重新校验前置条件，防止乱序的界面事件跳过步骤。
    const next = { ...this.progress!, progress: { ...state.progress } };
    switch (input.action) {
      case 'start': case 'resume': next.status = 'active'; break;
      case 'defer': next.status = 'deferred'; break;
      case 'dismiss': next.status = 'dismissed'; break;
      case 'acknowledge-menus':
        if (state.status !== 'active' || state.currentStep !== 'menus') throw new Error('请先开始菜单介绍。');
        next.progress.menus = 'done'; next.currentStep = 'ai'; break;
      case 'skip-ai':
        if (state.status !== 'active' || state.progress.menus !== 'done') throw new Error('请先完成菜单介绍。');
        next.progress.ai = 'skipped'; next.currentStep = 'question'; break;
      case 'show-ai':
        if (state.status !== 'active' || state.progress.menus !== 'done') throw new Error('请先完成菜单介绍。');
        next.currentStep = 'ai'; break;
      case 'show-question':
        if (state.status !== 'active' || state.progress.menus !== 'done') throw new Error('请先完成菜单介绍。');
        if (state.connection.state === 'missing') throw new Error('请先保存当前模型设置。');
        next.currentStep = 'question';
        if (state.connection.state === 'tested') next.progress.ai = 'done';
        else next.progress.ai = 'pending';
        break;
      case 'finish':
        if (state.progress.menus !== 'done' || state.progress.ai !== 'done' || state.progress.question !== 'done'
          || !state.successfulRequestId || state.connection.state !== 'tested') throw new Error('请先使用当前模型完成一次提问。');
        next.status = 'completed'; next.completedAt = new Date().toISOString(); break;
    }
    return this.commit(next);
  }

  /**
   * Switch the selected model profile, resetting practice progress when still in the course.
   * 切换所选模型配置；课程进行中时重置练习进度。
   *
   * @param profileId - Identifier of an already saved profile / 已保存配置的标识
   * @returns Updated onboarding state / 更新后的引导状态
   */
  selectProfile(profileId: string): OnboardingState {
    if (!this.ports.profiles().some(profile => profile.id === profileId)) throw new Error('请先保存这条模型连接。');
    const state = this.get();
    if (state.selectedProfileId === profileId) return state;
    return this.commit({ ...this.progress!, selectedProfileId: profileId,
      ...(state.status === 'completed' ? {} : { successfulRequestId: undefined, progress: { ...state.progress, ai: 'pending' as const, question: 'pending' as const } }) });
  }

  /**
   * Invalidation also fences responses from a test started before the user edited its draft.
   * 失效操作同时隔离用户修改草稿之前发起的测试所返回的结果。
   *
   * @param profileId - Profile whose draft changed / 草稿已变更的模型配置
   * @returns Updated onboarding state / 更新后的引导状态
   */
  invalidateDraft(profileId: string): OnboardingState {
    this.tests.delete(profileId);
    return this.publish();
  }

  /**
   * Begin a connection test for a profile and return its fencing token.
   * 为指定配置发起连接测试，并返回用于隔离的令牌。
   *
   * @param profileId - Profile being tested / 被测试的模型配置
   * @param config - Config snapshot the test runs against / 测试所依据的配置快照
   * @returns Token to pass to finishTest / 供 finishTest 使用的令牌
   */
  beginTest(profileId: string, config: AiProviderConfig): string {
    const token = randomUUID();
    this.tests.set(profileId, { token, fingerprint: this.fingerprint(config) });
    return token;
  }

  /**
   * Record a connection-test outcome; stale tokens are ignored.
   * 记录连接测试结果；过期令牌会被忽略。
   *
   * @param profileId - Profile that was tested / 被测试的模型配置
   * @param token - Token returned by beginTest / beginTest 返回的令牌
   * @param available - Whether the connection succeeded / 连接是否成功
   * @returns Nothing / 无返回值
   */
  finishTest(profileId: string, token: string, available: boolean): void {
    const record = this.tests.get(profileId);
    if (!record || record.token !== token) return;
    this.tests.set(profileId, { ...record, available });
    this.publish();
  }

  /**
   * Refresh saved-profile fingerprints after settings persistence and reset practice steps when the config changed.
   * 设置持久化后刷新已保存配置指纹；配置变化时重置练习步骤。
   *
   * @param profileId - Optional profile to select after the refresh / 刷新后可选要选中的配置
   * @returns Updated onboarding state / 更新后的引导状态
   */
  profilesSaved(profileId?: string): OnboardingState {
    const state = this.get();
    const profiles = this.ports.profiles();
    const selected = profiles.find(profile => profile.id === state.selectedProfileId);
    // A changed fingerprint means the user edited the connection; earlier practice proof no longer counts.
    // 指纹变化说明用户修改了连接配置；此前的练习凭据不再有效。
    const changed = state.selectedProfileId && (!selected || this.savedFingerprints.get(selected.id) !== this.fingerprint(selected.config));
    this.savedFingerprints.clear();
    for (const profile of profiles) this.savedFingerprints.set(profile.id, this.fingerprint(profile.config));
    if (changed && state.status !== 'completed') this.commit({ ...this.progress!, successfulRequestId: undefined,
      progress: { ...state.progress, ai: 'pending', question: 'pending' } });
    if (profileId) this.selectProfile(profileId);
    return this.publish();
  }

  /**
   * The caller verifies that this is an owned, empty chat session before binding.
   * 调用方在绑定前需确认这是一个归属明确的空聊天会话。
   *
   * @param senderId - Sending window identifier / 发送方窗口标识
   * @param input - Practice session binding request / 练习会话绑定请求
   * @returns Updated onboarding state / 更新后的引导状态
   */
  bindPractice(senderId: number, input: OnboardingPracticeBinding): OnboardingState {
    this.checkRevision(input.expectedRevision);
    const state = this.get();
    if (state.status !== 'completed' && (state.status !== 'active' || state.currentStep !== 'question')) throw new Error('请先配置模型并进入第一次提问。');
    const profile = this.ports.profiles().find(item => item.id === input.profileId);
    if (!profile || !this.isConfigured(profile.config)) throw new Error('选定的语言模型尚未配置。');
    this.bindings.set(senderId, { sessionId: input.sessionId, profileId: profile.id });
    if (state.status === 'completed') return state;
    return this.commit({ ...this.progress!, practiceSessionId: input.sessionId, selectedProfileId: profile.id });
  }

  /**
   * Freeze the actual resolved model at send time, not the default model at completion time.
   * 在发送时刻冻结实际解析出的模型，而不是完成时刻的默认模型。
   *
   * @param senderId - Sending window identifier / 发送方窗口标识
   * @param input - Outgoing request details / 即将发出的请求详情
   * @returns True when the request is registered as a practice request / 请求被登记为练习请求时为 true
   */
  beginPracticeRequest(senderId: number, input: { requestId: string; sessionId?: string; scope: string; profile: AiModelProfile; webSearch?: string }): boolean {
    const binding = this.bindings.get(senderId);
    const state = this.get();
    // Scope and web-search fences keep off-course requests out of the practice proof.
    // 范围与联网搜索的围栏把偏离课程的请求排除在练习凭据之外。
    if (!binding || binding.sessionId !== input.sessionId || binding.profileId !== input.profile.id || input.scope !== 'chat'
      || input.webSearch !== 'off' || !['active', 'deferred', 'completed'].includes(state.status)) return false;
    this.requests.set(input.requestId, { senderId, ...binding, fingerprint: this.fingerprint(input.profile.config) });
    return true;
  }

  /**
   * Whether the given request belongs to the given sender as a practice request.
   * 判断指定请求是否属于该发送方的练习请求。
   *
   * @param senderId - Sending window identifier / 发送方窗口标识
   * @param requestId - Request identifier / 请求标识
   * @returns True when the request is a practice request of that sender / 该请求属于此发送方的练习请求时为 true
   */
  isPracticeRequest(senderId: number, requestId: string): boolean {
    return this.requests.get(requestId)?.senderId === senderId;
  }

  /**
   * Only the normal main-process chat finalization calls this after successful persistence.
   * 仅主进程常规聊天收尾流程在成功持久化后调用本方法。
   *
   * @param senderId - Sending window identifier / 发送方窗口标识
   * @param requestId - Practice request identifier / 练习请求标识
   * @param input - Finalized answer and persistence outcome / 收尾后的回答与持久化结果
   * @returns Nothing / 无返回值
   */
  completePractice(senderId: number, requestId: string, input: { answer: string; persisted: boolean; sessionId?: string; complete: boolean }): void {
    const request = this.requests.get(requestId);
    if (!request || request.senderId !== senderId || !input.persisted || !input.complete
      || !input.answer.trim() || input.sessionId !== request.sessionId) return;
    const state = this.get();
    if (state.status === 'completed' || state.status === 'dismissed' || state.practiceSessionId !== request.sessionId || state.selectedProfileId !== request.profileId) return;
    if (state.successfulRequestId === requestId && state.progress.question === 'done') return;
    // The config must still match the fingerprint frozen at send time to count as a successful practice.
    // 配置必须仍与发送时冻结的指纹一致，才能计为练习成功。
    const profile = this.ports.profiles().find(item => item.id === request.profileId);
    if (!profile || this.fingerprint(profile.config) !== request.fingerprint) return;
    this.tests.set(profile.id, { token: randomUUID(), fingerprint: request.fingerprint, available: true });
    this.commit({ ...this.progress!, successfulRequestId: requestId, progress: { ...state.progress, ai: 'done', question: 'done' } });
  }

  /**
   * Drop a tracked practice request once it can no longer influence progress.
   * 当跟踪的练习请求不再影响进度时将其丢弃。
   *
   * @param senderId - Sending window identifier / 发送方窗口标识
   * @param requestId - Request identifier / 请求标识
   * @returns Nothing / 无返回值
   */
  forgetRequest(senderId: number, requestId: string): void {
    if (this.requests.get(requestId)?.senderId === senderId) this.requests.delete(requestId);
  }

  /**
   * Record that the sample content was imported.
   * 记录示例内容已导入。
   *
   * @returns Updated onboarding state / 更新后的引导状态
   */
  sampleImported(): OnboardingState { return this.commit({ ...this.progress!, sampleImported: true }); }

  // A usable connection needs a model, a valid HTTP(S) endpoint and either a local Ollama or a key with consent.
  // 可用连接需要：模型名、有效的 HTTP(S) 地址，以及本地 Ollama 或“密钥 + 云端同意”。
  private isConfigured(config: AiProviderConfig): boolean {
    if (!config.model?.trim()) return false;
    try { const url = new URL(config.endpoint || (config.kind === 'ollama' ? 'http://127.0.0.1:11434' : '')); if (!['http:', 'https:'].includes(url.protocol)) return false; } catch { return false; }
    return config.kind === 'ollama' || Boolean(config.apiKey?.trim() && config.remoteContentConsent);
  }

  // The HMAC salt is process-local, so fingerprints cannot be compared across runs or leak key material.
  // HMAC 盐值仅存于进程内，指纹无法跨运行比对，也不会泄露密钥材料。
  private fingerprint(config: AiProviderConfig): string {
    return createHmac('sha256', this.salt).update(JSON.stringify({
      kind: config.kind, provider: config.kind === 'ollama' ? undefined : config.provider ?? 'custom',
      api: config.kind === 'ollama' ? 'ollama-chat' : config.api ?? 'openai-completions', endpoint: (config.endpoint || (config.kind === 'ollama' ? 'http://127.0.0.1:11434' : '')).trim().replace(/\/+$/, ''),
      model: config.model?.trim(), apiKey: config.kind === 'ollama' ? undefined : config.apiKey?.trim(), consent: config.kind === 'ollama' ? undefined : Boolean(config.remoteContentConsent),
      contextWindowTokens: config.contextWindowTokensSource === 'user' ? config.contextWindowTokens : undefined,
    })).digest('hex');
  }

  // Optimistic concurrency: every action must name the revision it was based on.
  // 乐观并发：每个操作都必须指明其所基于的修订号。
  private checkRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision !== this.get().revision) throw new Error('引导进度已更新，请重试当前操作。');
  }

  private commit(next: OnboardingProgress): OnboardingState {
    const updated = { ...next, revision: this.get().revision + 1, updatedAt: new Date().toISOString() };
    this.ports.write(updated); // Do not advance in-memory progress when persistence fails. / 持久化失败时不推进内存中的进度。
    this.progress = updated;
    return this.publish();
  }

  private publish(): OnboardingState { const state = this.get(); this.ports.notify(state); return state; }
}
