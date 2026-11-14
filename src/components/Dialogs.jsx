import React, { useCallback, useRef, useState } from "react";
import { FileDown, FolderOpen, Settings, X } from "lucide-react";
import { pickSourceFolder } from "../data/apiClient.js";
import { useDialogFocusTrap } from "../hooks/useDialogFocusTrap.js";

/**
 * First-run wrapper over SettingsDialog that blocks dismissal until a source folder is configured.
 */
export function OnboardingDialog(props) {
  return <SettingsDialog {...props} onboarding canClose={Boolean(props.settings?.sourceRoot)} />;
}

/**
 * Modal dialog for configuring and validating the root directory containing ChatGPT exports.
 */
export function SettingsDialog({
  settings,
  sourceRoot,
  setSourceRoot,
  saving,
  error,
  onError,
  onClose,
  onSubmit,
  onboarding = false,
  canClose = true
}) {
  const settingsDialogRef = useRef(/** @type {HTMLFormElement | null} */ (null));
  const [browsing, setBrowsing] = useState(false);

  const browseSourceFolder = useCallback(async () => {
    setBrowsing(true);
    onError("");
    try {
      const payload = await pickSourceFolder({ initialPath: sourceRoot || settings?.sourceRoot || "" });
      if (payload.folder?.selectedPath) {
        setSourceRoot(payload.folder.selectedPath);
      }
    } catch (nextError) {
      onError(nextError.message);
    } finally {
      setBrowsing(false);
    }
  }, [onError, setSourceRoot, settings?.sourceRoot, sourceRoot]);

  const handleEscape = useCallback(() => {
    if (canClose && !saving) onClose();
  }, [canClose, onClose, saving]);

  useDialogFocusTrap(true, settingsDialogRef, { onEscape: handleEscape });

  return (
    <div
      className="settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={onboarding ? "Source folder onboarding" : "Settings"}
      onClick={() => {
        if (canClose && !saving) onClose();
      }}
    >
      <form ref={settingsDialogRef} className="settings-dialog" tabIndex={-1} onSubmit={onSubmit} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <Settings size={18} />
            <h2>{onboarding ? "Choose source folder" : "Settings"}</h2>
          </div>
          {canClose && (
            <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose} disabled={saving}>
              <X size={18} />
            </button>
          )}
        </header>

        <label className="settings-field" htmlFor="source-folder-input">
          <span>Source folder</span>
          <div className="settings-input-row">
            <input
              id="source-folder-input"
              value={sourceRoot}
              onChange={(event) => setSourceRoot(event.target.value)}
              disabled={saving || browsing}
              placeholder="E:\\OpenAI\\Exports"
              spellCheck={false}
            />
            <button type="button" aria-label="Browse source folder" onClick={browseSourceFolder} disabled={saving || browsing}>
              <FolderOpen size={15} />
              {browsing ? "Browsing..." : "Browse"}
            </button>
          </div>
        </label>

        <div className="settings-meta">
          <span>Cache</span>
          <strong title={settings?.cacheDir ?? ""}>{settings?.cacheDir ?? "-"}</strong>
        </div>

        {error && <p className="settings-error">{error}</p>}

        <footer>
          {canClose && (
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Applying..." : onboarding ? "Start" : "Apply"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/**
 * Modal progress dialog displaying multi-session archive export status and output folder shortcut.
 */
export function ExportProgressDialog({ job, onOpenFolder, onClose }) {
  const exportDialogRef = useRef(/** @type {HTMLElement | null} */ (null));
  const previouslyFocusedElementRef = useRef(/** @type {HTMLElement | null} */ (null));
  const isOpen = Boolean(job);

  const handleEscape = useCallback(() => {
    if (job?.status !== "running") {
      onClose();
    }
  }, [job?.status, onClose]);

  useDialogFocusTrap(isOpen, exportDialogRef, {
    onEscape: handleEscape,
    previouslyFocusedRef: previouslyFocusedElementRef
  });

  if (!job) return null;

  const percent = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;
  const title = job.status === "done" ? "Export complete" : job.status === "error" ? "Export failed" : "Exporting sessions...";

  return (
    <div className="export-progress-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
      <section
        className="export-progress-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-progress-title"
        tabIndex={-1}
        ref={exportDialogRef}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <FileDown size={18} />
            <h2 id="export-progress-title">{title}</h2>
          </div>
          {job.status !== "running" && (
            <button type="button" className="icon-button" aria-label="Close export dialog" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </header>

        <div
          className="progress-bar"
          role="progressbar"
          aria-label="Session export progress"
          aria-valuemin={0}
          aria-valuemax={job.total}
          aria-valuenow={job.completed}
        >
          <span style={{ width: `${percent}%` }} />
        </div>

        <p className="export-progress-count">
          {job.completed} / {job.total} sessions
        </p>

        {job.error && <p className="settings-error dialog-error">{job.error}</p>}
        {job.destinationDir && <p className="export-progress-path">{job.destinationDir}</p>}

        {(job.status === "done" || job.status === "error") && (
          <footer>
            {job.status === "done" && (
              <button type="button" className="primary-button export-progress-open" onClick={onOpenFolder}>
                <FolderOpen size={15} />
                Open folder
              </button>
            )}
            <button type="button" onClick={onClose}>
              Close
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
