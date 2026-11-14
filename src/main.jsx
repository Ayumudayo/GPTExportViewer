import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { currentMonitor, getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  ExternalLink,
  FileDown,
  FileImage,
  FolderOpen,
  Images,
  Info,
  Loader2,
  MessageSquare,
  Moon,
  Paperclip,
  RefreshCcw,
  Search,
  Settings,
  Star,
  Sun,
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
  rescanExports,
  saveOriginalImage,
  saveSessions,
  thumbUrl,
  updatePreferences,
  updateSettings
} from "./data/apiClient.js";
import { formatChatTimestamp, formatDate, formatExportLabel, formatShortDate, roleInitial, roleLabel } from "./data/formatters.js";
import { copyMessageText as copyMessageTextToClipboard } from "./chatReaderHelpers.js";
import { getAdjacentIndex, getWheelDirection } from "./libraryNavigation.js";
import { countMarkdownHighlightMatches, MarkdownContent } from "./markdownRenderer.js";
import { useMeasuredVirtualList, useScrollViewport } from "./measuredVirtualList.js";
import { computeVirtualRange } from "./virtualWindow.js";
import "./styles.css";

const CONVERSATION_ROW_SIZE = 76;
const LIBRARY_SIDE_ROW_SIZE = 68;
const ESTIMATED_MESSAGE_ROW_SIZE = 96;
const MESSAGE_COLLAPSE_LIMIT = 1200;
const GALLERY_ROW_SIZE = 284;
const GALLERY_MIN_CARD_WIDTH = 176;
const GALLERY_GAP = 14;
const LAYOUT_STORAGE_KEY = "chatgpt-export-layout";
const THEME_STORAGE_KEY = "gpt-export-viewer.theme.v1";
const FOCUSABLE_DIALOG_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(", ");
const DEFAULT_LAYOUT = { sidebar: 360, inspector: 340, inspectorOpen: true };
const LAYOUT_LIMITS = {
  sidebar: { min: 280, max: 560 },
  inspector: { min: 280, max: 540 }
};
const WINDOW_PREFERENCE_SAVE_DELAY_MS = 350;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLayout(value = {}) {
  return {
    sidebar: clamp(Number(value.sidebar) || DEFAULT_LAYOUT.sidebar, LAYOUT_LIMITS.sidebar.min, LAYOUT_LIMITS.sidebar.max),
    inspector: clamp(Number(value.inspector) || DEFAULT_LAYOUT.inspector, LAYOUT_LIMITS.inspector.min, LAYOUT_LIMITS.inspector.max),
    inspectorOpen: value.inspectorOpen !== false
  };
}

function normalizeWindowSize(value) {
  const width = Math.round(Number(value?.width));
  const height = Math.round(Number(value?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240) {
    return null;
  }
  return { width, height };
}

function pickExportId(exports, preferredExportId = "") {
  if (preferredExportId && exports.some((item) => item.id === preferredExportId)) {
    return preferredExportId;
  }
  return exports[0]?.id || "";
}

async function applySavedWindowSize(windowSize) {
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

function clampPopupPosition(x, y, width, height, viewportWidth, viewportHeight, margin = 12) {
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

function formatImageResolution(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "Unknown resolution";
  }
  return `${Math.round(width)}x${Math.round(height)}`;
}

function formatSourceStateLabel(sourceState) {
  if (sourceState === "linked") return "Linked";
  if (sourceState === "library-only") return "Library";
  if (sourceState === "missing-source-chat") return "No chat";
  return sourceState || "Unknown";
}

function scrollVirtualRowIntoView(container, index, rowSize, padding = rowSize) {
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

function collectConversationMedia(conversation) {
  const images = [];
  const files = [];
  const seenImageIds = new Set();
  const seenFileIds = new Set();
  const messages = conversation?.messages ?? [];
  for (const message of messages) {
    const parts = message?.parts ?? [];
    for (const part of parts) {
      const partType = part?.partType ?? part?.type ?? "text";
      if (partType === "image" && part?.fileId) {
        if (!seenImageIds.has(part.fileId)) {
          seenImageIds.add(part.fileId);
          images.push({
            fileId: part.fileId,
            displayName: part.name ?? part.fileId,
            mime: part.mimeType ?? part.mime ?? "image",
            sizeLabel: "",
            sourceState: "linked",
            status: "ready",
            exists: true,
            width: part.width,
            height: part.height,
            messageId: message.id ?? null,
            role: message.role ?? "assistant",
            sourceConversationId: conversation?.id ?? null,
            sourceMessageId: message.id ?? null,
            inChat: Boolean(conversation?.id)
          });
        }
      } else if ((partType === "file" || part?.fileId) && part?.fileId && partType !== "image") {
        if (!seenFileIds.has(part.fileId)) {
          seenFileIds.add(part.fileId);
          files.push({
            fileId: part.fileId,
            name: part.name ?? part.fileId,
            mime: part.mimeType ?? part.mime ?? "",
            messageId: message.id ?? null,
            role: message.role ?? "assistant"
          });
        }
      }
    }
    for (const asset of message?.assetRefs ?? []) {
      if (!asset?.fileId) continue;
      if (seenImageIds.has(asset.fileId) || seenFileIds.has(asset.fileId)) continue;
      seenFileIds.add(asset.fileId);
      files.push({
        fileId: asset.fileId,
        name: asset.name ?? asset.fileId,
        mime: asset.mimeType ?? asset.mime ?? "",
        messageId: message.id ?? null,
        role: message.role ?? "assistant"
      });
    }
  }
  return { images, files };
}

function findConversationTargetIndex(messages, jumpRequest) {
  if (!jumpRequest || !Array.isArray(messages) || messages.length === 0) return -1;
  const { messageId, fileId } = jumpRequest;
  if (messageId && fileId) {
    const exactIndex = messages.findIndex(
      (msg) =>
        (msg?.id === messageId || msg?.nodeId === messageId) &&
        ((msg?.parts ?? []).some((part) => part?.fileId === fileId) ||
          (msg?.assetRefs ?? []).some((asset) => asset?.fileId === fileId))
    );
    if (exactIndex >= 0) return exactIndex;
  }
  if (fileId) {
    const byFileIndex = messages.findIndex(
      (msg) =>
        (msg?.parts ?? []).some((part) => part?.fileId === fileId) ||
        (msg?.assetRefs ?? []).some((asset) => asset?.fileId === fileId)
    );
    if (byFileIndex >= 0) return byFileIndex;
  }
  if (messageId) {
    return messages.findIndex((msg) => msg?.id === messageId || msg?.nodeId === messageId);
  }
  return -1;
}

function findDescendantByAttr(container, attrName, attrValue) {
  if (!container || !attrValue) return null;
  for (const node of container.querySelectorAll(`[${attrName}]`)) {
    if (node.getAttribute(attrName) === attrValue) {
      return node;
    }
  }
  return null;
}

function lightboxSizeStyle(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {};
  }
  const preferredWidth = Math.max(520, Math.min(1640, Math.round(width + 168)));
  const preferredHeight = Math.max(320, Math.min(1040, Math.round(height + 132)));
  return {
    "--lightbox-width": `${preferredWidth}px`,
    "--lightbox-height": `${preferredHeight}px`,
    "--lightbox-aspect": `${Math.round(width)} / ${Math.round(height)}`
  };
}

function readSavedLayout() {
  try {
    return normalizeLayout(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}"));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function readSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function useVirtualList(items, { itemSize, overscan = 8, resetKey = "" }) {
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

function useVirtualGrid(items, { estimatedRowSize = GALLERY_ROW_SIZE, minCardWidth = GALLERY_MIN_CARD_WIDTH, gap = GALLERY_GAP, overscan = 3, resetKey = "" } = {}) {
  const { containerRef, viewport, syncViewport } = useScrollViewport(resetKey);
  const gridNodeRef = useRef(null);
  const stageNodeRef = useRef(null);
  const [gridNode, setGridNode] = useState(null);
  const gridRef = useMemo(() => {
    const callbackRef = Object.assign(
      (node) => {
        gridNodeRef.current = node;
        callbackRef.current = node;
        setGridNode((current) => (current === node ? current : node));
      },
      { current: null }
    );
    return callbackRef;
  }, []);
  const stageRef = useMemo(() => {
    const callbackRef = Object.assign(
      (node) => {
        stageNodeRef.current = node;
        callbackRef.current = node;
      },
      { current: null }
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

function LoadingState({ title, description = "", rows = 3 }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <Loader2 size={22} className="spin" />
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {rows > 0 && (
        <div className="loading-skeleton-list" aria-hidden="true">
          {Array.from({ length: rows }, (_, index) => (
            <span key={index} className="loading-skeleton-bar" />
          ))}
        </div>
      )}
    </div>
  );
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

function useDebouncedValue(value, delayMs = 200) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === "") {
      setDebounced("");
      return undefined;
    }
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

function useDialogFocusTrap(isOpen, dialogRef, { onEscape = undefined, previouslyFocusedRef = undefined } = {}) {
  const internalPreviousFocusRef = useRef(null);
  const previousFocusRef = previouslyFocusedRef ?? internalPreviousFocusRef;

  useEffect(() => {
    if (!isOpen) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const focusableElements = Array.from(dialog.querySelectorAll(FOCUSABLE_DIALOG_SELECTOR));
      const initialFocusTarget = focusableElements[0] ?? dialog;
      initialFocusTarget?.focus?.();
    }
    return () => {
      document.body.classList.remove("modal-open");
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    };
  }, [isOpen, dialogRef, previousFocusRef]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape") {
        if (onEscape) {
          event.preventDefault();
          onEscape(event);
        }
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
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, dialogRef, onEscape]);
}

function useAutoLoadMore({ hasMore, isLoading, onLoadMore, containerRef = null, itemCount = 0 }) {
  const [sentinelNode, setSentinelNode] = useState(null);
  const sentinelRef = useMemo(() => {
    const callbackRef = Object.assign(
      (node) => {
        callbackRef.current = node;
        setSentinelNode((current) => (current === node ? current : node));
      },
      { current: null }
    );
    return callbackRef;
  }, []);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!sentinelNode || !hasMore) return undefined;

    if (typeof IntersectionObserver === "undefined") {
      if (!isLoading) onLoadMoreRef.current();
      return undefined;
    }

    const rootNode = containerRef?.current instanceof Element ? containerRef.current : null;
    const checkNearBottom = () => {
      if (isLoading || !hasMore || !rootNode || rootNode.clientHeight <= 1) return;
      const remaining = rootNode.scrollHeight - (rootNode.scrollTop + rootNode.clientHeight);
      if (remaining <= 320) {
        onLoadMoreRef.current();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!isLoading && entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { root: rootNode, rootMargin: "320px 0px", threshold: 0 }
    );

    observer.observe(sentinelNode);
    checkNearBottom();
    rootNode?.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => {
      observer.disconnect();
      rootNode?.removeEventListener("scroll", checkNearBottom);
    };
  }, [sentinelNode, hasMore, isLoading, containerRef, itemCount]);

  return sentinelRef;
}

function App() {
  const [mode, setMode] = useState(new URLSearchParams(window.location.search).get("view") === "library" ? "library" : "chat");
  const [settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [sourceVersion, setSourceVersion] = useState(0);
  const [layoutSizes, setLayoutSizes] = useState(readSavedLayout);
  const [theme, setTheme] = useState(readSavedTheme);
  const [exports, setExports] = useState([]);
  const [selectedExportId, setSelectedExportId] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const query = mode === "chat" ? chatQuery : libraryQuery;
  const setQuery = mode === "chat" ? setChatQuery : setLibraryQuery;
  const debouncedChatQuery = useDebouncedValue(chatQuery, 200);
  const debouncedLibraryQuery = useDebouncedValue(libraryQuery, 200);
  const [conversationFilter, setConversationFilter] = useState("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedConversationIds, setSelectedConversationIds] = useState([]);
  const [lastSelectedConversationId, setLastSelectedConversationId] = useState("");
  const [sessionContextMenuState, setSessionContextMenu] = useState(null);
  const sessionContextMenu = sessionContextMenuState;
  const [libraryContextMenu, setLibraryContextMenu] = useState(null);
  const [sessionExportJob, setSessionExportJob] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [library, setLibrary] = useState([]);
  const [selectedImageId, setSelectedImageId] = useState("");
  const [stats, setStats] = useState(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImage, setLightboxImage] = useState(null);
  const [lightboxImages, setLightboxImages] = useState(null);
  const [busy, setBusy] = useState("Starting");
  const busyTasksRef = useRef([]);
  const [loadingExports, setLoadingExports] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [conversationLoadErrorId, setConversationLoadErrorId] = useState("");
  const [loadingMoreState, setLoadingMoreState] = useState({ sessions: false, library: false, messages: false });
  const loadingMoreKeyRef = useRef({ sessions: "", library: "", messages: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 1120px)").matches
      : false
  );
  const [sidebarImageJumpSeq, setSidebarImageJumpSeq] = useState(0);
  const [librarySideSyncSeq, setLibrarySideSyncSeq] = useState(0);
  const [sidebarSessionJumpSeq, setSidebarSessionJumpSeq] = useState(0);
  const [chatJumpRequest, setChatJumpRequest] = useState(null);
  const [conversationPage, setConversationPage] = useState(null);
  const [libraryPage, setLibraryPage] = useState(null);
  const latestLoadStateRef = useRef({});
  const pinnedConversationIdRef = useRef("");
  const pendingLightboxIndexRef = useRef(-1);
  const windowPreferenceTimeoutRef = useRef(null);

  const activeConversation = conversation?.id === selectedConversationId ? conversation : null;
  const displayedConversations = useMemo(() => {
    if (
      !selectedConversationId ||
      conversations.some((item) => item.id === selectedConversationId) ||
      activeConversation?.id !== selectedConversationId ||
      debouncedChatQuery.trim()
    ) {
      return conversations;
    }
    const filterMatches =
      conversationFilter === "all" ||
      (conversationFilter === "archived" ? Boolean(activeConversation.archived) : !activeConversation.archived);
    if (!filterMatches) return conversations;
    const firstTextMessage = (activeConversation.messages ?? []).find((msg) => typeof msg?.text === "string" && msg.text.trim());
    const pinnedSummary = {
      id: activeConversation.id,
      title: activeConversation.title ?? selectedConversationId,
      updatedAt: activeConversation.updatedAt ?? activeConversation.createdAt ?? "",
      createdAt: activeConversation.createdAt ?? activeConversation.updatedAt ?? "",
      model: activeConversation.model ?? "",
      messageCount: activeConversation.totalMessages ?? activeConversation.messages?.length ?? 0,
      attachmentCount: 0,
      archived: Boolean(activeConversation.archived),
      starred: Boolean(activeConversation.starred),
      preview: firstTextMessage ? firstTextMessage.text.trim().slice(0, 140) : ""
    };
    return [pinnedSummary, ...conversations];
  }, [activeConversation, conversationFilter, conversations, debouncedChatQuery, selectedConversationId]);
  const selectedConversationSummary = displayedConversations.find((item) => item.id === selectedConversationId);

  latestLoadStateRef.current = {
    selectedExportId,
    sourceVersion,
    chatQuery: debouncedChatQuery,
    libraryQuery: debouncedLibraryQuery,
    conversationFilter,
    libraryFilter,
    selectedConversationId,
    conversationPageCursor: conversationPage?.nextCursor ?? "",
    libraryPageCursor: libraryPage?.nextCursor ?? "",
    messageNextStart: conversation?.range?.nextStart ?? null
  };

  const pushBusyTask = useCallback((label) => {
    const token = Symbol(label);
    busyTasksRef.current = [...busyTasksRef.current, { token, label }];
    setBusy(label);
    return () => {
      busyTasksRef.current = busyTasksRef.current.filter((entry) => entry.token !== token);
      const next = busyTasksRef.current[busyTasksRef.current.length - 1];
      setBusy(next ? next.label : "");
    };
  }, []);

  const beginLoadingMore = useCallback((status, key) => {
    if (loadingMoreKeyRef.current[status]) return false;
    loadingMoreKeyRef.current[status] = key;
    setLoadingMoreState((current) => (current[status] ? current : { ...current, [status]: true }));
    return true;
  }, []);

  const finishLoadingMore = useCallback((status, key) => {
    if (loadingMoreKeyRef.current[status] !== key) return;
    loadingMoreKeyRef.current[status] = "";
    setLoadingMoreState((current) => (current[status] ? { ...current, [status]: false } : current));
  }, []);

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
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
    let ignore = false;
    setLoadingExports(true);
    const doneBusy = pushBusyTask("Loading exports");
    Promise.all([fetchSettings(), fetchExports()])
      .then(([settingsPayload, exportPayload]) => {
        if (ignore) return;
        const nextSettings = settingsPayload.settings ?? null;
        const nextExports = exportPayload.exports ?? [];
        const nextSelectedExportId = pickExportId(nextExports, settingsPayload.settings?.selectedExportId);
        if (nextSelectedExportId) {
          setLoadingSessions(true);
          setLoadingLibrary(true);
        }
        setSettings(nextSettings);
        setSettingsDraft(settingsPayload.settings?.sourceRoot ?? "");
        setExports(nextExports);
        setSelectedExportId(nextSelectedExportId);
        setOnboardingOpen(!settingsPayload.settings?.sourceRoot);
        void applySavedWindowSize(settingsPayload.settings?.windowSize);
      })
      .catch((nextError) => {
        if (!ignore) setError(nextError.message);
      })
      .finally(() => {
        if (!ignore) setLoadingExports(false);
        doneBusy();
      });
    return () => {
      ignore = true;
    };
  }, [pushBusyTask]);

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

  useEffect(() => {
    setSelectedConversationIds([]);
    setLastSelectedConversationId("");
    setSessionContextMenu(null);
    setLibraryContextMenu(null);
  }, [mode, selectedExportId, debouncedChatQuery, conversationFilter, debouncedLibraryQuery, libraryFilter]);

  useEffect(() => {
    const reconciled = reconcileConversationSelection(displayedConversations, selectedConversationIds, lastSelectedConversationId);
    if (
      reconciled.selectedConversationIds.length !== selectedConversationIds.length ||
      reconciled.selectedConversationIds.some((id, index) => id !== selectedConversationIds[index])
    ) {
      setSelectedConversationIds(reconciled.selectedConversationIds);
    }
    if (reconciled.lastSelectedConversationId !== lastSelectedConversationId) {
      setLastSelectedConversationId(reconciled.lastSelectedConversationId);
    }
    if (sessionContextMenuState && !displayedConversations.some((item) => item.id === sessionContextMenuState.conversationId)) {
      setSessionContextMenu(null);
    }
  }, [displayedConversations, lastSelectedConversationId, selectedConversationIds, sessionContextMenuState]);

  useEffect(() => {
    if (!selectedExportId) return;
    let ignore = false;
    const doneBusy = pushBusyTask("Indexing");
    fetchStats(selectedExportId)
      .then((nextStats) => {
        if (!ignore) setStats(nextStats);
      })
      .catch((nextError) => {
        if (!ignore) setError(nextError.message);
      })
      .finally(() => {
        doneBusy();
      });
    return () => {
      ignore = true;
    };
  }, [selectedExportId, sourceVersion, pushBusyTask]);

  useEffect(() => {
    if (!selectedExportId) {
      setLoadingSessions(false);
      return;
    }
    let ignore = false;
    setLoadingSessions(true);
    const doneBusy = pushBusyTask("Loading sessions");
    fetchConversations({ exportId: selectedExportId, query: debouncedChatQuery, filter: conversationFilter, limit: 80 })
      .then((conversationPayload) => {
        if (ignore) return;
        const nextConversations = conversationPayload.items ?? [];
        setConversations(nextConversations);
        setConversationPage(conversationPayload.page ?? null);
        setSelectedConversationId((current) => {
          if (current && current === pinnedConversationIdRef.current) {
            return current;
          }
          return nextConversations.some((item) => item.id === current) ? current : nextConversations[0]?.id || "";
        });
        if (nextConversations.length === 0 && !pinnedConversationIdRef.current) {
          setConversation(null);
        }
      })
      .catch((nextError) => {
        if (!ignore) setError(nextError.message);
      })
      .finally(() => {
        if (!ignore) setLoadingSessions(false);
        doneBusy();
      });
    return () => {
      ignore = true;
    };
  }, [selectedExportId, debouncedChatQuery, conversationFilter, sourceVersion, pushBusyTask]);

  useEffect(() => {
    pendingLightboxIndexRef.current = -1;
    if (!selectedExportId) {
      setLoadingLibrary(false);
      return;
    }
    let ignore = false;
    setLoadingLibrary(true);
    const doneBusy = pushBusyTask("Loading images");
    fetchLibrary({ exportId: selectedExportId, query: debouncedLibraryQuery, filter: libraryFilter, limit: 120 })
      .then((libraryPayload) => {
        if (ignore) return;
        const nextLibrary = libraryPayload.items ?? [];
        setLibrary(nextLibrary);
        setLibraryPage(libraryPayload.page ?? null);
        setSelectedImageId((current) =>
          nextLibrary.some((item) => item.fileId === current) ? current : nextLibrary[0]?.fileId || ""
        );
      })
      .catch((nextError) => {
        if (!ignore) setError(nextError.message);
      })
      .finally(() => {
        if (!ignore) setLoadingLibrary(false);
        doneBusy();
      });
    return () => {
      ignore = true;
    };
  }, [selectedExportId, debouncedLibraryQuery, libraryFilter, sourceVersion, pushBusyTask]);

  useEffect(() => {
    if (!selectedExportId || !selectedConversationId) {
      setLoadingConversation(false);
      return;
    }
    let ignore = false;
    setLoadingConversation(true);
    setConversationLoadErrorId("");
    const doneBusy = pushBusyTask("Loading conversation");
    fetchConversation({ exportId: selectedExportId, conversationId: selectedConversationId, limit: 120 })
      .then((payload) => {
        if (!ignore) {
          setConversationLoadErrorId("");
          setConversation(payload);
        }
      })
      .catch((nextError) => {
        if (!ignore) {
          setConversationLoadErrorId(selectedConversationId);
          setError(nextError.message);
        }
      })
      .finally(() => {
        if (!ignore) setLoadingConversation(false);
        doneBusy();
      });
    return () => {
      ignore = true;
    };
  }, [selectedExportId, selectedConversationId, sourceVersion, pushBusyTask]);

  const applySourcePayload = useCallback((payload, preferredExportId = "", { resetContent = true } = {}) => {
    const nextSettings = payload.settings ?? null;
    const nextExports = payload.exports ?? [];
    const nextSelectedExportId = pickExportId(nextExports, preferredExportId || nextSettings?.selectedExportId);
    setSettings(nextSettings);
    setSettingsDraft(nextSettings?.sourceRoot ?? "");
    setExports(nextExports);
    setSelectedExportId(nextSelectedExportId);
    if (resetContent) {
      pinnedConversationIdRef.current = "";
      pendingLightboxIndexRef.current = -1;
      setSelectedConversationId("");
      setSelectedConversationIds([]);
      setLastSelectedConversationId("");
      setSessionContextMenu(null);
      setConversation(null);
      setConversationLoadErrorId("");
      setConversations([]);
      setLibrary([]);
      setSelectedImageId("");
      setStats(null);
      setConversationPage(null);
      setLibraryPage(null);
      setLoadingSessions(Boolean(nextSelectedExportId));
      setLoadingLibrary(Boolean(nextSelectedExportId));
      setLightboxOpen(false);
      setLightboxImage(null);
      setLightboxImages(null);
      setInspectorDrawerOpen(false);
    }
    setSourceVersion((current) => current + 1);
  }, []);

  const selectExportId = useCallback(
    (exportId) => {
      if (exportId === selectedExportId) return;
      pinnedConversationIdRef.current = "";
      pendingLightboxIndexRef.current = -1;
      setSelectedExportId(exportId);
      setConversations([]);
      setSelectedConversationId("");
      setConversation(null);
      setConversationLoadErrorId("");
      setLibrary([]);
      setSelectedImageId("");
      setStats(null);
      setConversationPage(null);
      setLibraryPage(null);
      if (exportId) {
        setLoadingSessions(true);
        setLoadingLibrary(true);
      }
      if (!exportId) return;
      void updatePreferences({ selectedExportId: exportId }).catch((nextError) => {
        setError(nextError.message);
      });
    },
    [selectedExportId]
  );

  const openSettings = useCallback(() => {
    setSettingsDraft(settings?.sourceRoot ?? "");
    setSettingsError("");
    setSettingsOpen(true);
  }, [settings?.sourceRoot]);

  const closeSettings = useCallback(() => {
    if (!settingsSaving) setSettingsOpen(false);
  }, [settingsSaving]);

  const closeOnboarding = useCallback(() => {
    if (!settingsSaving && settings?.sourceRoot) setOnboardingOpen(false);
  }, [settings?.sourceRoot, settingsSaving]);

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
      const doneBusy = pushBusyTask("Updating settings");
      try {
        const payload = await updateSettings({ sourceRoot });
        applySourcePayload(payload);
        setError("");
        setSettingsOpen(false);
        setOnboardingOpen(false);
      } catch (nextError) {
        setSettingsError(nextError.message);
        setError(nextError.message);
      } finally {
        setSettingsSaving(false);
        doneBusy();
      }
    },
    [applySourcePayload, pushBusyTask, settingsDraft]
  );

  const rescanSourceFolder = useCallback(async () => {
    if (!settings?.sourceRoot) {
      setSettingsDraft("");
      setSettingsError("");
      setOnboardingOpen(true);
      return;
    }
    const doneBusy = pushBusyTask("Rescanning");
    try {
      const payload = await rescanExports();
      applySourcePayload(payload, selectedExportId, { resetContent: false });
      setOnboardingOpen(!payload.settings?.sourceRoot);
      setError("");
      setNotice("Source folder rescanned");
    } catch (nextError) {
      applySourcePayload({
        settings: settings ? { ...settings, sourceRoot: null, exportCount: 0, selectedExportId: null } : null,
        exports: []
      });
      setError(nextError.message);
      setSettingsError(nextError.message);
      setOnboardingOpen(true);
    } finally {
      doneBusy();
    }
  }, [applySourcePayload, pushBusyTask, selectedExportId, settings]);

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

  const closeLibraryContextMenu = useCallback(() => {
    setLibraryContextMenu(null);
  }, []);

  const isSessionExportRunning = sessionExportJob?.status === "running";

  const selectConversationRow = useCallback(
    (event, conversationId) => {
      if (isSessionExportRunning) return;
      pinnedConversationIdRef.current = "";
      setSelectedConversationId(conversationId);
      closeSessionContextMenu();

      if (event.shiftKey) {
        const anchorId = lastSelectedConversationId || selectedConversationId || conversationId;
        setSelectedConversationIds(selectConversationRange(displayedConversations, anchorId, conversationId));
      } else if (event.ctrlKey || event.metaKey) {
        setSelectedConversationIds((current) => {
          const base = current.length === 0 && selectedConversationId && selectedConversationId !== conversationId
            ? [selectedConversationId]
            : current;
          return toggleSelection(base, conversationId);
        });
      } else {
        setSelectedConversationIds([]);
      }

      setLastSelectedConversationId(conversationId);
    },
    [
      displayedConversations,
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

  useEffect(() => {
    if (!libraryContextMenu) return undefined;

    const closeOnKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeLibraryContextMenu();
      }
    };
    const closeOnPointerDown = () => closeLibraryContextMenu();

    window.addEventListener("keydown", closeOnKeyDown);
    window.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnKeyDown);
      window.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [libraryContextMenu, closeLibraryContextMenu]);

  const selectedExport = exports.find((item) => item.id === selectedExportId) ?? null;
  const selectedImage = library.find((item) => item.fileId === selectedImageId) ?? library[0] ?? null;
  const isSessionsLoading = loadingExports || (Boolean(selectedExportId) && loadingSessions);
  const isLibraryLoading = loadingExports || (Boolean(selectedExportId) && loadingLibrary);
  const isConversationLoading =
    loadingExports ||
    (Boolean(selectedExportId) && loadingSessions && !activeConversation) ||
    loadingConversation ||
    (Boolean(selectedExportId && selectedConversationId) &&
      !activeConversation &&
      conversationLoadErrorId !== selectedConversationId);
  const activeResizeHandlesVisible = !isCompactLayout && isInspectorOpen;

  const isLibraryLightbox = !lightboxImages?.length;
  const activeLightboxGallery = isLibraryLightbox ? library : lightboxImages;
  const activeLightboxImage = lightboxImage ?? selectedImage;
  const activeLightboxGalleryIndex = activeLightboxGallery.findIndex((item) => item.fileId === activeLightboxImage?.fileId);
  const activeLightboxInGallery = activeLightboxGalleryIndex >= 0;
  const activeLightboxIndex = activeLightboxInGallery ? activeLightboxGalleryIndex : 0;
  const libraryTotalCount = Math.max(library.length, Number(libraryPage?.total) || 0);
  const activeLightboxTotal = activeLightboxInGallery
    ? isLibraryLightbox
      ? libraryTotalCount
      : activeLightboxGallery.length
    : activeLightboxImage
      ? 1
      : 0;

  const enrichLightboxImage = useCallback(
    (item) => {
      if (!item?.fileId) return item;
      const libraryImage = library.find((entry) => entry.fileId === item.fileId);
      if (!libraryImage) return item;
      return {
        ...libraryImage,
        sourceConversationId: libraryImage.sourceConversationId ?? item.sourceConversationId ?? null,
        sourceMessageId: libraryImage.sourceMessageId ?? item.sourceMessageId ?? null,
        inChat: Boolean(libraryImage.inChat || item.inChat),
        width: libraryImage.width ?? item.width,
        height: libraryImage.height ?? item.height
      };
    },
    [library]
  );

  const loadMoreConversations = useCallback(async () => {
    const cursor = conversationPage?.nextCursor;
    if (!selectedExportId || !cursor) return;
    const loadKey = `sessions:${selectedExportId}:${sourceVersion}:${debouncedChatQuery}:${conversationFilter}:${cursor}`;
    if (!beginLoadingMore("sessions", loadKey)) return;
    try {
      const payload = await fetchConversations({
        exportId: selectedExportId,
        query: debouncedChatQuery,
        filter: conversationFilter,
        cursor,
        limit: conversationPage.limit ?? 80
      });
      const latest = latestLoadStateRef.current;
      if (
        latest.selectedExportId !== selectedExportId ||
        latest.sourceVersion !== sourceVersion ||
        latest.chatQuery !== debouncedChatQuery ||
        latest.conversationFilter !== conversationFilter ||
        latest.conversationPageCursor !== cursor
      ) return;
      setConversations((current) => mergeByKey(current, payload.items ?? [], "id"));
      setConversationPage(payload.page ?? null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      finishLoadingMore("sessions", loadKey);
    }
  }, [beginLoadingMore, conversationFilter, conversationPage, debouncedChatQuery, finishLoadingMore, selectedExportId, sourceVersion]);

  const loadMoreLibrary = useCallback(async () => {
    const cursor = libraryPage?.nextCursor;
    if (!selectedExportId || !cursor) return;
    const loadKey = `library:${selectedExportId}:${sourceVersion}:${debouncedLibraryQuery}:${libraryFilter}:${cursor}`;
    if (!beginLoadingMore("library", loadKey)) return;
    try {
      const payload = await fetchLibrary({
        exportId: selectedExportId,
        query: debouncedLibraryQuery,
        filter: libraryFilter,
        cursor,
        limit: libraryPage.limit ?? 120
      });
      const latest = latestLoadStateRef.current;
      if (
        latest.selectedExportId !== selectedExportId ||
        latest.sourceVersion !== sourceVersion ||
        latest.libraryQuery !== debouncedLibraryQuery ||
        latest.libraryFilter !== libraryFilter ||
        latest.libraryPageCursor !== cursor
      ) return;
      setLibrary((current) => mergeByKey(current, payload.items ?? [], "fileId"));
      setLibraryPage(payload.page ?? null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      finishLoadingMore("library", loadKey);
    }
  }, [beginLoadingMore, debouncedLibraryQuery, finishLoadingMore, libraryFilter, libraryPage, selectedExportId, sourceVersion]);

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
      finishLoadingMore("messages", loadKey);
    }
  }, [beginLoadingMore, conversation, finishLoadingMore, selectedConversationId, selectedExportId, sourceVersion]);

  const openImagePreview = useCallback(
    (image, galleryImages = null) => {
      if (!image?.fileId) return;
      pendingLightboxIndexRef.current = -1;
      const knownImage = enrichLightboxImage(image);
      const nextGallery = Array.isArray(galleryImages) && galleryImages.length ? galleryImages.map(enrichLightboxImage) : null;
      if (!nextGallery && knownImage.fileId) {
        setSelectedImageId(knownImage.fileId);
      }
      setLightboxImages(nextGallery);
      setLightboxImage(knownImage);
      setLightboxOpen(true);
    },
    [enrichLightboxImage]
  );

  const closeImagePreview = useCallback(() => {
    pendingLightboxIndexRef.current = -1;
    setLightboxOpen(false);
    setLightboxImage(null);
    setLightboxImages(null);
  }, []);

  const saveImage = useCallback(
    async (image) => {
      if (!selectedExportId || !image?.fileId) return;
      setError("");
      const doneBusy = pushBusyTask("Saving image");
      try {
        const result = await saveOriginalImage({ exportId: selectedExportId, fileId: image.fileId });
        if (!result?.canceled) {
          setNotice(`Saved ${result?.fileName || image.displayName || "image"}`);
        }
      } catch (nextError) {
        setError(nextError?.message ?? "Failed to save image");
      } finally {
        doneBusy();
      }
    },
    [pushBusyTask, selectedExportId]
  );

  const openPreviewFromQuery = useCallback(() => {
    const preview = new URLSearchParams(window.location.search).get("preview");
    const previewImage = library.find((item) => item.fileId === preview);
    if (previewImage) {
      setSelectedImageId(preview);
      setMode("library");
      setLightboxImages(null);
      setLightboxImage(previewImage);
      setLightboxOpen(true);
    }
  }, [library]);

  useEffect(() => {
    openPreviewFromQuery();
  }, [openPreviewFromQuery]);

  useEffect(() => {
    if (
      !lightboxOpen ||
      !isLibraryLightbox ||
      !libraryPage?.nextCursor ||
      loadingMoreState.library ||
      isLibraryLoading ||
      !activeLightboxInGallery
    ) {
      return;
    }
    if (activeLightboxIndex >= Math.max(0, library.length - 6)) {
      void loadMoreLibrary();
    }
  }, [
    activeLightboxInGallery,
    activeLightboxIndex,
    isLibraryLightbox,
    isLibraryLoading,
    library.length,
    libraryPage?.nextCursor,
    lightboxOpen,
    loadMoreLibrary,
    loadingMoreState.library
  ]);

  useEffect(() => {
    const pendingIndex = pendingLightboxIndexRef.current;
    if (!lightboxOpen || !isLibraryLightbox || pendingIndex < 0) return;
    const nextItem = library[pendingIndex];
    if (!nextItem) return;
    pendingLightboxIndexRef.current = -1;
    setSelectedImageId(nextItem.fileId);
    setLibrarySideSyncSeq((current) => current + 1);
    setSidebarImageJumpSeq((current) => current + 1);
    setLightboxImage(nextItem);
  }, [isLibraryLightbox, library, lightboxOpen]);

  const moveLightbox = useCallback(
    (direction) => {
      if (activeLightboxTotal <= 1 || activeLightboxGallery.length === 0) return;
      const targetFileId = lightboxImage?.fileId ?? selectedImageId;
      const currentIndex = activeLightboxGallery.findIndex((item) => item.fileId === targetFileId);
      if (currentIndex < 0) return;

      if (isLibraryLightbox && libraryPage?.nextCursor) {
        if (direction > 0 && currentIndex >= activeLightboxGallery.length - 1) {
          pendingLightboxIndexRef.current = currentIndex + 1;
          void loadMoreLibrary();
          return;
        }
        if (direction < 0 && currentIndex === 0) {
          return;
        }
      }

      const nextIndex = getAdjacentIndex(currentIndex, direction, activeLightboxGallery.length);
      if (nextIndex >= 0) {
        pendingLightboxIndexRef.current = -1;
        const nextItem = activeLightboxGallery[nextIndex];
        if (isLibraryLightbox) {
          setSelectedImageId(nextItem.fileId);
          setLibrarySideSyncSeq((current) => current + 1);
          setSidebarImageJumpSeq((current) => current + 1);
        }
        setLightboxImage(nextItem);
      }
    },
    [
      activeLightboxGallery,
      activeLightboxTotal,
      isLibraryLightbox,
      libraryPage?.nextCursor,
      lightboxImage?.fileId,
      loadMoreLibrary,
      selectedImageId
    ]
  );

  const selectLibrarySideImage = useCallback((fileId) => {
    setSelectedImageId(fileId);
    setSidebarImageJumpSeq((current) => current + 1);
  }, []);

  const selectGalleryImage = useCallback((fileId) => {
    setSelectedImageId(fileId);
    setLibrarySideSyncSeq((current) => current + 1);
  }, []);

  const clearConversationSelection = useCallback(() => {
    setSelectedConversationIds([]);
    setSessionContextMenu(null);
  }, []);

  const openLibraryContextMenu = useCallback((event, item, source = "gallery") => {
    event.preventDefault();
    event.stopPropagation();
    if (!item) return;
    setSessionContextMenu(null);
    setSelectedImageId(item.fileId);
    if (source === "sidebar") {
      setSidebarImageJumpSeq((current) => current + 1);
    } else {
      setLibrarySideSyncSeq((current) => current + 1);
    }
    setLibraryContextMenu({ x: event.clientX, y: event.clientY, image: item });
  }, []);

  const jumpToConversationTarget = useCallback(
    ({ conversationId = "", messageId = null, fileId = null } = {}) => {
      const targetConversationId = conversationId || selectedConversationId;
      if (!targetConversationId) return;
      if (mode !== "chat" || targetConversationId !== selectedConversationId) {
        pinnedConversationIdRef.current = targetConversationId;
        if (debouncedChatQuery !== "" || conversationFilter !== "all") {
          setLoadingSessions(true);
        }
        setChatQuery("");
        setConversationFilter("all");
        setSelectedConversationId(targetConversationId);
        setSidebarSessionJumpSeq((current) => current + 1);
        setMode("chat");
      }
      pendingLightboxIndexRef.current = -1;
      setLightboxOpen(false);
      setLightboxImage(null);
      setLightboxImages(null);
      setLibraryContextMenu(null);
      setInspectorDrawerOpen(false);
      if (messageId || fileId) {
        setChatJumpRequest((prev) => ({
          seq: (prev?.seq ?? 0) + 1,
          conversationId: targetConversationId,
          messageId: messageId || null,
          fileId: fileId || null
        }));
      }
    },
    [conversationFilter, debouncedChatQuery, mode, selectedConversationId, setChatQuery]
  );

  const openSourceSession = useCallback(
    (conversationId, target = null) => {
      if (!conversationId) return;
      jumpToConversationTarget({
        conversationId,
        messageId: target?.messageId ?? null,
        fileId: target?.fileId ?? null
      });
    },
    [jumpToConversationTarget]
  );

  const openImageInChat = useCallback(
    (item) => {
      if (!item?.inChat || !item?.sourceConversationId) return;
      jumpToConversationTarget({
        conversationId: item.sourceConversationId,
        messageId: item.sourceMessageId ?? null,
        fileId: item.fileId ?? null
      });
    },
    [jumpToConversationTarget]
  );

  const resetFilters = useCallback(() => {
    if (mode === "chat") {
      setChatQuery("");
      setConversationFilter("all");
    } else {
      setLibraryQuery("");
      setLibraryFilter("all");
    }
  }, [mode, setChatQuery, setLibraryQuery]);

  return (
    <div
      className={!isCompactLayout && !isInspectorOpen ? "app-shell inspector-collapsed" : "app-shell"}
      style={{
        "--sidebar-width": `${layoutSizes.sidebar}px`,
        "--inspector-width": `${layoutSizes.inspector}px`
      }}
    >
      {busy && (
        <div className="top-loading-bar" role="progressbar" aria-label={busy}>
          <span />
        </div>
      )}

      <Sidebar
        mode={mode}
        setMode={setMode}
        exports={exports}
        selectedExport={selectedExport}
        selectedExportId={selectedExportId}
        setSelectedExportId={selectExportId}
        query={query}
        setQuery={setQuery}
        debouncedChatQuery={debouncedChatQuery}
        debouncedLibraryQuery={debouncedLibraryQuery}
        conversationFilter={conversationFilter}
        setConversationFilter={setConversationFilter}
        libraryFilter={libraryFilter}
        setLibraryFilter={setLibraryFilter}
        conversations={displayedConversations}
        selectedConversationId={selectedConversationId}
        selectedConversationIds={selectedConversationIds}
        onSelectConversationRow={selectConversationRow}
        onOpenSessionContextMenu={openSessionContextMenu}
        onExportSessions={exportSelectedSessions}
        onClearSelection={clearConversationSelection}
        isExportRunning={isSessionExportRunning}
        library={library}
        selectedImageId={selectedImageId}
        setSelectedImageId={selectLibrarySideImage}
        onOpenImageContextMenu={(event, item) => openLibraryContextMenu(event, item, "sidebar")}
        librarySideSyncSeq={librarySideSyncSeq}
        sidebarSessionJumpSeq={sidebarSessionJumpSeq}
        stats={stats}
        busy={busy}
        isLoadingSessions={isSessionsLoading}
        isLoadingLibrary={isLibraryLoading}
        conversationPage={conversationPage}
        libraryPage={libraryPage}
        loadingMoreSessions={loadingMoreState.sessions}
        loadingMoreLibrary={loadingMoreState.library}
        onLoadMoreConversations={loadMoreConversations}
        onLoadMoreLibrary={loadMoreLibrary}
        onOpenSettings={openSettings}
        onRescanExports={rescanSourceFolder}
        onResetFilters={resetFilters}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <ResizeHandle pane="sidebar" onPointerDown={startResize} onKeyDown={nudgeResize} />

      {mode === "chat" ? (
        <ChatReader
          exportId={selectedExportId}
          conversation={activeConversation}
          selectedSummary={selectedConversationSummary}
          resetKey={`${selectedExportId}:${selectedConversationId}`}
          sidebarSearchQuery={chatQuery}
          jumpRequest={chatJumpRequest}
          busy={busy}
          isLoadingConversation={isConversationLoading}
          loadingMore={loadingMoreState.messages ? "messages" : ""}
          onLoadMoreMessages={loadMoreMessages}
          onOpenImage={openImagePreview}
          onExportSessions={exportSelectedSessions}
          isExportRunning={isSessionExportRunning}
          onNotify={setNotice}
          isInspectorOpen={isInspectorOpen}
          onToggleInspector={toggleInspector}
        />
      ) : (
        <LibraryReader
          exportId={selectedExportId}
          images={library}
          image={selectedImage}
          selectedImageId={selectedImageId}
          setSelectedImageId={selectGalleryImage}
          onOpenImageContextMenu={(event, item) => openLibraryContextMenu(event, item, "gallery")}
          sidebarJumpSeq={sidebarImageJumpSeq}
          stats={stats?.library}
          page={libraryPage}
          resetKey={`${selectedExportId}:${debouncedLibraryQuery}:${libraryFilter}`}
          busy={busy}
          isLoadingLibrary={isLibraryLoading}
          loadingMore={loadingMoreState.library ? "library" : ""}
          hasActiveFilter={Boolean(libraryQuery) || libraryFilter !== "all"}
          onResetFilters={resetFilters}
          onLoadMoreLibrary={loadMoreLibrary}
          openLightbox={(targetImage) => {
            const resolvedImage = targetImage ?? selectedImage;
            if (resolvedImage?.exists) openImagePreview(resolvedImage);
          }}
          isInspectorOpen={isInspectorOpen}
          onToggleInspector={toggleInspector}
        />
      )}

      {activeResizeHandlesVisible && <ResizeHandle pane="inspector" onPointerDown={startResize} onKeyDown={nudgeResize} />}

      {isCompactLayout && inspectorDrawerOpen && (
        <div className="inspector-backdrop" onClick={closeInspector} aria-hidden="true" />
      )}

      <Inspector
        mode={mode}
        selectedExport={selectedExport}
        conversation={activeConversation}
        selectedSummary={selectedConversationSummary}
        image={selectedImage}
        stats={stats}
        error={error}
        drawerOpen={isCompactLayout && inspectorDrawerOpen}
        onCloseDrawer={closeInspector}
        selectedSessionCount={selectedConversationIds.length || (selectedConversationId ? 1 : 0)}
        onExportSessions={exportSelectedSessions}
        isExportRunning={isSessionExportRunning}
        onOpenSourceSession={openSourceSession}
        onJumpToMessage={jumpToConversationTarget}
        onPreviewImage={openImagePreview}
        onSaveImage={saveImage}
      />

      {error && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}

      {notice && (
        <div className="toast-banner" role="status" aria-live="polite">
          <Check size={15} />
          <span>{notice}</span>
        </div>
      )}

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

      {onboardingOpen && !settingsOpen && (
        <OnboardingDialog
          settings={settings}
          sourceRoot={settingsDraft}
          setSourceRoot={setSettingsDraft}
          saving={settingsSaving}
          error={settingsError}
          onError={setSettingsError}
          onClose={closeOnboarding}
          onSubmit={saveSettings}
        />
      )}

      <SessionContextMenu
        menu={sessionContextMenu}
        count={selectedConversationIds.length}
        onExport={exportSelectedSessions}
        onClose={closeSessionContextMenu}
      />

      <ImageContextMenu
        menu={libraryContextMenu}
        image={libraryContextMenu?.image ?? null}
        onOpenInChat={openImageInChat}
        onSaveImage={saveImage}
        onClose={closeLibraryContextMenu}
      />

      <ExportProgressDialog job={sessionExportJob} onOpenFolder={openExportFolder} onClose={closeExportProgressDialog} />

      {lightboxOpen && activeLightboxImage && (
        <ImageLightbox
          exportId={selectedExportId}
          image={activeLightboxImage}
          currentIndex={activeLightboxIndex}
          total={activeLightboxTotal}
          onClose={closeImagePreview}
          onMove={moveLightbox}
          onOpenInChat={openImageInChat}
          onSaveImage={saveImage}
        />
      )}
    </div>
  );
}

function SessionContextMenu({ menu, count, onExport, onClose }) {
  const menuRef = useRef(null);
  const [menuBounds, setMenuBounds] = useState({ width: 240, height: 44 });

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setMenuBounds({ width: rect.width, height: rect.height });
    }
  }, [menu, count]);

  if (!menu || count < 1) return null;
  const label = count === 1 ? "Export this session" : `Export ${count} selected sessions`;
  const pos = clampPopupPosition(
    menu.x,
    menu.y,
    menuBounds.width,
    menuBounds.height,
    typeof window !== "undefined" ? window.innerWidth : 1280,
    typeof window !== "undefined" ? window.innerHeight : 720
  );

  return (
    <div
      ref={menuRef}
      className="session-context-menu"
      role="group"
      aria-label="Session actions"
      style={{ left: pos.x, top: pos.y }}
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

  const handleEscape = useCallback(() => {
    if (job?.status !== "running") {
      onClose();
    }
  }, [job?.status, onClose]);

  useDialogFocusTrap(isOpen, exportDialogRef, {
    onEscape: handleEscape,
    previouslyFocusedRef: previouslyFocusedElementRef
  });

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
  debouncedChatQuery,
  debouncedLibraryQuery,
  conversationFilter,
  setConversationFilter,
  libraryFilter,
  setLibraryFilter,
  conversations,
  selectedConversationId,
  selectedConversationIds,
  onSelectConversationRow,
  onOpenSessionContextMenu: handleSessionContextPopup,
  onExportSessions,
  onClearSelection,
  isExportRunning = false,
  library,
  selectedImageId,
  setSelectedImageId,
  onOpenImageContextMenu,
  librarySideSyncSeq = 0,
  sidebarSessionJumpSeq = 0,
  stats,
  busy,
  isLoadingSessions = false,
  isLoadingLibrary = false,
  conversationPage,
  libraryPage,
  loadingMoreSessions = false,
  loadingMoreLibrary = false,
  onLoadMoreConversations,
  onLoadMoreLibrary,
  onOpenSettings,
  onRescanExports,
  onResetFilters,
  theme = "dark",
  onToggleTheme
}) {
  const virtualConversations = useVirtualList(conversations, {
    itemSize: CONVERSATION_ROW_SIZE,
    overscan: 8,
    resetKey: `sessions:${selectedExportId}:${debouncedChatQuery}:${conversationFilter}`
  });
  const virtualSideImages = useVirtualList(library, {
    itemSize: LIBRARY_SIDE_ROW_SIZE,
    overscan: 8,
    resetKey: `library-side:${selectedExportId}:${debouncedLibraryQuery}:${libraryFilter}`
  });
  const handledSideSyncSeqRef = useRef(librarySideSyncSeq);
  const handledSessionJumpSeqRef = useRef(sidebarSessionJumpSeq);

  useEffect(() => {
    if (librarySideSyncSeq <= 0 || handledSideSyncSeqRef.current === librarySideSyncSeq) return;
    if (mode !== "library") return;
    if (!selectedImageId) {
      handledSideSyncSeqRef.current = librarySideSyncSeq;
      return;
    }
    const targetIndex = library.findIndex((item) => item.fileId === selectedImageId);
    const container = virtualSideImages.containerRef.current;
    if (targetIndex < 0 || !container) return;
    handledSideSyncSeqRef.current = librarySideSyncSeq;
    if (scrollVirtualRowIntoView(container, targetIndex, LIBRARY_SIDE_ROW_SIZE, LIBRARY_SIDE_ROW_SIZE)) {
      virtualSideImages.syncViewport?.();
    }
  }, [library, librarySideSyncSeq, mode, selectedImageId, virtualSideImages]);

  useEffect(() => {
    if (sidebarSessionJumpSeq <= 0 || handledSessionJumpSeqRef.current === sidebarSessionJumpSeq) return;
    if (mode !== "chat" || isLoadingSessions) return;
    if (!selectedConversationId) {
      handledSessionJumpSeqRef.current = sidebarSessionJumpSeq;
      return;
    }
    const targetIndex = conversations.findIndex((item) => item.id === selectedConversationId);
    const container = virtualConversations.containerRef.current;
    if (targetIndex < 0 || !container) return;
    handledSessionJumpSeqRef.current = sidebarSessionJumpSeq;
    if (scrollVirtualRowIntoView(container, targetIndex, CONVERSATION_ROW_SIZE, CONVERSATION_ROW_SIZE)) {
      virtualConversations.syncViewport?.();
    }
  }, [conversations, isLoadingSessions, mode, selectedConversationId, sidebarSessionJumpSeq, virtualConversations]);

  const conversationAutoLoadRef = useAutoLoadMore({
    hasMore: mode === "chat" && Boolean(conversationPage?.nextCursor),
    isLoading: isLoadingSessions || loadingMoreSessions,
    onLoadMore: onLoadMoreConversations,
    containerRef: virtualConversations.containerRef,
    itemCount: conversations.length
  });
  const libraryAutoLoadRef = useAutoLoadMore({
    hasMore: mode === "library" && Boolean(libraryPage?.nextCursor),
    isLoading: isLoadingLibrary || loadingMoreLibrary,
    onLoadMore: onLoadMoreLibrary,
    containerRef: virtualSideImages.containerRef,
    itemCount: library.length
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

  const handleExportMenuKeyDown = useCallback(
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExportMenuOpen(false);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const container = event.currentTarget;
      const options = Array.from(container.querySelectorAll(".snapshot-option"));
      if (!exportMenuOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setExportMenuOpen(true);
        }
        return;
      }
      if (!options.length) return;
      event.preventDefault();
      const currentIndex = options.findIndex((item) => item === document.activeElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = currentIndex < 0 ? (step > 0 ? 0 : options.length - 1) : (currentIndex + step + options.length) % options.length;
      options[nextIndex]?.focus?.();
    },
    [exportMenuOpen]
  );

  const handleSearchKeyDown = useCallback(
    (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      const step = event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1;
      if (mode === "chat" && conversations.length > 0) {
        event.preventDefault();
        const currentIndex = conversations.findIndex((item) => item.id === selectedConversationId);
        if (step > 0 && currentIndex === conversations.length - 1 && conversationPage?.nextCursor) {
          onLoadMoreConversations?.();
          return;
        }
        if (step < 0 && currentIndex === 0 && conversationPage?.nextCursor) {
          return;
        }
        const nextIndex =
          currentIndex < 0 ? (step > 0 ? 0 : conversations.length - 1) : (currentIndex + step + conversations.length) % conversations.length;
        const nextItem = conversations[nextIndex];
        if (!nextItem) return;
        onSelectConversationRow({ shiftKey: false, ctrlKey: false, metaKey: false }, nextItem.id);
        const container = virtualConversations.containerRef.current;
        if (scrollVirtualRowIntoView(container, nextIndex, CONVERSATION_ROW_SIZE, CONVERSATION_ROW_SIZE)) {
          virtualConversations.syncViewport?.();
        }
        if (step > 0 && conversationPage?.nextCursor && nextIndex >= conversations.length - 4) {
          onLoadMoreConversations?.();
        }
      } else if (mode === "library" && library.length > 0) {
        event.preventDefault();
        const currentIndex = library.findIndex((item) => item.fileId === selectedImageId);
        if (step > 0 && currentIndex === library.length - 1 && libraryPage?.nextCursor) {
          onLoadMoreLibrary?.();
          return;
        }
        if (step < 0 && currentIndex === 0 && libraryPage?.nextCursor) {
          return;
        }
        const nextIndex =
          currentIndex < 0 ? (step > 0 ? 0 : library.length - 1) : (currentIndex + step + library.length) % library.length;
        const nextItem = library[nextIndex];
        if (!nextItem) return;
        setSelectedImageId(nextItem.fileId);
        const container = virtualSideImages.containerRef.current;
        if (scrollVirtualRowIntoView(container, nextIndex, LIBRARY_SIDE_ROW_SIZE, LIBRARY_SIDE_ROW_SIZE)) {
          virtualSideImages.syncViewport?.();
        }
        if (step > 0 && libraryPage?.nextCursor && nextIndex >= library.length - 4) {
          onLoadMoreLibrary?.();
        }
      }
    },
    [
      conversationPage?.nextCursor,
      conversations,
      library,
      libraryPage?.nextCursor,
      mode,
      onLoadMoreConversations,
      onLoadMoreLibrary,
      onSelectConversationRow,
      selectedConversationId,
      selectedImageId,
      setSelectedImageId,
      virtualConversations,
      virtualSideImages
    ]
  );

  const hasChatFilter = Boolean(query) || conversationFilter !== "all";
  const hasLibraryFilter = Boolean(query) || libraryFilter !== "all";

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>GPTExportViewer</h1>
        <button
          type="button"
          className="icon-button"
          aria-label="Toggle color theme"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button type="button" className="icon-button" aria-label="Settings" onClick={onOpenSettings}>
          <Settings size={17} />
        </button>
        <button type="button" className="icon-button" aria-label="Rescan source folder" onClick={onRescanExports}>
          <RefreshCcw size={17} className={busy === "Rescanning" ? "spin" : ""} />
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
            {exports.length === 0 ? (
              <div className="snapshot-empty">No exports found in source folder</div>
            ) : (
              exports.map((item) => (
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
              ))
            )}
          </div>
        )}
      </div>

      <div className="mode-switcher">
        <button type="button" className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}>
          <MessageSquare size={16} />
          Sessions
        </button>
        <button type="button" className={mode === "library" ? "active" : ""} onClick={() => setMode("library")}>
          <Images size={16} />
          Library
        </button>
      </div>

      <label className="search-field">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder={mode === "chat" ? "Search sessions" : "Search images"}
        />
        {Boolean(query.trim()) && (
          <span className="search-count-badge" title="Matching items">
            {mode === "chat" ? conversationPage?.total ?? conversations.length : libraryPage?.total ?? library.length}
          </span>
        )}
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
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
                    {item.preview && <p className="conversation-preview">{item.preview}</p>}
                    <span className="conversation-meta-line">
                      {item.model && <em className="row-model-badge">{item.model}</em>}
                      {item.messageCount} msgs
                      {item.attachmentCount ? ` · ${item.attachmentCount} files` : ""}
                    </span>
                  </span>
                  <time>{formatShortDate(item.updatedAt)}</time>
                </button>
              );
            })()
          ))}
          <VirtualSpacer size={virtualConversations.afterSize} />
          {isLoadingSessions && conversations.length === 0 && (
            <LoadingState
              title={busy === "Indexing" ? "Indexing export archive..." : "Loading sessions..."}
              description="Building local index and reading conversation summaries."
              rows={4}
            />
          )}
          {!isLoadingSessions && conversations.length === 0 && (
            <div className="empty-state">
              <MessageSquare size={22} />
              <strong>{hasChatFilter ? "No matching sessions" : "No sessions found"}</strong>
              <p>{hasChatFilter ? "Try another search query or reset filters." : "This export does not contain any indexed conversations."}</p>
              {hasChatFilter && (
                <button type="button" onClick={onResetFilters}>
                  Reset filters
                </button>
              )}
            </div>
          )}
          {conversationPage?.nextCursor && (
            <div className={`auto-load-sentinel ${loadingMoreSessions ? "loading" : ""}`} ref={conversationAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMoreSessions}>
              {loadingMoreSessions ? "Loading sessions..." : `Auto-loading sessions (${conversations.length} / ${conversationPage.total})`}
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
              onContextMenu={(event) => onOpenImageContextMenu?.(event, item)}
            >
              <Thumb exportId={selectedExportId} image={item} small />
              <span>
                <strong>{item.displayName}</strong>
                <em>{item.mime} · {item.sizeLabel}</em>
              </span>
              <small className={item.sourceState === "linked" ? "side-origin-badge linked" : "side-origin-badge"} title={item.sourceState}>
                {formatSourceStateLabel(item.sourceState)}
              </small>
            </button>
          ))}
          <VirtualSpacer size={virtualSideImages.afterSize} />
          {isLoadingLibrary && library.length === 0 && (
            <LoadingState
              title={busy === "Indexing" ? "Indexing export archive..." : "Loading images..."}
              description="Scanning export assets and image metadata."
              rows={3}
            />
          )}
          {!isLoadingLibrary && library.length === 0 && (
            <div className="empty-state">
              <Images size={22} />
              <strong>{hasLibraryFilter ? "No matching images" : "No images found"}</strong>
              <p>{hasLibraryFilter ? "Try another search query or reset filters." : "No image files were indexed for this export."}</p>
              {hasLibraryFilter && (
                <button type="button" onClick={onResetFilters}>
                  Reset filters
                </button>
              )}
            </div>
          )}
          {libraryPage?.nextCursor && (
            <div className={`auto-load-sentinel ${loadingMoreLibrary ? "loading" : ""}`} ref={libraryAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMoreLibrary}>
              {loadingMoreLibrary ? "Loading images..." : `Auto-loading images (${library.length} / ${libraryPage.total})`}
            </div>
          )}
        </div>
      )}

      {mode === "chat" && selectedConversationIds.length > 0 && (
        <div className="selection-action-bar" role="region" aria-label="Selected sessions">
          <span className="selection-action-count">{selectedConversationIds.length} selected</span>
          <div className="selection-action-buttons">
            <button type="button" className="selection-export-btn" onClick={onExportSessions} disabled={isExportRunning}>
              <FileDown size={14} />
              Export
            </button>
            <button type="button" className="selection-clear-btn" aria-label="Clear session selection" onClick={onClearSelection} disabled={isExportRunning}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <footer className="sidebar-footer">
        <span>
          {busy ? <Loader2 size={14} className="spin" /> : <Database size={14} />}
          {busy || "Ready"}
        </span>
        <span>{mode === "chat" ? stats?.conversations?.totalConversations ?? 0 : stats?.library?.totalImages ?? 0} indexed</span>
      </footer>
    </aside>
  );
}

function ChatReader({
  exportId,
  conversation,
  selectedSummary,
  resetKey,
  sidebarSearchQuery = "",
  jumpRequest = null,
  busy,
  isLoadingConversation = false,
  loadingMore,
  onLoadMoreMessages,
  onOpenImage,
  onExportSessions,
  isExportRunning,
  onNotify,
  isInspectorOpen = true,
  onToggleInspector
}) {
  const title = conversation?.title ?? selectedSummary?.title ?? "No session selected";
  const messages = conversation?.messages ?? [];
  const [expandedMessageIds, setExpandedMessageIds] = useState(() => new Set());
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [findOpen, setFindOpen] = useState(() => Boolean(sidebarSearchQuery.trim()));
  const [findQuery, setFindQuery] = useState(() => sidebarSearchQuery.trim());
  const [activeMatchOrdinal, setActiveMatchOrdinal] = useState(0);
  const [scrollRequestSeq, setScrollRequestSeq] = useState(0);
  const [highlightedTarget, setHighlightedTarget] = useState(null);
  const [jumpScrollTick, setJumpScrollTick] = useState(0);
  const findInputRef = useRef(null);
  const copyFeedbackTimerRef = useRef(null);
  const highlightTimerRef = useRef(null);
  const findEditedManuallyRef = useRef(false);
  const prevResetKeyRef = useRef(resetKey);
  const prevSidebarQueryRef = useRef(sidebarSearchQuery.trim());
  const prevMatchCountRef = useRef(0);

  const virtualMessages = useMeasuredVirtualList(messages, {
    estimatedItemSize: ESTIMATED_MESSAGE_ROW_SIZE,
    overscan: 12,
    resetKey,
    getItemKey: (message) => message.id
  });
  const offsetsRef = useRef(virtualMessages.offsets);
  offsetsRef.current = virtualMessages.offsets;
  const pendingScrollRef = useRef({ seq: 0, attempts: 0, settledPasses: 0 });
  const handledJumpSeqRef = useRef(0);
  const pendingJumpScrollRef = useRef({ seq: 0, messageIndex: -1, messageId: "", fileId: null, attempts: 0, settledPasses: 0 });
  const messageAutoLoadRef = useAutoLoadMore({
    hasMore: conversation?.range?.nextStart != null,
    isLoading: isLoadingConversation || loadingMore === "messages",
    onLoadMore: onLoadMoreMessages,
    containerRef: virtualMessages.containerRef,
    itemCount: messages.length
  });

  const cancelPendingSearchScroll = useCallback(() => {
    pendingScrollRef.current = { seq: pendingScrollRef.current.seq, attempts: 0, settledPasses: 0 };
    pendingJumpScrollRef.current = { ...pendingJumpScrollRef.current, attempts: 0, settledPasses: 0 };
  }, []);

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    []
  );

  const copyMessageText = useCallback(
    async (text, messageId = "") => {
      const copied = await copyMessageTextToClipboard(text);
      if (!copied) return;
      if (messageId) setCopiedMessageId(messageId);
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = window.setTimeout(() => setCopiedMessageId(""), 1600);
      onNotify?.("Copied message to clipboard");
    },
    [onNotify]
  );

  const isMessageExpanded = useCallback((messageId) => expandedMessageIds.has(messageId), [expandedMessageIds]);
  const toggleMessageExpanded = useCallback((messageId) => {
    setExpandedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const trimmedSidebarQuery = sidebarSearchQuery.trim();
    const resetChanged = prevResetKeyRef.current !== resetKey;
    const sidebarChanged = prevSidebarQueryRef.current !== trimmedSidebarQuery;
    prevResetKeyRef.current = resetKey;
    prevSidebarQueryRef.current = trimmedSidebarQuery;

    if (resetChanged) {
      setExpandedMessageIds(new Set());
      setCopiedMessageId("");
      setHighlightedTarget(null);
      pendingJumpScrollRef.current = { seq: 0, messageIndex: -1, messageId: "", fileId: null, attempts: 0, settledPasses: 0 };
      findEditedManuallyRef.current = false;
      prevMatchCountRef.current = 0;
      if (trimmedSidebarQuery) {
        setFindOpen(true);
        setFindQuery(trimmedSidebarQuery);
        setActiveMatchOrdinal(0);
        setScrollRequestSeq((seq) => seq + 1);
      } else {
        setFindOpen(false);
        setFindQuery("");
        setActiveMatchOrdinal(0);
      }
      return;
    }

    if (sidebarChanged) {
      if (trimmedSidebarQuery) {
        findEditedManuallyRef.current = false;
        setFindOpen(true);
        setFindQuery(trimmedSidebarQuery);
        setActiveMatchOrdinal(0);
        setScrollRequestSeq((seq) => seq + 1);
      } else if (!findEditedManuallyRef.current) {
        setFindOpen(false);
        setFindQuery("");
        setActiveMatchOrdinal(0);
      }
    }
  }, [resetKey, sidebarSearchQuery]);

  const normalizedFindQuery = findOpen ? findQuery.trim() : "";

  useEffect(() => {
    if (!findOpen || !normalizedFindQuery) return;
    if (conversation?.range?.nextStart == null) return;
    if (loadingMore === "messages") return;
    onLoadMoreMessages?.();
  }, [findOpen, normalizedFindQuery, conversation?.range?.nextStart, loadingMore, onLoadMoreMessages]);

  const searchPlan = useMemo(() => {
    if (!normalizedFindQuery) {
      return { matches: [], matchedMessageIds: new Set() };
    }
    const matches = [];
    const matchedMessageIds = new Set();
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      const parts = message?.parts ?? [];
      const displayParts = parts.length ? parts : [{ partType: "text", text: message?.text || "(empty message)" }];
      for (let partIndex = 0; partIndex < displayParts.length; partIndex += 1) {
        const part = displayParts[partIndex];
        const partType = part?.partType ?? part?.type ?? "text";
        if ((partType === "image" || partType === "file" || part?.fileId) && part?.fileId) {
          continue;
        }
        const partText = String(part?.text ?? "");
        if (!partText) continue;
        const partMatches = countMarkdownHighlightMatches(partText, normalizedFindQuery);
        if (partMatches > 0) {
          matchedMessageIds.add(message.id);
          for (let occurrenceInPart = 0; occurrenceInPart < partMatches; occurrenceInPart += 1) {
            matches.push({
              messageIndex,
              messageId: message.id,
              partIndex,
              occurrenceInPart
            });
          }
        }
      }
    }
    return { matches, matchedMessageIds };
  }, [messages, normalizedFindQuery]);

  useEffect(() => {
    if (!normalizedFindQuery || searchPlan.matchedMessageIds.size === 0) return;
    setExpandedMessageIds((current) => {
      let missing = false;
      for (const id of searchPlan.matchedMessageIds) {
        if (!current.has(id)) {
          missing = true;
          break;
        }
      }
      if (!missing) return current;
      const next = new Set(current);
      for (const id of searchPlan.matchedMessageIds) {
        next.add(id);
      }
      return next;
    });
  }, [normalizedFindQuery, searchPlan.matchedMessageIds]);

  const safeActiveOrdinal = searchPlan.matches.length
    ? Math.min(activeMatchOrdinal, searchPlan.matches.length - 1)
    : 0;
  const activeMatch = searchPlan.matches[safeActiveOrdinal] ?? null;

  useEffect(() => {
    const count = searchPlan.matches.length;
    const prevCount = prevMatchCountRef.current;
    prevMatchCountRef.current = count;
    if (count === 0) {
      if (activeMatchOrdinal !== 0) setActiveMatchOrdinal(0);
      return;
    }
    if (prevCount === 0) {
      setActiveMatchOrdinal(0);
      setScrollRequestSeq((seq) => seq + 1);
    } else if (activeMatchOrdinal >= count) {
      setActiveMatchOrdinal(count - 1);
    }
  }, [searchPlan.matches.length, activeMatchOrdinal]);

  const stepFindMatch = useCallback(
    (delta) => {
      const totalMatches = searchPlan.matches.length;
      if (!totalMatches) return;
      const currentOrdinal = Math.min(activeMatchOrdinal, totalMatches - 1);
      const nextOrdinal = (currentOrdinal + delta + totalMatches) % totalMatches;
      const target = searchPlan.matches[nextOrdinal];
      if (target?.messageId) {
        setExpandedMessageIds((current) => {
          if (current.has(target.messageId)) return current;
          const next = new Set(current);
          next.add(target.messageId);
          return next;
        });
      }
      setActiveMatchOrdinal(nextOrdinal);
      setScrollRequestSeq((seq) => seq + 1);
    },
    [activeMatchOrdinal, searchPlan.matches]
  );

  useEffect(() => {
    if (scrollRequestSeq <= 0) return;
    pendingScrollRef.current = { seq: scrollRequestSeq, attempts: 6, settledPasses: 3 };
  }, [scrollRequestSeq]);

  useEffect(() => {
    const pending = pendingScrollRef.current;
    if ((!pending.attempts && !pending.settledPasses) || !activeMatch) return;
    const container = virtualMessages.containerRef.current;
    if (!container) return;

    const mark = container.querySelector('[data-active-match="true"]');
    if (!mark) {
      if (!pending.attempts) return;
      const targetOffset =
        offsetsRef.current?.[activeMatch.messageIndex] ?? activeMatch.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
      container.scrollTop = Math.max(0, targetOffset - 48);
      virtualMessages.syncViewport?.();
      pending.attempts -= 1;
      return;
    }

    pending.attempts = 0;
    const containerRect = container.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    if (container.clientHeight > 1 && markRect.height > 0 && containerRect.height > 0) {
      const relativeTop = markRect.top - containerRect.top;
      const isComfortable = relativeTop >= container.clientHeight * 0.12 && relativeTop <= container.clientHeight * 0.72;
      if (pending.settledPasses > 0 && !isComfortable) {
        const nextScrollTop =
          container.scrollTop + relativeTop - Math.round(container.clientHeight * 0.35);
        container.scrollTop = Math.max(0, nextScrollTop);
        virtualMessages.syncViewport?.();
      }
      pending.settledPasses = Math.max(0, pending.settledPasses - 1);
    } else {
      pending.settledPasses = 0;
      const fallbackOffset =
        offsetsRef.current?.[activeMatch.messageIndex] ?? activeMatch.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
      container.scrollTop = Math.max(0, fallbackOffset - 24);
      virtualMessages.syncViewport?.();
    }
  }, [
    scrollRequestSeq,
    activeMatch,
    virtualMessages.items,
    virtualMessages.beforeSize,
    virtualMessages.totalSize,
    virtualMessages.containerRef,
    virtualMessages.syncViewport
  ]);

  const scheduleFocusFindInput = useCallback(() => {
    const focusInput = () => findInputRef.current?.focus?.();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focusInput);
    } else {
      window.setTimeout(focusInput, 0);
    }
  }, []);

  useEffect(() => {
    if (!jumpRequest || jumpRequest.seq <= 0 || handledJumpSeqRef.current === jumpRequest.seq) return;
    if (!conversation || conversation.id !== jumpRequest.conversationId) return;

    const targetIndex = findConversationTargetIndex(messages, jumpRequest);
    if (targetIndex < 0) {
      if (conversation?.range?.nextStart != null) {
        if (!isLoadingConversation && loadingMore !== "messages") {
          onLoadMoreMessages?.();
        }
      } else {
        handledJumpSeqRef.current = jumpRequest.seq;
      }
      return;
    }

    handledJumpSeqRef.current = jumpRequest.seq;
    const targetMessage = messages[targetIndex];
    const targetMessageId = targetMessage?.id ?? "";
    if (targetMessageId) {
      setExpandedMessageIds((current) => {
        if (current.has(targetMessageId)) return current;
        const next = new Set(current);
        next.add(targetMessageId);
        return next;
      });
      setHighlightedTarget({ messageId: targetMessageId, fileId: jumpRequest.fileId || null });
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => setHighlightedTarget(null), 2400);
    }

    pendingJumpScrollRef.current = {
      seq: jumpRequest.seq,
      messageIndex: targetIndex,
      messageId: targetMessageId,
      fileId: jumpRequest.fileId || null,
      attempts: 8,
      settledPasses: 4
    };
    setJumpScrollTick((tick) => tick + 1);
  }, [
    conversation,
    isLoadingConversation,
    jumpRequest,
    loadingMore,
    messages,
    onLoadMoreMessages
  ]);

  useEffect(() => {
    const pending = pendingJumpScrollRef.current;
    if ((!pending.attempts && !pending.settledPasses) || pending.messageIndex < 0) return;
    const container = virtualMessages.containerRef.current;
    if (!container) return;

    const targetElement =
      findDescendantByAttr(container, "data-file-id", pending.fileId) ||
      findDescendantByAttr(container, "data-message-id", pending.messageId);
    if (!targetElement) {
      if (!pending.attempts) return;
      const targetOffset =
        offsetsRef.current?.[pending.messageIndex] ?? pending.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
      container.scrollTop = Math.max(0, targetOffset - 36);
      virtualMessages.syncViewport?.();
      pending.attempts -= 1;
      return;
    }

    pending.attempts = 0;
    const containerRect = container.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    if (container.clientHeight > 1 && targetRect.height > 0 && containerRect.height > 0) {
      const relativeTop = targetRect.top - containerRect.top;
      const isComfortable = relativeTop >= 12 && relativeTop <= container.clientHeight * 0.65;
      if (pending.settledPasses > 0 && !isComfortable) {
        const nextScrollTop =
          container.scrollTop + relativeTop - Math.round(container.clientHeight * 0.25);
        container.scrollTop = Math.max(0, nextScrollTop);
        virtualMessages.syncViewport?.();
      }
      pending.settledPasses = Math.max(0, pending.settledPasses - 1);
    } else {
      pending.settledPasses = 0;
      const fallbackOffset =
        offsetsRef.current?.[pending.messageIndex] ?? pending.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
      container.scrollTop = Math.max(0, fallbackOffset - 24);
      virtualMessages.syncViewport?.();
    }
  }, [
    jumpScrollTick,
    virtualMessages.items,
    virtualMessages.beforeSize,
    virtualMessages.totalSize,
    virtualMessages.containerRef,
    virtualMessages.syncViewport
  ]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
        scheduleFocusFindInput();
      } else if (event.key === "F3" && findOpen) {
        event.preventDefault();
        stepFindMatch(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape" && findOpen) {
        event.preventDefault();
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [findOpen, scheduleFocusFindInput, stepFindMatch]);

  const { images: conversationImages } = useMemo(() => collectConversationMedia(conversation), [conversation]);

  const handleOpenChatImage = useCallback(
    (image) => {
      const targetImage = conversationImages.find((entry) => entry.fileId === image?.fileId) ?? image;
      onOpenImage?.(targetImage, conversationImages);
    },
    [conversationImages, onOpenImage]
  );

  const modelLabel = conversation?.model ?? selectedSummary?.model ?? "model unknown";
  const totalMessages = conversation?.totalMessages ?? selectedSummary?.messageCount ?? messages.length;
  const messageSummary = messages.length
    ? messages.length < totalMessages
      ? `${messages.length} / ${totalMessages} msgs`
      : `${totalMessages} ${totalMessages === 1 ? "message" : "messages"}`
    : isLoadingConversation
      ? busy || "Loading conversation..."
      : "No messages";
  const updatedLabel = formatChatTimestamp(conversation?.updatedAt ?? selectedSummary?.updatedAt, "");
  const headerSubtitle = [modelLabel, messageSummary, updatedLabel].filter(Boolean).join(" · ");

  return (
    <main className={findOpen ? "reader has-find-bar" : "reader"}>
      <header className="reader-header">
        <div>
          <div className="title-line">
            <MessageSquare size={18} />
            <h2 title={title}>{title}</h2>
            {conversation?.starred && <span className="library-pill">Starred</span>}
          </div>
          <span title={headerSubtitle}>{headerSubtitle}</span>
        </div>
        <div className="reader-actions">
          <button
            type="button"
            className={findOpen ? "active" : ""}
            aria-label="Find in conversation"
            aria-pressed={findOpen}
            title="Find in conversation (Ctrl+F)"
            onClick={() => {
              const next = !findOpen;
              setFindOpen(next);
              if (next) scheduleFocusFindInput();
            }}
          >
            <Search size={17} />
          </button>
          <button
            type="button"
            aria-label="Export session"
            title="Export session"
            onClick={onExportSessions}
            disabled={isExportRunning || (!conversation && !selectedSummary)}
          >
            <FileDown size={17} />
          </button>
          <button
            type="button"
            className={isInspectorOpen ? "inspector-drawer-toggle active" : "inspector-drawer-toggle"}
            aria-label="Toggle details panel"
            aria-expanded={isInspectorOpen}
            title={isInspectorOpen ? "Hide details panel" : "Show details panel"}
            onClick={onToggleInspector}
          >
            <Info size={17} />
          </button>
        </div>
      </header>

      {findOpen && (
        <div className="in-chat-search" role="search" aria-label="Find in conversation">
          <Search size={15} />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(event) => {
              findEditedManuallyRef.current = true;
              setFindQuery(event.target.value);
              setActiveMatchOrdinal(0);
              setScrollRequestSeq((seq) => seq + 1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepFindMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setFindOpen(false);
              }
            }}
            placeholder="Find in conversation..."
            aria-label="Find in conversation query"
          />
          <span className="in-chat-search-count">
            {searchPlan.matches.length
              ? `${safeActiveOrdinal + 1} / ${searchPlan.matches.length}${conversation?.range?.nextStart != null ? "+" : ""}`
              : conversation?.range?.nextStart != null && normalizedFindQuery
                ? "Searching..."
                : "0 / 0"}
          </span>
          <button
            type="button"
            onClick={() => stepFindMatch(-1)}
            disabled={!searchPlan.matches.length}
            aria-label="Previous match"
            title="Previous match (Shift+Enter / Shift+F3)"
          >
            <ChevronUp size={14} />
            Prev
          </button>
          <button
            type="button"
            onClick={() => stepFindMatch(1)}
            disabled={!searchPlan.matches.length}
            aria-label="Next match"
            title="Next match (Enter / F3)"
          >
            Next
            <ChevronDown size={14} />
          </button>
          <button type="button" onClick={() => setFindOpen(false)} aria-label="Close find bar">
            <X size={14} />
          </button>
        </div>
      )}

      <section
        className="message-window scroll-window"
        ref={virtualMessages.containerRef}
        onWheel={cancelPendingSearchScroll}
        onPointerDown={cancelPendingSearchScroll}
      >
        {isLoadingConversation && messages.length === 0 && (
          <LoadingState
            title={busy === "Indexing" ? "Indexing export archive..." : "Loading conversation..."}
            description="Preparing messages and attachments."
            rows={4}
          />
        )}
        {!isLoadingConversation && messages.length === 0 && (
          <div className="empty-state">
            <MessageSquare size={24} />
            <strong>{selectedSummary ? "No displayable messages" : "No session selected"}</strong>
            <p>{selectedSummary ? "This conversation has no visible message turns." : "Select a session from the sidebar to start reading."}</p>
          </div>
        )}
        <VirtualSpacer size={virtualMessages.beforeSize} />
        {virtualMessages.items.map(({ item: message, index: messageIndex }) => {
          const isLong = (message.text?.length ?? 0) > MESSAGE_COLLAPSE_LIMIT;
          const expanded = !isLong || isMessageExpanded(message.id);
          const parts = message.parts ?? [];
          const displayParts = parts.length ? parts : [{ partType: "text", text: message.text || "(empty message)" }];
          const renderedPartFileIds = new Set(displayParts.map((part) => part.fileId).filter(Boolean));
          const extraAssetRefs = (message.assetRefs ?? []).filter((asset) => !renderedPartFileIds.has(asset.fileId));
          const isCopied = copiedMessageId === message.id;
          const isJumpHighlighted = highlightedTarget?.messageId === message.id;
          const highlightedFileId = highlightedTarget?.fileId ?? "";
          return (
            <article
              className={`message ${message.role === "user" ? "user" : ""}${isJumpHighlighted ? " jump-highlight" : ""}`}
              data-message-id={message.id}
              key={message.id}
              ref={virtualMessages.measureItem(message.id)}
            >
              <div className="avatar">{roleInitial(message.role)}</div>
              <div className={`message-body ${isLong && !expanded ? "collapsed" : ""}`}>
                <div className="message-meta">
                  <strong>{roleLabel(message.role)}</strong>
                  <time>{formatChatTimestamp(message.createdAt, "")}</time>
                </div>
                <div className="message-parts">
                  {displayParts.map((part, index) => {
                    const activePartMatchIndex =
                      activeMatch && activeMatch.messageIndex === messageIndex && activeMatch.partIndex === index
                        ? activeMatch.occurrenceInPart
                        : -1;
                    return renderMessagePart(
                      part,
                      message,
                      index,
                      exportId,
                      isLong && !expanded,
                      handleOpenChatImage,
                      normalizedFindQuery,
                      activePartMatchIndex,
                      highlightedFileId
                    );
                  })}
                </div>
                {extraAssetRefs.length > 0 && (
                  <div className="attachment-chips">
                    {extraAssetRefs.slice(0, 6).map((asset) => (
                      <span
                        key={`${message.id}-${asset.fileId}`}
                        data-file-id={asset.fileId}
                        className={highlightedFileId && highlightedFileId === asset.fileId ? "jump-highlight-target" : undefined}
                      >
                        <Paperclip size={13} />
                        {asset.name ?? asset.fileId}
                      </span>
                    ))}
                  </div>
                )}
                {isLong && (
                  <div className="message-actions">
                    <button type="button" className="message-expand-button" onClick={() => toggleMessageExpanded(message.id)}>
                      {expanded ? "Collapse message" : "Show full message"}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className={isCopied ? "message-copy-button copied" : "message-copy-button"}
                  aria-label="Copy message"
                  title={isCopied ? "Copied" : "Copy message"}
                  onClick={() => void copyMessageText(message.text ?? "", message.id)}
                >
                  {isCopied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </article>
          );
        })}
        <VirtualSpacer size={virtualMessages.afterSize} />
        {conversation?.range?.nextStart != null && (
          <div className={`auto-load-sentinel ${loadingMore === "messages" ? "loading" : ""}`} ref={messageAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMore === "messages"}>
            {loadingMore === "messages" ? "Loading messages..." : `Auto-loading messages (${messages.length} / ${conversation.totalMessages})`}
          </div>
        )}
      </section>
    </main>
  );
}

function renderMessagePart(part, message, index, exportId, collapsed, onOpenImage, highlightQuery = "", activeMatchIndex = -1, highlightedFileId = "") {
  const partType = part.partType ?? part.type ?? "text";
  const key = `${message.id}-${index}-${part.fileId ?? partType}`;
  if (partType === "image" && part.fileId && exportId) {
    const image = {
      fileId: part.fileId,
      displayName: part.name ?? part.fileId,
      mime: part.mimeType ?? part.mime ?? "image",
      sizeLabel: "",
      sourceState: "linked",
      status: "ready",
      exists: true,
      width: part.width,
      height: part.height
    };
    const isHighlightedFile = Boolean(highlightedFileId && highlightedFileId === part.fileId);
    return (
      <button
        type="button"
        className={isHighlightedFile ? "chat-image-button jump-highlight-target" : "chat-image-button"}
        data-file-id={part.fileId}
        key={key}
        onClick={() => onOpenImage?.(image)}
        aria-label={`Open ${image.displayName}`}
      >
        <figure className="chat-image">
          <img
            src={assetUrl(exportId, part.fileId)}
            alt={image.displayName}
            width={part.width || undefined}
            height={part.height || undefined}
            loading="lazy"
            decoding="async"
          />
          {(part.name || part.width || part.height) && (
            <figcaption>
              <FileImage size={13} />
              <span>{part.name ?? part.fileId}</span>
              {part.width && part.height && <em>{part.width}x{part.height}</em>}
            </figcaption>
          )}
        </figure>
      </button>
    );
  }

  if ((partType === "file" || part.fileId) && part.fileId) {
    const isHighlightedFile = Boolean(highlightedFileId && highlightedFileId === part.fileId);
    return (
      <div className="attachment-chips" key={key}>
        <span data-file-id={part.fileId} className={isHighlightedFile ? "jump-highlight-target" : undefined}>
          <Paperclip size={13} />
          {part.name ?? part.fileId}
        </span>
      </div>
    );
  }

  const text = String(part.text ?? "");
  const visibleText = collapsed && text.length > MESSAGE_COLLAPSE_LIMIT ? `${text.slice(0, MESSAGE_COLLAPSE_LIMIT).trimEnd()}...` : text;
  if (!visibleText) return null;
  return <MarkdownContent key={key} text={visibleText} collapsed={collapsed} highlightQuery={highlightQuery} activeMatchIndex={activeMatchIndex} />;
}

function LibraryReader({
  exportId,
  images,
  image,
  selectedImageId,
  setSelectedImageId,
  onOpenImageContextMenu,
  sidebarJumpSeq = 0,
  stats,
  page,
  resetKey,
  busy,
  isLoadingLibrary = false,
  loadingMore,
  hasActiveFilter,
  onResetFilters,
  onLoadMoreLibrary,
  openLightbox,
  isInspectorOpen = true,
  onToggleInspector
}) {
  const virtualImages = useVirtualGrid(images, { resetKey });
  const libraryAutoLoadRef = useAutoLoadMore({
    hasMore: Boolean(page?.nextCursor),
    isLoading: isLoadingLibrary || loadingMore === "library",
    onLoadMore: onLoadMoreLibrary,
    containerRef: virtualImages.containerRef,
    itemCount: images.length
  });

  const handledJumpSeqRef = useRef(sidebarJumpSeq);

  useEffect(() => {
    if (sidebarJumpSeq <= 0 || handledJumpSeqRef.current === sidebarJumpSeq) return;
    if (!selectedImageId) {
      handledJumpSeqRef.current = sidebarJumpSeq;
      return;
    }
    const targetIndex = images.findIndex((item) => item.fileId === selectedImageId);
    const container = virtualImages.containerRef.current;
    if (targetIndex < 0 || !container) return;
    handledJumpSeqRef.current = sidebarJumpSeq;
    const gridTop = virtualImages.gridOffsetTop ?? 0;
    const rowIndex = Math.floor(targetIndex / Math.max(1, virtualImages.columns));
    const rowSize = Math.max(1, virtualImages.rowSize);
    const rowTop = gridTop + rowIndex * rowSize;
    const rowBottom = rowTop + rowSize;
    const viewportHeight = container.clientHeight;
    if (viewportHeight <= 1) {
      container.scrollTop = rowIndex === 0 ? 0 : Math.max(0, rowTop - 12);
      virtualImages.syncViewport?.();
      return;
    }
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + viewportHeight;
    if (rowTop < viewTop + 12) {
      container.scrollTop = rowIndex === 0 ? 0 : Math.max(0, rowTop - 12);
      virtualImages.syncViewport?.();
    } else if (rowBottom > viewBottom - 12) {
      container.scrollTop = Math.max(0, rowBottom + 12 - viewportHeight);
      virtualImages.syncViewport?.();
    }
  }, [images, selectedImageId, sidebarJumpSeq, virtualImages]);

  const totalCount = stats?.totalImages ?? page?.total ?? images.length;
  const visibleTotal = page?.total ?? images.length;
  const summaryParts = [];
  if (hasActiveFilter && visibleTotal !== totalCount) {
    summaryParts.push(`${visibleTotal} matching`);
  }
  summaryParts.push(`${totalCount} ${totalCount === 1 ? "image" : "images"}`);
  if (stats) {
    summaryParts.push(`${stats.linkedImages ?? 0} linked`);
    summaryParts.push(`${stats.libraryOnlyImages ?? 0} library`);
    if (stats.missingFiles) {
      summaryParts.push(`${stats.missingFiles} missing`);
    }
  }
  const librarySubtitle = summaryParts.join(" · ");

  return (
    <main className="reader library-reader">
      <header className="reader-header">
        <div>
          <div className="title-line">
            <Images size={18} />
            <h2>Library</h2>
            <span className="library-pill">Images</span>
          </div>
          <span title={librarySubtitle}>{librarySubtitle}</span>
        </div>
        <div className="reader-actions">
          <button type="button" aria-label="Open selected image" onClick={() => openLightbox(image)} disabled={!image?.exists}>
            <ZoomIn size={17} />
          </button>
          <button
            type="button"
            className={isInspectorOpen ? "inspector-drawer-toggle active" : "inspector-drawer-toggle"}
            aria-label="Toggle details panel"
            aria-expanded={isInspectorOpen}
            title={isInspectorOpen ? "Hide details panel" : "Show details panel"}
            onClick={onToggleInspector}
          >
            <Info size={17} />
          </button>
        </div>
      </header>

      <section className="gallery-window" ref={virtualImages.containerRef}>
        {isLoadingLibrary && images.length === 0 ? (
          <LoadingState
            title={busy === "Indexing" ? "Indexing export archive..." : "Loading library images..."}
            description="Scanning export assets and reading image metadata."
            rows={4}
          />
        ) : !isLoadingLibrary && images.length === 0 ? (
          <div className="empty-state">
            <Images size={24} />
            <strong>{hasActiveFilter ? "No matching images" : "No images found"}</strong>
            <p>{hasActiveFilter ? "Try another search query or reset filters." : "No image files were indexed for this export."}</p>
            {hasActiveFilter && (
              <button type="button" onClick={onResetFilters}>
                Reset filters
              </button>
            )}
          </div>
        ) : (
          <div ref={virtualImages.stageRef}>
            <VirtualSpacer size={virtualImages.beforeSize} />
            <div className="gallery-grid" ref={virtualImages.gridRef}>
              {virtualImages.items.map(({ item }) => (
                <button
                  type="button"
                  className={`image-card ${item.fileId === selectedImageId ? "selected" : ""}`}
                  key={item.fileId}
                  onClick={() => setSelectedImageId(item.fileId)}
                  onContextMenu={(event) => onOpenImageContextMenu?.(event, item)}
                  onDoubleClick={() => {
                    setSelectedImageId(item.fileId);
                    if (item.exists) openLightbox(item);
                  }}
                >
                  <Thumb exportId={exportId} image={item} />
                  <span className="image-card-copy">
                    <strong>{item.displayName}</strong>
                    <em>{item.mime} · {item.sizeLabel}</em>
                  </span>
                  <span className={`origin-chip ${item.sourceState === "linked" ? "linked" : ""}`} title={item.sourceState}>
                    {formatSourceStateLabel(item.sourceState)}
                  </span>
                </button>
              ))}
            </div>
            <VirtualSpacer size={virtualImages.afterSize} />
          </div>
        )}
        {page?.nextCursor && (
          <div className={`auto-load-sentinel ${loadingMore === "library" ? "loading" : ""}`} ref={libraryAutoLoadRef} role="status" aria-live="polite" aria-busy={loadingMore === "library"}>
            {loadingMore === "library" ? "Loading images..." : `Auto-loading images (${images.length} / ${page.total})`}
          </div>
        )}
      </section>
    </main>
  );
}

function ImageLightbox({ exportId, image, currentIndex, total, onClose, onMove, onOpenInChat, onSaveImage }) {
  const lightboxDialogRef = useRef(null);
  const wheelAccumRef = useRef(0);
  const wheelLastStepAtRef = useRef(0);
  const [imageContextMenu, setImageContextMenu] = useState(null);
  const closeImageContextMenu = useCallback(() => setImageContextMenu(null), []);
  const openImageContextMenu = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setImageContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  useDialogFocusTrap(true, lightboxDialogRef, { onEscape: onClose });

  useEffect(() => {
    const onKeyDown = (event) => {
      if (total <= 1) return;
      if (event.key === "ArrowRight") onMove(1);
      if (event.key === "ArrowLeft") onMove(-1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onMove, total]);

  const onWheel = (event) => {
    if (total <= 1) return;
    const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!Number.isFinite(rawDelta) || rawDelta === 0) return;

    const now = Date.now();
    if (now - wheelLastStepAtRef.current < 180) {
      return;
    }

    wheelAccumRef.current += rawDelta;
    if (Math.abs(wheelAccumRef.current) < 48) {
      return;
    }

    const direction = getWheelDirection(wheelAccumRef.current);
    wheelAccumRef.current = 0;
    wheelLastStepAtRef.current = now;
    if (direction) onMove(direction);
  };

  return (
    <div className="lightbox-backdrop" role="dialog" aria-modal="true" aria-label="Image preview" onWheel={onWheel} onClick={onClose}>
      <div
        ref={lightboxDialogRef}
        className="lightbox-shell"
        tabIndex={-1}
        style={lightboxSizeStyle(image)}
        onClick={(event) => {
          event.stopPropagation();
          closeImageContextMenu();
        }}
      >
        <header className="lightbox-header">
          <div>
            <strong>{image.displayName}</strong>
            <span>{currentIndex + 1} / {total}</span>
          </div>
          <div className="lightbox-actions">
            <button type="button" aria-label="Save original image" title="Save original image" disabled={!image.exists} onClick={() => onSaveImage?.(image)}>
              <FileDown size={18} />
            </button>
            <button type="button" aria-label="Close preview" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="lightbox-stage">
          <button type="button" className="lightbox-step previous" aria-label="Previous image" onClick={() => onMove(-1)} disabled={total <= 1}>
            <ArrowLeft size={22} />
          </button>
          {image.exists === false ? (
            <div className="lightbox-missing">
              <AlertTriangle size={28} />
              <strong>Original image file is missing</strong>
              <span>{image.fileRef || image.displayName}</span>
            </div>
          ) : (
            <div className="lightbox-image real-image" onContextMenu={openImageContextMenu}>
              <img src={assetUrl(exportId, image.fileId)} alt={image.displayName} />
            </div>
          )}
          <button type="button" className="lightbox-step next" aria-label="Next image" onClick={() => onMove(1)} disabled={total <= 1}>
            <ArrowRight size={22} />
          </button>
        </div>
        <footer className="lightbox-footer">
          <span>{image.mime}</span>
          <span>{formatImageResolution(image)}</span>
          <span title={image.sourceState}>{formatSourceStateLabel(image.sourceState)}</span>
          <span>{image.status}</span>
        </footer>
      </div>
      <ImageContextMenu
        menu={imageContextMenu}
        image={image}
        onOpenInChat={onOpenInChat}
        onSaveImage={onSaveImage}
        onClose={closeImageContextMenu}
      />
    </div>
  );
}

function ImageContextMenu({ menu, image, onOpenInChat, onSaveImage, onClose }) {
  const menuRef = useRef(null);
  const [menuBounds, setMenuBounds] = useState({ width: 210, height: 44 });
  const canOpenInChat = Boolean(image?.inChat && image?.sourceConversationId && onOpenInChat);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setMenuBounds({ width: rect.width, height: rect.height });
    }
  }, [menu, image?.fileId, canOpenInChat]);

  if (!menu || !image) return null;
  const pos = clampPopupPosition(
    menu.x,
    menu.y,
    menuBounds.width,
    menuBounds.height,
    typeof window !== "undefined" ? window.innerWidth : 1280,
    typeof window !== "undefined" ? window.innerHeight : 720
  );

  return (
    <div
      ref={menuRef}
      className="image-context-menu"
      role="group"
      aria-label="Image actions"
      style={{ left: pos.x, top: pos.y }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {canOpenInChat && (
        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenInChat?.(image);
          }}
        >
          <MessageSquare size={15} />
          Go to message in chat
        </button>
      )}
      <button
        type="button"
        disabled={image.exists === false}
        onClick={() => {
          onClose();
          onSaveImage?.(image);
        }}
      >
        <FileDown size={15} />
        Save original image
      </button>
    </div>
  );
}

function OnboardingDialog(props) {
  return <SettingsDialog {...props} onboarding canClose={Boolean(props.settings?.sourceRoot)} />;
}

function SettingsDialog({ settings, sourceRoot, setSourceRoot, saving, error, onError, onClose, onSubmit, onboarding = false, canClose = true }) {
  const settingsDialogRef = useRef(null);
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

  const handleEscape = useCallback(() => {
    if (canClose && !saving) onClose();
  }, [canClose, onClose, saving]);

  useDialogFocusTrap(true, settingsDialogRef, { onEscape: handleEscape });

  return (
    <div
      className="settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={onboarding ? "Source folder onboarding" : "Settings"}
      onClick={() => {
        if (canClose && !saving) onClose();
      }}
    >
      <form ref={settingsDialogRef} className="settings-dialog" tabIndex={-1} onSubmit={onSubmit} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <Settings size={18} />
            <h2>{onboarding ? "Choose source folder" : "Settings"}</h2>
          </div>
          {canClose && (
            <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose} disabled={saving}>
              <X size={18} />
            </button>
          )}
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
          {canClose && (
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Applying..." : onboarding ? "Start" : "Apply"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Inspector({
  mode,
  selectedExport,
  conversation,
  selectedSummary = null,
  image,
  stats,
  error,
  drawerOpen = false,
  onCloseDrawer,
  selectedSessionCount = 0,
  onExportSessions,
  isExportRunning = false,
  onOpenSourceSession,
  onJumpToMessage,
  onPreviewImage,
  onSaveImage
}) {
  const exportWarnings = selectedExport?.warnings ?? [];
  const warningMessages = [];
  if (error) warningMessages.push(error);
  for (const warning of exportWarnings) {
    if (warning) warningMessages.push(warning);
  }
  const hasWarnings = warningMessages.length > 0;
  const sessionIdValue = conversation?.id ?? selectedSummary?.id ?? "-";
  const sessionMessageCount = conversation?.totalMessages ?? selectedSummary?.messageCount ?? 0;
  const sessionModelValue = conversation?.model ?? selectedSummary?.model ?? "-";
  const sessionUpdatedAt = conversation?.updatedAt ?? selectedSummary?.updatedAt;
  const sessionMedia = useMemo(
    () => (mode === "chat" ? collectConversationMedia(conversation) : { images: [], files: [] }),
    [conversation, mode]
  );

  return (
    <aside className={drawerOpen ? "inspector drawer-open" : "inspector"}>
      <header className="inspector-header">
        <span className="inspector-header-title">
          <Info size={16} />
          Details
        </span>
        <button type="button" className="icon-button inspector-toggle" aria-label="Close details panel" onClick={onCloseDrawer}>
          <X size={16} />
        </button>
      </header>
      <Panel title="Export" icon={<Info size={17} />}>
        <dl className="detail-grid">
          <dt>Name</dt>
          <dd title={selectedExport?.name ?? ""}>{selectedExport ? formatExportLabel(selectedExport) : "None"}</dd>
          <dt>Modified</dt>
          <dd>{formatDate(selectedExport?.modifiedAt)}</dd>
          {stats && (
            <>
              <dt>Indexed</dt>
              <dd>{stats.conversations?.totalConversations ?? 0} chats · {stats.library?.totalImages ?? 0} images</dd>
            </>
          )}
        </dl>
      </Panel>

      {mode === "chat" ? (
        <>
          <Panel title="Session details" icon={<MessageSquare size={17} />}>
            <dl className="detail-grid">
              <dt>Session ID</dt>
              <dd title={sessionIdValue}>{sessionIdValue}</dd>
              <dt>Messages</dt>
              <dd>{sessionMessageCount}</dd>
              <dt>Model</dt>
              <dd>{sessionModelValue}</dd>
              <dt>Updated</dt>
              <dd>{formatDate(sessionUpdatedAt)}</dd>
            </dl>
            <div className="inspector-actions">
              <button
                type="button"
                onClick={onExportSessions}
                disabled={isExportRunning || (!conversation && !selectedSummary && selectedSessionCount < 1)}
              >
                <FileDown size={15} />
                {selectedSessionCount > 1 ? `Export ${selectedSessionCount} selected sessions` : "Export selected sessions"}
              </button>
            </div>
          </Panel>
          {sessionMedia.images.length > 0 && (
            <Panel title="Session media" icon={<Images size={17} />} count={String(sessionMedia.images.length)}>
              <div className="inspector-media-grid">
                {sessionMedia.images.map((item) => (
                  <div className="inspector-media-row" key={item.fileId}>
                    <button
                      type="button"
                      className="inspector-media-item"
                      title={`Go to ${item.displayName} in conversation`}
                      onClick={() =>
                        onJumpToMessage?.({
                          conversationId: conversation?.id,
                          messageId: item.messageId,
                          fileId: item.fileId
                        })
                      }
                    >
                      <Thumb exportId={selectedExport?.id} image={item} small />
                      <span className="inspector-media-copy">
                        <strong>{item.displayName}</strong>
                        <em>{roleLabel(item.role)} · Go to message</em>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="inspector-media-preview-btn"
                      aria-label={`Preview ${item.displayName}`}
                      title="Open image preview"
                      onClick={() => onPreviewImage?.(item, sessionMedia.images)}
                    >
                      <ZoomIn size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          {sessionMedia.files.length > 0 && (
            <Panel title="Attached files" icon={<Paperclip size={17} />} count={String(sessionMedia.files.length)}>
              <div className="inspector-file-list">
                {sessionMedia.files.map((file) => (
                  <button
                    type="button"
                    key={file.fileId}
                    className="inspector-file-item"
                    title={`Go to ${file.name} in conversation`}
                    onClick={() =>
                      onJumpToMessage?.({
                        conversationId: conversation?.id,
                        messageId: file.messageId,
                        fileId: file.fileId
                      })
                    }
                  >
                    <span className="inspector-file-icon">
                      <Paperclip size={14} />
                    </span>
                    <span className="inspector-file-copy">
                      <strong>{file.name}</strong>
                      <em>{file.mime || "Attached file"} · Go to message</em>
                    </span>
                  </button>
                ))}
              </div>
            </Panel>
          )}
        </>
      ) : (
        <>
          <Panel title="Image details" icon={<FileImage size={17} />}>
            {image && <Thumb exportId={selectedExport?.id} image={image} preview />}
            {image && (
              <div className="inspector-actions">
                <button type="button" onClick={() => onPreviewImage?.(image)} disabled={!image.exists}>
                  <ZoomIn size={15} />
                  Original view
                </button>
                <button type="button" onClick={() => onSaveImage?.(image)} disabled={!image.exists}>
                  <FileDown size={15} />
                  Save original image
                </button>
              </div>
            )}
            <dl className="detail-grid">
              <dt>Name</dt>
              <dd>{image?.displayName ?? "-"}</dd>
              <dt>MIME</dt>
              <dd>{image?.mime ?? "-"}</dd>
              <dt>Size</dt>
              <dd>{image?.sizeLabel ?? "-"}</dd>
              <dt>Resolution</dt>
              <dd>{formatImageResolution(image)}</dd>
              <dt>Status</dt>
              <dd>{image?.status ?? "-"}</dd>
              <dt>File</dt>
              <dd>{image?.fileRef ?? "-"}</dd>
            </dl>
          </Panel>
          <Panel title="Origin" icon={<Tag size={17} />}>
            <div className="tag-list">
              <span title={image?.sourceState ?? ""}>{image?.sourceState ? formatSourceStateLabel(image.sourceState) : "None"}</span>
              <span title={image?.sourceConversationTitle || image?.sourceConversationId || ""}>
                {image?.sourceConversationTitle || image?.sourceConversationId || "No linked session"}
              </span>
            </div>
            {image?.sourceConversationId && image?.inChat && (
              <div className="inspector-actions">
                <button
                  type="button"
                  onClick={() =>
                    onOpenSourceSession?.(image.sourceConversationId, {
                      messageId: image.sourceMessageId ?? null,
                      fileId: image.fileId ?? null
                    })
                  }
                >
                  <ExternalLink size={15} />
                  Open source session
                </button>
              </div>
            )}
          </Panel>
        </>
      )}

      {hasWarnings && (
        <Panel title="Warnings" icon={<AlertTriangle size={17} />} count={String(warningMessages.length)} warning>
          <p className="warning-copy">{warningMessages.join(" · ")}</p>
        </Panel>
      )}
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
      <img src={thumbUrl(exportId, image.fileId)} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

function Panel({ title, icon, count = undefined, warning = false, children }) {
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

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    /** @type {{ error: any }} */
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("GPTExportViewer render failed:", error);
  }

  render() {
    const self = /** @type {any} */ (this);
    if (self.state.error) {
      return (
        <div className="app-crash-fallback" role="alert">
          <div className="app-crash-card">
            <h2>Unable to render GPTExportViewer</h2>
            <p>{String(self.state.error?.message || self.state.error || "Unknown error")}</p>
            <button type="button" onClick={() => self.setState({ error: null })}>
              Reload view
            </button>
          </div>
        </div>
      );
    }
    return self.props.children;
  }
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

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

export { App, AppErrorBoundary };
