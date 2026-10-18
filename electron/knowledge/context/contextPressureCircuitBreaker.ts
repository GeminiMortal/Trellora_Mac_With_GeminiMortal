/**
 * Circuit breaker that tracks pressure-reduction episodes and skips actions
 * that previously produced zero gain, preventing repeated ineffective work.
 * 断路器，跟踪压力削减 episode，跳过先前零收益的操作，避免重复无效工作。
 */
import { createHash } from 'node:crypto';
import type { ContextEnvelope, ContextPressureActionDiagnostics } from './contextRuntimeTypes.ts';

// Internal mutable state for a single pressure episode, keyed by session+route.
// 单个 pressure episode 的内部可变状态，按 session+route 索引。
interface PressureEpisodeState {
  pressureEpisodeId: string;
  fingerprint: string;
  windowTokens: number;
  zeroGainActions: Set<string>;
  consecutiveIneffectiveGains: number;
  updatedAt: number;
}

/**
 * Handle returned by the circuit breaker for a single pressure episode. Provides
 * methods to skip already-known-zero-gain actions and record new action outcomes.
 * 断路器为单个 pressure episode 返回的句柄，提供跳过已知零收益操作和记录新操作结果的方法。
 */
export interface PressureEpisodeHandle {
  pressureEpisodeId: string;
  materialFingerprint: string;
  minPressureGainTokens: number;
  shouldSkip(actionKey: string): boolean;
  record(actionKey: string, action: Pick<ContextPressureActionDiagnostics, 'beforeTokens' | 'afterTokens'>): {
    ineffective: boolean;
    tripped: boolean;
  };
}

const MAX_EPISODES = 100;

/**
 * In-process episode memory only. It never mutates Prompt authority or conversation state.
 * 仅保存在进程内存中，不会修改 Prompt 权限或对话状态。
 */
export class ContextPressureCircuitBreaker {
  private readonly episodes = new Map<string, PressureEpisodeState>();

  /**
   * Begins or resumes a pressure episode for the current session and route.
   * Returns a handle that records action outcomes and indicates when the breaker trips.
   * 为当前会话和路由开始或恢复一个 pressure episode。
   * 返回一个句柄，用于记录操作结果并在断路器触发时发出信号。
   *
   * @param input - Envelope and optional fingerprint override / 信封和可选的指纹覆盖
   * @returns Handle with skip/record methods / 带 skip/record 方法的句柄
   */
  begin(input: { envelope: ContextEnvelope; fingerprint?: string }): PressureEpisodeHandle {
    const fingerprint = input.fingerprint ?? createContextMaterialFingerprint(input.envelope);
    const windowTokens = input.envelope.windowProfile.effectiveContextTokens;
    const sessionKey = hash(`${input.envelope.scope.sessionId ?? input.envelope.scope.turnId ?? 'anonymous'}\u0000${input.envelope.route}`);
    let state = this.episodes.get(sessionKey);
    if (!state || state.fingerprint !== fingerprint || windowTokens > state.windowTokens) {
      state = {
        pressureEpisodeId: `pressure-${hash(`${sessionKey}\u0000${fingerprint}\u0000${windowTokens}`).slice(0, 24)}`,
        fingerprint,
        windowTokens,
        zeroGainActions: new Set(),
        consecutiveIneffectiveGains: 0,
        updatedAt: Date.now(),
      };
      this.episodes.set(sessionKey, state);
      this.trim();
    }
    state.updatedAt = Date.now();
    const minPressureGainTokens = Math.max(2_048, Math.floor(windowTokens * 0.01));
    return {
      pressureEpisodeId: state.pressureEpisodeId,
      materialFingerprint: fingerprint,
      minPressureGainTokens,
      shouldSkip: (actionKey) => state!.zeroGainActions.has(actionKey),
      record: (actionKey, action) => {
        const gain = Math.max(0, action.beforeTokens - action.afterTokens);
        if (gain === 0) state!.zeroGainActions.add(actionKey);
        if (gain < minPressureGainTokens) state!.consecutiveIneffectiveGains += 1;
        else state!.consecutiveIneffectiveGains = 0;
        state!.updatedAt = Date.now();
        return { ineffective: gain < minPressureGainTokens, tripped: state!.consecutiveIneffectiveGains >= 2 };
      },
    };
  }

  /**
   * Clears all tracked pressure episodes, resetting the circuit breaker state.
   * 清除所有已跟踪的 pressure episode，重置断路器状态。
   */
  clear(): void {
    this.episodes.clear();
  }

  // Evicts the oldest episodes when the map exceeds MAX_EPISODES to bound memory.
  // 当 episode 数量超过 MAX_EPISODES 时驱逐最旧的 episode 以限制内存使用。
  private trim(): void {
    if (this.episodes.size <= MAX_EPISODES) return;
    const oldest = [...this.episodes.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (const [key] of oldest.slice(0, this.episodes.size - MAX_EPISODES)) this.episodes.delete(key);
  }
}

/**
 * Produces a deterministic SHA-256 fingerprint of an envelope's material set,
 * used to detect when materials change between episodes.
 * 生成信封材料集的确定性 SHA-256 指纹，用于检测 episode 之间材料是否发生变化。
 *
 * @param envelope - The context envelope to fingerprint / 需要生成指纹的上下文信封
 * @returns Hex-encoded SHA-256 fingerprint / 十六进制编码的 SHA-256 指纹
 */
export function createContextMaterialFingerprint(envelope: ContextEnvelope): string {
  return hash(JSON.stringify({
    route: envelope.route,
    callKind: envelope.callKind,
    materials: [...envelope.materials]
      .map((material) => ({
        id: material.id,
        zone: material.zone,
        channel: material.channel,
        source: material.source,
        contentHash: hash(material.content),
        lifecycle: material.lifecycle,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }));
}

// SHA-256 hash helper used for fingerprinting and key generation.
// SHA-256 哈希辅助函数，用于生成指纹和键。
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
