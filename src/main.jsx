import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Check, X } from "lucide-react";
import {
  fetchConversation,
  fetchConversations,
  fetchExports,
  fetchLibrary,
  fetchSettings,
  fetchStats,
  rescanExports,
  saveOriginalImage,
  updatePreferences,
  updateSettings
} from "./data/apiClient.js";
import { getAdjacentIndex } from "./libraryNavigation.js";
import { useDebouncedValue } from "./hooks/useDebouncedValue.js";
import { useSessionExport } from "./hooks/useSessionExport.js";
import { useWorkspaceChrome } from "./hooks/useWorkspaceChrome.js";
import { applySavedWindowSize } from "./utils/desktopWindow.js";
import { mergeByKey, pickExportId } from "./utils/selection.js";
import { ChatReader } from "./components/ChatReader.jsx";
import { AppErrorBoundary, ResizeHandle } from "./components/Common.jsx";
import { ImageContextMenu, SessionContextMenu } from "./components/ContextMenus.jsx";
import { ExportProgressDialog, OnboardingDialog, SettingsDialog } from "./components/Dialogs.jsx";
import { ImageLightbox } from "./components/ImageLightbox.jsx";
import { Inspector } from "./components/Inspector.jsx";
import { LibraryReader } from "./components/LibraryReader.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import "./styles.css";

/**
 * Root application coordinator managing export loading, pagination, reader modes, and modal state.
 */
function App() {
  const [mode, setMode] = useState(new URLSearchParams(window.location.search).get("view") === "library" ? "library" : "chat");
  const [settings, setSettings] = useState(/** @type {any} */ (null));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [sourceVersion, setSourceVersion] = useState(0);
  const [exports, setExports] = useState(/** @type {any[]} */ ([]));
  const [selectedExportId, setSelectedExportId] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const query = mode === "chat" ? chatQuery : libraryQuery;
  const setQuery = mode === "chat" ? setChatQuery : setLibraryQuery;
  const debouncedChatQuery = useDebouncedValue(chatQuery, 200);
  const debouncedLibraryQuery = useDebouncedValue(libraryQuery, 200);
  const [conversationFilter, setConversationFilter] = useState("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [conversations, setConversations] = useState(/** @type {any[]} */ ([]));
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [libraryContextMenu, setLibraryContextMenu] = useState(/** @type {any} */ (null));
  const [conversation, setConversation] = useState(/** @type {any} */ (null));
  const [library, setLibrary] = useState(/** @type {any[]} */ ([]));
  const [selectedImageId, setSelectedImageId] = useState("");
  const [stats, setStats] = useState(/** @type {any} */ (null));
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImage, setLightboxImage] = useState(/** @type {any} */ (null));
  const [lightboxImages, setLightboxImages] = useState(/** @type {any[] | null} */ (null));
  const [busy, setBusy] = useState("Starting");
  const busyTasksRef = useRef(/** @type {{ token: symbol, label: string }[]} */ ([]));
  const [loadingExports, setLoadingExports] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [conversationLoadErrorId, setConversationLoadErrorId] = useState("");
  const [loadingMoreState, setLoadingMoreState] = useState({ sessions: false, library: false, messages: false });
  const loadingMoreKeyRef = useRef({ sessions: "", library: "", messages: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sidebarImageJumpSeq, setSidebarImageJumpSeq] = useState(0);
  const [librarySideSyncSeq, setLibrarySideSyncSeq] = useState(0);
  const [sidebarSessionJumpSeq, setSidebarSessionJumpSeq] = useState(0);
  const [chatJumpRequest, setChatJumpRequest] = useState(/** @type {any} */ (null));
  const [conversationPage, setConversationPage] = useState(/** @type {any} */ (null));
  const [libraryPage, setLibraryPage] = useState(/** @type {any} */ (null));
  const latestLoadStateRef = useRef(/** @type {any} */ ({}));
  const pinnedConversationIdRef = useRef("");
  const pendingLightboxIndexRef = useRef(-1);

  const {
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
  } = useWorkspaceChrome();

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

  const {
    selectedConversationIds,
    sessionContextMenu,
    sessionExportJob,
    isSessionExportRunning,
    closeSessionContextMenu,
    clearConversationSelection,
    resetSessionSelection,
    selectConversationRow,
    openSessionContextMenu,
    exportSelectedSessions,
    closeExportProgressDialog,
    openExportFolder
  } = useSessionExport({
    displayedConversations,
    selectedExportId,
    selectedConversationId,
    setSelectedConversationId,
    pinnedConversationIdRef,
    setError
  });

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
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
    resetSessionSelection();
    setLibraryContextMenu(null);
  }, [mode, selectedExportId, debouncedChatQuery, conversationFilter, debouncedLibraryQuery, libraryFilter, resetSessionSelection]);

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

  const applySourcePayload = useCallback(
    (payload, preferredExportId = "", { resetContent = true } = {}) => {
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
        resetSessionSelection();
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
    },
    [resetSessionSelection, setInspectorDrawerOpen]
  );

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

  const closeLibraryContextMenu = useCallback(() => {
    setLibraryContextMenu(null);
  }, []);

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
      ) {
        return;
      }
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
      ) {
        return;
      }
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
      ) {
        return;
      }
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

  const openLibraryContextMenu = useCallback(
    (event, item, source = "gallery") => {
      event.preventDefault();
      event.stopPropagation();
      if (!item) return;
      closeSessionContextMenu();
      setSelectedImageId(item.fileId);
      if (source === "sidebar") {
        setSidebarImageJumpSeq((current) => current + 1);
      } else {
        setLibrarySideSyncSeq((current) => current + 1);
      }
      setLibraryContextMenu({ x: event.clientX, y: event.clientY, image: item });
    },
    [closeSessionContextMenu]
  );

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
    [conversationFilter, debouncedChatQuery, mode, selectedConversationId, setInspectorDrawerOpen]
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
  }, [mode]);

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

      {isCompactLayout && inspectorDrawerOpen && <div className="inspector-backdrop" onClick={closeInspector} aria-hidden="true" />}

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

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

export { App, AppErrorBoundary };
