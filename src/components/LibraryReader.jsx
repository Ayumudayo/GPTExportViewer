import React, { useEffect, useRef } from "react";
import { ImageDown, Images, Info, ZoomIn } from "lucide-react";
import { useAutoLoadMore } from "../hooks/useAutoLoadMore.js";
import { useVirtualGrid } from "../hooks/useVirtualList.js";
import { formatSourceStateLabel } from "../utils/media.js";
import { LoadingState, Thumb, VirtualSpacer } from "./Common.jsx";

/**
 * Virtualized grid view of indexed export images with sidebar scroll synchronization.
 */
export function LibraryReader({
  exportId,
  images,
  image,
  selectedImageId,
  setSelectedImageId,
  onOpenImageContextMenu,
  sidebarJumpSeq = 0,
  stats,
  page,
  resetKey,
  busy,
  isLoadingLibrary = false,
  loadingMore,
  hasActiveFilter,
  onResetFilters,
  onLoadMoreLibrary,
  openLightbox,
  onExportAllImages,
  isImageExportRunning = false,
  isInspectorOpen = true,
  onToggleInspector
}) {
  const virtualImages = useVirtualGrid(images, { resetKey });
  const libraryAutoLoadRef = useAutoLoadMore({
    hasMore: Boolean(page?.nextCursor),
    isLoading: isLoadingLibrary || loadingMore === "library",
    onLoadMore: onLoadMoreLibrary,
    containerRef: virtualImages.containerRef,
    itemCount: images.length
  });

  const handledJumpSeqRef = useRef(sidebarJumpSeq);

  useEffect(() => {
    if (sidebarJumpSeq <= 0 || handledJumpSeqRef.current === sidebarJumpSeq) return;
    if (!selectedImageId) {
      handledJumpSeqRef.current = sidebarJumpSeq;
      return;
    }
    const targetIndex = images.findIndex((item) => item.fileId === selectedImageId);
    const container = virtualImages.containerRef.current;
    if (targetIndex < 0 || !container) return;
    handledJumpSeqRef.current = sidebarJumpSeq;
    const gridTop = virtualImages.gridOffsetTop ?? 0;
    const rowIndex = Math.floor(targetIndex / Math.max(1, virtualImages.columns));
    const rowSize = Math.max(1, virtualImages.rowSize);
    const rowTop = gridTop + rowIndex * rowSize;
    const rowBottom = rowTop + rowSize;
    const viewportHeight = container.clientHeight;
    if (viewportHeight <= 1) {
      container.scrollTop = rowIndex === 0 ? 0 : Math.max(0, rowTop - 12);
      virtualImages.syncViewport?.();
      return;
    }
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + viewportHeight;
    if (rowTop < viewTop + 12) {
      container.scrollTop = rowIndex === 0 ? 0 : Math.max(0, rowTop - 12);
      virtualImages.syncViewport?.();
    } else if (rowBottom > viewBottom - 12) {
      container.scrollTop = Math.max(0, rowBottom + 12 - viewportHeight);
      virtualImages.syncViewport?.();
    }
  }, [images, selectedImageId, sidebarJumpSeq, virtualImages]);

  const totalCount = stats?.totalImages ?? page?.total ?? images.length;
  const visibleTotal = page?.total ?? images.length;
  const summaryParts = [];
  if (hasActiveFilter && visibleTotal !== totalCount) {
    summaryParts.push(`${visibleTotal} matching`);
  }
  summaryParts.push(`${totalCount} ${totalCount === 1 ? "image" : "images"}`);
  if (stats) {
    summaryParts.push(`${stats.linkedImages ?? 0} linked`);
    summaryParts.push(`${stats.libraryOnlyImages ?? 0} library`);
    if (stats.missingFiles) {
      summaryParts.push(`${stats.missingFiles} missing`);
    }
  }
  const librarySubtitle = summaryParts.join(" · ");

  return (
    <main className="reader library-reader">
      <header className="reader-header">
        <div>
          <div className="title-line">
            <Images size={18} />
            <h2>Library</h2>
            <span className="library-pill">Images</span>
          </div>
          <span title={librarySubtitle}>{librarySubtitle}</span>
        </div>
        <div className="reader-actions">
          <button type="button" aria-label="Open selected image" onClick={() => openLightbox(image)} disabled={!image?.exists}>
            <ZoomIn size={17} />
          </button>
          <button
            type="button"
            aria-label="Export all images"
            title="Export all original images from this export"
            onClick={onExportAllImages}
            disabled={isImageExportRunning || totalCount < 1}
          >
            <ImageDown size={17} />
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

      <section className="gallery-window" ref={virtualImages.containerRef}>
        {isLoadingLibrary && images.length === 0 ? (
          <LoadingState
            title={busy === "Indexing" ? "Indexing export archive..." : "Loading library images..."}
            description="Scanning export assets and reading image metadata."
            rows={4}
          />
        ) : !isLoadingLibrary && images.length === 0 ? (
          <div className="empty-state">
            <Images size={24} />
            <strong>{hasActiveFilter ? "No matching images" : "No images found"}</strong>
            <p>{hasActiveFilter ? "Try another search query or reset filters." : "No image files were indexed for this export."}</p>
            {hasActiveFilter && (
              <button type="button" onClick={onResetFilters}>
                Reset filters
              </button>
            )}
          </div>
        ) : (
          <div ref={virtualImages.stageRef}>
            <VirtualSpacer size={virtualImages.beforeSize} />
            <div className="gallery-grid" ref={virtualImages.gridRef}>
              {virtualImages.items.map(({ item }) => (
                <button
                  type="button"
                  className={`image-card ${item.fileId === selectedImageId ? "selected" : ""}`}
                  key={item.fileId}
                  onClick={() => setSelectedImageId(item.fileId)}
                  onContextMenu={(event) => onOpenImageContextMenu?.(event, item)}
                  onDoubleClick={() => {
                    setSelectedImageId(item.fileId);
                    if (item.exists) openLightbox(item);
                  }}
                >
                  <Thumb exportId={exportId} image={item} />
                  <span className="image-card-copy">
                    <strong>{item.displayName}</strong>
                    <em>
                      {item.mime} · {item.sizeLabel}
                    </em>
                  </span>
                  <span className={`origin-chip ${item.sourceState === "linked" ? "linked" : ""}`} title={item.sourceState}>
                    {formatSourceStateLabel(item.sourceState)}
                  </span>
                </button>
              ))}
            </div>
            <VirtualSpacer size={virtualImages.afterSize} />
          </div>
        )}
        {page?.nextCursor && (
          <div
            className={`auto-load-sentinel ${loadingMore === "library" ? "loading" : ""}`}
            ref={libraryAutoLoadRef}
            role="status"
            aria-live="polite"
            aria-busy={loadingMore === "library"}
          >
            {loadingMore === "library" ? "Loading images..." : `Auto-loading images (${images.length} / ${page.total})`}
          </div>
        )}
      </section>
    </main>
  );
}
