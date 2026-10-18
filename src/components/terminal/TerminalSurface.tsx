/**
 * TerminalSurface — DOM host for a single xterm instance.
 * TerminalSurface — 单个 xterm 实例的 DOM 宿主。
 * Supports reparenting (keeps xterm alive across panel/view switches).
 */
import { useEffect, useRef, useCallback } from 'react';
import { useTerminalSessionsProvider } from './useTerminalSessions.tsx';

interface TerminalSurfaceProps {
  sessionId: string;
  active: boolean;
  className?: string;
}

export default function TerminalSurface({ sessionId, active, className }: TerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const { getInstance, attachElement, detachElement } = useTerminalSessionsProvider();

  const handleResize = useCallback(() => {
    const inst = getInstance(sessionId);
    const el = containerRef.current;
    if (inst && el && el.offsetHeight > 0 && el.offsetWidth > 0) {
      try {
        inst.fitAddon.fit();
        const { cols, rows } = inst.term;
        (window as any).electronAPI.resizeTerminal(sessionId, cols, rows);
      } catch (err) {
        // Ignore fit errors during transitions
      }
    }
  }, [sessionId, getInstance]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !active) {
      // Detach when becoming inactive
      if (!active) {
        detachElement(sessionId);
      }
      return;
    }

    // Attach terminal to this element
    attachElement(sessionId, el);

    // Set up ResizeObserver
    if (!observerRef.current) {
      observerRef.current = new ResizeObserver(() => {
        handleResize();
      });
    }
    observerRef.current.observe(el);

    // Initial fit after mount
    const timer = setTimeout(handleResize, 100);

    return () => {
      clearTimeout(timer);
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      detachElement(sessionId);
    };
  }, [sessionId, active, attachElement, detachElement, handleResize]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--surface-canvas)',
        display: active ? 'block' : 'none',
      }}
    />
  );
}