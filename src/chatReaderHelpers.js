export async function copyMessageText(text, clipboard = globalThis.navigator?.clipboard) {
  if (typeof text !== "string" || !clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function computeMeasuredVirtualRange({
  itemKeys,
  measuredHeights,
  estimatedItemSize,
  scrollOffset,
  viewportSize,
  overscan = 4
}) {
  const keys = Array.isArray(itemKeys) ? itemKeys : [];
  if (keys.length === 0) {
    return { startIndex: 0, endIndex: 0, beforeSize: 0, afterSize: 0, totalSize: 0 };
  }

  const safeEstimatedItemSize = Math.max(1, Number.isFinite(estimatedItemSize) ? estimatedItemSize : 1);
  const safeViewportSize = Math.max(1, Number.isFinite(viewportSize) ? viewportSize : safeEstimatedItemSize);
  const safeOverscan = Math.max(0, Number.isFinite(overscan) ? Math.floor(overscan) : 0);
  const offsets = new Array(keys.length + 1);
  offsets[0] = 0;

  for (let index = 0; index < keys.length; index += 1) {
    const measuredHeight = Number(measuredHeights?.[keys[index]]);
    const nextSize = Number.isFinite(measuredHeight) && measuredHeight > 0 ? Math.ceil(measuredHeight) : safeEstimatedItemSize;
    offsets[index + 1] = offsets[index] + nextSize;
  }

  const totalSize = offsets[keys.length];
  const maxScrollOffset = Math.max(0, totalSize - safeViewportSize);
  const safeScrollOffset = Math.min(maxScrollOffset, Math.max(0, Number.isFinite(scrollOffset) ? scrollOffset : 0));
  const visibleStartIndex = findItemIndexForOffset(offsets, safeScrollOffset);
  const visibleEndOffset = Math.min(totalSize - 1, safeScrollOffset + safeViewportSize - 1);
  const visibleEndIndex = findItemIndexForOffset(offsets, visibleEndOffset) + 1;
  const startIndex = Math.max(0, visibleStartIndex - safeOverscan);
  const endIndex = Math.max(startIndex, Math.min(keys.length, visibleEndIndex + safeOverscan));

  return {
    startIndex,
    endIndex,
    beforeSize: offsets[startIndex],
    afterSize: Math.max(0, totalSize - offsets[endIndex]),
    totalSize
  };
}

function findItemIndexForOffset(offsets, targetOffset) {
  let low = 0;
  let high = offsets.length - 2;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= targetOffset) low = middle + 1;
    else high = middle - 1;
  }

  return Math.max(0, Math.min(offsets.length - 2, low));
}
