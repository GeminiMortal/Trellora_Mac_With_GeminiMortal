/**
 * QA context memory adapter bridging QA memory storage to the ContextMemoryAdapter interface.
 * 问答上下文记忆适配器，将问答记忆存储桥接到 ContextMemoryAdapter 接口。
 */
import { createHash } from 'node:crypto';
import type { QaMemoryRepository } from './qaMemoryRepository.ts';
import {
  renderQaSummaryBlock,
  selectQaRollingSummaryBlocks,
  selectQaShortTermEntries,
} from './qaMemoryAssembler.ts';
import { projectQaRecentTurnsToHistoryMessages } from './qaCanonicalHistory.ts';
import type { QaCanonicalHistoryMessage, QaRecentCompleteTurn, QaRecentTurn, QaStoredTurn } from './qaMemoryTypes.ts';
import type {
  ContextMemoryAdapter,
  ContextMemoryRequest,
  ContextMemoryResult,
} from '../context/contextMemoryTypes.ts';
import type { ContextMaterial } from '../context/contextRuntimeTypes.ts';

/** Minimal repository interface needed by the adapter. / 适配器所需的最小仓储接口。 */
type QaMemoryReader = Pick<QaMemoryRepository, 'listSummaries' | 'loadRecentCompleteTurns'>;

/**
 * ContextMemoryAdapter implementation backed by QA memory storage.
 * Provides M1 rolling summaries, M2 short-term turns, and canonical L2 projections.
 *
 * 基于问答记忆存储的 ContextMemoryAdapter 实现。
 * 提供 M1 滚动摘要、M2 短期轮次和规范 L2 投影。
 */
export class QaContextMemoryAdapter implements ContextMemoryAdapter {
  /** Adapter identifier / 适配器标识 */
  readonly id = 'qa-memory';

  constructor(private readonly repository: QaMemoryReader) {}

  /**
   * Check whether this adapter supports the given request route.
   * 检查此适配器是否支持给定的请求路由。
   *
   * @param request - Context memory request / 上下文记忆请求
   * @returns True if route is 'chat' or 'knowledge-base' / 路由为 'chat' 或 'knowledge-base' 时返回 true
   */
  supports(request: ContextMemoryRequest): boolean {
    return request.route === 'chat' || request.route === 'knowledge-base';
  }

  /**
   * Load context memory materials (M1 summaries + M2 short-term) for a session.
   * 加载会话的上下文记忆材料（M1 摘要 + M2 短期记忆）。
   *
   * @param request - Context memory request / 上下文记忆请求
   * @returns Materials with version hash and diagnostics / 包含版本哈希和诊断信息的材料
   */
  async load(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    if (!this.supports(request)) throw new Error(`QA Memory Adapter 不支持 Route：${request.route}`);
    const summaries = selectQaRollingSummaryBlocks(
      this.repository.listSummaries(request.sessionId),
      normalizeBudget(request.budgets.summaryTokens),
    ).blocks;
    const recentTurns = this.repository.loadRecentCompleteTurns(request.sessionId);
    const hotEntries = selectQaShortTermEntries(
      recentTurns.map(toStoredTurn).reverse(),
      normalizeBudget(request.budgets.hotTokens),
    );
    const materials: ContextMaterial[] = [
      ...summaries.map((block, index): ContextMaterial => ({
        id: `qa-summary:${String(block.turnFrom).padStart(10, '0')}`,
        zone: 'conversation-summary',
        channel: 'user',
        trust: 'untrusted-memory',
        content: `${index === 0 ? '[Zone M1 滚动摘要]\n' : ''}${renderQaSummaryBlock(block)}`,
        priority: 60,
        protected: false,
        compressStrategy: 'summary',
        source: {
          kind: 'qa-summary-batch',
          id: block.batchId,
          version: block.updatedAt,
        },
        tokenBudget: { absoluteMax: 800 },
        stalePolicy: 'refresh',
        overflowPolicy: 'drop',
        provenance: {
          sessionId: request.sessionId,
          turnSeqs: range(block.turnFrom, block.turnTo),
        },
        cache: { stability: 'session', prefixEligible: false },
      })),
      ...hotEntries.map((entry, index): ContextMaterial => ({
        id: `qa-hot:${String(entry.turn.turnSeq).padStart(10, '0')}`,
        zone: 'conversation-hot',
        channel: 'user',
        trust: 'untrusted-memory',
        content: `${index === 0 ? '[Zone M2 短期记忆]\n' : ''}${entry.content}`,
        priority: 70,
        protected: false,
        compressStrategy: 'truncate',
        source: {
          kind: 'qa-turn',
          id: entry.turn.turnId,
          version: entry.turn.finishedAt ?? entry.turn.createdAt,
        },
        tokenBudget: { absoluteMax: 1_500 },
        stalePolicy: 'keep',
        overflowPolicy: 'compress',
        provenance: {
          sessionId: request.sessionId,
          turnSeqs: [entry.turn.turnSeq],
        },
        cache: { stability: 'session', prefixEligible: false },
      })),
    ];
    return {
      materials,
      version: createMemoryVersion(request.sessionId, materials),
      diagnostics: {
        source: this.id,
        loadedTurns: hotEntries.length,
        loadedSummaries: summaries.length,
        recalledTurns: 0,
        staleItems: 0,
      },
    };
  }

  /**
   * WK-M9 canonical L2 projector. Reads exactly the shared recent-complete turn
   * contract and never reads legacy summary/checkpoint/profile tables.
   *
   * WK-M9 规范 L2 投影器。仅读取共享的最近完整轮次契约，
   * 不读取旧版摘要/检查点/画像表。
   *
   * @param request - Context memory request / 上下文记忆请求
   * @returns Canonical L2 materials / 规范 L2 材料
   */
  async loadCanonical(request: ContextMemoryRequest): Promise<ContextMemoryResult> {
    if (!this.supports(request)) throw new Error(`QA Memory Adapter 不支持 Route：${request.route}`);
    const recentTurns = this.repository.loadRecentCompleteTurns(request.sessionId);
    const materials = recentTurns.map((turn, index): ContextMaterial => ({
      id: `qa-canonical-l2:${turn.turnId}`,
      zone: 'conversation-hot',
      channel: 'user',
      trust: 'untrusted-memory',
      content: `${index === 0 ? '[最近 5 轮完整对话]\n' : ''}用户：${turn.userText}\n助手：${turn.assistantText}`,
      priority: 75,
      protected: false,
      compressStrategy: 'checkpoint',
      source: {
        kind: 'qa-turn',
        id: turn.turnId,
        version: turn.finishedAt ?? turn.createdAt,
      },
      stalePolicy: 'keep',
      overflowPolicy: 'compress',
      provenance: { sessionId: request.sessionId, turnSeqs: [turn.turnSeq] },
      cache: { stability: 'session', prefixEligible: false },
    }));
    return {
      materials,
      version: createMemoryVersion(`${request.sessionId}:canonical-l2`, materials),
      diagnostics: {
        source: `${this.id}:canonical-l2`,
        loadedTurns: recentTurns.length,
        loadedSummaries: 0,
        recalledTurns: 0,
        staleItems: 0,
      },
    };
  }

  /**
   * Explicit M2 view for Query Rewrite; never reads summaries or old recall.
   * 用于问题改写的显式 M2 视图；不读取摘要或旧召回。
   *
   * @param request - Context memory request / 上下文记忆请求
   * @returns Recent turns for query rewrite / 用于问题改写的最近轮次
   */
  async loadQueryRewriteHistory(request: ContextMemoryRequest): Promise<QaRecentTurn[]> {
    if (!this.supports(request)) return [];
    return this.repository.loadRecentCompleteTurns(request.sessionId, 3).map((turn) => ({
      userText: turn.userText,
      answerHead: turn.assistantText.slice(0, 200),
    }));
  }

  /**
   * Load recent complete turns for the given request's session.
   * 加载给定请求会话的最近完整轮次。
   *
   * @param request - Context memory request / 上下文记忆请求
   * @returns Array of recent complete turns / 最近完整轮次数组
   */
  loadRecentCompleteTurns(request: ContextMemoryRequest): QaRecentCompleteTurn[] {
    if (!this.supports(request)) return [];
    return this.repository.loadRecentCompleteTurns(request.sessionId);
  }

  /**
   * Project recent complete turns into canonical history messages for replay.
   * 将最近完整轮次投影为规范历史消息用于重放。
   *
   * @param request - Context memory request / 上下文记忆请求
   * @returns Array of canonical history messages / 规范历史消息数组
   */
  loadRecentHistoryMessages(request: ContextMemoryRequest): QaCanonicalHistoryMessage[] {
    return projectQaRecentTurnsToHistoryMessages(this.loadRecentCompleteTurns(request));
  }
}

function toStoredTurn(turn: QaRecentCompleteTurn): QaStoredTurn {
  return {
    turnId: turn.turnId,
    requestId: turn.requestId,
    attemptNo: turn.attemptNo,
    turnSeq: turn.turnSeq,
    userText: turn.userText,
    assistantText: turn.assistantText,
    scopeLabel: turn.scopeLabel,
    status: turn.status,
    createdAt: turn.createdAt,
    finishedAt: turn.finishedAt,
  };
}

function normalizeBudget(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, value) : 0;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

function createMemoryVersion(sessionId: string, materials: readonly ContextMaterial[]): string {
  return createHash('sha256').update(JSON.stringify({
    sessionId,
    sources: materials.map((material) => ({
      id: material.id,
      sourceId: material.source.id,
      sourceVersion: material.source.version,
    })),
  }), 'utf8').digest('hex');
}
