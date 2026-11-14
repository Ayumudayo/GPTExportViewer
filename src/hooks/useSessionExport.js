import { useCallback, useEffect, useState } from "react";
import { openSavedSessionsFolder, saveSessions } from "../data/apiClient.js";
import { reconcileConversationSelection, selectConversationRange, toggleSelection } from "../utils/selection.js";

/**
 * Own multi-session selection, the session context menu popup, and session export job state.
 */
export function useSessionExport({
  displayedConversations,
  selectedExportId,
  selectedConversationId,
  setSelectedConversationId,
  pinnedConversationIdRef,
  setError
}) {
  const [selectedConversationIds, setSelectedConversationIds] = useState(/** @type {string[]} */ ([]));
  const [lastSelectedConversationId, setLastSelectedConversationId] = useState("");
  const [sessionContextMenuState, setSessionContextMenu] = useState(/** @type {any} */ (null));
  const [sessionExportJob, setSessionExportJob] = useState(/** @type {any} */ (null));

  const sessionContextMenu = sessionContextMenuState;
  const isSessionExportRunning = sessionExportJob?.status === "running";

  const closeSessionContextMenu = useCallback(() => {
    setSessionContextMenu(null);
  }, []);

  const clearConversationSelection = useCallback(() => {
    setSelectedConversationIds([]);
    setSessionContextMenu(null);
  }, []);

  const resetSessionSelection = useCallback(() => {
    setSelectedConversationIds([]);
    setLastSelectedConversationId("");
    setSessionContextMenu(null);
  }, []);

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
          const base =
            current.length === 0 && selectedConversationId && selectedConversationId !== conversationId
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
      pinnedConversationIdRef,
      selectedConversationId,
      setSelectedConversationId,
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
    [isSessionExportRunning, selectedConversationIds, setSelectedConversationId]
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
  }, [selectedConversationId, selectedConversationIds, selectedExportId, sessionExportJob?.status, closeSessionContextMenu, setError]);

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
    if (!sessionContextMenuState) return undefined;

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

  return {
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
  };
}
