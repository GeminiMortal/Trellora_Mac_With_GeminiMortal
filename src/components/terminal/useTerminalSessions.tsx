/**
 * useTerminalSessions — React context for terminal session/tab state.
 * useTerminalSessions — 终端会话/标签状态的 React Context。
 */
import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalSessionInfo, TerminalDataEvent, TerminalExitEvent, ShellInfo } from '../../../shared/terminal.ts';
import { createTerminalTheme } from './terminalTheme.ts';

interface TerminalTab {
  id: string;
  title: string;
  status: 'running' | 'exited';
}

interface TerminalInstance {
  term: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement | null;
  ready: boolean;
}

interface TerminalSessionsContextValue {
  tabs: TerminalTab[];
  activeId: string | null;
  create: (title?: string, shell?: string) => Promise<void>;
  close: (id: string) => void;
  select: (id: string) => void;
  rename: (id: string, title: string) => void;
  getInstance: (id: string) => TerminalInstance | undefined;
  attachElement: (id: string, el: HTMLElement) => void;
  detachElement: (id: string) => void;
  refreshTheme: () => void;
  availableShells: ShellInfo[];
  selectedShell: string | null;
  setSelectedShell: (shell: string | null) => void;
  refreshShells: () => Promise<void>;
  lastError: string | null;
  clearError: () => void;
}

const TerminalSessionsContext = createContext<TerminalSessionsContextValue | null>(null);

export function useTerminalSessionsProvider() {
  const ctx = useContext(TerminalSessionsContext);
  if (!ctx) throw new Error('useTerminalSessions must be used within TerminalSessionsProvider');
  return ctx;
}

export function TerminalSessionsProvider({ children, themeMode }: { children: ReactNode; themeMode: 'light' | 'dark' }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);
  const [selectedShell, setSelectedShell] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const instancesRef = useRef(new Map<string, TerminalInstance>());
  const pendingDataRef = useRef(new Map<string, string[]>());

  const clearError = useCallback(() => setLastError(null), []);

  // Detect available shells on mount
  const refreshShells = useCallback(async () => {
    try {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.listTerminalShells) return;
      const shells = await electronAPI.listTerminalShells();
      setAvailableShells(shells);
      // Set default shell if none selected
      if (selectedShell === null) {
        const defaultShell = shells.find((s: ShellInfo) => s.isDefault);
        if (defaultShell) setSelectedShell(defaultShell.path);
      }
    } catch (err) {
      console.warn('Failed to detect available shells:', err);
    }
  }, [selectedShell]);

  useEffect(() => { refreshShells(); }, []);

  // Refresh theme on all terminals when theme changes
  const refreshTheme = useCallback(() => {
    const theme = createTerminalTheme(themeMode);
    for (const { term } of instancesRef.current.values()) {
      term.options.theme = theme;
    }
  }, [themeMode]);

  useEffect(() => { refreshTheme(); }, [refreshTheme]);

  // Subscribe to terminal data events
  useEffect(() => {
    const unsub = (window as any).electronAPI?.onTerminalData?.((event: TerminalDataEvent) => {
      const inst = instancesRef.current.get(event.id);
      if (inst && inst.ready) {
        inst.term.write(event.data);
      } else {
        // Buffer data until terminal is ready
        const pending = pendingDataRef.current.get(event.id) || [];
        pending.push(event.data);
        pendingDataRef.current.set(event.id, pending);
      }
    });
    return unsub;
  }, []);

  // Subscribe to terminal exit events
  useEffect(() => {
    const unsub = (window as any).electronAPI?.onTerminalExit?.((event: TerminalExitEvent) => {
      setTabs((prev) => prev.map((t) => t.id === event.id ? { ...t, status: 'exited' } : t));
      const inst = instancesRef.current.get(event.id);
      if (inst && inst.ready) {
        inst.term.write('\r\n\x1b[90m[进程已结束]\x1b[0m\r\n');
      }
    });
    return unsub;
  }, []);

  const create = useCallback(async (title?: string, shell?: string) => {
    try {
      setLastError(null);
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.createTerminal) {
        setLastError('终端 API 不可用，请检查应用是否正确加载。');
        return;
      }
      const shellToUse = shell || selectedShell || undefined;
      const info: TerminalSessionInfo = await electronAPI.createTerminal({ title, shell: shellToUse });
      const term = new Terminal({
        theme: createTerminalTheme(themeMode),
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
        allowProposedApi: true,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Wire terminal input to PTY
      term.onData((data: string) => {
        electronAPI.writeTerminal(info.id, data);
      });

      const inst: TerminalInstance = {
        term,
        fitAddon,
        container: null,
        ready: false,
      };
      instancesRef.current.set(info.id, inst);

      setTabs((prev) => [...prev, { id: info.id, title: info.title, status: info.status }]);
      setActiveId(info.id);
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('Failed to create terminal:', msg);
      setLastError(`终端创建失败: ${msg}`);
    }
  }, [themeMode, selectedShell]);

  const close = useCallback((id: string) => {
    const inst = instancesRef.current.get(id);
    if (inst) {
      inst.term.dispose();
      instancesRef.current.delete(id);
    }
    pendingDataRef.current.delete(id);
    (window as any).electronAPI.killTerminal(id).catch(() => {});
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const idx = prev.findIndex((t) => t.id === id);
        setActiveId(next.length > 0 ? next[Math.min(idx, next.length - 1)].id : null);
      }
      return next;
    });
  }, [activeId]);

  const select = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const rename = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, title } : t));
  }, []);

  const getInstance = useCallback((id: string) => instancesRef.current.get(id), []);

  const attachElement = useCallback((id: string, el: HTMLElement) => {
    const inst = instancesRef.current.get(id);
    if (!inst) return;
    if (inst.container === el) return;

    inst.container = el;

    // Open terminal in the element if not already open
    if (!inst.term.element) {
      inst.term.open(el);
    } else if (inst.term.element.parentElement !== el) {
      // Reparent the terminal element
      el.appendChild(inst.term.element);
    }

    // Mark as ready and flush pending data
    inst.ready = true;
    const pending = pendingDataRef.current.get(id);
    if (pending && pending.length > 0) {
      for (const data of pending) {
        inst.term.write(data);
      }
      pendingDataRef.current.delete(id);
    }

    // Fit and resize after a short delay to ensure DOM is ready
    setTimeout(() => {
      try {
        if (inst.container === el && el.offsetHeight > 0 && el.offsetWidth > 0) {
          inst.fitAddon.fit();
          const { cols, rows } = inst.term;
          (window as any).electronAPI.resizeTerminal(id, cols, rows);
        }
        inst.term.focus();
      } catch (err) {
        console.warn('Terminal fit failed:', err);
      }
    }, 50);
  }, []);

  const detachElement = useCallback((id: string) => {
    const inst = instancesRef.current.get(id);
    if (inst) {
      inst.container = null;
      inst.ready = false;
    }
  }, []);

  const value: TerminalSessionsContextValue = {
    tabs,
    activeId,
    create,
    close,
    select,
    rename,
    getInstance,
    attachElement,
    detachElement,
    refreshTheme,
    availableShells,
    selectedShell,
    setSelectedShell,
    refreshShells,
    lastError,
    clearError,
  };

  return (
    <TerminalSessionsContext.Provider value={value}>
      {children}
    </TerminalSessionsContext.Provider>
  );
}