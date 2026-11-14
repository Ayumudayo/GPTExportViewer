import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, FileDown, X } from "lucide-react";
import { assetUrl } from "../data/apiClient.js";
import { useDialogFocusTrap } from "../hooks/useDialogFocusTrap.js";
import { getWheelDirection } from "../libraryNavigation.js";
import { formatImageResolution, formatSourceStateLabel, lightboxSizeStyle } from "../utils/media.js";
import { ImageContextMenu } from "./ContextMenus.jsx";

/**
 * Full-viewport modal lightbox viewer for inspecting original-resolution images with keyboard/wheel paging.
 */
export function ImageLightbox({ exportId, image, currentIndex, total, onClose, onMove, onOpenInChat, onSaveImage }) {
  const lightboxDialogRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const wheelAccumRef = useRef(0);
  const wheelLastStepAtRef = useRef(0);
  const [imageContextMenu, setImageContextMenu] = useState(/** @type {{ x: number, y: number } | null} */ (null));
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
            <span>
              {currentIndex + 1} / {total}
            </span>
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
