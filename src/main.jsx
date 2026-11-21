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
import { formatExportLabel } from "./data/formatters.js";
import { getAdjacentIndex } from "./libraryNavigation.js";
import { useDebouncedValue } from "./hooks/useDebouncedValue.js";
import { useImageExport } from "./hooks/useImageExport.js";
import { useSessionExport } from "./hooks/useSessionExport.js";
import { useWorkspaceChrome } from "./hooks/useWorkspaceChrome.js";
import { applySavedWindowSize } from "./utils/desktopWindow.js";
import { normalizeConversationKind } from "./utils/projects.js";
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
  const [conversationScope, setConversationScope] = useState("all");
  const [selectedProjectIds, setSelectedProjectIds] = useState(/** @type {string[]} */ ([]));
  const projectKey = selectedProjectIds.join(",");
  const [aliasVersion, setAliasVersion] = useState(0);
  const [projectAliasesDraft, setProjectAliasesDraft] = useState(/** @type {Record<string, string>} */ ({}));
  const [libraryFilter, setLibraryFilter] = useState("all");
  const projectAliases = settings?.projectAliases ?? {};
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
    const activeKind = normalizeConversationKind(activeConversation);
    const statusMatches =
      conversationFilter === "all" ||
      (conversationFilter === "archived" ? Boolean(activeConversation.archived) : !activeConversation.archived);
    const scopeMatches =
      conversationScope === "all" ||
      (conversationScope === "other"
        ? activeKind === "custom_gpt" || activeKind === "group_chat" || activeKind === "codex"
        : activeKind === conversationScope);
    const projectMatches = selectedProjectIds.length === 0 || selectedProjectIds.includes(activeConversation.projectId);
    if (!statusMatches || !scopeMatches || !projectMatches) return conversations;
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
      kind: activeKind,
      projectId: activeConversation.projectId ?? null,
      gizmoId: activeConversation.gizmoId ?? null,
      preview: firstTextMessage ? firstTextMessage.text.trim().slice(0, 140) : ""
    };
    return [pinnedSummary, ...conversations];
  }, [activeConversation, conversationFilter, conversationScope, conversations, debouncedChatQuery, selectedConversationId, selectedProjectIds]);
  const selectedConversationSummary = displayedConversations.find((item) => item.id === selectedConversationId);

  const handleChangeConversationScope = useCallback((nextScope) => {
    setConversationScope(nextScope);
    if (nextScope !== "project") {
      setSelectedProjectIds([]);
    }
  }, []);

  const handleToggleProject = useCallback((projectId) => {
    if (!projectId) {
      setSelectedProjectIds([]);
      return;
    }
    setMode("chat");
    setConversationScope("project");
    setSelectedProjectIds((current) =>
      current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]
    );
  }, []);

  const handleFocusProject = useCallback((projectId) => {
    if (projectId) {
      setMode("chat");
      setConversationScope("project");
      setSelectedProjectIds([projectId]);
    } else {
      setSelectedProjectIds([]);
    }
  }, []);

  const saveProjectAlias = useCallback(
    async (projectId, nextAlias) => {
      const normalizedId = String(projectId || "").trim();
      if (!normalizedId) return false;
      const trimmedAlias = String(nextAlias || "").trim();
      try {
        const payload = await updatePreferences({ projectAliases: { [normalizedId]: trimmedAlias } });
        if (payload?.settings) {
          setSettings(payload.settings);
          setProjectAliasesDraft(payload.settings.projectAliases ?? {});
        }
        setNotice(trimmedAlias ? "Project name saved" : "Project name reset");
        if (debouncedChatQuery.trim()) {
          setAliasVersion((current) => current + 1);
        }
        return true;
      } catch (nextError) {
        setError(nextError.message);
        return false;
      }
    },
    [debouncedChatQuery]
  );

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

  const {
    imageExportJob,
    isImageExportRunning,
    exportImages,
    closeImageExportDialog,
    openImageExportFolder
  } = useImageExport({
    selectedExportId,
    setError,
    onNotify: setNotice
  });

  const exportCurrentSessionImages = useCallback(() => {
    closeSessionContextMenu();
    const conversationIds = selectedConversationIds.length
      ? selectedConversationIds
      : selectedConversationId
        ? [selectedConversationId]
        : [];
    if (!conversationIds.length) return;
    const scopeLabel =
      conversationIds.length === 1
        ? displayedConversations.find((item) => item.id === conversationIds[0])?.title ||
          activeConversation?.title ||
          conversationIds[0]
        : `${conversationIds.length} sessions`;
    void exportImages({ scope: "conversations", conversationIds, scopeLabel });
  }, [
    activeConversation?.title,
    closeSessionContextMenu,
    displayedConversations,
    exportImages,
    selectedConversationId,
    selectedConversationIds
  ]);

  const exportProjectImages = useCallback(
    (projectIdsOrId, label) => {
      const ids = (Array.isArray(projectIdsOrId) ? projectIdsOrId : [projectIdsOrId])
        .map((id) => String(id || "").trim())
        .filter(Boolean);
      if (!ids.length) return;
      const scopeLabel = label || (ids.length === 1 ? ids[0] : `${ids.length} projects`);
      void exportImages({
        scope: "project",
        projectId: ids.length === 1 ? ids[0] : undefined,
        projectIds: ids,
        scopeLabel
      });
    },
    [exportImages]
  );

  const exportAllExportImages = useCallback(() => {
    const selected = exports.find((item) => item.id === selectedExportId);
    const scopeLabel = selected ? formatExportLabel(selected) : "Export";
    void exportImages({ scope: "export", scopeLabel });
  }, [exportImages, exports, selectedExportId]);

  latestLoadStateRef.current = {
    selectedExportId,
    sourceVersion,
    aliasVersion,
    chatQuery: debouncedChatQuery,
    libraryQuery: debouncedLibraryQuery,
    conversationFilter,
    conversationScope,
    projectKey,
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
  }, [
    mode,
    selectedExportId,
    debouncedChatQuery,
    conversationFilter,
    conversationScope,
    projectKey,
    debouncedLibraryQuery,
    libraryFilter,
    resetSessionSelection
  ]);

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
    fetchConversations({
      exportId: selectedExportId,
      query: debouncedChatQuery,
      filter: conversationFilter,
      scope: conversationScope,
      projectIds: selectedProjectIds,
      limit: 80
    })
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
  }, [
    selectedExportId,
    debouncedChatQuery,
    conversationFilter,
    conversationScope,
    projectKey,
    aliasVersion,
    sourceVersion,
    pushBusyTask
  ]);

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
        setConversationScope("all");
        setSelectedProjectIds([]);
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
      setConversationScope("all");
      setSelectedProjectIds([]);
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
    setProjectAliasesDraft({ ...(settings?.projectAliases ?? {}) });
    setSettingsError("");
    setSettingsOpen(true);
  }, [settings?.projectAliases, settings?.sourceRoot]);

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
      const existingRoot = (settings?.sourceRoot ?? "").trim();
      const rootChanged = onboardingOpen || !existingRoot || sourceRoot !== existingRoot;
      const existingAliases = settings?.projectAliases ?? {};
      const aliasKeys = new Set([
        ...Object.keys(existingAliases),
        ...Object.keys(projectAliasesDraft),
        ...(stats?.conversations?.projects ?? []).map((item) => item.id)
      ]);
      const changedAliases = {};
      for (const key of aliasKeys) {
        const nextVal = (projectAliasesDraft[key] ?? "").trim();
        const prevVal = (existingAliases[key] ?? "").trim();
        if (nextVal !== prevVal) {
          changedAliases[key] = nextVal;
        }
      }
      const aliasesChanged = Object.keys(changedAliases).length > 0;
      if (!rootChanged && !aliasesChanged) {
        setSettingsOpen(false);
        return;
      }

      setSettingsSaving(true);
      setSettingsError("");
      const doneBusy = pushBusyTask("Updating settings");
      try {
        if (rootChanged) {
          const payload = await updateSettings({ sourceRoot });
          if (aliasesChanged) {
            const prefPayload = await updatePreferences({ projectAliases: changedAliases });
            applySourcePayload(prefPayload?.settings ? { ...payload, settings: prefPayload.settings } : payload);
          } else {
            applySourcePayload(payload);
          }
        } else if (aliasesChanged) {
          const prefPayload = await updatePreferences({ projectAliases: changedAliases });
          if (prefPayload?.settings) {
            setSettings(prefPayload.settings);
            setProjectAliasesDraft(prefPayload.settings.projectAliases ?? {});
          }
          if (debouncedChatQuery.trim()) {
            setAliasVersion((current) => current + 1);
          }
          setNotice("Project names saved");
        }
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
    [
      applySourcePayload,
      debouncedChatQuery,
      onboardingOpen,
      projectAliasesDraft,
      pushBusyTask,
      settings?.projectAliases,
      settings?.sourceRoot,
      settingsDraft,
      stats?.conversations?.projects
    ]
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
    const loadKey = `sessions:${selectedExportId}:${sourceVersion}:${aliasVersion}:${debouncedChatQuery}:${conversationFilter}:${conversationScope}:${projectKey}:${cursor}`;
    if (!beginLoadingMore("sessions", loadKey)) return;
    try {
      const payload = await fetchConversations({
        exportId: selectedExportId,
        query: debouncedChatQuery,
        filter: conversationFilter,
        scope: conversationScope,
        projectIds: selectedProjectIds,
        cursor,
        limit: conversationPage.limit ?? 80
      });
      const latest = latestLoadStateRef.current;
      if (
        latest.selectedExportId !== selectedExportId ||
        latest.sourceVersion !== sourceVersion ||
        latest.aliasVersion !== aliasVersion ||
        latest.chatQuery !== debouncedChatQuery ||
        latest.conversationFilter !== conversationFilter ||
        latest.conversationScope !== conversationScope ||
        latest.projectKey !== projectKey ||
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
  }, [
    aliasVersion,
    beginLoadingMore,
    conversationFilter,
    conversationPage,
    conversationScope,
    debouncedChatQuery,
    finishLoadingMore,
    projectKey,
    selectedExportId,
    selectedProjectIds,
    sourceVersion
  ]);

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
        if (debouncedChatQuery !== "" || conversationFilter !== "all" || conversationScope !== "all" || selectedProjectIds.length > 0) {
          setLoadingSessions(true);
        }
        setChatQuery("");
        setConversationFilter("all");
        setConversationScope("all");
        setSelectedProjectIds([]);
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
    [conversationFilter, conversationScope, debouncedChatQuery, mode, selectedConversationId, selectedProjectIds.length, setInspectorDrawerOpen]
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
      setConversationScope("all");
      setSelectedProjectIds([]);
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
        conversationScope={conversationScope}
        setConversationScope={handleChangeConversationScope}
        selectedProjectIds={selectedProjectIds}
        onToggleProject={handleToggleProject}
        onClearProjects={() => setSelectedProjectIds([])}
        projectAliases={projectAliases}
        onSaveProjectAlias={saveProjectAlias}
        libraryFilter={libraryFilter}
        setLibraryFilter={setLibraryFilter}
        conversations={displayedConversations}
        selectedConversationId={selectedConversationId}
        selectedConversationIds={selectedConversationIds}
        onSelectConversationRow={selectConversationRow}
        onOpenSessionContextMenu={openSessionContextMenu}
        onExportSessions={exportSelectedSessions}
        onExportSessionImages={exportCurrentSessionImages}
        onExportProjectImages={exportProjectImages}
        onClearSelection={clearConversationSelection}
        isExportRunning={isSessionExportRunning}
        isImageExportRunning={isImageExportRunning}
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
          onExportSessionImages={exportCurrentSessionImages}
          isImageExportRunning={isImageExportRunning}
          onNotify={setNotice}
          projectAliases={projectAliases}
          onSelectProject={handleFocusProject}
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
          onExportAllImages={exportAllExportImages}
          isImageExportRunning={isImageExportRunning}
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
        onExportAllImages={exportAllExportImages}
        onExportSessionImages={exportCurrentSessionImages}
        onExportProjectImages={exportProjectImages}
        isImageExportRunning={isImageExportRunning}
        onOpenSourceSession={openSourceSession}
        onJumpToMessage={jumpToConversationTarget}
        onPreviewImage={openImagePreview}
        onSaveImage={saveImage}
        projectAliases={projectAliases}
        onSelectProject={handleFocusProject}
        onSaveProjectAlias={saveProjectAlias}
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
          projects={stats?.conversations?.projects ?? []}
          projectAliasesDraft={projectAliasesDraft}
          setProjectAliasesDraft={setProjectAliasesDraft}
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
        onExportImages={exportCurrentSessionImages}
        isImageExportRunning={isImageExportRunning}
        onClose={closeSessionContextMenu}
      />

      <ImageContextMenu
        menu={libraryContextMenu}
        image={libraryContextMenu?.image ?? null}
        onOpenInChat={openImageInChat}
        onSaveImage={saveImage}
        onClose={closeLibraryContextMenu}
      />

      <ExportProgressDialog
        job={imageExportJob ?? sessionExportJob}
        onOpenFolder={imageExportJob ? openImageExportFolder : openExportFolder}
        onClose={imageExportJob ? closeImageExportDialog : closeExportProgressDialog}
      />

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
