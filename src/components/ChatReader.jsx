import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, FileDown, FileImage, Info, MessageSquare, Paperclip, Search, X } from "lucide-react";
import { ESTIMATED_MESSAGE_ROW_SIZE, MESSAGE_COLLAPSE_LIMIT } from "../constants.js";
import { copyMessageText as copyMessageTextToClipboard } from "../chatReaderHelpers.js";
import { assetUrl } from "../data/apiClient.js";
import { formatChatTimestamp, roleInitial, roleLabel } from "../data/formatters.js";
import { useAutoLoadMore } from "../hooks/useAutoLoadMore.js";
import { countMarkdownHighlightMatches, MarkdownContent } from "../markdownRenderer.js";
import { useMeasuredVirtualList } from "../measuredVirtualList.js";
import { findDescendantByAttr } from "../utils/layout.js";
import { collectConversationMedia, findConversationTargetIndex } from "../utils/media.js";
import { LoadingState, VirtualSpacer } from "./Common.jsx";

/**
 * Main conversation reader supporting measured message virtualization, find-in-chat, and target jumps.
 */
export function ChatReader({
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
  const [highlightedTarget, setHighlightedTarget] = useState(/** @type {{ messageId: string, fileId: string | null } | null} */ (null));
  const [jumpScrollTick, setJumpScrollTick] = useState(0);
  const findInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const copyFeedbackTimerRef = useRef(/** @type {number | null} */ (null));
  const highlightTimerRef = useRef(/** @type {number | null} */ (null));
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
  const pendingJumpScrollRef = useRef({
    seq: 0,
    messageIndex: -1,
    messageId: "",
    fileId: /** @type {string | null} */ (null),
    attempts: 0,
    settledPasses: 0
  });
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

  const safeActiveOrdinal = searchPlan.matches.length ? Math.min(activeMatchOrdinal, searchPlan.matches.length - 1) : 0;
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
      const targetOffset = offsetsRef.current?.[activeMatch.messageIndex] ?? activeMatch.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
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
        const nextScrollTop = container.scrollTop + relativeTop - Math.round(container.clientHeight * 0.35);
        container.scrollTop = Math.max(0, nextScrollTop);
        virtualMessages.syncViewport?.();
      }
      pending.settledPasses = Math.max(0, pending.settledPasses - 1);
    } else {
      pending.settledPasses = 0;
      const fallbackOffset = offsetsRef.current?.[activeMatch.messageIndex] ?? activeMatch.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
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
  }, [conversation, isLoadingConversation, jumpRequest, loadingMore, messages, onLoadMoreMessages]);

  useEffect(() => {
    const pending = pendingJumpScrollRef.current;
    if ((!pending.attempts && !pending.settledPasses) || pending.messageIndex < 0) return;
    const container = virtualMessages.containerRef.current;
    if (!container) return;

    const targetElement =
      findDescendantByAttr(container, "data-file-id", pending.fileId) || findDescendantByAttr(container, "data-message-id", pending.messageId);
    if (!targetElement) {
      if (!pending.attempts) return;
      const targetOffset = offsetsRef.current?.[pending.messageIndex] ?? pending.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
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
        const nextScrollTop = container.scrollTop + relativeTop - Math.round(container.clientHeight * 0.25);
        container.scrollTop = Math.max(0, nextScrollTop);
        virtualMessages.syncViewport?.();
      }
      pending.settledPasses = Math.max(0, pending.settledPasses - 1);
    } else {
      pending.settledPasses = 0;
      const fallbackOffset = offsetsRef.current?.[pending.messageIndex] ?? pending.messageIndex * ESTIMATED_MESSAGE_ROW_SIZE;
      container.scrollTop = Math.max(0, fallbackOffset - 24);
      virtualMessages.syncViewport?.();
    }
  }, [jumpScrollTick, virtualMessages.items, virtualMessages.beforeSize, virtualMessages.totalSize, virtualMessages.containerRef, virtualMessages.syncViewport]);

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
          <div
            className={`auto-load-sentinel ${loadingMore === "messages" ? "loading" : ""}`}
            ref={messageAutoLoadRef}
            role="status"
            aria-live="polite"
            aria-busy={loadingMore === "messages"}
          >
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
