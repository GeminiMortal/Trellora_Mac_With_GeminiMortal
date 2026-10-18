import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Simulate what the backend does
const DEFAULT_GRAPH_ENHANCEMENT_CONFIG = {
  schemaVersion: 1,
  enabled: false,
  maxChars: 6000,
  maxEntitiesPerChunk: 20,
  maxRelationsPerChunk: 30,
  promptVersion: 'graph-entities-v3',
  llmTimeoutMs: 60000,
  llmMaxOutputTokens: 4000,
  summaryBudgetTokens: 8000,
  globalSearchLevel: 1,
};

function boundedInteger(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedPromptVersion(value) {
  if (typeof value !== 'string') return DEFAULT_GRAPH_ENHANCEMENT_CONFIG.promptVersion;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !/^[\w.-]+$/u.test(trimmed)) return DEFAULT_GRAPH_ENHANCEMENT_CONFIG.promptVersion;
  return trimmed;
}

function normalizedSummaryPromptVersion(value) {
  if (typeof value !== 'string') return 'graph-summary-v1';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !/^[\w.-]+$/u.test(trimmed)) return 'graph-summary-v1';
  return trimmed;
}

function normalizeLibraryLeidenConfig(candidate) {
  const source = (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) ? candidate : {};
  return {
    resolution: typeof source.resolution === 'number' ? source.resolution : 1,
    maxDepth: boundedInteger(source.maxDepth, 4, 1, 8),
    minSplitSize: boundedInteger(source.minSplitSize, 3, 2, 100),
    seed: Number.isInteger(source.seed) ? source.seed : 42,
  };
}

function normalizeGraphEnhancementConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图谱增强配置必须是 JSON 对象。');
  const candidate = value;
  return {
    schemaVersion: 1,
    enabled: candidate.enabled === true,
    maxChars: boundedInteger(candidate.maxChars, 6000, 200, 20000),
    maxEntitiesPerChunk: boundedInteger(candidate.maxEntitiesPerChunk, 20, 1, 100),
    maxRelationsPerChunk: boundedInteger(candidate.maxRelationsPerChunk, 30, 1, 200),
    promptVersion: normalizedPromptVersion(candidate.promptVersion),
    llmTimeoutMs: boundedInteger(candidate.llmTimeoutMs, 60000, 5000, 600000),
    llmMaxOutputTokens: boundedInteger(candidate.llmMaxOutputTokens, 4000, 256, 65536),
    leidenConfig: normalizeLibraryLeidenConfig(candidate.leidenConfig),
    summaryPromptVersion: normalizedSummaryPromptVersion(candidate.summaryPromptVersion),
    summaryBudgetTokens: boundedInteger(candidate.summaryBudgetTokens, 8000, 4000, 32000),
    globalSearchLevel: boundedInteger(candidate.globalSearchLevel, 1, 0, 3),
    aliasArbitrationEnabled: candidate.aliasArbitrationEnabled === true,
  };
}

// === TEST ===
console.log('=== Graph Enhancement Config Test ===\n');

// Test 1: Patch-only (original broken behavior)
console.log('Test 1: Sending patch only { llmTimeoutMs: 120000 }');
const patchOnly = normalizeGraphEnhancementConfig({ llmTimeoutMs: 120000 });
console.log('  Result:', JSON.stringify(patchOnly));
console.log('  enabled:', patchOnly.enabled, '| llmTimeoutMs:', patchOnly.llmTimeoutMs);
console.log('  ❌ Bug: enabled becomes', patchOnly.enabled, '(was not in patch)\n');

// Test 2: Full config with merge (fixed behavior)
console.log('Test 2: Sending full config { enabled: true, llmTimeoutMs: 120000, ... }');
const fullConfig = normalizeGraphEnhancementConfig({
  enabled: true,
  llmTimeoutMs: 120000,
  maxChars: 6000,
  maxEntitiesPerChunk: 20,
  maxRelationsPerChunk: 30,
  promptVersion: 'graph-entities-v3',
  llmMaxOutputTokens: 4000,
  summaryBudgetTokens: 8000,
  globalSearchLevel: 1,
});
console.log('  Result:', JSON.stringify(fullConfig));
console.log('  enabled:', fullConfig.enabled, '| llmTimeoutMs:', fullConfig.llmTimeoutMs);
console.log('  ✅ Both preserved!\n');

// Test 3: Enabled + patch timeout (what the user does)
console.log('Test 3: Simulate user flow — enable then change timeout');
let currentConfig = normalizeGraphEnhancementConfig({
  enabled: true, llmTimeoutMs: 60000, maxChars: 6000, maxEntitiesPerChunk: 20, maxRelationsPerChunk: 30,
  promptVersion: 'graph-entities-v3', llmMaxOutputTokens: 4000, summaryBudgetTokens: 8000, globalSearchLevel: 1,
});
console.log('  After enable:', 'enabled=', currentConfig.enabled, '| llmTimeoutMs=', currentConfig.llmTimeoutMs);

// Simulate patch { llmTimeoutMs: 120000 } with merge
const patch = { llmTimeoutMs: 120000 };
const merged = { ...currentConfig, ...patch };
const saved = normalizeGraphEnhancementConfig(merged);
console.log('  After timeout change (merged):', 'enabled=', saved.enabled, '| llmTimeoutMs=', saved.llmTimeoutMs);
console.log('  ✅ enabled preserved:', saved.enabled === true);

// Test 4: What happens without merge — the original bug
console.log('\nTest 4: Without merge (original bug)');
const broken = normalizeGraphEnhancementConfig({ llmTimeoutMs: 120000 });
console.log('  Result: enabled=', broken.enabled, '| llmTimeoutMs=', broken.llmTimeoutMs);
console.log('  ❌ enabled becomes false!');