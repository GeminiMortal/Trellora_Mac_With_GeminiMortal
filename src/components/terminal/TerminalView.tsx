/**
 * TerminalView — standalone full-screen terminal view (nav rail).
 * TerminalView — 独立全屏终端视图（导航栏）。
 */
import { useEffect } from 'react';
import { useTerminalSessionsProvider } from './useTerminalSessions.tsx';
import TerminalTabs from './TerminalTabs.tsx';
import TerminalSurface from './TerminalSurface.tsx';
import './Terminal.css';

interface TerminalViewProps {
  active: boolean;
}

export default function TerminalView({ active }: TerminalViewProps) {
  const { tabs, activeId, create, lastError, clearError } = useTerminalSessionsProvider();

  // Auto-create first terminal when view becomes active and empty
  useEffect(() => {
    if (active && tabs.length === 0 && !lastError) create();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="terminal-view" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-view-header">
        <TerminalTabs showCollapse={false} />
      </div>
      <div className="terminal-view-body">
        {tabs.map((tab) => (
          <TerminalSurface
            key={tab.id}
            sessionId={tab.id}
            active={tab.id === activeId}
            className="terminal-view-surface"
          />
        ))}
        {lastError && tabs.length === 0 && (
          <div className="terminal-panel-empty" style={{ flexDirection: 'column', gap: 8 }}>
            <span style={{ color: 'var(--status-danger)' }}>{lastError}</span>
            <button
              onClick={() => { clearError(); create(); }}
              style={{
                padding: '4px 12px', border: '1px solid var(--border-default)',
                borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}