/**
 * IPC sender-gate coverage audit for electron/main.ts.
 *
 * Verifies that every `registerAppHandler(...)` channel either
 *   1. is guarded by assertInternalRenderer / assertNoteWindow in its own handler body, OR
 *   2. relies on the central gate inside the registerAppHandler wrapper, AND the
 *      wrapper still contains that central assertInternalRenderer call.
 *
 * It also enumerates bare ipcMain.handle / ipcMain.on registrations so each can be
 * reviewed for an explicit sender assertion.
 *
 * Exit code 1 with a report when the central gate is missing or a bare
 * registration is found without a sender assertion inside its handler.
 *
 * electron/main.ts IPC 发送方门禁覆盖审计：
 *  - registerAppHandler 的每个通道要么自带 assertInternalRenderer/assertNoteWindow，
 *    要么依赖 wrapper 内的统一断言（并验证该断言仍然存在）。
 *  - 同时枚举绕过 wrapper 的裸 ipcMain.handle/on 注册，要求其 handler 内有显式断言。
 *  - 中心门禁缺失或裸注册未断言时，以非零码退出并输出报告。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../node_modules/typescript/lib/typescript.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(projectRoot, 'electron', 'main.ts');
const source = readFileSync(sourcePath, 'utf8');
const sf = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);

const ASSERT_RE = /assertInternalRenderer|assertNoteWindow/;
const EXTERNAL_GATE_RE = /externalWebContentsIds|isExternalWebNavigationAction/;

// Pre-index named top-level functions so handler references like
// ipcMain.on('channel', handleExternalWebNavigation) can be resolved to their bodies.
// 建立具名函数索引，使 ipcMain.on('channel', fnRef) 形态能解析到函数体内的断言。
const namedFunctions = new Map();
function indexNamedFunctions(node) {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) {
    namedFunctions.set(node.name.text, node.body.getText(sf));
  }
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer && ts.isFunctionLike(decl.initializer) && decl.initializer.body) {
        namedFunctions.set(decl.name.text, decl.initializer.body.getText(sf));
      }
    }
  }
  ts.forEachChild(node, indexNamedFunctions);
}
indexNamedFunctions(sf);

function handlerGuarded(handlerNodes) {
  const text = handlerNodes.map(a => a.getText(sf)).join(' ');
  if (ASSERT_RE.test(text)) return true;
  if (EXTERNAL_GATE_RE.test(text)) return true;
  // Resolve bare identifier references to their function bodies (max depth 2 to
  // avoid trivial cycles). 将裸函数引用解析到函数体内再判定。
  for (const node of handlerNodes) {
    if (ts.isIdentifier(node)) {
      const body = namedFunctions.get(node.text);
      if (body && (ASSERT_RE.test(body) || EXTERNAL_GATE_RE.test(body))) return true;
    }
  }
  return false;
}

/**
 * Statement-level assertion detection: comments mentioning assertInternalRenderer must
 * not count as a real gate. Walk executable statements inside a function body.
 * 语句级断言检测：提及 assertInternalRenderer 的注释不算真实门禁，只统计可执行语句。
 */
function bodyHasGateStatement(bodyNode) {
  let found = false;
  function walk(node) {
    if (found) return;
    // Skip comment trivia entirely. 完全跳过注释。
    if (ts.isExpressionStatement(node)) {
      const exprText = node.expression.getText(sf);
      if (/^assertInternalRenderer\s*\(/.test(exprText)) { found = true; return; }
    }
    ts.forEachChild(node, walk);
  }
  walk(bodyNode);
  return found;
}

const findings = { wrappedTotal: 0, wrappedUnguarded: [], bare: [], centralGatePresent: false, centralGateLine: 0 };

function visit(node) {
  // registerAppHandler('channel', handler) calls
  if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'registerAppHandler'
      && node.arguments.length >= 2) {
    const channel = ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : '<dynamic>';
    const guarded = ASSERT_RE.test(node.arguments[1].getText(sf));
    findings.wrappedTotal += 1;
    if (!guarded) findings.wrappedUnguarded.push(channel);
  }
  // bare ipcMain.handle / ipcMain.on outside the wrapper
  if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'ipcMain'
      && (node.expression.name.text === 'handle' || node.expression.name.text === 'on')) {
    const first = node.arguments[0]?.getText(sf) ?? '';
    if (first !== 'channel') { // `channel` is the wrapper's own internal registration
      const guarded = handlerGuarded(node.arguments.slice(1));
      findings.bare.push({ method: node.expression.name.text, channel: first.slice(0, 50), guarded });
    } else {
      // Central gate check: inspect the wrapper handler's executable statements only,
      // so a comment mentioning the assert cannot fake a gate.
      // 中心门禁检查：只检查 wrapper handler 的可执行语句，注释提及断言不算数。
      const wrapperHandler = node.arguments[1];
      const body = ts.isFunctionLike(wrapperHandler) ? wrapperHandler.body : undefined;
      findings.centralGatePresent = body ? bodyHasGateStatement(body) : false;
      findings.centralGateLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    }
  }
  ts.forEachChild(node, visit);
}
visit(sf);

console.log(`registerAppHandler 通道总数: ${findings.wrappedTotal}`);
console.log(`  依赖统一门禁(无独立断言): ${findings.wrappedUnguarded.length}`);
console.log(`wrapper 中心断言: ${findings.centralGatePresent ? `存在 (L${findings.centralGateLine})` : '缺失'}`);
console.log(`裸 ipcMain 注册: ${findings.bare.length}`);
for (const b of findings.bare) {
  console.log(`  ${b.guarded ? '  [已断言]' : '  [未断言]'} ipcMain.${b.method} ${b.channel}`);
}

let failed = false;
if (!findings.centralGatePresent) {
  console.error('\nFAIL: registerAppHandler wrapper 中的统一 assertInternalRenderer 门禁缺失——所有未带断言的通道将失去保护。');
  failed = true;
}
const unguardedBare = findings.bare.filter(b => !b.guarded);
if (unguardedBare.length > 0) {
  console.error(`\nFAIL: ${unguardedBare.length} 个裸 ipcMain 注册缺少发送方断言。`);
  failed = true;
}
if (failed) process.exit(1);
console.log('\nPASS: IPC 发送方门禁覆盖完整。');
