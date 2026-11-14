import React, { useMemo } from "react";
import { AlertTriangle, ExternalLink, FileDown, FileImage, Images, Info, MessageSquare, Paperclip, Tag, X, ZoomIn } from "lucide-react";
import { formatDate, formatExportLabel, roleLabel } from "../data/formatters.js";
import { collectConversationMedia, formatImageResolution, formatSourceStateLabel } from "../utils/media.js";
import { Panel, Thumb } from "./Common.jsx";

/**
 * Right-hand details pane showing export summary, session media/files, image origin, and warnings.
 */
export function Inspector({
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
              <dd>
                {stats.conversations?.totalConversations ?? 0} chats · {stats.library?.totalImages ?? 0} images
              </dd>
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
