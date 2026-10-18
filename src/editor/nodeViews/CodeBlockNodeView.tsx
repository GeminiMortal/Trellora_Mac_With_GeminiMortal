/**
 * React node view that renders Mermaid code blocks as live diagram previews over an editable source.
 * React 节点视图：把 Mermaid 代码块渲染为可编辑源码之上的实时图表预览。
 */
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { Maximize2 } from 'lucide-react';
import mermaid from 'mermaid';
import { useEffect, useRef, useState } from 'react';
import MermaidDiagramViewer from '../../components/markdown/MermaidDiagramViewer.tsx';
import { t } from '../../i18n/index.ts';

/**
 * Render lifecycle state of a Mermaid preview.
 * Mermaid 预览的渲染生命周期状态。
 */
type MermaidRenderState = 'empty' | 'loading' | 'ready' | 'error';

/**
 * Intrinsic size of a rendered Mermaid SVG diagram.
 * 已渲染 Mermaid SVG 图表的固有尺寸。
 */
interface MermaidDiagramSize {
  width: number;
  height: number;
}

/**
 * Monotonic id source keeping Mermaid render ids unique across node views.
 * 单调递增的 id 源，保证各节点视图的 Mermaid 渲染 id 唯一。
 */
let nextEditorMermaidId = 0;
/**
 * Upper clamp for the automatic fit scale of editor diagrams.
 * 编辑器图表自动适配缩放的上限。
 */
const maxEditorMermaidScale = 1.35;

/**
 * Resolve the current document theme for Mermaid rendering.
 * 获取当前文档主题以供 Mermaid 渲染使用。
 *
 * @returns The active Mermaid theme name / 当前 Mermaid 主题名
 */
function getMermaidTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * React hook that tracks the document theme, following `data-theme` attribute changes.
 * 跟踪文档主题的 React 钩子，随 `data-theme` 属性变化更新。
 *
 * @returns The active Mermaid theme name / 当前 Mermaid 主题名
 */
function useMermaidTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState(getMermaidTheme);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(getMermaidTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

/**
 * Read a diagram's intrinsic size from its viewBox, width/height attributes, or measured bounds.
 * 从 viewBox、width/height 属性或测量边界读取图表的固有尺寸。
 *
 * @param svg - Rendered Mermaid SVG element / 已渲染的 Mermaid SVG 元素
 * @returns The diagram size, or null when it cannot be measured / 图表尺寸；无法测量时返回 null
 */
function getMermaidDiagramSize(svg: SVGSVGElement): MermaidDiagramSize | null {
  const viewBox = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[ ,]+/)
    .map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  const width = Number.parseFloat(svg.getAttribute('width') ?? '');
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }

  try {
    const bounds = svg.getBBox();
    if (bounds.width > 0 && bounds.height > 0) return bounds;
  } catch {
    // Detached or test DOM SVG elements may not expose layout bounds. / 脱离文档或测试 DOM 中的 SVG 元素可能不提供布局边界。
  }
  return null;
}

/**
 * Parse a CSS length string into a pixel number, falling back to zero.
 * 将 CSS 长度字符串解析为像素数字，失败时回退为 0。
 *
 * @param value - CSS length value / CSS 长度值
 * @returns The parsed pixel count, or 0 on failure / 解析得到的像素数；失败时为 0
 */
function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Scale the rendered SVG to fit the preview box, clamped to sensible bounds.
 * 将已渲染的 SVG 缩放到预览框内，并限制在合理范围。
 *
 * @param preview - Preview container element / 预览容器元素
 * @param canvas - Canvas element holding the SVG / 承载 SVG 的画布元素
 * @param svg - The rendered diagram SVG / 已渲染的图表 SVG
 * @returns Nothing. / 无返回值。
 */
function fitMermaidSvgToPreview(preview: HTMLElement, canvas: HTMLElement, svg: SVGSVGElement): void {
  const diagramSize = getMermaidDiagramSize(svg);
  if (!diagramSize || preview.clientWidth <= 0) return;

  const canvasStyle = window.getComputedStyle(canvas);
  const horizontalPadding = cssPixels(canvasStyle.paddingLeft) + cssPixels(canvasStyle.paddingRight);
  const verticalPadding = cssPixels(canvasStyle.paddingTop) + cssPixels(canvasStyle.paddingBottom);
  const availableWidth = Math.max(1, preview.clientWidth - horizontalPadding);

  const previewMaxHeight = cssPixels(window.getComputedStyle(preview).maxHeight);
  const fallbackMaxHeight = Math.min(460, Math.max(220, window.innerHeight * 0.46));
  const availableHeight = Math.max(1, (previewMaxHeight || fallbackMaxHeight) - verticalPadding);
  const fitScale = Math.min(
    availableWidth / diagramSize.width,
    availableHeight / diagramSize.height,
  );
  const scale = Math.max(0.01, Math.min(maxEditorMermaidScale, fitScale));

  svg.style.width = `${Math.round(diagramSize.width * scale)}px`;
  svg.style.height = `${Math.round(diagramSize.height * scale)}px`;
  svg.style.minWidth = '0';
  svg.style.maxWidth = 'none';
  svg.dataset.fitScale = scale.toFixed(3);
}

/**
 * The React node view is reserved for Mermaid, whose diagram preview needs React state.
 * React 节点视图专供 Mermaid 使用，其图表预览需要 React 状态。
 *
 * @param props - Node view props from Tiptap / Tiptap 传入的节点视图属性
 * @returns The Mermaid node view for this code block / 该代码块的 Mermaid 节点视图
 */
export default function CodeBlockNodeView(props: NodeViewProps) {
  return <MermaidCodeBlockNodeView {...props} />;
}

/**
 * Mermaid-specific node view: editable source plus a live preview with fullscreen viewing.
 * Mermaid 专用节点视图：可编辑源码加实时预览，并支持全屏查看。
 *
 * @param props - Node view props from Tiptap / Tiptap 传入的节点视图属性
 * @returns The rendered Mermaid node view element / 渲染后的 Mermaid 节点视图元素
 */
function MermaidCodeBlockNodeView({ node, editor, getPos }: NodeViewProps) {
  const source = node.textContent;
  const theme = useMermaidTheme();
  const canvasRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLPreElement>(null);
  const [isSourceVisible, setIsSourceVisible] = useState(false);
  const [renderState, setRenderState] = useState<MermaidRenderState>('empty');
  const [renderedDiagram, setRenderedDiagram] = useState<string | null>(null);
  const [viewedDiagram, setViewedDiagram] = useState<string | null>(null);

  useEffect(() => {
    if (!isSourceVisible) return undefined;
    const wrapper = sourceRef.current?.parentElement;
    if (!wrapper) return undefined;

    const hideSource = () => setIsSourceVisible(false);
    const selectionIsInsideSource = () => {
      if (!editor) return false;
      const position = getPos();
      if (typeof position !== 'number') return false;
      const { from, to } = editor.state.selection;
      // Selection events can precede React props after typing; use the current document bounds. / 输入后选区事件可能早于 React 属性更新；改用当前文档边界判断。
      const currentNode = editor.state.doc.nodeAt(position);
      return !!currentNode && from >= position + 1 && to <= position + currentNode.nodeSize - 1;
    };
    const hideOutsideSource = (event: Event) => {
      // ProseMirror focuses its root even when the caret is inside this node. / 即使光标在该节点内，ProseMirror 也会聚焦其根元素。
      if (event.type === 'focusin' && event.target === editor?.view.dom && selectionIsInsideSource()) return;
      if (event.target instanceof window.Node && !wrapper.contains(event.target)) hideSource();
    };
    const hideOutsideSelection = () => {
      if (!selectionIsInsideSource()) hideSource();
    };

    document.addEventListener('click', hideOutsideSource, true);
    document.addEventListener('focusin', hideOutsideSource, true);
    window.addEventListener('blur', hideSource);
    editor?.on('selectionUpdate', hideOutsideSelection);
    return () => {
      document.removeEventListener('click', hideOutsideSource, true);
      document.removeEventListener('focusin', hideOutsideSource, true);
      window.removeEventListener('blur', hideSource);
      editor?.off('selectionUpdate', hideOutsideSelection);
    };
  }, [isSourceVisible, editor, getPos]);

  useEffect(() => {
    if (!isSourceVisible || !editor) return;
    const position = getPos();
    if (typeof position === 'number') {
      // Reveal contentDOM before ProseMirror moves the caret into the source. / 在 ProseMirror 把光标移入源码前先显示 contentDOM。
      editor.chain().setTextSelection(position + 1).focus().run();
    }
  }, [isSourceVisible, editor, getPos]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const preview = previewRef.current;
    if (!canvas || !preview) return undefined;
    canvas.replaceChildren();
    setRenderedDiagram(null);
    setViewedDiagram(null);

    if (!source.trim()) {
      setRenderState('empty');
      return undefined;
    }

    let active = true;
    let resizeObserver: ResizeObserver | undefined;
    let refitDiagram: (() => void) | undefined;
    setRenderState('loading');
    const timer = window.setTimeout(() => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: theme === 'dark' ? 'dark' : 'default',
      });

      const diagramId = `menghan-editor-mermaid-${++nextEditorMermaidId}`;
      void (async () => {
        const parsed = await mermaid.parse(source, { suppressErrors: true });
        if (!active) return;
        if (!parsed) {
          setRenderState('error');
          return;
        }

        // Mermaid measures the generated SVG during layout. A detached host / Mermaid 在布局过程中测量生成的 SVG；脱离文档的宿主
        // makes complex diagrams fail in Chromium, so mount an isolated host / 会让 Chromium 中的复杂图表失败，因此挂载一个隔离宿主
        // briefly without letting Mermaid write into the live editor or page root. / 短暂渲染，避免 Mermaid 写入实时编辑器或页面根节点。
        const renderHost = document.createElement('div');
        renderHost.className = 'mermaid-editor-render-host';
        renderHost.setAttribute('aria-hidden', 'true');
        document.body.append(renderHost);
        try {
          const { svg, bindFunctions } = await mermaid.render(diagramId, source, renderHost);
          if (!active) return;
          canvas.innerHTML = svg;
          setRenderedDiagram(svg);
          bindFunctions?.(canvas);
          const renderedSvg = canvas.querySelector<SVGSVGElement>('svg');
          if (renderedSvg) {
            refitDiagram = () => fitMermaidSvgToPreview(preview, canvas, renderedSvg);
            refitDiagram();
            if (typeof ResizeObserver !== 'undefined') {
              resizeObserver = new ResizeObserver(refitDiagram);
              resizeObserver.observe(preview);
            }
            window.addEventListener('resize', refitDiagram);
          }
          setRenderState('ready');
        } finally {
          renderHost.remove();
        }
      })().catch(() => {
        if (!active) return;
        canvas.replaceChildren();
        setRenderedDiagram(null);
        setRenderState('error');
      });
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
      resizeObserver?.disconnect();
      if (refitDiagram) window.removeEventListener('resize', refitDiagram);
    };
  }, [source, theme]);

  return (
    <NodeViewWrapper as="div" className="mermaid-editor-node-view" data-code-block="true" data-language="mermaid">
        {/* Keep contentDOM mounted so hiding source preserves editing and serialization. / 始终挂载 contentDOM，隐藏源码时仍保留编辑与序列化能力。 */}
      <pre ref={sourceRef} className="mermaid-editor-source" hidden={!isSourceVisible}>
        <NodeViewContent as="code" className="language-mermaid" style={{ whiteSpace: 'pre' }} />
      </pre>
      <div
        ref={previewRef}
        className="mermaid-editor-preview"
        contentEditable={false}
        aria-label="Mermaid 图表预览"
      >
        {renderState === 'ready' && renderedDiagram ? (
          <div className="mermaid-editor-preview-toolbar" role="toolbar" aria-label="Mermaid 图表操作">
            <span className="mermaid-editor-preview-toolbar-spacer" />
            <button
              type="button"
              className="mermaid-editor-preview-expand-button"
              aria-label="全屏查看 Mermaid 图表"
              title="全屏查看图表"
              onMouseDown={event => event.preventDefault()}
              onClick={() => setViewedDiagram(renderedDiagram)}
            >
              <Maximize2 size={17} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div
          className="mermaid-editor-preview-edit"
          role="button"
          tabIndex={0}
          aria-label={t('点击编辑 Mermaid 代码')}
          aria-expanded={isSourceVisible}
          title={t('点击编辑 Mermaid 代码')}
          onPointerDown={event => {
            if (event.button !== 0) return;
            // Open before the previous diagram collapses and shifts the click target. / 在上一个图表收起、点击目标位移之前先打开源码。
            event.preventDefault();
            setIsSourceVisible(true);
          }}
          onMouseDown={event => event.preventDefault()}
          onClick={() => setIsSourceVisible(true)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsSourceVisible(true);
            }
          }}
        >
          <div
            ref={canvasRef}
            className="mermaid-editor-preview-canvas"
            aria-busy={renderState === 'loading'}
          />
          {renderState === 'error' ? (
            <p className="mermaid-editor-preview-error">Mermaid 渲染失败，请检查图表语法。</p>
          ) : null}
          {renderState === 'empty' ? (
            <p className="mermaid-editor-preview-empty">{t('点击编写 Mermaid 图表')}</p>
          ) : null}
        </div>
      </div>
      {viewedDiagram ? <MermaidDiagramViewer svg={viewedDiagram} onClose={() => setViewedDiagram(null)} /> : null}
    </NodeViewWrapper>
  );
}
