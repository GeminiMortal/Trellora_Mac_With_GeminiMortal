/**
 * terminalWorker — runs PTY sessions in a dedicated thread to avoid
 * blocking the Electron main process on macOS TCC permission checks.
 */
import { parentPort } from 'node:worker_threads';
import { spawn, type IPty } from 'node-pty';
import * as os from 'node:os';

const sessions = new Map<string, IPty>();

parentPort?.on('message', (msg: { type: string; [key: string]: unknown }) => {
  const { type } = msg;
  try {
    switch (type) {
      case 'spawn': {
        const { id, shell, shellArgs, cols, rows, cwd, env } = msg as {
          id: string; shell: string; shellArgs: string[];
          cols: number; rows: number; cwd: string; env: Record<string, string>;
        };
        const pty = spawn(shell, shellArgs, {
          name: 'xterm-256color', cols, rows, cwd, env,
        });
        sessions.set(id, pty);
        pty.onData((data: string) => {
          parentPort?.postMessage({ type: 'data', id, data });
        });
        pty.onExit(({ exitCode, signal }) => {
          sessions.delete(id);
          parentPort?.postMessage({ type: 'exit', id, exitCode, signal });
        });
        parentPort?.postMessage({ type: 'spawned', id });
        break;
      }
      case 'write': {
        const { id, data } = msg as { id: string; data: string };
        sessions.get(id)?.write(data);
        break;
      }
      case 'resize': {
        const { id, cols, rows } = msg as { id: string; cols: number; rows: number };
        sessions.get(id)?.resize(cols, rows);
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
    }
  } catch (err) {
    parentPort?.postMessage({
      type: 'error', id: (msg as { id?: string }).id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});