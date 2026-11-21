import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileDown,
  FileImage,
  Folder,
  ImageDown,
  Images,
  Info,
  MessageSquare,
  Paperclip,
  Pencil,
  Tag,
  X,
  ZoomIn
} from "lucide-react";
import { formatDate, formatExportLabel, roleLabel } from "../data/formatters.js";
import { collectConversationMedia, formatImageResolution, formatSourceStateLabel } from "../utils/media.js";
import { formatConversationKindLabel, formatProjectLabel, normalizeConversationKind, shortProjectCode } from "../utils/projects.js";
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
  onExportAllImages,
  onExportSessionImages,
  onExportProjectImages,
  isImageExportRunning = false,
  onOpenSourceSession,
  onJumpToMessage,
  onPreviewImage,
  onSaveImage,
  projectAliases = {},
  onSelectProject,
  onSaveProjectAlias
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
  const sessionKind = normalizeConversationKind(conversation ?? selectedSummary);
  const sessionProjectId = conversation?.projectId ?? selectedSummary?.projectId ?? null;
  const sessionGizmoId = conversation?.gizmoId ?? selectedSummary?.gizmoId ?? null;
  const [editingProject, setEditingProject] = useState(false);
  const [projectAliasDraft, setProjectAliasDraft] = useState("");

  useEffect(() => {
    setEditingProject(false);
    setProjectAliasDraft("");
  }, [sessionIdValue, sessionProjectId]);

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
              {(stats.conversations?.projectConversations ?? 0) > 0 && (
                <>
                  <dt>Projects</dt>
                  <dd>
                    {stats.conversations.projects?.length ?? 0} projects · {stats.conversations.projectConversations} chats
                  </dd>
                </>
              )}
            </>
          )}
        </dl>
        {onExportAllImages && (
          <div className="inspector-actions">
            <button
              type="button"
              onClick={onExportAllImages}
              disabled={isImageExportRunning || !selectedExport || (stats?.library?.totalImages ?? 0) < 1}
            >
              <ImageDown size={15} />
              Export all images
            </button>
          </div>
        )}
      </Panel>

      {mode === "chat" ? (
        <>
          <Panel title="Session details" icon={<MessageSquare size={17} />}>
            <dl className="detail-grid">
              <dt>Type</dt>
              <dd>{formatConversationKindLabel(sessionKind)}</dd>
              {sessionProjectId && (
                <>
                  <dt>Project</dt>
                  <dd className="detail-project-cell">
                    {editingProject ? (
                      <form
                        className="inspector-project-form"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          const ok = await onSaveProjectAlias?.(sessionProjectId, projectAliasDraft);
                          if (ok !== false) setEditingProject(false);
                        }}
                      >
                        <input
                          value={projectAliasDraft}
                          onChange={(event) => setProjectAliasDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingProject(false);
                            }
                          }}
                          placeholder={`Project ${shortProjectCode(sessionProjectId)}`}
                          aria-label={`Project name for ${sessionProjectId}`}
                          maxLength={80}
                          autoFocus
                        />
                        <button type="submit" aria-label="Save project name" title="Save">
                          <Check size={13} />
                        </button>
                        <button type="button" aria-label="Cancel project rename" title="Cancel" onClick={() => setEditingProject(false)}>
                          <X size={13} />
                        </button>
                      </form>
                    ) : (
                      <div className="inspector-project-value">
                        <span title={sessionProjectId}>{formatProjectLabel(sessionProjectId, projectAliases)}</span>
                        <div className="inspector-project-buttons">
                          {onExportProjectImages && (
                            <button
                              type="button"
                              aria-label="Export project images"
                              title={`Export original images from ${formatProjectLabel(sessionProjectId, projectAliases)}`}
                              disabled={isImageExportRunning}
                              onClick={() => onExportProjectImages(sessionProjectId, formatProjectLabel(sessionProjectId, projectAliases))}
                            >
                              <ImageDown size={12} />
                            </button>
                          )}
                          {onSaveProjectAlias && (
                            <button
                              type="button"
                              aria-label="Rename project"
                              title="Rename project"
                              onClick={() => {
                                setProjectAliasDraft(projectAliases?.[sessionProjectId] ?? "");
                                setEditingProject(true);
                              }}
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                          {onSelectProject && (
                            <button
                              type="button"
                              aria-label="Filter by project"
                              title={`Show all chats in ${formatProjectLabel(sessionProjectId, projectAliases)}`}
                              onClick={() => onSelectProject(sessionProjectId)}
                            >
                              <Folder size={12} />
                              Filter
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </dd>
                </>
              )}
              {sessionKind === "custom_gpt" && sessionGizmoId && (
                <>
                  <dt>GPT ID</dt>
                  <dd title={sessionGizmoId}>{sessionGizmoId}</dd>
                </>
              )}
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
              {onExportSessionImages && (
                <div className="inspector-actions">
                  <button type="button" onClick={onExportSessionImages} disabled={isImageExportRunning}>
                    <ImageDown size={15} />
                    Export session images ({sessionMedia.images.length})
                  </button>
                </div>
              )}
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
              {image?.projectId && (
                <span className="origin-project-pill" title={`Project (${image.projectId})`}>
                  {formatProjectLabel(image.projectId, projectAliases)}
                </span>
              )}
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
