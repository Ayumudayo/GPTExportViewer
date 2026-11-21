/**
 * Format image pixel dimensions for inspector and lightbox metadata display.
 */
export function formatImageResolution(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "Unknown resolution";
  }
  return `${Math.round(width)}x${Math.round(height)}`;
}

/**
 * Convert an internal library sourceState identifier into a concise badge label.
 */
export function formatSourceStateLabel(sourceState) {
  if (sourceState === "linked") return "Linked";
  if (sourceState === "library-only") return "Library";
  if (sourceState === "missing-source-chat") return "No chat";
  return sourceState || "Unknown";
}

/**
 * Compute CSS custom properties driving aspect-aware ImageLightbox dimensions.
 */
export function lightboxSizeStyle(image) {
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

/**
 * Partition all unique images and attached files referenced across a conversation's messages.
 */
export function collectConversationMedia(conversation) {
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
            status: part.exists === false ? "missing" : "ready",
            exists: part.exists !== false,
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

/**
 * Resolve the target message index for a jump-to-message request, preferring exact message+file match.
 */
export function findConversationTargetIndex(messages, jumpRequest) {
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
