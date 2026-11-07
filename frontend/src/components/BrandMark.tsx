/**
 * 品牌图标：屋顶 + 账本层 + 橙色目录标记。
 *
 * 图形是用户提供的 `public/homeledger-mark.svg`，这里只负责尺寸与对齐；
 * 不内联路径，后续换图标只需要替换 public 里的 SVG。
 */
export function BrandMark({
  size = 34,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      className={className ? `brand-logo ${className}` : "brand-logo"}
      src="/homeledger-mark.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
