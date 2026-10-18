import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const rootDir = '/Users/geminimortal/Desktop/trellora';
const electronPath = path.join(rootDir, 'node_modules/.pnpm/electron@44.7.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const mainJs = path.join(rootDir, 'dist-electron/main.js');
const TARGET = '/Users/geminimortal/Documents/Trellora工作区/knowledge-base/sut-20261009-171326';

const child = spawn(electronPath, [mainJs, '--remote-debugging-port=9333'], {
  cwd: rootDir, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production' },
});

// Wait for Electron to be ready
await new Promise(r => setTimeout(r, 8000));

async function cdpEval(wsUrl, expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = randomUUID();
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.close();
        if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text));
        else resolve(msg.result?.result?.value);
      }
    });
    ws.on('error', reject);
    setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 15000);
  });
}

async function getCdpTarget() {
  const res = await fetch('http://localhost:9333/json');
  const targets = await res.json();
  return targets.find(t => t.type === 'page')?.webSocketDebuggerUrl;
}

try {
  const wsUrl = await getCdpTarget();
  if (!wsUrl) throw new Error('No CDP target found');
  console.log('Connected to', wsUrl);

  const config = await cdpEval(wsUrl, `window.electronAPI.getLibraryGraphEnhancementConfig("${TARGET}")`);
  console.log('\n📋 Current config:');
  console.log(JSON.stringify(config, null, 2));

  // Step 1: Enable graph enhancement
  console.log('\n--- Enabling graph enhancement ---');
  const saved1 = await cdpEval(wsUrl, `
    window.electronAPI.saveLibraryGraphEnhancementConfig("${TARGET}", {
      enabled: true,
      llmTimeoutMs: ${config.llmTimeoutMs || 60000},
      maxChars: ${config.maxChars || 6000},
      maxEntitiesPerChunk: ${config.maxEntitiesPerChunk || 20},
      maxRelationsPerChunk: ${config.maxRelationsPerChunk || 30},
      promptVersion: "${config.promptVersion || 'graph-entities-v3'}",
      llmMaxOutputTokens: ${config.llmMaxOutputTokens || 4000},
      summaryBudgetTokens: ${config.summaryBudgetTokens || 8000},
      globalSearchLevel: ${config.globalSearchLevel || 1}
    })
  `);
  console.log('✅ After enabling: enabled=', saved1.enabled, 'llmTimeoutMs=', saved1.llmTimeoutMs);

  // Step 2: Simulate what the FIXED frontend does — merge ref + send full config
  console.log('\n--- Changing timeout to 120s (as fixed frontend would) ---');
  const saved2 = await cdpEval(wsUrl, `
    (async () => {
      const current = await window.electronAPI.getLibraryGraphEnhancementConfig("${TARGET}");
      const merged = { ...current, llmTimeoutMs: 120000 };
      return window.electronAPI.saveLibraryGraphEnhancementConfig("${TARGET}", merged);
    })()
  `);
  console.log('✅ After timeout change: enabled=', saved2.enabled, 'llmTimeoutMs=', saved2.llmTimeoutMs);

  // Step 3: Verify disk
  const disk = await cdpEval(wsUrl, `window.electronAPI.getLibraryGraphEnhancementConfig("${TARGET}")`);
  console.log('\n📋 Disk config:');
  console.log(JSON.stringify(disk, null, 2));

  if (disk.enabled === true && disk.llmTimeoutMs === 120000) {
    console.log('\n✅ PASS: Graph stayed enabled AND timeout saved correctly!');
  } else {
    console.log('\n❌ FAIL: enabled=', disk.enabled, 'llmTimeoutMs=', disk.llmTimeoutMs);
  }

} catch (e) {
  console.error('Error:', e.message);
} finally {
  child.kill();
}