import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LAYOUT_STORAGE_KEY, THEME_STORAGE_KEY, WINDOW_PREFERENCE_SAVE_DELAY_MS } from "../constants.js";
import { updatePreferences } from "../data/apiClient.js";
import { normalizeLayout, normalizeWindowSize, readSavedLayout, readSavedTheme } from "../utils/layout.js";

/**
 * Manage pane sizes, theme polarity, responsive inspector drawer, window size persistence, and WebView context menus.
 */
export function useWorkspaceChrome() {
  const [layoutSizes, setLayoutSizes] = useState(readSavedLayout);
  const [theme, setTheme] = useState(readSavedTheme);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 1120px)").matches
      : false
  );
  const windowPreferenceTimeoutRef = useRef(/** @type {number | null} */ (null));

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(max-width: 1120px)");
    const syncCompactLayout = () => setIsCompactLayout(media.matches);
    syncCompactLayout();
    media.addEventListener?.("change", syncCompactLayout);
    return () => media.removeEventListener?.("change", syncCompactLayout);
  }, []);

  const isInspectorOpen = isCompactLayout ? inspectorDrawerOpen : layoutSizes.inspectorOpen !== false;

  const toggleInspector = useCallback(() => {
    if (isCompactLayout) {
      setInspectorDrawerOpen((current) => !current);
      return;
    }
    setLayoutSizes((current) => ({ ...current, inspectorOpen: current.inspectorOpen === false }));
  }, [isCompactLayout]);

  const closeInspector = useCallback(() => {
    setInspectorDrawerOpen(false);
    if (!isCompactLayout) {
      setLayoutSizes((current) => (current.inspectorOpen === false ? current : { ...current, inspectorOpen: false }));
    }
  }, [isCompactLayout]);

  useEffect(() => {
    if (!inspectorDrawerOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setInspectorDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorDrawerOpen]);

  useEffect(() => {
    const preventNativeContextMenu = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) {
        return;
      }
      const selectedText = window.getSelection?.()?.toString?.() ?? "";
      if (selectedText && target?.closest(".message-body, .inspector")) {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("contextmenu", preventNativeContextMenu, { capture: true });
    return () => {
      window.removeEventListener("contextmenu", preventNativeContextMenu, { capture: true });
    };
  }, []);

  useEffect(() => {
    let unlisten = null;

    async function bindWindowResizePersistence() {
      try {
        unlisten = await getCurrentWindow().onResized(({ payload }) => {
          const nextWindowSize = normalizeWindowSize(payload);
          if (!nextWindowSize) return;
          if (windowPreferenceTimeoutRef.current) {
            window.clearTimeout(windowPreferenceTimeoutRef.current);
          }
          windowPreferenceTimeoutRef.current = window.setTimeout(async () => {
            try {
              const currentWindow = getCurrentWindow();
              if ((await currentWindow.isMinimized?.()) || (await currentWindow.isMaximized?.())) {
                return;
              }
              await updatePreferences({ windowSize: nextWindowSize });
            } catch {
              // Ignore failed background window-preference writes.
            }
          }, WINDOW_PREFERENCE_SAVE_DELAY_MS);
        });
      } catch {
        // The same bundle can be inspected in a plain browser during development.
      }
    }

    void bindWindowResizePersistence();
    return () => {
      if (windowPreferenceTimeoutRef.current) {
        window.clearTimeout(windowPreferenceTimeoutRef.current);
        windowPreferenceTimeoutRef.current = null;
      }
      if (unlisten) void unlisten();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutSizes));
    } catch {
      // Local storage is optional; resizing should still work for this session.
    }
  }, [layoutSizes]);

  const startResize = useCallback(
    (pane, event) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startLayout = layoutSizes;
      handle.setPointerCapture?.(event.pointerId);

      const onPointerMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        setLayoutSizes((current) =>
          normalizeLayout({
            ...current,
            sidebar: pane === "sidebar" ? startLayout.sidebar + delta : current.sidebar,
            inspector: pane === "inspector" ? startLayout.inspector - delta : current.inspector
          })
        );
      };
      const stopResize = (upEvent) => {
        handle.releasePointerCapture?.(upEvent.pointerId);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [layoutSizes]
  );

  const nudgeResize = useCallback((pane, event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const amount = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setLayoutSizes((current) =>
      normalizeLayout({
        ...current,
        sidebar: pane === "sidebar" ? current.sidebar + direction * amount : current.sidebar,
        inspector: pane === "inspector" ? current.inspector - direction * amount : current.inspector
      })
    );
  }, []);

  return {
    layoutSizes,
    theme,
    toggleTheme,
    isCompactLayout,
    inspectorDrawerOpen,
    setInspectorDrawerOpen,
    isInspectorOpen,
    toggleInspector,
    closeInspector,
    startResize,
    nudgeResize
  };
}
