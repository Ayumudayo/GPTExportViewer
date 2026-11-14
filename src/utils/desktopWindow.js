import { currentMonitor, getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";
import { clamp, normalizeWindowSize } from "./layout.js";

/**
 * Restore the persisted desktop window size clamped to the active monitor work area.
 */
export async function applySavedWindowSize(windowSize) {
  const normalized = normalizeWindowSize(windowSize);
  if (!normalized) return;
  try {
    const currentWindow = getCurrentWindow();
    const monitor = await currentMonitor();
    const scaleFactor = Number(monitor?.scaleFactor) || window.devicePixelRatio || 1;
    const minWidth = Math.round(980 * scaleFactor);
    const minHeight = Math.round(620 * scaleFactor);
    const monitorWidth = Number(monitor?.size?.width);
    const monitorHeight = Number(monitor?.size?.height);
    const maxWidth = Number.isFinite(monitorWidth) && monitorWidth > 0 ? Math.max(minWidth, monitorWidth) : normalized.width;
    const maxHeight = Number.isFinite(monitorHeight) && monitorHeight > 0 ? Math.max(minHeight, monitorHeight) : normalized.height;
    const clampedWidth = clamp(normalized.width, minWidth, maxWidth);
    const clampedHeight = clamp(normalized.height, minHeight, maxHeight);
    await currentWindow.setSize(new PhysicalSize(clampedWidth, clampedHeight));
  } catch {
    // Browser-only development should still render even when Tauri window APIs are unavailable.
  }
}
