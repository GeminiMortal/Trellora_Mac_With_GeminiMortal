import { t, useI18n } from '../../i18n/index.ts';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

interface WikiSplitPaneProps {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryOpen: boolean;
  overlay: boolean;
}

/** 详情面板宽度上下限与默认值（px）；中间导图取剩余空间。 */
const detailMinWidth = 320;
const detailMaxWidth = 560;
const detailDefaultWidth = 400;
const detailKeyboardStep = 24;

export default function WikiSplitPane({ primary, secondary, secondaryOpen, overlay }: WikiSplitPaneProps) {
  useI18n();
  const [detailWidth, setDetailWidth] = useState(detailDefaultWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const clampDetailWidth = useCallback(
    (width: number) => Math.min(detailMaxWidth, Math.max(detailMinWidth, Math.round(width))),
    [],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: detailWidth };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // 以按下点为基准做增量拖拽：向左拖 = 详情变宽；避免按落点吸附导致分隔条跳变。
    setDetailWidth(clampDetailWidth(drag.startWidth + (drag.startX - event.clientX)));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  useEffect(() => {
    if (!secondaryOpen) setDetailWidth(detailDefaultWidth);
  }, [secondaryOpen]);

  return (
    <div
      className={[
        'wiki-split-pane',
        secondaryOpen ? 'detail-open' : '',
        overlay ? 'detail-overlay' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--wiki-detail-width': `${detailWidth}px` } as CSSProperties}
    >
      <section className="wiki-split-primary">{primary}</section>
      {secondaryOpen && !overlay ? (
        <div
          className="wiki-split-handle"
          role="separator"
          aria-label={t("调整导图与详情宽度")}
          aria-orientation="vertical"
          aria-valuemin={detailMinWidth}
          aria-valuemax={detailMaxWidth}
          aria-valuenow={detailWidth}
          aria-valuetext={`${detailWidth}px`}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onDoubleClick={() => setDetailWidth(detailDefaultWidth)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setDetailWidth((width) => clampDetailWidth(width + detailKeyboardStep));
            if (event.key === 'ArrowRight') setDetailWidth((width) => clampDetailWidth(width - detailKeyboardStep));
            if (event.key === 'Home') setDetailWidth(detailDefaultWidth);
          }}
        ><span /></div>
      ) : null}
      {secondaryOpen ? <section className="wiki-split-secondary">{secondary}</section> : null}
    </div>
  );
}
