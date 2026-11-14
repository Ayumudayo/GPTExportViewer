import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GALLERY_GAP, GALLERY_MIN_CARD_WIDTH, GALLERY_ROW_SIZE } from "../constants.js";
import { useScrollViewport } from "../measuredVirtualList.js";
import { computeVirtualRange } from "../virtualWindow.js";

/**
 * Virtualize a fixed-height vertical list viewport and track its scroll container.
 */
export function useVirtualList(items, { itemSize, overscan = 8, resetKey = "" }) {
  const { containerRef, viewport, syncViewport } = useScrollViewport(resetKey);
  const range = computeVirtualRange({
    itemCount: items.length,
    scrollOffset: viewport.scrollOffset,
    viewportSize: viewport.viewportSize,
    itemSize,
    overscan
  });

  return {
    containerRef,
    beforeSize: range.beforeSize,
    afterSize: range.afterSize,
    items: items.slice(range.startIndex, range.endIndex).map((item, offset) => ({ item, index: range.startIndex + offset })),
    syncViewport
  };
}

/**
 * Virtualize a responsive multi-column CSS grid using measured column count and row height.
 */
export function useVirtualGrid(
  items,
  { estimatedRowSize = GALLERY_ROW_SIZE, minCardWidth = GALLERY_MIN_CARD_WIDTH, gap = GALLERY_GAP, overscan = 3, resetKey = "" } = {}
) {
  const { containerRef, viewport, syncViewport } = useScrollViewport(resetKey);
  const gridNodeRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const stageNodeRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [gridNode, setGridNode] = useState(/** @type {HTMLDivElement | null} */ (null));
  const gridRef = useMemo(() => {
    const callbackRef = Object.assign(
      (node) => {
        gridNodeRef.current = node;
        callbackRef.current = node;
        setGridNode((current) => (current === node ? current : node));
      },
      { current: /** @type {HTMLDivElement | null} */ (null) }
    );
    return callbackRef;
  }, []);
  const stageRef = useMemo(() => {
    const callbackRef = Object.assign(
      (node) => {
        stageNodeRef.current = node;
        callbackRef.current = node;
      },
      { current: /** @type {HTMLDivElement | null} */ (null) }
    );
    return callbackRef;
  }, []);
  const [gridMetrics, setGridMetrics] = useState({ columns: 1, rowSize: estimatedRowSize, offsetTop: 0 });
  const hasItems = items.length > 0;

  const measureGrid = useCallback(() => {
    const grid = gridNodeRef.current;
    if (!grid) return;
    const styles = window.getComputedStyle(grid);
    const templateColumns = styles.gridTemplateColumns.split(" ").filter(Boolean);
    const firstCard = grid.querySelector(".image-card");
    const measuredGap = Number.parseFloat(styles.rowGap) || gap;
    const columns = Math.max(1, templateColumns.length || Math.floor((viewport.width + gap) / (minCardWidth + gap)));
    const rowSize = Math.max(1, Math.round((firstCard?.getBoundingClientRect().height || estimatedRowSize - measuredGap) + measuredGap));
    const offsetTop = Math.max(0, Math.round(Number(stageNodeRef.current?.offsetTop) || 0));
    setGridMetrics((current) =>
      current.columns === columns && current.rowSize === rowSize && current.offsetTop === offsetTop
        ? current
        : { columns, rowSize, offsetTop }
    );
  }, [estimatedRowSize, gap, minCardWidth, viewport.width]);

  useEffect(() => {
    if (!gridNode) return undefined;
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(measureGrid) : null;
    measureGrid();
    resizeObserver?.observe(gridNode);
    window.addEventListener("resize", measureGrid);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureGrid);
    };
  }, [gridNode, hasItems, measureGrid]);

  const rowCount = Math.ceil(items.length / gridMetrics.columns);
  const range = computeVirtualRange({
    itemCount: rowCount,
    scrollOffset: Math.max(0, viewport.scrollOffset - gridMetrics.offsetTop),
    viewportSize: viewport.viewportSize,
    itemSize: gridMetrics.rowSize,
    overscan
  });
  const startIndex = range.startIndex * gridMetrics.columns;
  const endIndex = Math.min(items.length, range.endIndex * gridMetrics.columns);

  return {
    containerRef,
    stageRef,
    gridRef,
    gridOffsetTop: gridMetrics.offsetTop,
    beforeSize: range.beforeSize,
    afterSize: range.afterSize,
    columns: gridMetrics.columns,
    rowSize: gridMetrics.rowSize,
    items: items.slice(startIndex, endIndex).map((item, offset) => ({ item, index: startIndex + offset })),
    syncViewport
  };
}
