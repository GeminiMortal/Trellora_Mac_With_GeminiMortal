/**
 * terminalTheme — maps CSS theme tokens to xterm ITheme.
 * terminalTheme — 将 CSS 主题令牌映射到 xterm ITheme。
 */
import type { ITheme } from '@xterm/xterm';

export function createTerminalTheme(mode: 'light' | 'dark'): ITheme {
  if (mode === 'dark') {
    return {
      background: '#1a1e1c',
      foreground: '#e8f0ea',
      cursor: '#4ade80',
      cursorAccent: '#1a1e1c',
      selectionBackground: 'rgba(74, 222, 128, 0.2)',
      selectionForeground: '#ffffff',
      black: '#1a1e1c',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e8f0ea',
      brightBlack: '#4a5568',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde68a',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#f7fafc',
    };
  }

  return {
    background: '#f5f8f6',
    foreground: '#24352c',
    cursor: '#16a34a',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(22, 163, 74, 0.15)',
    selectionForeground: '#24352c',
    black: '#24352c',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#f5f8f6',
    brightBlack: '#94a3b8',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#ffffff',
  };
}