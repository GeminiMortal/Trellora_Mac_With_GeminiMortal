/**
 * TerminalService — manages PTY sessions via a lightweight child process.
 * Features: lazy initialization, auto-restart on crash, retry with backoff,
 * shell validation, and available shell detection.
 */
import { fork, type ChildProcess, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import type { TerminalSessionInfo, TerminalCreateOptions, ShellInfo } from '../../shared/terminal.ts';

const SPAWN_TIMEOUT_MS = 15_000;
const FLUSH_INTERVAL_MS = 12;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

interface Session {
  info: TerminalSessionInfo;
  sender: WebContents;
  buffer: string;
  flushTimer?: ReturnType<typeof setInterval>;
}

export class TerminalService {
  private sessions = new Map<string, Session>();
  private titleCounter = 0;
  private host: ChildProcess | undefined;
  private hostReady = false;
  private hostReadyPromise: Promise<void>;
  private resolveHostReady: (() => void) | undefined;
  private rejectHostReady: ((err: Error) => void) | undefined;
  private pendingSpawns = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  private inputBuf = '';
  private disposing = false;
  private retryCount = 0;
  private hostInitialized = false;

  constructor(private readonly options: {
    getWorkspacePath: () => string;
  }) {
    this.hostReadyPromise = this.createReadyPromise();
    // Lazy initialization: host is spawned on first create() call
  }

  private createReadyPromise(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveHostReady = resolve;
      this.rejectHostReady = reject;
    });
  }

  private spawnHost(): void {
    try {
      const hostPath = this.resolveHostPath();
      // In packaged apps, node-pty lives in app.asar.unpacked/node_modules/.
      // The host script is in app.asar.unpacked/dist-electron/, so we must
      // set cwd or NODE_PATH so require("node-pty") resolves correctly.
      const isPackaged = __dirname.includes(`${path.sep}app.asar${path.sep}`);
      const unpackedDir = isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked')
        : path.join(__dirname, '..');
      const child = fork(hostPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        cwd: unpackedDir,
        env: {
          ...process.env,
          NODE_PATH: path.join(unpackedDir, 'node_modules'),
        } as Record<string, string>,
      });
      this.host = child;
      this.inputBuf = '';

      // Buffered NDJSON parsing
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        this.inputBuf += chunk;
        let nl: number;
        while ((nl = this.inputBuf.indexOf('\n')) !== -1) {
          const line = this.inputBuf.slice(0, nl);
          this.inputBuf = this.inputBuf.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'pong' && !this.hostReady) {
              this.hostReady = true;
              this.retryCount = 0;
              this.resolveHostReady?.();
            }
            this.handleHostMessage(msg);
          } catch { /* ignore malformed */ }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trimEnd();
        if (msg) {
          console.error('[TerminalHost]', msg);
          // Detect node-pty native module loading failure
          if (msg.includes('node-pty') || msg.includes('MODULE_NOT_FOUND') || msg.includes('dlopen')) {
            console.error('[TerminalService] node-pty native module failed to load. Try running: npm run rebuild:native');
          }
          // Write stderr to debug file
          try {
            const dbgFile = path.join(os.homedir(), '.trellora', 'terminal-service-debug.log');
            fs.appendFileSync(dbgFile, `[${new Date().toISOString()}] [HOST STDERR] ${msg}\n`);
          } catch {}
        }
      });

      child.on('error', (err) => {
        console.error('[TerminalHost] child error:', err);
        try {
          const dbgFile = path.join(os.homedir(), '.trellora', 'terminal-service-debug.log');
          fs.appendFileSync(dbgFile, `[${new Date().toISOString()}] [CHILD ERROR] ${err.message}\n${err.stack}\n`);
        } catch {}
        this.hostReady = false;
        this.rejectHostReady?.(err);
        this.rejectAllPending('终端进程启动失败');
        this.scheduleRestart();
      });

      child.on('exit', (code, signal) => {
        console.error(`[TerminalHost] child exited: code=${code}, signal=${signal}`);
        try {
          const dbgFile = path.join(os.homedir(), '.trellora', 'terminal-service-debug.log');
          fs.appendFileSync(dbgFile, `[${new Date().toISOString()}] [CHILD EXIT] code=${code}, signal=${signal}\n`);
        } catch {}
        this.host = undefined;
        this.hostReady = false;
        if (!this.disposing) {
          this.rejectHostReady?.(new Error(`终端进程异常退出 (${code})`));
          this.rejectAllPending('终端进程已退出，正在重启…');
          this.scheduleRestart();
        }
      });

      // Ping immediately — no artificial delay
      this.sendToHost({ type: 'ping' });

    } catch (err) {
      this.rejectHostReady?.(err as Error);
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.disposing) return;
    if (this.retryCount >= MAX_RETRIES) {
      console.error(`[TerminalService] 最多重试 ${MAX_RETRIES} 次，放弃重启。`);
      return;
    }
    const delay = RETRY_BASE_DELAY_MS * (2 ** this.retryCount);
    this.retryCount++;
    console.warn(`[TerminalService] ${delay}ms 后尝试第 ${this.retryCount}/${MAX_RETRIES} 次重启…`);
    setTimeout(() => {
      if (!this.disposing) {
        this.hostReadyPromise = this.createReadyPromise();
        this.spawnHost();
      }
    }, delay);
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingSpawns) {
      pending.reject(new Error(reason));
    }
    this.pendingSpawns.clear();
  }

  private handleHostMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'spawned': {
        const { id } = msg as { id: string };
        const pending = this.pendingSpawns.get(id);
        if (pending) {
          pending.resolve();
          this.pendingSpawns.delete(id);
        }
        break;
      }
      case 'data': {
        const { id, data } = msg as { id: string; data: string };
        const session = this.sessions.get(id);
        if (!session) return;
        session.buffer += data;
        if (!session.flushTimer) {
          session.flushTimer = setInterval(() => {
            if (session.buffer.length > 0 && !session.sender.isDestroyed()) {
              session.sender.send('terminal:data', { id, data: session.buffer });
              session.buffer = '';
            }
          }, FLUSH_INTERVAL_MS);
        }
        break;
      }
      case 'exit': {
        const { id, exitCode, signal } = msg as { id: string; exitCode: number; signal: number };
        const session = this.sessions.get(id);
        if (!session) return;
        if (session.buffer.length > 0 && !session.sender.isDestroyed()) {
          session.sender.send('terminal:data', { id, data: session.buffer });
          session.buffer = '';
        }
        if (session.flushTimer) {
          clearInterval(session.flushTimer);
          session.flushTimer = undefined;
        }
        session.info.status = 'exited';
        if (!session.sender.isDestroyed()) {
          session.sender.send('terminal:exit', { id, exitCode, signal });
        }
        break;
      }
      case 'error': {
        const { id, message } = msg as { id: string; message: string };
        console.error(`[TerminalHost] error from host: id=${id}, message=${message}`);
        try {
          const dbgFile = path.join(os.homedir(), '.trellora', 'terminal-service-debug.log');
          fs.appendFileSync(dbgFile, `[${new Date().toISOString()}] [HOST ERROR MSG] id=${id}, message=${message}\n`);
        } catch {}
        const pending = this.pendingSpawns.get(id);
        if (pending) {
          pending.reject(new Error(message));
          this.pendingSpawns.delete(id);
        }
        break;
      }
    }
  }

  private sendToHost(msg: Record<string, unknown>): void {
    if (this.host?.stdin && !this.host.stdin.destroyed) {
      try {
        this.host.stdin.write(JSON.stringify(msg) + '\n');
      } catch { /* host closing */ }
    }
  }

  private async ensureHost(): Promise<void> {
    if (!this.hostInitialized) {
      this.hostInitialized = true;
      this.spawnHost();
    }
    if (!this.hostReady) {
      await this.hostReadyPromise;
    }
  }

  async create(sender: WebContents, options?: TerminalCreateOptions): Promise<TerminalSessionInfo> {
    // Lazy host initialization — only spawns when first terminal is requested
    await this.ensureHost();

    const cwd = this.resolveCwd(options?.cwd);
    const shell = this.resolveShell(options?.shell);
    const id = randomUUID();
    const title = options?.title || `终端 ${++this.titleCounter}`;

    const shellArgs = shell.endsWith('zsh') || shell.endsWith('bash') ? ['--login'] : [];
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG ?? 'zh_CN.UTF-8',
    } as Record<string, string>;

    // Debug: log terminal spawn parameters
    const dbgFile = path.join(os.homedir(), '.trellora', 'terminal-service-debug.log');
    try {
      fs.mkdirSync(path.join(os.homedir(), '.trellora'), { recursive: true });
      const log = (m: string) => fs.appendFileSync(dbgFile, `[${new Date().toISOString()}] ${m}\n`);
      log(`CREATE: shell=${shell}, shellArgs=${JSON.stringify(shellArgs)}, cwd=${cwd}`);
      log(`Shell exists: ${fs.existsSync(shell)}, executable: ${(() => { try { fs.accessSync(shell, fs.constants.X_OK); return true; } catch { return false; } })()}`);
      log(`CWD exists: ${fs.existsSync(cwd)}`);
      log(`PATH: ${env.PATH}`);
      log(`isPackaged: ${__dirname.includes(`${path.sep}app.asar${path.sep}`)}`);
      log(`hostReady: ${this.hostReady}`);
      log(`hostPath: ${this.resolveHostPath()}`);
    } catch (e) {
      console.error('[TerminalService] Debug log write failed:', e);
    }

    const info: TerminalSessionInfo = { id, title, status: 'running' };
    const session: Session = { info, sender, buffer: '' };

    sender.once('destroyed', () => this.kill(id));
    this.sessions.set(id, session);

    // Fire-and-forget spawn — resolve on 'spawned' message
    const spawnPromise = new Promise<void>((resolve, reject) => {
      this.pendingSpawns.set(id, { resolve, reject });
      this.sendToHost({
        type: 'spawn', id, shell, shellArgs,
        cols: options?.cols ?? 80, rows: options?.rows ?? 24,
        cwd, env,
      });
      setTimeout(() => {
        if (this.pendingSpawns.delete(id)) {
          reject(new Error('终端启动超时，请检查系统资源后重试。'));
        }
      }, SPAWN_TIMEOUT_MS);
    });

    spawnPromise.catch((err) => {
      session.info.status = 'exited';
      this.sessions.delete(id);
      if (!sender.isDestroyed()) {
        const errorMsg = err.message.includes('超时')
          ? '终端启动超时，请检查系统资源后重试。'
          : `终端启动失败: ${err.message}`;
        sender.send('terminal:data', { id, data: `\x1b[31m${errorMsg}\x1b[0m\r\n` });
        sender.send('terminal:exit', { id, exitCode: 1, signal: 0 });
      }
    });

    return info;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session?.info.status === 'running') {
      this.sendToHost({ type: 'write', id, data });
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session?.info.status === 'running') {
      this.sendToHost({ type: 'resize', id, cols, rows });
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.flushTimer) {
      clearInterval(session.flushTimer);
      session.flushTimer = undefined;
    }

    this.sendToHost({ type: 'kill', id });
    this.sessions.delete(id);
  }

  killBySender(senderId: number): void {
    for (const [id, session] of this.sessions) {
      if (session.sender.id === senderId) this.kill(id);
    }
  }

  dispose(): void {
    this.disposing = true;
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
    if (this.host && !this.host.killed) {
      this.host.kill();
      this.host = undefined;
    }
    this.hostReady = false;
  }

  private resolveCwd(cwd?: string): string {
    if (cwd && fs.existsSync(cwd)) return cwd;
    const workspacePath = this.options.getWorkspacePath();
    if (workspacePath && fs.existsSync(workspacePath)) return workspacePath;
    return os.homedir();
  }

  /**
   * Resolve the shell binary path with validation.
   * Validates that the shell actually exists and is executable.
   */
  resolveShell(preferredShell?: string): string {
    if (process.platform === 'win32') {
      // Windows: try preferred, then COMSPEC, then powershell
      const candidates = [preferredShell, process.env.COMSPEC, 'powershell.exe', 'cmd.exe'].filter(Boolean) as string[];
      for (const candidate of candidates) {
        if (this.validateShellBinary(candidate)) return candidate;
      }
      return 'powershell.exe'; // ultimate fallback
    }

    // macOS/Linux: build candidate list with fallback chain
    const candidates = [
      preferredShell,
      process.env.SHELL,
      '/bin/zsh',
      '/bin/bash',
      '/usr/bin/bash',
      '/bin/sh',
    ].filter(Boolean) as string[];

    // Deduplicate while preserving order
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (this.validateShellBinary(candidate)) return candidate;
    }

    // Absolute fallback
    return '/bin/sh';
  }

  /**
   * Validate that a shell binary exists and is executable.
   */
  private validateShellBinary(shellPath: string): boolean {
    try {
      // If it's a bare name (no path separator), try to find it via `which`
      if (!path.isAbsolute(shellPath) && !shellPath.includes(path.sep)) {
        try {
          const resolved = execSync(`which ${shellPath}`, { encoding: 'utf8', timeout: 3000 }).trim();
          return resolved.length > 0 && fs.existsSync(resolved);
        } catch {
          return false;
        }
      }
      // Absolute path: check existence and execute permission
      if (!fs.existsSync(shellPath)) return false;
      fs.accessSync(shellPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect all available shell programs on the system.
   * Returns a list of ShellInfo objects with name, path, and whether it's the default.
   */
  detectAvailableShells(): ShellInfo[] {
    const isWindows = process.platform === 'win32';
    const defaultShell = this.resolveShell();
    const shells: ShellInfo[] = [];
    const seen = new Set<string>();

    const addShell = (name: string, shellPath: string, isBuiltin?: boolean) => {
      if (seen.has(shellPath)) return;
      seen.add(shellPath);
      if (!isBuiltin && !this.validateShellBinary(shellPath)) return;
      shells.push({
        name,
        path: shellPath,
        isDefault: shellPath === defaultShell,
        isBuiltin: isBuiltin ?? false,
      });
    };

    if (isWindows) {
      addShell('PowerShell', 'powershell.exe');
      addShell('CMD', 'cmd.exe');
      addShell('Git Bash', 'C:\\Program Files\\Git\\bin\\bash.exe');
      // Check for WSL
      try {
        execSync('wsl --list --quiet', { encoding: 'utf8', timeout: 3000 });
        addShell('WSL', 'wsl.exe', true);
      } catch { /* no WSL */ }
    } else {
      // macOS / Linux common shells
      addShell('zsh', '/bin/zsh');
      addShell('bash', '/bin/bash');
      addShell('sh', '/bin/sh');
      addShell('fish', '/usr/local/bin/fish');
      addShell('fish', '/opt/homebrew/bin/fish');

      // Try shells from $PATH
      const pathDirs = (process.env.PATH || '').split(path.delimiter);
      for (const dir of pathDirs) {
        try {
          const entries = fs.readdirSync(dir);
          for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            // Only consider common shell names
            if (['zsh', 'bash', 'fish', 'sh', 'dash', 'ash', 'ksh', 'csh', 'tcsh', 'elvish', 'nushell', 'nu'].includes(entry)) {
              addShell(entry, fullPath);
            }
          }
        } catch { /* skip inaccessible dirs */ }
      }

      // macOS Terminal.app detection
      if (process.platform === 'darwin') {
        try {
          execSync('open -Ra "Terminal.app" 2>/dev/null || true', { encoding: 'utf8', timeout: 2000 });
          // Terminal.app exists but we can't spawn it as a shell; skip
        } catch { /* ignore */ }
      }
    }

    return shells;
  }

  private resolveHostPath(): string {
    if (__dirname.includes(`${path.sep}app.asar${path.sep}`)) {
      return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'terminalHost.js');
    }
    return path.join(__dirname, 'terminalHost.js');
  }
}