/**
 * terminalHost — lightweight PTY session manager.
 * Communicates with Electron main via stdin/stdout NDJSON.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type IPty } from 'node-pty';

// Fix node-pty helperPath double-unpacked bug:
// When node-pty is loaded from app.asar.unpacked, its internal
// helperPath.replace('app.asar', 'app.asar.unpacked') creates
// 'app.asar.unpacked.unpacked' which doesn't exist.
// Patch: resolve the actual spawn-helper path and monkey-patch pty.fork.
try {
  const ptyBuildDir = path.dirname(require.resolve('node-pty/build/Release/pty.node'));
  const actualHelper = path.join(ptyBuildDir, 'spawn-helper');
  if (fs.existsSync(actualHelper)) {
    // Monkey-patch the native pty module's fork to fix the helperPath argument
    const ptyNative = require('node-pty/build/Release/pty.node');
    const origFork = ptyNative.fork;
    if (origFork && typeof origFork === 'function') {
      ptyNative.fork = function (...args: unknown[]) {
        // helperPath is the 10th argument (index 9)
        if (args.length > 9 && typeof args[9] === 'string') {
          args[9] = actualHelper;
        }
        return origFork.apply(this, args);
      };
    }
  }
} catch { /* best effort */ }

const sessions = new Map<string, IPty>();

function send(msg: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch { /* stdout closed */ }
}

// Buffered stdin parsing
let inputBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inputBuf += chunk;
  let nl: number;
  while ((nl = inputBuf.indexOf('\n')) !== -1) {
    const line = inputBuf.slice(0, nl);
    inputBuf = inputBuf.slice(nl + 1);
    try {
      handleMessage(JSON.parse(line));
    } catch { /* ignore malformed */ }
  }
});

process.stdin.on('end', () => {
  for (const pty of sessions.values()) {
    try { pty.kill(); } catch { /* already dead */ }
  }
  sessions.clear();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  send({ type: 'error', message: err.message });
});

function handleMessage(msg: { type: string; [key: string]: unknown }): void {
  try {
    switch (msg.type) {
      case 'spawn': {
        const { id, shell, shellArgs, cols, rows, cwd, env } = msg as {
          id: string; shell: string; shellArgs: string[];
          cols: number; rows: number; cwd: string; env: Record<string, string>;
        };

        // Debug logging for posix_spawnp failures
        try {
          const fs = require('fs');
          const os = require('os');
          const logDir = path.join(os.homedir(), '.trellora');
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          const logFile = path.join(logDir, 'terminal-debug.log');
          const log = (m: string) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };
          log(`SPAWN REQUEST: shell=${shell}, args=${JSON.stringify(shellArgs)}, cwd=${cwd}`);
          log(`Shell exists: ${fs.existsSync(shell)}, platform: ${process.platform}`);
          log(`CWD exists: ${fs.existsSync(cwd)}`);
          log(`PATH: ${env?.PATH || process.env.PATH}`);
        } catch (e) {
          try { require('fs').appendFileSync('/tmp/trellora-debug.log', `[${new Date().toISOString()}] LOG INIT FAILED: ${e}\n`); } catch { /* ignore */ }
        }

        let pty: IPty;
        try {
          pty = spawn(shell, shellArgs, {
            name: 'xterm-256color', cols, rows, cwd, env,
          });
        } catch (spawnErr) {
          try {
            const fs = require('fs');
            const os = require('os');
            const logDir = path.join(os.homedir(), '.trellora');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logFile = path.join(logDir, 'terminal-debug.log');
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] SPAWN FAILED: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}\n`);
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] SPAWN FAILED stack: ${spawnErr instanceof Error ? spawnErr.stack : 'no stack'}\n`);
          } catch (e) {
            try { require('fs').appendFileSync('/tmp/trellora-debug.log', `[${new Date().toISOString()}] SPAWN FAILED LOG FAILED: ${e}\n`); } catch { /* ignore */ }
          }
          throw spawnErr;
        }
        sessions.set(id, pty);

        // Batch output — send immediately on data
        pty.onData((data: string) => {
          send({ type: 'data', id, data });
        });

        pty.onExit(({ exitCode, signal }) => {
          sessions.delete(id);
          send({ type: 'exit', id, exitCode, signal });
        });

        send({ type: 'spawned', id });
        break;
      }
      case 'write': {
        const { id, data } = msg as { id: string; data: string };
        sessions.get(id)?.write(data);
        break;
      }
      case 'resize': {
        const { id, cols, rows } = msg as { id: string; cols: number; rows: number };
        try { sessions.get(id)?.resize(cols, rows); } catch { /* dead */ }
        break;
      }
      case 'kill': {
        const { id } = msg as { id: string };
        const pty = sessions.get(id);
        if (pty) {
          try { pty.kill(); } catch { /* already dead */ }
          sessions.delete(id);
        }
        break;
      }
      case 'ping': {
        send({ type: 'pong' });
        break;
      }
    }
  } catch (err) {
    send({
      type: 'error', id: (msg as { id?: string }).id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}