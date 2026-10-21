/**
 * TerminalTabs — tab strip for terminal sessions with shell selector.
 * TerminalTabs — 终端会话的标签栏，带终端选择器。
 */
import { useState, useRef, useEffect } from 'react';
import { ActionIcon, Tooltip, ScrollArea } from '@mantine/core';
import { Plus, X, Circle, ChevronDown, Terminal as TerminalIcon } from 'lucide-react';
import { t, useI18n } from '../../i18n/index.ts';
import { useTerminalSessionsProvider } from './useTerminalSessions.tsx';

interface TerminalTabsProps {
  onTogglePanel?: () => void;
  showCollapse?: boolean;
}

export default function TerminalTabs({ onTogglePanel, showCollapse }: TerminalTabsProps) {
  useI18n();
  const { tabs, activeId, create, close, select, availableShells, selectedShell, setSelectedShell } = useTerminalSessionsProvider();
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!shellMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShellMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [shellMenuOpen]);

  const currentShellName = availableShells.find((s) => s.path === selectedShell)?.name
    || (selectedShell ? selectedShell.split('/').pop() : null)
    || t('终端');

  const handleShellSelect = (shellPath: string) => {
    setSelectedShell(shellPath);
    setShellMenuOpen(false);
  };

  const handleNewTerminal = (shellPath?: string) => {
    create(undefined, shellPath);
    setShellMenuOpen(false);
  };

  return (
    <div className="terminal-tabs">
      <ScrollArea type="never" style={{ flex: 1 }}>
        <div className="terminal-tabs-list">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${tab.id === activeId ? 'terminal-tab--active' : ''}`}
              onClick={() => select(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) close(tab.id); }}
              role="tab"
              aria-selected={tab.id === activeId}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') select(tab.id); }}
            >
              <Circle
                size={8}
                fill={tab.status === 'running' ? 'var(--status-success)' : 'var(--text-tertiary)'}
                color={tab.status === 'running' ? 'var(--status-success)' : 'var(--text-tertiary)'}
              />
              <span className="terminal-tab-title">{tab.title}</span>
              <div
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); close(tab.id); }}
                role="button"
                tabIndex={-1}
              >
                <X size={12} />
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="terminal-tabs-actions">
        {/* Shell selector + new terminal */}
        <div className="terminal-shell-selector" ref={menuRef}>
          <Tooltip label={t('选择终端')} position="bottom">
            <button
              className="terminal-shell-trigger"
              onClick={() => setShellMenuOpen(!shellMenuOpen)}
            >
              <TerminalIcon size={12} />
              <span className="terminal-shell-name">{currentShellName}</span>
              <ChevronDown size={10} />
            </button>
          </Tooltip>

          {shellMenuOpen && (
            <div className="terminal-shell-menu">
              <div className="terminal-shell-menu-header">{t('选择终端')}</div>
              {availableShells.length === 0 && (
                <div className="terminal-shell-menu-empty">{t('未检测到可用终端')}</div>
              )}
              {availableShells.map((shell) => (
                <div
                  key={shell.path}
                  className={`terminal-shell-option ${shell.path === selectedShell ? 'terminal-shell-option--active' : ''}`}
                  onClick={() => handleShellSelect(shell.path)}
                >
                  <span className="terminal-shell-option-name">{shell.name}</span>
                  <span className="terminal-shell-option-path">{shell.path}</span>
                  {shell.isDefault && <span className="terminal-shell-option-badge">{t('默认')}</span>}
                </div>
              ))}
              {availableShells.length > 0 && <div className="terminal-shell-menu-divider" />}
              <div className="terminal-shell-menu-header">{t('以此终端新建')}</div>
              {availableShells.map((shell) => (
                <div
                  key={`new-${shell.path}`}
                  className="terminal-shell-option terminal-shell-option--new"
                  onClick={() => handleNewTerminal(shell.path)}
                >
                  <Plus size={12} />
                  <span className="terminal-shell-option-name">{shell.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <Tooltip label={t('新建终端')} position="bottom">
          <ActionIcon aria-label="关闭终端标签" variant="subtle" size="sm" onClick={() => create()}>
            <Plus size={14} />
          </ActionIcon>
        </Tooltip>
        {showCollapse && onTogglePanel && (
          <Tooltip label={t('收起终端')} position="bottom">
            <ActionIcon aria-label="新建终端" variant="subtle" size="sm" onClick={onTogglePanel}>
              <X size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>
    </div>
  );
}