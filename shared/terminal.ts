/**
 * Terminal — shared types for the terminal feature.
 * 终端 — 终端功能的共享类型定义。
 */

/** Options for creating a new terminal session. */
export interface TerminalCreateOptions {
  /** Working directory; defaults to workspace root. */
  cwd?: string;
  /** Initial columns. */
  cols?: number;
  /** Initial rows. */
  rows?: number;
  /** Optional custom title for the tab. */
  title?: string;
  /** Preferred shell binary path; falls back to system default. */
  shell?: string;
}

/** Information returned after creating a terminal session. */
export interface TerminalSessionInfo {
  /** Unique session ID. */
  id: string;
  /** Display title (shell name or cwd basename). */
  title: string;
  /** Process status. */
  status: 'running' | 'exited';
}

/** Push event: PTY data (stdout + stderr merged). */
export interface TerminalDataEvent {
  id: string;
  data: string;
}

/** Push event: PTY process exited. */
export interface TerminalExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
}

/** Information about an available shell program. */
export interface ShellInfo {
  /** Display name (e.g. "zsh", "bash", "PowerShell"). */
  name: string;
  /** Full path to the shell binary. */
  path: string;
  /** Whether this is the system default shell. */
  isDefault: boolean;
  /** Whether this shell is a built-in/platform shell (e.g. WSL). */
  isBuiltin?: boolean;
}