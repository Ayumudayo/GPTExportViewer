import React from "react";
import { FileImage, Loader2 } from "lucide-react";
import { thumbUrl } from "../data/apiClient.js";

/**
 * Display an inline progress spinner with optional skeleton placeholder bars while data loads.
 */
export function LoadingState({ title, description = "", rows = 3 }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <Loader2 size={22} className="spin" />
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {rows > 0 && (
        <div className="loading-skeleton-list" aria-hidden="true">
          {Array.from({ length: rows }, (_, index) => (
            <span key={index} className="loading-skeleton-bar" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Render an inert spacer block representing offscreen virtualized rows or columns.
 */
export function VirtualSpacer({ size }) {
  if (!size) return null;
  return <div className="virtual-spacer" style={{ height: size }} aria-hidden="true" />;
}

/**
 * Render an accessible vertical splitter handle between adjacent workspace panes.
 */
export function ResizeHandle({ pane, onPointerDown, onKeyDown }) {
  const label = pane === "sidebar" ? "Resize sidebar" : "Resize inspector";
  return (
    <div
      className={`resize-handle ${pane}-resize`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => onPointerDown(pane, event)}
      onKeyDown={(event) => onKeyDown(pane, event)}
    />
  );
}

/**
 * Render a cached image thumbnail or an amber fallback tile when the source asset is missing.
 */
export function Thumb({ exportId, image, small = false, preview = false }) {
  if (!image?.exists || !exportId) {
    return (
      <span className={preview ? "inspector-preview tone-amber" : small ? "mini-thumb tone-amber" : "image-thumb tone-amber"}>
        <FileImage size={small ? 18 : 34} />
      </span>
    );
  }
  return (
    <span className={preview ? "inspector-preview real-thumb" : small ? "mini-thumb real-thumb" : "image-thumb real-thumb"}>
      <img src={thumbUrl(exportId, image.fileId)} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

/**
 * Render a titled section panel inside the right-hand details inspector.
 */
export function Panel({ title, icon, count = undefined, warning = false, children }) {
  return (
    <section className={`utility-panel ${warning ? "warning" : ""}`}>
      <header>
        <span>
          {icon}
          {title}
        </span>
        {count && <em>{count}</em>}
      </header>
      {children}
    </section>
  );
}

/**
 * Catch unexpected React rendering errors at the root and allow user-initiated recovery.
 */
export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    /** @type {{ error: any }} */
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("GPTExportViewer render failed:", error);
  }

  render() {
    const self = /** @type {any} */ (this);
    if (self.state.error) {
      return (
        <div className="app-crash-fallback" role="alert">
          <div className="app-crash-card">
            <h2>Unable to render GPTExportViewer</h2>
            <p>{String(self.state.error?.message || self.state.error || "Unknown error")}</p>
            <button type="button" onClick={() => self.setState({ error: null })}>
              Reload view
            </button>
          </div>
        </div>
      );
    }
    return self.props.children;
  }
}
