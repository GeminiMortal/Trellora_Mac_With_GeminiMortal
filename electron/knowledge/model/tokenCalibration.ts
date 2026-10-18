/**
 * Token calibration: maintains per-model calibration ratios by observing the
 * difference between locally estimated and provider-reported input tokens.
 * Uses EWMA smoothing; deliberately has no persistence so version changes
 * don't reuse stale ratios.
 * Token 校准：通过观察本地估算与提供商报告的输入 token 差异来维护每模型校准比率。
 * 使用 EWMA 平滑；故意不持久化，避免版本变更复用过时比率。
 */

import type { AssistantTokenUsage } from './tokenEstimator.ts';

/** Version identifier for the calibration schema / 校准 schema 的版本标识。 */
export const TOKEN_CALIBRATION_VERSION = 'estimator-v2-envelope-v1';

/**
 * Key for identifying a calibration entry: provider + model + call kind + versions.
 * 校准条目的标识键：提供商 + 模型 + 调用类型 + 版本。
 */
export interface TokenCalibrationKey {
  providerKind: string;
  model: string;
  callKind?: string;
  tokenizerVersion?: string;
  requestEnvelopeVersion?: string;
}

/**
 * A single calibration observation pairing local estimate with provider truth.
 * 单次校准观测，将本地估算与提供商真实值配对。
 */
export interface TokenCalibrationSample {
  key: TokenCalibrationKey;
  locallyEstimatedTokens: number;
  providerInputTokens: number;
}

const MIN_CALIBRATION = 1.05;
const MAX_CALIBRATION = 1.35;
const EWMA_ALPHA = 0.25;

/**
 * In-process calibration cache that tracks per-model multiplier ratios.
 * Uses EWMA smoothing; no persistence — version changes invalidate stale ratios.
 * 进程内校准缓存，跟踪每模型的乘数比率。使用 EWMA 平滑；不持久化——版本变更使过时比率失效。
 */
export class TokenCalibrationStore {
  private readonly ratios = new Map<string, number>();

  getMultiplier(key: TokenCalibrationKey): number {
    return this.ratios.get(createCalibrationKey(key)) ?? MIN_CALIBRATION;
  }

  observe(sample: TokenCalibrationSample): number {
    if (!Number.isSafeInteger(sample.locallyEstimatedTokens) || sample.locallyEstimatedTokens < 1) {
      return this.getMultiplier(sample.key);
    }
    if (!Number.isSafeInteger(sample.providerInputTokens) || sample.providerInputTokens < 1) {
      return this.getMultiplier(sample.key);
    }
    const key = createCalibrationKey(sample.key);
    const ratio = clamp(sample.providerInputTokens / sample.locallyEstimatedTokens, MIN_CALIBRATION, MAX_CALIBRATION);
    const next = clamp((this.ratios.get(key) ?? ratio) * (1 - EWMA_ALPHA) + ratio * EWMA_ALPHA, MIN_CALIBRATION, MAX_CALIBRATION);
    this.ratios.set(key, next);
    return next;
  }

  observeUsage(key: TokenCalibrationKey, localTokens: number, usage: AssistantTokenUsage | undefined): number {
    return usage?.inputTokens === undefined
      ? this.getMultiplier(key)
      : this.observe({ key, locallyEstimatedTokens: localTokens, providerInputTokens: usage.inputTokens });
  }

  fingerprint(key: TokenCalibrationKey): string {
    return `${createCalibrationKey(key)}:${this.getMultiplier(key).toFixed(4)}`;
  }
}

/** Singleton calibration store shared across the application / 应用内共享的单例校准缓存。 */
export const sharedTokenCalibrationStore = new TokenCalibrationStore();

function createCalibrationKey(key: TokenCalibrationKey): string {
  return [
    key.providerKind.trim().toLowerCase(),
    key.model.trim(),
    key.callKind?.trim() ?? '*',
    key.tokenizerVersion ?? TOKEN_CALIBRATION_VERSION,
    key.requestEnvelopeVersion ?? 'chat-completions-v1',
  ].join('\u0000');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
