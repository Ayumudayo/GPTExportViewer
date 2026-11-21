import { useCallback, useEffect, useState } from "react";
import { exportOriginalImages, openExportedImagesFolder } from "../data/apiClient.js";

/**
 * Own batch original-image extraction state, progress updates, and destination folder shortcuts.
 */
export function useImageExport({ selectedExportId, setError, onNotify }) {
  const [imageExportJob, setImageExportJob] = useState(/** @type {any} */ (null));
  const [isImageExportRunning, setIsImageExportRunning] = useState(false);

  useEffect(() => {
    setImageExportJob((current) => (current?.exportId === selectedExportId ? current : null));
  }, [selectedExportId]);

  const exportImages = useCallback(
    async ({ scope, conversationIds = undefined, projectId = undefined, projectIds = undefined, scopeLabel = "" } = {}) => {
      if (isImageExportRunning || !selectedExportId || !scope) return;
      setError("");
      setIsImageExportRunning(true);

      try {
        const payload = await exportOriginalImages({
          exportId: selectedExportId,
          scope,
          conversationIds,
          projectId,
          projectIds,
          onProgress: (progress) => {
            if (!progress?.total) return;
            setImageExportJob({
              kind: "images",
              status: "running",
              scope,
              scopeLabel,
              total: progress.total,
              completed: progress.completed ?? 0,
              skippedMissing: progress.skippedMissing ?? 0,
              totalBytes: 0,
              exportId: progress.exportId ?? selectedExportId,
              destinationDir: "",
              currentFileName: progress.currentFileName ?? "",
              error: ""
            });
          }
        });

        if (payload?.canceled) {
          setImageExportJob(null);
          return;
        }

        const exportedCount = payload?.exportedCount ?? 0;
        const skippedMissing = payload?.skippedMissing ?? 0;
        if (exportedCount === 0) {
          setImageExportJob(null);
          onNotify?.(
            skippedMissing > 0
              ? `No exportable images (${skippedMissing} missing from export)`
              : "No images found to export"
          );
          return;
        }

        setImageExportJob({
          kind: "images",
          status: "done",
          scope: payload?.scope ?? scope,
          scopeLabel: payload?.scopeLabel || scopeLabel,
          total: exportedCount,
          completed: exportedCount,
          skippedMissing,
          totalBytes: payload?.totalBytes ?? 0,
          exportId: payload?.export?.id ?? selectedExportId,
          destinationDir: payload?.destinationDir ?? "",
          currentFileName: payload?.progress?.currentFileName ?? "",
          error: ""
        });
      } catch (nextError) {
        const message = nextError?.message ?? "Failed to export images";
        setImageExportJob((current) => ({
          kind: "images",
          status: "error",
          scope,
          scopeLabel: current?.scopeLabel || scopeLabel,
          total: current?.total ?? 0,
          completed: current?.completed ?? 0,
          skippedMissing: current?.skippedMissing ?? 0,
          totalBytes: current?.totalBytes ?? 0,
          exportId: current?.exportId ?? selectedExportId,
          destinationDir: current?.destinationDir ?? "",
          currentFileName: current?.currentFileName ?? "",
          error: message
        }));
        setError(message);
      } finally {
        setIsImageExportRunning(false);
      }
    },
    [isImageExportRunning, onNotify, selectedExportId, setError]
  );

  const closeImageExportDialog = useCallback(() => {
    setImageExportJob((current) => (current?.status === "running" ? current : null));
  }, []);

  const openImageExportFolder = useCallback(async () => {
    const targetPath = imageExportJob?.destinationDir;
    if (!targetPath) return;
    try {
      await openExportedImagesFolder({ path: targetPath });
    } catch (nextError) {
      const message = nextError?.message ?? "Failed to open exported images folder";
      setImageExportJob((current) => (current ? { ...current, error: message } : current));
    }
  }, [imageExportJob?.destinationDir]);

  return {
    imageExportJob,
    isImageExportRunning,
    exportImages,
    closeImageExportDialog,
    openImageExportFolder
  };
}
