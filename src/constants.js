export const CONVERSATION_ROW_SIZE = 76;
export const LIBRARY_SIDE_ROW_SIZE = 68;
export const ESTIMATED_MESSAGE_ROW_SIZE = 96;
export const MESSAGE_COLLAPSE_LIMIT = 1200;
export const GALLERY_ROW_SIZE = 284;
export const GALLERY_MIN_CARD_WIDTH = 176;
export const GALLERY_GAP = 14;
export const LAYOUT_STORAGE_KEY = "chatgpt-export-layout";
export const THEME_STORAGE_KEY = "gpt-export-viewer.theme.v1";
export const FOCUSABLE_DIALOG_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(", ");
export const DEFAULT_LAYOUT = { sidebar: 360, inspector: 340, inspectorOpen: true };
export const LAYOUT_LIMITS = {
  sidebar: { min: 280, max: 560 },
  inspector: { min: 280, max: 540 }
};
export const WINDOW_PREFERENCE_SAVE_DELAY_MS = 350;
