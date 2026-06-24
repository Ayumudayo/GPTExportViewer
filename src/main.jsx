import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  FileDown,
  FileImage,
  FolderOpen,
  HardDrive,
  Images,
  Info,
  MessageSquare,
  Paperclip,
  RefreshCcw,
  Search,
  Settings,
  Sparkles,
  Star,
  Tag,
  X,
  ZoomIn
} from "lucide-react";
import {
  assetUrl,
  fetchConversation,
  fetchConversations,
  fetchExports,
  fetchLibrary,
  fetchSettings,
  fetchStats,
  openSavedSessionsFolder,
  pickSourceFolder,
  saveSessions,
  updateSettings
} from "./data/apiClient.js";
import { formatDate, formatExportLabel, formatShortDate, roleInitial, roleLabel, truncate } from "./data/formatters.js";
import { computeMeasuredVirtualRange, copyMessageText as copyMessageTextToClipboard } from "./chatReaderHelpers.js";
import { getAdjacentIndex, getWheelDirection } from "./libraryNavigation.js";
import { computeVirtualRange } from "./virtualWindow.js";
import "./styles.css";

const CONVERSATION_ROW_SIZE = 64;
const LIBRARY_SIDE_ROW_SIZE = 68;
const ESTIMATED_MESSAGE_ROW_SIZE = 96;
const GALLERY_ROW_SIZE = 284;
const GALLERY_MIN_CARD_WIDTH = 176;
const GALLERY_GAP = 14;
const LAYOUT_STORAGE_KEY = "chatgpt-export-layout";
const FOCUSABLE_DIALOG_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(", ");
const DEFAULT_LAYOUT = { sidebar: 360, inspector: 340 };
const LAYOUT_LIMITS = {
  sidebar: { min: 280, max: 560 },
  inspector: { min: 280, max: 540 }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLayout(value = {}) {
  return {
    sidebar: clamp(Number(value.sidebar) || DEFAULT_LAYOUT.sidebar, LAYOUT_LIMITS.sidebar.min, LAYOUT_LIMITS.sidebar.max),
    inspector: clamp(Number(value.inspector) || DEFAULT_LAYOUT.inspector, LAYOUT_LIMITS.inspector.min, LAYOUT_LIMITS.inspector.max)
  };
}

function readSavedLayout() {
  try {
    return normalizeLayout(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}"));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function useScrollViewport(resetKey) {
  const containerRef = useRef(null);
  const [viewport, setViewport] = useState({ scrollOffset: 0, viewportSize: 1, width: 1 });

  const updateViewport = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    const nextViewport = {
      scrollOffset: node.scrollTop,
      viewportSize: node.clientHeight || 1,
      width: node.clientWidth || 1
    };
    setViewport((current) =>
      current.scrollOffset === nextViewport.scrollOffset &&
      current.viewportSize === nextViewport.viewportSize &&
      current.width === nextViewport.width
        ? current
        : nextViewport
    );
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      const run = () => {
        frame = 0;
        updateViewport();
      };
      frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : window.setTimeout(run, 0);
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleUpdate) : null;

    updateViewport();
    node.addEventListener("scroll", scheduleUpdate, { passive: true });
    resizeObserver?.observe(node);
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      node.removeEventListener("scroll", scheduleUpdate);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      if (frame) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
        else window.clearTimeout(frame);
      }
    };
  }, [updateViewport]);

  useEffect(() => {
    const node = containerRef.current;
    if (node) node.scrollTop = 0;
    updateViewport();
  }, [resetKey, updateViewport]);

  return { containerRef, viewport };
}

function useVirtualList(items, { itemSize, overscan = 8, resetKey = "" }) {
  const { containerRef, viewport } = useScrollViewport(resetKey);
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
    items: items.slice(range.startIndex, range.endIndex).map((item, offset) => ({ item, index: range.startIndex + offset }))
  };
}

function useMeasuredVirtualList(items, { estimatedItemSize, overscan = 8, resetKey = "", getItemKey = (_, index) => index }) {
  const { containerRef, viewport } = useScrollViewport(resetKey);
  const [measuredHeights, setMeasuredHeights] = useState({});
  const measuredHeightsRef = useRef({});
  const observerEntriesRef = useRef(new Map());
  const itemRefCallbacksRef = useRef(new Map());
  const frameRef = useRef(0);

  const syncMeasuredHeights = useCallback(() => {
    if (frameRef.current) return;
    const schedule =
      typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback) => window.setTimeout(callback, 0);

    frameRef.current = schedule(() => {
      frameRef.current = 0;
      const nextHeights = measuredHeightsRef.current;
      setMeasuredHeights((current) => {
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(nextHeights);
        if (
          currentKeys.length === nextKeys.length &&
          nextKeys.every((key) => current[key] === nextHeights[key])
        ) {
          return current;
        }
        return nextHeights;
      });
    });
  }, []);

  const disconnectMeasuredNode = useCallback((key) => {
    const entry = observerEntriesRef.current.get(key);
    if (!entry) return;
    entry.observer?.disconnect();
    observerEntriesRef.current.delete(key);
  }, []);

  const rememberMeasuredHeight = useCallback(
    (key, height) => {
      const nextHeight = Math.max(1, Math.ceil(Number(height) || 0));
      if (!Number.isFinite(nextHeight) || measuredHeightsRef.current[key] === nextHeight) return;
      measuredHeightsRef.current = { ...measuredHeightsRef.current, [key]: nextHeight };
      syncMeasuredHeights();
    },
    [syncMeasuredHeights]
  );

  const bindMeasuredNode = useCallback(
    (key, node) => {
      const currentEntry = observerEntriesRef.current.get(key);
      if (currentEntry?.node === node) return;
      disconnectMeasuredNode(key);
      if (!node) return;

      const measureNode = () => rememberMeasuredHeight(key, node.getBoundingClientRect().height);
      let observer = null;
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver((entries) => {
          const nextHeight = entries[0]?.contentRect?.height ?? node.getBoundingClientRect().height;
          rememberMeasuredHeight(key, nextHeight);
        });
        observer.observe(node);
      }

      observerEntriesRef.current.set(key, { node, observer });
      measureNode();
    },
    [disconnectMeasuredNode, rememberMeasuredHeight]
  );

  const measureItem = useCallback(
    (key) => {
      if (!itemRefCallbacksRef.current.has(key)) {
        itemRefCallbacksRef.current.set(key, (node) => bindMeasuredNode(key, node));
      }
      return itemRefCallbacksRef.current.get(key);
    },
    [bindMeasuredNode]
  );

  useEffect(() => {
    for (const key of observerEntriesRef.current.keys()) disconnectMeasuredNode(key);
    itemRefCallbacksRef.current.clear();
    measuredHeightsRef.current = {};
    setMeasuredHeights({});
  }, [disconnectMeasuredNode, resetKey]);

  useEffect(
    () => () => {
      for (const key of observerEntriesRef.current.keys()) disconnectMeasuredNode(key);
      if (frameRef.current) {
        if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(frameRef.current);
        } else if (typeof window !== "undefined") {
          window.clearTimeout(frameRef.current);
        }
      }
    },
    [disconnectMeasuredNode]
  );

  const itemKeys = useMemo(() => items.map((item, index) => String(getItemKey(item, index))), [getItemKey, items]);
  const range = useMemo(
    () =>
      computeMeasuredVirtualRange({
        itemKeys,
        measuredHeights,
        estimatedItemSize,
        scrollOffset: viewport.scrollOffset,
        viewportSize: viewport.viewportSize,
        overscan
      }),
    [estimatedItemSize, itemKeys, measuredHeights, overscan, viewport.scrollOffset, viewport.viewportSize]
  );

  return {
    containerRef,
    beforeSize: range.beforeSize,
    afterSize: range.afterSize,
    items: items.slice(range.startIndex, range.endIndex).map((item, offset) => ({ item, index: range.startIndex + offset })),
    measureItem
  };
}

function useVirtualGrid(items, { estimatedRowSize = GALLERY_ROW_SIZE, minCardWidth = GALLERY_MIN_CARD_WIDTH, gap = GALLERY_GAP, overscan = 3, resetKey = "" } = {}) {
  const { containerRef, viewport } = useScrollViewport(resetKey);
  const gridRef = useRef(null);
  const [gridMetrics, setGridMetrics] = useState({ columns: 1, rowSize: estimatedRowSize });

  const measureGrid = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const styles = window.getComputedStyle(grid);
    const templateColumns = styles.gridTemplateColumns.split(" ").filter(Boolean);
    const firstCard = grid.querySelector(".image-card");
    const measuredGap = Number.parseFloat(styles.rowGap) || gap;
    const columns = Math.max(1, templateColumns.length || Math.floor((viewport.width + gap) / (minCardWidth + gap)));
    const rowSize = Math.max(1, Math.round((firstCard?.getBoundingClientRect().height || estimatedRowSize - measuredGap) + measuredGap));
    setGridMetrics((current) => (current.columns === columns && current.rowSize === rowSize ? current : { columns, rowSize }));
  }, [estimatedRowSize, gap, minCardWidth, viewport.width]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(measureGrid) : null;
    measureGrid();
    resizeObserver?.observe(grid);
    window.addEventListener("resize", measureGrid);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureGrid);
    };
  }, [measureGrid]);

  const rowCount = Math.ceil(items.length / gridMetrics.columns);
  const range = computeVirtualRange({
    itemCount: rowCount,
    scrollOffset: viewport.scrollOffset,
    viewportSize: viewport.viewportSize,
    itemSize: gridMetrics.rowSize,
    overscan
  });
  const startIndex = range.startIndex * gridMetrics.columns;
  const endIndex = Math.min(items.length, range.endIndex * gridMetrics.columns);

  return {
    containerRef,
    gridRef,
    beforeSize: range.beforeSize,
    afterSize: range.afterSize,
    columns: gridMetrics.columns,
    items: items.slice(startIndex, endIndex).map((item, offset) => ({ item, index: startIndex + offset }))
  };
}

function VirtualSpacer({ size }) {
  if (!size) return null;
  return <div className="virtual-spacer" style={{ height: size }} aria-hidden="true" />;
}

function toggleSelection(current, id) {
  return current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id];
}

function selectConversationRange(conversations, anchorId, targetId) {
  const targetIndex = conversations.findIndex((item) => item.id === targetId);
  const anchorIndex = conversations.findIndex((item) => item.id === anchorId);
  if (targetIndex < 0) return [];
  if (anchorIndex < 0) return [targetId];
  const startIndex = Math.min(anchorIndex, targetIndex);
  const endIndex = Math.max(anchorIndex, targetIndex);
  return conversations.slice(startIndex, endIndex + 1).map((item) => item.id);
}

function reconcileConversationSelection(conversations, selectedConversationIds, lastSelectedConversationId) {
  const availableIds = new Set(conversations.map((item) => item.id));
  return {
    selectedConversationIds: selectedConversationIds.filter((id) => availableIds.has(id)),
    lastSelectedConversationId: availableIds.has(lastSelectedConversationId) ? lastSelectedConversationId : ""
  };
}

function getNextDialogFocusIndex(currentIndex, focusableCount, isShiftKey) {
  if (focusableCount <= 0) return -1;
  if (currentIndex < 0) return isShiftKey ? focusableCount - 1 : 0;
  if (isShiftKey) return currentIndex <= 0 ? focusableCount - 1 : currentIndex - 1;
  return currentIndex >= focusableCount - 1 ? 0 : currentIndex + 1;
}

function useAutoLoadMore({ hasMore, isLoading, onLoadMore }) {
  const sentinelRef = useRef(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;

    if (typeof IntersectionObserver === "undefined") {
      if (!isLoading) onLoadMoreRef.current();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!isLoading && entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { root: null, rootMargin: "240px 0px", threshold: 0.01 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoading]);

  return sentinelRef;
}

function App() {
  const [mode, setMode] = useState(new URLSearchParams(window.location.search).get("view") === "library" ? "library" : "chat");
  const [settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [sourceVersion, setSourceVersion] = useState(0);
  const [layoutSizes, setLayoutSizes] = useState(readSavedLayout);
  const [exports, setExports] = useState([]);
  const [selectedExportId, setSelectedExportId] = useState("");
  const [query, setQuery] = useState("");
  const [conversationFilter, setConversationFilter] = useState("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationIds, setSelectedConversationIds] = useState([]);
  const [lastSelectedConversationId, setLastSelectedConversationId] = useState("");
  const [sessionContextMenuState, setSessionContextMenu] = useState(null);
  const sessionContextMenu = sessionContextMenuState;
  const [sessionExportJob, setSessionExportJob] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [library, setLibrary] = useState([]);
  const [selectedImageId, setSelectedImageId] = useState("");
  const [stats, setStats] = useState(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [busy, setBusy] = useState("Starting");
  const [loadingMore, setLoadingMore] = useState("");
  const loadingMoreKeyRef = useRef("");
  const [error, setError] = useState("");
  const [conversationPage, setConversationPage] = useState(null);
  const [libraryPage, setLibraryPage] = useState(null);
  const latestLoadStateRef = useRef({});

  latestLoadStateRef.current = {
    selectedExportId,
    sourceVersion,
    query,
    conversationFilter,
    libraryFilter,
    selectedConversationId,
    conversationPageCursor: conversationPage?.nextCursor ?? "",
    libraryPageCursor: libraryPage?.nextCursor ?? "",
    messageNextStart: conversation?.range?.nextStart ?? null
  };

  const beginLoadingMore = useCallback((status, key) => {
    if (loadingMoreKeyRef.current) return false;
    loadingMoreKeyRef.current = key;
    setLoadingMore(status);
    return true;
  }, []);

  const finishLoadingMore = useCallback((key) => {
    if (loadingMoreKeyRef.current !== key) return;
    loadingMoreKeyRef.current = "";
    setLoadingMore("");
  }, []);

  useEffect(() => {
    let ignore = false;
    setBusy("Loading exports");
    Promise.all([fetchSettings(), fetchExports()])
      .then(([settingsPayload, exportPayload]) => {
        if (ignore) return;
        setSettings(settingsPayload.settings ?? null);
        setSettingsDraft(settingsPayload.settings?.sourceRoot ?? "");
        setExports(exportPayload.exports ?? []);
        setSelectedExportId((current) => current || exportPayload.exports?.[0]?.id || "");
      })
      .catch((nextError) => setError(nextError.message))
      .finally(() => !ignore && setBusy(""));
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutSizes));
    } catch {
      // Local storage is optional; resizing should still work for this session.
    }
  }, [layoutSizes]);

  useEffect(() => {
    setSelectedConversationIds([]);
    setLastSelectedConversationId("");
    setSessionContextMenu(null);
  }, [mode, selectedExportId, query, conversationFilter]);

  useEffect(() => {
    const reconciled = reconcileConversationSelection(conversations, selectedConversationIds, lastSelectedConversationId);
    if (
      reconciled.selectedConversationIds.length !== selectedConversationIds.length ||
      reconciled.selectedConversationIds.some((id, index) => id !== selectedConversationIds[index])
    ) {
      setSelectedConversationIds(reconciled.selectedConversationIds);
    }
    if (reconciled.lastSelectedConversationId !== lastSelectedConversationId) {
      setLastSelectedConversationId(reconciled.lastSelectedConversationId);
    }
    if (sessionContextMenuState && !conversations.some((item) => item.id === sessionContextMenuState.conversationId)) {
      setSessionContextMenu(null);
    }
  }, [conversations, lastSelectedConversationId, selectedConversationIds, sessionContextMenuState]);

  useEffect(() => {
    if (!selectedExportId) return;
    let ignore = false;
    setBusy("Indexing");
    Promise.all([
      fetchStats(selectedExportId),
      fetchConversations({ exportId: selectedExportId, query, filter: conversationFilter, limit: 80 }),
      fetchLibrary({ exportId: selectedExportId, query, filter: libraryFilter, limit: 120 })
    ])
      .then(([nextStats, conversationPayload, libraryPayload]) => {
        if (ignore) return;
        const nextConversations = conversationPayload.items ?? [];
        const nextLibrary = libraryPayload.items ?? [];
        setStats(nextStats);
        setConversations(nextConversations);
        setLibrary(nextLibrary);
        setConversationPage(conversationPayload.page ?? null);
        setLibraryPage(libraryPayload.page ?? null);
        setSelectedConversationId((current) => (nextConversations.some((item) => item.id === current) ? current : nextConversations[0]?.id || ""));
        setSelectedImageId((current) => (nextLibrary.some((item) => item.fileId === current) ? current : nextLibrary[0]?.fileId || ""));
      })
      .catch((nextError) => setError(nextError.message))
      .finally(() => !ignore && setBusy(""));
    return () => {
      ignore = true;
    };
  }, [selectedExportId, query, conversationFilter, libraryFilter, sourceVersion]);

  useEffect(() => {
    if (!selectedExportId || !selectedConversationId) return;
    let ignore = false;
    setBusy("Loading conversation");
    fetchConversation({ exportId: selectedExportId, conversationId: selectedConversationId, limit: 120 })
      .then((payload) => {
        if (!ignore) setConversation(payload);
      })
      .catch((nextError) => setError(nextError.message))
      .finally(() => !ignore && setBusy(""));
    return () => {
      ignore = true;
    };
  }, [selectedExportId, selectedConversationId, sourceVersion]);

  const openSettings = useCallback(() => {
    setSettingsDraft(settings?.sourceRoot ?? "");
    setSettingsError("");
    setSettingsOpen(true);
  }, [settings?.sourceRoot]);

  const closeSettings = useCallback(() => {
    if (!settingsSaving) setSettingsOpen(false);
  }, [settingsSaving]);

  const saveSettings = useCallback(
    async (event) => {
      event.preventDefault();
      const sourceRoot = settingsDraft.trim();
      if (!sourceRoot) {
        setSettingsError("Source folder is required");
        return;
      }
      setSettingsSaving(true);
      setSettingsError("");
      setBusy("Updating settings");
      try {
        const payload = await updateSettings({ sourceRoot });
        const nextExports = payload.exports ?? [];
        setSettings(payload.settings ?? null);
        setExports(nextExports);
        setSelectedExportId(nextExports[0]?.id || "");
        setSelectedConversationId("");
        setSelectedConversationIds([]);
        setLastSelectedConversationId("");
        setSessionContextMenu(null);
        setConversation(null);
        setConversations([]);
        setLibrary([]);
        setSelectedImageId("");
        setStats(null);
        setConversationPage(null);
        setLibraryPage(null);
        setLightboxOpen(false);
        setSourceVersion((current) => current + 1);
        setError("");
        setSettingsOpen(false);
      } catch (nextError) {
        setSettingsError(nextError.message);
        setError(nextError.message);
      } finally {
        setSettingsSaving(false);
        setBusy("");
      }
    },
    [settingsDraft]
  );

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

  const closeSessionContextMenu = useCallback(() => {
    setSessionContextMenu(null);
  }, []);

  const isSessionExportRunning = sessionExportJob?.status === "running";

  const selectConversationRow = useCallback(
    (event, conversationId) => {
      if (isSessionExportRunning) return;
      setSelectedConversationId(conversationId);
      closeSessionContextMenu();

      if (event.shiftKey) {
        const anchorId = lastSelectedConversationId || selectedConversationId || conversationId;
        setSelectedConversationIds(selectConversationRange(conversations, anchorId, conversationId));
      } else if (event.ctrlKey || event.metaKey) {
        setSelectedConversationIds((current) => toggleSelection(current, conversationId));
      } else {
        setSelectedConversationIds([conversationId]);
      }

      setLastSelectedConversationId(conversationId);
    },
    [
      conversations,
      isSessionExportRunning,
      lastSelectedConversationId,
      selectedConversationId,
      closeSessionContextMenu
    ]
  );

  const openSessionContextMenu = useCallback(
    (event, conversationId) => {
      if (isSessionExportRunning) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      setSelectedConversationId(conversationId);
      if (!selectedConversationIds.includes(conversationId)) {
        setSelectedConversationIds([conversationId]);
      }
      setLastSelectedConversationId(conversationId);
      setSessionContextMenu({ x: event.clientX, y: event.clientY, conversationId });
    },
    [isSessionExportRunning, selectedConversationIds]
  );

  const exportSelectedSessions = useCallback(async () => {
    if (sessionExportJob?.status === "running") return;
    closeSessionContextMenu();
    const conversationIds = selectedConversationIds.length
      ? selectedConversationIds
      : selectedConversationId
        ? [selectedConversationId]
        : [];
    if (!selectedExportId || !conversationIds.length) return;

    setError("");
    setSessionExportJob({
      status: "running",
      total: conversationIds.length,
      completed: 0,
      exportId: selectedExportId,
      destinationDir: "",
      items: [],
      error: ""
    });

    try {
      const payload = await saveSessions({
        exportId: selectedExportId,
        conversationIds,
        onProgress: (progress) => {
          setSessionExportJob((current) =>
            current
              ? {
                  ...current,
                  total: progress?.total ?? current.total,
                  completed: progress?.completed ?? current.completed,
                  exportId: progress?.exportId ?? current.exportId,
                  status: "running"
                }
              : current
          );
        }
      });

      setSessionExportJob({
        status: "done",
        total: payload?.progress?.total ?? conversationIds.length,
        completed: payload?.progress?.completed ?? payload?.items?.length ?? 0,
        exportId: payload?.export?.id ?? selectedExportId,
        destinationDir: payload?.destinationDir ?? "",
        items: payload?.items ?? [],
        error: ""
      });
    } catch (nextError) {
      const message = nextError?.message ?? "Failed to export sessions";
      setSessionExportJob((current) => ({
        status: "error",
        total: current?.total ?? conversationIds.length,
        completed: current?.completed ?? 0,
        exportId: current?.exportId ?? selectedExportId,
        destinationDir: current?.destinationDir ?? "",
        items: current?.items ?? [],
        error: message
      }));
      setError(message);
    }
  }, [selectedConversationId, selectedConversationIds, selectedExportId, sessionExportJob?.status, closeSessionContextMenu]);

  useEffect(() => {
    if (isSessionExportRunning) {
      setSessionContextMenu(null);
    }
  }, [isSessionExportRunning]);

  const closeExportProgressDialog = useCallback(() => {
    setSessionExportJob((current) => (current?.status === "running" ? current : null));
  }, []);

  const openExportFolder = useCallback(async () => {
    if (!sessionExportJob?.exportId) return;
    try {
      const payload = await openSavedSessionsFolder({ exportId: sessionExportJob.exportId });
      setSessionExportJob((current) =>
        current
          ? {
              ...current,
              destinationDir: current.destinationDir || payload?.path || ""
            }
          : current
      );
    } catch (nextError) {
      const message = nextError?.message ?? "Failed to open export folder";
      setSessionExportJob((current) =>
        current
          ? {
              ...current,
              error: message
            }
          : current
      );
    }
  }, [sessionExportJob?.exportId]);

  useEffect(() => {
    if (!sessionContextMenuState) return;

    const closeOnKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSessionContextMenu();
      }
    };
    const closeOnPointerDown = () => closeSessionContextMenu();

    window.addEventListener("keydown", closeOnKeyDown);
    window.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnKeyDown);
      window.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [sessionContextMenuState, closeSessionContextMenu]);

  const selectedExport = exports.find((item) => item.id === selectedExportId) ?? null;
  const selectedImage = library.find((item) => item.fileId === selectedImageId) ?? library[0] ?? null;
  const selectedImageIndex = Math.max(library.findIndex((item) => item.fileId === selectedImage?.fileId), 0);

  const openPreviewFromQuery = useCallback(() => {
    const preview = new URLSearchParams(window.location.search).get("preview");
    if (preview && library.some((item) => item.fileId === preview)) {
      setSelectedImageId(preview);
      setMode("library");
      setLightboxOpen(true);
    }
  }, [library]);

  useEffect(() => {
    openPreviewFromQuery();
  }, [openPreviewFromQuery]);

  const moveLightbox = useCallback(
    (direction) => {
      if (!library.length) return;
      const nextIndex = getAdjacentIndex(selectedImageIndex, direction, library.length);
      if (nextIndex >= 0) setSelectedImageId(library[nextIndex].fileId);
    },
    [library, selectedImageIndex]
  );

  const loadMoreConversations = useCallback(async () => {
    const cursor = conversationPage?.nextCursor;
    if (!selectedExportId || !cursor) return;
    const loadKey = `sessions:${selectedExportId}:${sourceVersion}:${query}:${conversationFilter}:${cursor}`;
    if (!beginLoadingMore("sessions", loadKey)) return;
    try {
      const payload = await fetchConversations({
        exportId: selectedExportId,
        query,
        filter: conversationFilter,
        cursor,
        limit: conversationPage.limit ?? 80
      });
      const latest = latestLoadStateRef.current;
      if (
        latest.selectedExportId !== selectedExportId ||
        latest.sourceVersion !== sourceVersion ||
        latest.query !== query ||
        latest.conversationFilter !== conversationFilter ||
        latest.conversationPageCursor !== cursor
      ) return;
      setConversations((current) => mergeByKey(current, payload.items ?? [], "id"));
      setConversationPage(payload.page ?? null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      finishLoadingMore(loadKey);
    }
  }, [beginLoadingMore, conversationFilter, conversationPage, finishLoadingMore, query, selectedExportId, sourceVersion]);

  const loadMoreLibrary = useCallback(async () => {
    const cursor = libraryPage?.nextCursor;
    if (!selectedExportId || !cursor) return;
    const loadKey = `library:${selectedExportId}:${sourceVersion}:${query}:${libraryFilter}:${cursor}`;
    if (!beginLoadingMore("library", loadKey)) return;
    try {
      const payload = await fetchLibrary({
        exportId: selectedExportId,
        query,
        filter: libraryFilter,
        cursor,
        limit: libraryPage.limit ?? 120
      });
      const latest = latestLoadStateRef.current;
      if (
        latest.selectedExportId !== selectedExportId ||
        latest.sourceVersion !== sourceVersion ||
        latest.query !== query ||
        latest.libraryFilter !== libraryFilter ||
        latest.libraryPageCursor !== cursor
      ) return;
      setLibrary((current) => mergeByKey(current, payload.items ?? [], "fileId"));
      setLibraryPage(payload.page ?? null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      finishLoadingMore(loadKey);
    }
  }, [beginLoadingMore, finishLoadingMore, libraryFilter, libraryPage, query, selectedExportId, sourceVersion]);

  const loadMoreMessages = useCallback(async () => {
    const nextStart = conversation?.range?.nextStart;
    if (!selectedExportId || !selectedConversationId || nextStart == null) return;
    const loadKey = `messages:${selectedExportId}:${sourceVersion}:${selectedConversationId}:${nextStart}`;
    if (!beginLoadingMore("messages", loadKey)) return;
    try {
      const payload = await fetchConversation({
        exportId: selectedExportId,
        conversationId: selectedConversationId,
        start: nextStart,
        limit: conversation.range?.limit ?? 120
      });
      const latest = latestLoadStateRef.current;
      if (
        latest.selectedExportId !== selectedExportId ||
        latest.sourceVersion !== sourceVersion ||
        latest.selectedConversationId !== selectedConversationId ||
        latest.messageNextStart !== nextStart
      ) return;
      setConversation((current) => {
        if (!current || current.id !== payload.id) return current;
        return {
          ...payload,
          messages: mergeByKey(current.messages ?? [], payload.messages ?? [], "id")
        };
      });
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      finishLoadingMore(loadKey);
    }
  }, [beginLoadingMore, conversation, finishLoadingMore, selectedConversationId, selectedExportId, sourceVersion]);

  return (
    <div
      className="app-shell"
      style={{
        "--sidebar-width": `${layoutSizes.sidebar}px`,
        "--inspector-width": `${layoutSizes.inspector}px`
      }}
    >
      <Sidebar
        mode={mode}
        setMode={setMode}
        exports={exports}
        selectedExport={selectedExport}
        selectedExportId={selectedExportId}
        setSelectedExportId={setSelectedExportId}
        query={query}
        setQuery={setQuery}
        conversationFilter={conversationFilter}
        setConversationFilter={setConversationFilter}
        libraryFilter={libraryFilter}
        setLibraryFilter={setLibraryFilter}
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        selectedConversationIds={selectedConversationIds}
        onSelectConversationRow={selectConversationRow}
        onOpenSessionContextMenu={openSessionContextMenu}
        library={library}
        selectedImageId={selectedImageId}
        setSelectedImageId={setSelectedImageId}
        stats={stats}
        busy={busy}
        conversationPage={conversationPage}
        libraryPage={libraryPage}
        loadingMore={loadingMore}
        onLoadMoreConversations={loadMoreConversations}
        onLoadMoreLibrary={loadMoreLibrary}
        onOpenSettings={openSettings}
      />

      <ResizeHandle pane="sidebar" onPointerDown={startResize} onKeyDown={nudgeResize} />

      {mode === "chat" ? (
        <ChatReader
          conversation={conversation}
          selectedSummary={conversations.find((item) => item.id === selectedConversationId)}
          resetKey={`${selectedExportId}:${selectedConversationId}`}
          busy={busy}
          loadingMore={loadingMore}
          onLoadMoreMessages={loadMoreMessages}
        />
      ) : (
        <LibraryReader
          exportId={selectedExportId}
          images={library}
          image={selectedImage}
          selectedImageId={selectedImageId}
          setSelectedImageId={setSelectedImageId}
          stats={stats?.library}
          page={libraryPage}
          resetKey={`${selectedExportId}:${query}:${libraryFilter}`}
          busy={busy}
          loadingMore={loadingMore}
          onLoadMoreLibrary={loadMoreLibrary}
          openLightbox={() => setLightboxOpen(true)}
        />
      )}

      <ResizeHandle pane="inspector" onPointerDown={startResize} onKeyDown={nudgeResize} />

      <Inspector mode={mode} selectedExport={selectedExport} conversation={conversation} image={selectedImage} stats={stats} error={error} />

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          sourceRoot={settingsDraft}
          setSourceRoot={setSettingsDraft}
          saving={settingsSaving}
          error={settingsError}
          onError={setSettingsError}
          onClose={closeSettings}
          onSubmit={saveSettings}
        />
      )}

      <SessionContextMenu
        menu={sessionContextMenu}
        count={selectedConversationIds.length}
        onExport={exportSelectedSessions}
        onClose={closeSessionContextMenu}
      />

      <ExportProgressDialog job={sessionExportJob} onOpenFolder={openExportFolder} onClose={closeExportProgressDialog} />

      {lightboxOpen && selectedImage && (
        <ImageLightbox
          exportId={selectedExportId}
          image={selectedImage}
          currentIndex={selectedImageIndex}
          total={library.length}
          onClose={() => setLightboxOpen(false)}
          onMove={moveLightbox}
        />
      )}
    </div>
  );
}

function SessionContextMenu({ menu, count, onExport, onClose }) {
  if (!menu || count < 1) return null;
  const label = count === 1 ? "Export this session" : `Export ${count} selected sessions`;

  return (
    <div
      className="session-context-menu"
      role="group"
      aria-label="Session actions"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" onClick={onExport}>
        <FileDown size={15} />
        <span>{label}</span>
      </button>
      <button type="button" className="session-context-menu-close" aria-label="Close session context menu" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

function ExportProgressDialog({ job, onOpenFolder, onClose }) {
  const exportDialogRef = useRef(null);
  const previouslyFocusedElementRef = useRef(null);
  const isOpen = Boolean(job);

  useEffect(() => {
    if (!isOpen) return undefined;
    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    const dialog = exportDialogRef.current;
    const focusableElements = dialog ? Array.from(dialog.querySelectorAll(FOCUSABLE_DIALOG_SELECTOR)) : [];
    const initialFocusTarget = focusableElements[0] ?? dialog;
    initialFocusTarget?.focus?.();
    return () => {
      document.body.classList.remove("modal-open");
      const previousFocus = previouslyFocusedElementRef.current;
      if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event) => {
      const dialog = exportDialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape" && job.status !== "running") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "Tab") {
        const focusableElements = Array.from(dialog.querySelectorAll(FOCUSABLE_DIALOG_SELECTOR));
        const currentIndex = focusableElements.findIndex((element) => element === document.activeElement);
        const nextIndex = getNextDialogFocusIndex(currentIndex, focusableElements.length, event.shiftKey);
        event.preventDefault();
        if (nextIndex < 0) {
          dialog.focus();
          return;
        }
        focusableElements[nextIndex]?.focus?.();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, job?.status, onClose]);

  if (!job) return null;

  const percent = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;
  const title = job.status === "done" ? "Export complete" : job.status === "error" ? "Export failed" : "Exporting sessions...";

  return (
    <div className="export-progress-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
      <section
        className="export-progress-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-progress-title"
        tabIndex={-1}
        ref={exportDialogRef}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <FileDown size={18} />
            <h2 id="export-progress-title">{title}</h2>
          </div>
          {job.status !== "running" && (
            <button type="button" className="icon-button" aria-label="Close export dialog" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </header>

        <div className="progress-bar" role="progressbar" aria-label="Session export progress" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.completed}>
          <span style={{ width: `${percent}%` }} />
        </div>

        <p className="export-progress-count">
          {job.completed} / {job.total} sessions
        </p>

        {job.error && <p className="settings-error dialog-error">{job.error}</p>}
        {job.destinationDir && <p className="export-progress-path">{job.destinationDir}</p>}

        {(job.status === "done" || job.status === "error") && (
          <footer>
            {job.status === "done" && (
              <button type="button" className="primary-button export-progress-open" onClick={onOpenFolder}>
                <FolderOpen size={15} />
                Open folder
              </button>
            )}
            <button type="button" onClick={onClose}>
              Close
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}

function ResizeHandle({ pane, onPointerDown, onKeyDown }) {
  const label = pane === "sidebar" ? "Resize sidebar" : "Resize inspector";
  return (
    <div
      className={`resize-handle ${pane}-resize`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => onPointerDown(pane, event)}
      onKeyDown={(event) => onKeyDown(pane, event)}
    />
  );
}

function Sidebar({
  mode,
  setMode,
  exports,
  selectedExport,
  selectedExportId,
  setSelectedExportId,
  query,
  setQuery,
  conversationFilter,
  setConversationFilter,
  libraryFilter,
  setLibraryFilter,
  conversations,
  selectedConversationId,
  selectedConversationIds,
  onSelectConversationRow,
  onOpenSessionContextMenu: handleSessionContextPopup,
  library,
  selectedImageId,
  setSelectedImageId,
  stats,
  busy,
  conversationPage,
  libraryPage,
  loadingMore,
  onLoadMoreConversations,
  onLoadMoreLibrary,
  onOpenSettings
}) {
  const virtualConversations = useVirtualList(conversations, {
    itemSize: CONVERSATION_ROW_SIZE,
    overscan: 8,
    resetKey: `sessions:${selectedExportId}:${query}:${conversationFilter}`
  });
  const virtualSideImages = useVirtualList(library, {
    itemSize: LIBRARY_SIDE_ROW_SIZE,
    overscan: 8,
    resetKey: `library-side:${selectedExportId}:${query}:${libraryFilter}`
  });
  const conversationAutoLoadRef = useAutoLoadMore({
    hasMore: mode === "chat" && Boolean(conversationPage?.nextCursor),
    isLoading: Boolean(busy) || loadingMore === "sessions",
    onLoadMore: onLoadMoreConversations
  });
  const libraryAutoLoadRef = useAutoLoadMore({
    hasMore: mode === "library" && Boolean(libraryPage?.nextCursor),
    isLoading: Boolean(busy) || loadingMore === "library",
    onLoadMore: onLoadMoreLibrary
  });
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const selectExport = useCallback(
    (exportId) => {
      setSelectedExportId(exportId);
      setExportMenuOpen(false);
    },
    [setSelectedExportId]
  );

  const closeExportMenu = useCallback((event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setExportMenuOpen(false);
    }
  }, []);

  const handleExportMenuKeyDown = useCallback((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setExportMenuOpen(false);
    }
  }, []);

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>ChatGPT Export</h1>
        <button className="icon-button" aria-label="Settings" onClick={onOpenSettings}>
          <Settings size={17} />
        </button>
        <button className="icon-button" aria-label="Refresh" onClick={() => window.location.reload()}>
          <RefreshCcw size={17} />
        </button>
      </header>

      <div className="snapshot-switcher-wrap" onBlur={closeExportMenu} onKeyDown={handleExportMenuKeyDown}>
        <button type="button" className="snapshot-switcher" aria-haspopup="listbox" aria-expanded={exportMenuOpen} onClick={() => setExportMenuOpen((current) => !current)}>
          <span className="status-dot" />
          <span className="snapshot-selected-export">
            <strong>{selectedExport ? formatExportLabel(selectedExport) : "No export selected"}</strong>
          </span>
          <ChevronDown size={17} />
          <small title={selectedExport?.name ?? ""}>{selectedExport ? `${selectedExport.warnings?.length ?? 0} warnings` : "No export selected"}</small>
        </button>
        {exportMenuOpen && (
          <div className="snapshot-menu" role="listbox" aria-label="Export snapshots">
            {exports.map((item) => (
              <div
                key={item.id}
                className={`snapshot-option ${item.id === selectedExportId ? "selected" : ""}`}
                role="option"
                aria-selected={item.id === selectedExportId}
                tabIndex={0}
                title={item.name}
                onClick={() => selectExport(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectExport(item.id);
                  }
                }}
              >
                <span className="status-dot" />
                <span>
                  <strong>{formatExportLabel(item)}</strong>
                  <small>{item.warnings?.length ?? 0} warnings</small>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mode-switcher">
        <button className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}>
          <MessageSquare size={16} />
          Sessions
        </button>
        <button className={mode === "library" ? "active" : ""} onClick={() => setMode("library")}>
          <Images size={16} />
          Library
        </button>
      </div>

      <label className="search-field">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === "chat" ? "Search sessions" : "Search images"} />
        {query && (
          <button aria-label="Clear search" onClick={() => setQuery("")}>
            <X size={14} />
          </button>
        )}
      </label>

      {mode === "library" ? (
        <div className="segmented">
          {[
            ["all", "All"],
            ["linked", "Linked"],
            ["library-only", "Library"]
          ].map(([value, label]) => (
            <button key={value} className={libraryFilter === value ? "active" : ""} onClick={() => setLibraryFilter(value)}>
              {label}
            </button>
          ))}
        </div>
      ) : (
        <div className="segmented chat-filter" aria-label="Session filter">
          {[
            ["all", "All"],
            ["active", "Active"],
            ["archived", "Archived"]
          ].map(([value, label]) => (
            <button key={value} className={conversationFilter === value ? "active" : ""} onClick={() => setConversationFilter(value)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === "chat" ? (
        <div className="conversation-list" ref={virtualConversations.containerRef}>
          <VirtualSpacer size={virtualConversations.beforeSize} />
          {virtualConversations.items.map(({ item }) => (
            (() => {
              const isActive = item.id === selectedConversationId;
              const isExportSelected = selectedConversationIds.includes(item.id);
              return (
                <button
                  className={`conversation-row ${isActive ? "selected" : ""} ${isExportSelected ? "multi-selected" : ""}`}
                  key={item.id}
                  aria-current={isActive ? "true" : undefined}
                  aria-pressed={isExportSelected}
                  onClick={(event) => onSelectConversationRow(event, item.id)}
                  onContextMenu={(event) => handleSessionContextPopup(event, item.id)}
                >
                  <span className="star-wrap">{item.starred ? <Star className="starred" size={16} fill="currentColor" /> : <MessageSquare size={15} />}</span>
                  <span className="conversation-copy">
                    <strong>{item.title}</strong>
                    <span>
                      {item.messageCount} messages
                      {item.attachmentCount ? ` · ${item.attachmentCount} files` : ""}
                    </span>
                  </span>
                  <time>{formatShortDate(item.updatedAt)}</time>
                </button>
              );
            })()
          ))}
          <VirtualSpacer size={virtualConversations.afterSize} />
          {conversationPage?.nextCursor && (
            <div className={`auto-load-sentinel ${loadingMore === "sessions" ? "loading" : ""}`} ref={conversationAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMore === "sessions"}>
              {loadingMore === "sessions" ? "Loading sessions..." : `Auto-loading sessions (${conversations.length} / ${conversationPage.total})`}
            </div>
          )}
        </div>
      ) : (
        <div className="library-side-list" ref={virtualSideImages.containerRef}>
          <VirtualSpacer size={virtualSideImages.beforeSize} />
          {virtualSideImages.items.map(({ item }) => (
            <button
              className={`image-side-row ${item.fileId === selectedImageId ? "selected" : ""}`}
              key={item.fileId}
              onClick={() => setSelectedImageId(item.fileId)}
            >
              <Thumb exportId={selectedExportId} image={item} small />
              <span>
                <strong>{item.displayName}</strong>
                <em>{item.mime} · {item.sizeLabel}</em>
              </span>
              <small>{item.sourceState}</small>
            </button>
          ))}
          <VirtualSpacer size={virtualSideImages.afterSize} />
          {libraryPage?.nextCursor && (
            <div className={`auto-load-sentinel ${loadingMore === "library" ? "loading" : ""}`} ref={libraryAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMore === "library"}>
              {loadingMore === "library" ? "Loading images..." : `Auto-loading images (${library.length} / ${libraryPage.total})`}
            </div>
          )}
        </div>
      )}

      <footer className="sidebar-footer">
        <span>
          <Database size={14} />
          {busy || "Ready"}
        </span>
        <span>{mode === "chat" ? stats?.conversations?.totalConversations ?? 0 : stats?.library?.totalImages ?? 0} indexed</span>
      </footer>
    </aside>
  );
}

function ChatReader({ conversation, selectedSummary, resetKey, busy, loadingMore, onLoadMoreMessages }) {
  const title = conversation?.title ?? selectedSummary?.title ?? "No session selected";
  const messages = conversation?.messages ?? [];
  const virtualMessages = useMeasuredVirtualList(messages, {
    estimatedItemSize: ESTIMATED_MESSAGE_ROW_SIZE,
    overscan: 12,
    resetKey,
    getItemKey: (message) => message.id
  });
  const messageAutoLoadRef = useAutoLoadMore({
    hasMore: conversation?.range?.nextStart != null,
    isLoading: Boolean(busy) || loadingMore === "messages",
    onLoadMore: onLoadMoreMessages
  });
  const copyMessageText = useCallback(async (text) => {
    await copyMessageTextToClipboard(text);
  }, []);

  return (
    <main className="reader">
      <header className="reader-header">
        <div>
          <div className="title-line">
            <MessageSquare size={18} />
            <h2>{title}</h2>
            {conversation?.starred && <span className="library-pill">Starred</span>}
          </div>
          <span>{conversation?.model ?? selectedSummary?.model ?? "model unknown"}</span>
        </div>
      </header>

      <div className="range-strip">
        <span>{messages.length ? `Showing ${messages.length} of ${conversation.totalMessages}` : busy || "No messages"}</span>
        <span>{formatDate(conversation?.updatedAt, "")}</span>
      </div>

      <section className="message-window scroll-window" ref={virtualMessages.containerRef}>
        <VirtualSpacer size={virtualMessages.beforeSize} />
        {virtualMessages.items.map(({ item: message }) => (
          <article className={`message ${message.role === "user" ? "user" : ""}`} key={message.id} ref={virtualMessages.measureItem(message.id)}>
            <div className="avatar">{roleInitial(message.role)}</div>
            <div className="message-body">
              <button type="button" className="message-copy-button" aria-label="Copy message" onClick={() => void copyMessageText(message.text ?? "")}>
                <Copy size={14} />
              </button>
              <div className="message-meta">
                <strong>{roleLabel(message.role)}</strong>
                <time>{formatDate(message.createdAt, "")}</time>
              </div>
              <p>{truncate(message.text || "(empty message)", 1000)}</p>
              {message.assetRefs?.length > 0 && (
                <div className="attachment-chips">
                  {message.assetRefs.slice(0, 6).map((asset) => (
                    <span key={`${message.id}-${asset.fileId}`}>
                      <Paperclip size={13} />
                      {asset.name ?? asset.fileId}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </article>
        ))}
        <VirtualSpacer size={virtualMessages.afterSize} />
        {conversation?.range?.nextStart != null && (
          <div className={`auto-load-sentinel ${loadingMore === "messages" ? "loading" : ""}`} ref={messageAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMore === "messages"}>
            {loadingMore === "messages" ? "Loading messages..." : `Auto-loading messages (${messages.length} / ${conversation.totalMessages})`}
          </div>
        )}
      </section>

      <div className="composer">
        <span>(Read-only) This export is browsed locally.</span>
        <button aria-label="Read only">
          <Sparkles size={16} />
        </button>
      </div>

      <footer className="reader-status">
        <span className="ok">
          <Clock3 size={14} />
          Automatic message load
        </span>
        <span>JSON cache</span>
        <span>Local only</span>
      </footer>
    </main>
  );
}

function LibraryReader({ exportId, images, image, selectedImageId, setSelectedImageId, stats, page, resetKey, busy, loadingMore, onLoadMoreLibrary, openLightbox }) {
  const virtualImages = useVirtualGrid(images, { resetKey });
  const libraryAutoLoadRef = useAutoLoadMore({
    hasMore: Boolean(page?.nextCursor),
    isLoading: Boolean(busy) || loadingMore === "library",
    onLoadMore: onLoadMoreLibrary
  });

  return (
    <main className="reader library-reader">
      <header className="reader-header">
        <div>
          <div className="title-line">
            <Images size={18} />
            <h2>Library</h2>
            <span className="library-pill">Images</span>
          </div>
          <span>{images.length} visible images</span>
        </div>
        <div className="reader-actions">
          <button aria-label="Open selected image" onClick={openLightbox} disabled={!image}>
            <ZoomIn size={17} />
          </button>
        </div>
      </header>

      <div className="range-strip">
        <span>Linked, library-only, and missing-source images</span>
        <span>{stats?.missingFiles ? `${stats.missingFiles} missing files` : "streamed on demand"}</span>
      </div>

      <section className="gallery-window" ref={virtualImages.containerRef}>
        <div className="library-summary">
          <div>
            <strong>{stats?.totalImages ?? images.length}</strong>
            <span>Total images</span>
          </div>
          <div>
            <strong>{stats?.linkedImages ?? 0}</strong>
            <span>Linked to chats</span>
          </div>
          <div>
            <strong>{stats?.libraryOnlyImages ?? 0}</strong>
            <span>Library only</span>
          </div>
        </div>

        {image && (
          <div className="selected-image-strip">
            <Thumb exportId={exportId} image={image} small />
            <div>
              <strong>{image.displayName}</strong>
              <span>{image.mime} · {image.sizeLabel} · {image.sourceState}</span>
            </div>
            <button onClick={openLightbox}>
              <ExternalLink size={15} />
              Preview
            </button>
          </div>
        )}

        <VirtualSpacer size={virtualImages.beforeSize} />
        <div className="gallery-grid" ref={virtualImages.gridRef}>
          {virtualImages.items.map(({ item }) => (
            <button
              className={`image-card ${item.fileId === selectedImageId ? "selected" : ""}`}
              key={item.fileId}
              onClick={() => setSelectedImageId(item.fileId)}
              onDoubleClick={openLightbox}
            >
              <Thumb exportId={exportId} image={item} />
              <span className="image-card-copy">
                <strong>{item.displayName}</strong>
                <em>{item.mime} · {item.sizeLabel}</em>
              </span>
              <span className={`origin-chip ${item.sourceState === "linked" ? "linked" : ""}`}>{item.sourceState}</span>
            </button>
          ))}
        </div>
        <VirtualSpacer size={virtualImages.afterSize} />
        {page?.nextCursor && (
          <div className={`auto-load-sentinel ${loadingMore === "library" ? "loading" : ""}`} ref={libraryAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMore === "library"}>
            {loadingMore === "library" ? "Loading images..." : `Auto-loading images (${images.length} / ${page.total})`}
          </div>
        )}
      </section>

      <footer className="reader-status">
        <span className="ok">
          <HardDrive size={14} />
          Asset files stay on disk
        </span>
        <span>Images streamed by file id</span>
      </footer>
    </main>
  );
}

function ImageLightbox({ exportId, image, currentIndex, total, onClose, onMove }) {
  useEffect(() => {
    document.body.classList.add("modal-open");
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") onMove(1);
      if (event.key === "ArrowLeft") onMove(-1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, onMove]);

  const onWheel = (event) => {
    const direction = getWheelDirection(event.deltaY || event.deltaX);
    if (direction) onMove(direction);
  };

  return (
    <div className="lightbox-backdrop" role="dialog" aria-modal="true" aria-label="Image preview" onWheel={onWheel}>
      <div className="lightbox-shell">
        <header className="lightbox-header">
          <div>
            <strong>{image.displayName}</strong>
            <span>{currentIndex + 1} / {total}</span>
          </div>
          <div className="lightbox-actions">
            <button aria-label="Close preview" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="lightbox-stage">
          <button className="lightbox-step previous" aria-label="Previous image" onClick={() => onMove(-1)}>
            <ArrowLeft size={22} />
          </button>
          <div className="lightbox-image real-image">
            <img src={assetUrl(exportId, image.fileId)} alt={image.displayName} />
          </div>
          <button className="lightbox-step next" aria-label="Next image" onClick={() => onMove(1)}>
            <ArrowRight size={22} />
          </button>
        </div>
        <footer className="lightbox-footer">
          <span>{image.mime}</span>
          <span>{image.sourceState}</span>
          <span>{image.status}</span>
        </footer>
      </div>
    </div>
  );
}

function SettingsDialog({ settings, sourceRoot, setSourceRoot, saving, error, onError, onClose, onSubmit }) {
  const [browsing, setBrowsing] = useState(false);

  const browseSourceFolder = useCallback(
    async () => {
      setBrowsing(true);
      onError("");
      try {
        const payload = await pickSourceFolder({ initialPath: sourceRoot || settings?.sourceRoot || "" });
        if (payload.folder?.selectedPath) {
          setSourceRoot(payload.folder.selectedPath);
        }
      } catch (nextError) {
        onError(nextError.message);
      } finally {
        setBrowsing(false);
      }
    },
    [onError, setSourceRoot, settings?.sourceRoot, sourceRoot]
  );

  useEffect(() => {
    document.body.classList.add("modal-open");
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <form className="settings-dialog" onSubmit={onSubmit}>
        <header>
          <div>
            <Settings size={18} />
            <h2>Settings</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose} disabled={saving}>
            <X size={18} />
          </button>
        </header>

        <label className="settings-field" htmlFor="source-folder-input">
          <span>Source folder</span>
          <div className="settings-input-row">
            <input
              id="source-folder-input"
              value={sourceRoot}
              onChange={(event) => setSourceRoot(event.target.value)}
              disabled={saving || browsing}
              placeholder="E:\\OpenAI\\Exports"
              spellCheck={false}
            />
            <button type="button" aria-label="Browse source folder" onClick={browseSourceFolder} disabled={saving || browsing}>
              <FolderOpen size={15} />
              {browsing ? "Browsing..." : "Browse"}
            </button>
          </div>
        </label>

        <div className="settings-meta">
          <span>Cache</span>
          <strong title={settings?.cacheDir ?? ""}>{settings?.cacheDir ?? "-"}</strong>
        </div>

        {error && <p className="settings-error">{error}</p>}

        <footer>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Applying..." : "Apply"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Inspector({ mode, selectedExport, conversation, image, stats, error }) {
  return (
    <aside className="inspector">
      <Panel title="Export" icon={<Info size={17} />}>
        <dl className="detail-grid">
          <dt>Name</dt>
          <dd title={selectedExport?.name ?? ""}>{selectedExport ? formatExportLabel(selectedExport) : "None"}</dd>
          <dt>Modified</dt>
          <dd>{formatDate(selectedExport?.modifiedAt)}</dd>
          <dt>Warnings</dt>
          <dd>{selectedExport?.warnings?.length ?? 0}</dd>
        </dl>
      </Panel>

      {mode === "chat" ? (
        <>
          <Panel title="Session details" icon={<MessageSquare size={17} />}>
            <dl className="detail-grid">
              <dt>Session ID</dt>
              <dd>{conversation?.id ?? "-"}</dd>
              <dt>Messages</dt>
              <dd>{conversation?.totalMessages ?? 0}</dd>
              <dt>Model</dt>
              <dd>{conversation?.model ?? "-"}</dd>
              <dt>Updated</dt>
              <dd>{formatDate(conversation?.updatedAt)}</dd>
            </dl>
          </Panel>
          <Panel title="Index totals" icon={<Database size={17} />}>
            <div className="source-list">
              <div className="source-row">
                <span>Conversations</span>
                <em>{stats?.conversations?.totalConversations ?? 0}</em>
              </div>
              <div className="source-row">
                <span>Messages</span>
                <em>{stats?.conversations?.totalMessages ?? 0}</em>
              </div>
            </div>
          </Panel>
        </>
      ) : (
        <>
          <Panel title="Image details" icon={<FileImage size={17} />}>
            {image && <Thumb exportId={selectedExport?.id} image={image} preview />}
            <dl className="detail-grid">
              <dt>Name</dt>
              <dd>{image?.displayName ?? "-"}</dd>
              <dt>MIME</dt>
              <dd>{image?.mime ?? "-"}</dd>
              <dt>Size</dt>
              <dd>{image?.sizeLabel ?? "-"}</dd>
              <dt>Status</dt>
              <dd>{image?.status ?? "-"}</dd>
              <dt>File</dt>
              <dd>{image?.fileRef ?? "-"}</dd>
            </dl>
          </Panel>
          <Panel title="Origin" icon={<Tag size={17} />}>
            <div className="tag-list">
              <span>{image?.sourceState ?? "none"}</span>
              <span>{image?.sourceConversationId ?? "no source chat"}</span>
            </div>
          </Panel>
        </>
      )}

      <Panel title="Warnings" icon={<AlertTriangle size={17} />} count={error ? "1" : undefined} warning={Boolean(error)}>
        <p className="warning-copy">{error || selectedExport?.warnings?.join(", ") || "No active warnings."}</p>
      </Panel>
    </aside>
  );
}

function Thumb({ exportId, image, small = false, preview = false }) {
  if (!image?.exists || !exportId) {
    return (
      <span className={preview ? "inspector-preview tone-amber" : small ? "mini-thumb tone-amber" : "image-thumb tone-amber"}>
        <FileImage size={small ? 18 : 34} />
      </span>
    );
  }
  return (
    <span className={preview ? "inspector-preview real-thumb" : small ? "mini-thumb real-thumb" : "image-thumb real-thumb"}>
      <img src={assetUrl(exportId, image.fileId)} alt="" loading="lazy" />
    </span>
  );
}

function Panel({ title, icon, count, warning = false, children }) {
  return (
    <section className={`utility-panel ${warning ? "warning" : ""}`}>
      <header>
        <span>
          {icon}
          {title}
        </span>
        {count && <em>{count}</em>}
      </header>
      {children}
    </section>
  );
}

function mergeByKey(current, next, key) {
  const merged = [...current];
  const seen = new Set(current.map((item) => item[key]));
  for (const item of next) {
    const value = item[key];
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(item);
  }
  return merged;
}

createRoot(document.getElementById("root")).render(<App />);
