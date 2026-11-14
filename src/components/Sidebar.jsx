import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Database,
  FileDown,
  Images,
  Loader2,
  MessageSquare,
  Moon,
  RefreshCcw,
  Search,
  Settings,
  Star,
  Sun,
  X
} from "lucide-react";
import { CONVERSATION_ROW_SIZE, LIBRARY_SIDE_ROW_SIZE } from "../constants.js";
import { formatExportLabel, formatShortDate } from "../data/formatters.js";
import { useAutoLoadMore } from "../hooks/useAutoLoadMore.js";
import { useVirtualList } from "../hooks/useVirtualList.js";
import { scrollVirtualRowIntoView } from "../utils/layout.js";
import { formatSourceStateLabel } from "../utils/media.js";
import { LoadingState, Thumb, VirtualSpacer } from "./Common.jsx";

/**
 * Left navigation sidebar containing snapshot switcher, mode toggle, filters, and virtualized lists.
 */
export function Sidebar({
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
      /** @type {HTMLElement | undefined} */ (options[nextIndex])?.focus?.();
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
        <button
          type="button"
          className="snapshot-switcher"
          aria-haspopup="listbox"
          aria-expanded={exportMenuOpen}
          onClick={() => setExportMenuOpen((current) => !current)}
        >
          <span className="status-dot" />
          <span className="snapshot-selected-export">
            <strong>{selectedExport ? formatExportLabel(selectedExport) : "No export selected"}</strong>
          </span>
          <ChevronDown size={17} />
          <small title={selectedExport?.name ?? ""}>
            {selectedExport ? `${selectedExport.warnings?.length ?? 0} warnings` : "No export selected"}
          </small>
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
          {virtualConversations.items.map(({ item }) =>
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
                  <span className="star-wrap">
                    {item.starred ? <Star className="starred" size={16} fill="currentColor" /> : <MessageSquare size={15} />}
                  </span>
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
          )}
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
            <div
              className={`auto-load-sentinel ${loadingMoreSessions ? "loading" : ""}`}
              ref={conversationAutoLoadRef}
              role="status"
              aria-live="polite"
              aria-busy={loadingMoreSessions}
            >
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
                <em>
                  {item.mime} · {item.sizeLabel}
                </em>
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
            <div
              className={`auto-load-sentinel ${loadingMoreLibrary ? "loading" : ""}`}
              ref={libraryAutoLoadRef}
              role="status"
              aria-live="polite"
              aria-busy={loadingMoreLibrary}
            >
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
