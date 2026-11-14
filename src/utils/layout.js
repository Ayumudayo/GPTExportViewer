import { DEFAULT_LAYOUT, LAYOUT_LIMITS, LAYOUT_STORAGE_KEY, THEME_STORAGE_KEY } from "../constants.js";

/**
 * Clamp a numeric value into an inclusive [min, max] range.
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp persisted sidebar/inspector dimensions and drawer state within safe UI bounds.
 */
export function normalizeLayout(value = {}) {
  return {
    sidebar: clamp(Number(value.sidebar) || DEFAULT_LAYOUT.sidebar, LAYOUT_LIMITS.sidebar.min, LAYOUT_LIMITS.sidebar.max),
    inspector: clamp(Number(value.inspector) || DEFAULT_LAYOUT.inspector, LAYOUT_LIMITS.inspector.min, LAYOUT_LIMITS.inspector.max),
    inspectorOpen: value.inspectorOpen !== false
  };
}

/**
 * Validate and round persisted or event-reported desktop window dimensions.
 */
export function normalizeWindowSize(value) {
  const width = Math.round(Number(value?.width));
  const height = Math.round(Number(value?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240) {
    return null;
  }
  return { width, height };
}

/**
 * Keep floating context menus completely inside the viewport with margin.
 */
export function clampPopupPosition(x, y, width, height, viewportWidth, viewportHeight, margin = 12) {
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeViewportWidth = Math.max(safeMargin * 2 + 1, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(safeMargin * 2 + 1, Number(viewportHeight) || 0);
  const safeWidth = Math.max(0, Number(width) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const maxX = Math.max(safeMargin, safeViewportWidth - safeWidth - safeMargin);
  const maxY = Math.max(safeMargin, safeViewportHeight - safeHeight - safeMargin);
  return {
    x: clamp(Math.round(Number(x) || 0), safeMargin, maxX),
    y: clamp(Math.round(Number(y) || 0), safeMargin, maxY)
  };
}

/**
 * Compute the next focusable element index when wrapping Tab/Shift+Tab inside a modal dialog.
 */
export function getNextDialogFocusIndex(currentIndex, focusableCount, isShiftKey) {
  if (focusableCount <= 0) return -1;
  if (currentIndex < 0) return isShiftKey ? focusableCount - 1 : 0;
  if (isShiftKey) return currentIndex <= 0 ? focusableCount - 1 : currentIndex - 1;
  return currentIndex >= focusableCount - 1 ? 0 : currentIndex + 1;
}

/**
 * Scroll a fixed-row virtualized container so a target row index sits comfortably inside view.
 */
export function scrollVirtualRowIntoView(container, index, rowSize, padding = rowSize) {
  if (!container || index < 0 || rowSize <= 0) return false;
  const rowTop = index * rowSize;
  const rowBottom = rowTop + rowSize;
  const viewportHeight = container.clientHeight;
  if (viewportHeight <= 1) {
    container.scrollTop = Math.max(0, rowTop - rowSize * 2);
    return true;
  }
  const safePadding = Math.max(0, Math.min(padding, Math.floor((viewportHeight - rowSize) / 2)));
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + viewportHeight;
  if (rowTop < viewTop + safePadding) {
    container.scrollTop = Math.max(0, rowTop - safePadding);
    return true;
  }
  if (rowBottom > viewBottom - safePadding) {
    container.scrollTop = Math.max(0, rowBottom + safePadding - viewportHeight);
    return true;
  }
  return false;
}

/**
 * Find the first descendant element whose attribute matches `attrValue` without CSS-selector escaping issues.
 */
export function findDescendantByAttr(container, attrName, attrValue) {
  if (!container || !attrValue) return null;
  for (const node of container.querySelectorAll(`[${attrName}]`)) {
    if (node.getAttribute(attrName) === attrValue) {
      return node;
    }
  }
  return null;
}

/**
 * Read saved pane layout dimensions from localStorage, falling back to DEFAULT_LAYOUT.
 */
export function readSavedLayout() {
  try {
    return normalizeLayout(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}"));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/**
 * Read the saved UI theme preference ("dark" or "light") from localStorage.
 */
export function readSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
