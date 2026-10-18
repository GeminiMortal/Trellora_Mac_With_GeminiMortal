import brandIconUrl from '../../../build/icon.svg';

/**
 * Props for the BrandMark component.
 * BrandMark 组件的属性。
 */
interface BrandMarkProps {
  /** Rendered size in pixels (width = height). / 渲染尺寸（像素），宽高相等。 */
  size?: number;
}

/**
 * BrandMark: renders the unified knowledge-knot SVG as the app logo.
 * BrandMark：将统一的"知识织结"SVG 渲染为应用徽标。
 *
 * Uses the same graphic as the desktop icon for visual consistency.
 * 与桌面图标使用同一图形，保持视觉一致性。
 *
 * @param size - Icon size in pixels, defaults to 16 / 图标尺寸（像素），默认 16
 * @returns An img element with the brand icon / 带品牌图标的 img 元素
 */
export default function BrandMark({ size = 16 }: BrandMarkProps) {
  return (
    <img
      src={brandIconUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block' }}
    />
  );
}
