import React, { useEffect, useRef, useState } from "react";
import { FileDown, ImageDown, MessageSquare, X } from "lucide-react";
import { clampPopupPosition } from "../utils/layout.js";

/**
 * Floating popup menu for exporting one or more selected conversation sessions.
 */
export function SessionContextMenu({ menu, count, onExport, onExportImages, isImageExportRunning = false, onClose }) {
  const menuRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [menuBounds, setMenuBounds] = useState({ width: 256, height: 82 });

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setMenuBounds({ width: rect.width, height: rect.height });
    }
  }, [menu, count, Boolean(onExportImages)]);

  if (!menu || count < 1) return null;
  const label = count === 1 ? "Export this session" : `Export ${count} selected sessions`;
  const imageLabel = count === 1 ? "Export images from this session" : `Export images from ${count} selected sessions`;
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
      <div className="session-context-menu-actions">
        <button type="button" onClick={onExport}>
          <FileDown size={15} />
          <span>{label}</span>
        </button>
        {onExportImages && (
          <button type="button" onClick={onExportImages} disabled={isImageExportRunning}>
            <ImageDown size={15} />
            <span>{imageLabel}</span>
          </button>
        )}
      </div>
      <button type="button" className="session-context-menu-close" aria-label="Close session context menu" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

/**
 * Floating popup menu offering source-chat navigation and original-file export for an image.
 */
export function ImageContextMenu({ menu, image, onOpenInChat, onSaveImage, onClose }) {
  const menuRef = useRef(/** @type {HTMLDivElement | null} */ (null));
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
