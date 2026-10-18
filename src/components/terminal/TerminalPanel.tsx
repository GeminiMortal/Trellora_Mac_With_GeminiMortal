/**
 * TerminalPanel — bottom panel terminal with resizable height.
 * TerminalPanel — 可调高度的底部面板终端。
 */
import { useCallback, useRef, useEffect, useState } from 'react';
import { useTerminalSessionsProvider } from './useTerminalSessions.tsx';
import TerminalTabs from './TerminalTabs.tsx';
import TerminalSurface from './TerminalSurface.tsx';
import './Terminal.css';

interface TerminalPanelProps {
  height: number;
  onHeightChange: (height: number) => void;
  onToggle: () => void;
}

export default function TerminalPanel({ height, onHeightChange, onToggle }: TerminalPanelProps) {
  const { tabs, activeId, create, lastError, clearError } = useTerminalSessionsProvider();
  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Auto-create first terminal if empty
  useEffect(() => {
    if (tabs.length === 0) create();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height;
    document.body.classList.add('resizing-terminal-panel');

    const onMove = (ev: MouseEvent) => {
      const delta = startYRef.current - ev.clientY;
      const newHeight = Math.max(120, Math.min(800, startHeightRef.current + delta));
      onHeightChange(newHeight);
    };
    const onUp = () => {
      setIsResizing(false);
      document.body.classList.remove('resizing-terminal-panel');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [height, onHeightChange]);

  return (
    <div className="terminal-panel" style={{ height }}>
      {/* Resize handle (top) */}
      <div
        className={`terminal-panel-resize ${isResizing ? 'terminal-panel-resize--active' : ''}`}
        onMouseDown={handleResizeStart}
      />

      {/* Header with tabs */}
      <div className="terminal-panel-header">
        <TerminalTabs onTogglePanel={onToggle} showCollapse />
      </div>

      {/* Terminal surface */}
      <div className="terminal-panel-body">
        {tabs.map((tab) => (
          <TerminalSurface
            key={tab.id}
            sessionId={tab.id}
            active={tab.id === activeId}
            className="terminal-panel-surface"
          />
        ))}
        {tabs.length === 0 && !lastError && (
          <div className="terminal-panel-empty">
            <span>点击 + 创建新终端</span>
          </div>
        )}
        {lastError && (
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