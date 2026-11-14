import { useEffect, useRef } from "react";
import { FOCUSABLE_DIALOG_SELECTOR } from "../constants.js";
import { getNextDialogFocusIndex } from "../utils/layout.js";

/**
 * Trap Tab focus within an open modal dialog, handle Escape, and restore prior focus on close.
 */
export function useDialogFocusTrap(isOpen, dialogRef, { onEscape = undefined, previouslyFocusedRef = undefined } = {}) {
  const internalPreviousFocusRef = useRef(/** @type {HTMLElement | null} */ (null));
  const previousFocusRef = previouslyFocusedRef ?? internalPreviousFocusRef;

  useEffect(() => {
    if (!isOpen) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const focusableElements = Array.from(dialog.querySelectorAll(FOCUSABLE_DIALOG_SELECTOR));
      const initialFocusTarget = /** @type {HTMLElement | null} */ (focusableElements[0] ?? dialog);
      initialFocusTarget?.focus?.();
    }
    return () => {
      document.body.classList.remove("modal-open");
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    };
  }, [isOpen, dialogRef, previousFocusRef]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape") {
        if (onEscape) {
          event.preventDefault();
          onEscape(event);
        }
        return;
      }

      if (event.key === "Tab") {
        const focusableElements = Array.from(dialog.querySelectorAll(FOCUSABLE_DIALOG_SELECTOR));
        const currentIndex = focusableElements.findIndex((element) => element === document.activeElement);
        const nextIndex = getNextDialogFocusIndex(currentIndex, focusableElements.length, event.shiftKey);
        event.preventDefault();
        if (nextIndex < 0) {
          dialog.focus();
          return;
        }
        /** @type {HTMLElement | undefined} */ (focusableElements[nextIndex])?.focus?.();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, dialogRef, onEscape]);
}
