export function computeVirtualRange({ itemCount, scrollOffset, viewportSize, itemSize, overscan = 4 }) {
  const count = Math.max(0, Number.isFinite(itemCount) ? itemCount : 0);
  if (count === 0) {
    return { startIndex: 0, endIndex: 0, beforeSize: 0, afterSize: 0 };
  }

  const safeItemSize = Math.max(1, Number.isFinite(itemSize) ? itemSize : 1);
  const safeViewportSize = Math.max(1, Number.isFinite(viewportSize) ? viewportSize : safeItemSize);
  const totalSize = count * safeItemSize;
  const maxScrollOffset = Math.max(0, totalSize - safeViewportSize);
  const safeScrollOffset = Math.min(maxScrollOffset, Math.max(0, Number.isFinite(scrollOffset) ? scrollOffset : 0));
  const safeOverscan = Math.max(0, Number.isFinite(overscan) ? Math.floor(overscan) : 0);

  const visibleStart = Math.floor(safeScrollOffset / safeItemSize);
  const visibleCount = Math.ceil(safeViewportSize / safeItemSize);
  const startIndex = Math.max(0, Math.min(count, visibleStart - safeOverscan));
  const endIndex = Math.max(startIndex, Math.min(count, visibleStart + visibleCount + safeOverscan));

  return {
    startIndex,
    endIndex,
    beforeSize: startIndex * safeItemSize,
    afterSize: Math.max(0, (count - endIndex) * safeItemSize)
  };
}
