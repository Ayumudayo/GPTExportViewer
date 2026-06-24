import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const styles = await readFile("src/styles.css", "utf8");
const main = await readFile("src/main.jsx", "utf8");
const apiClient = await readFile("src/data/apiClient.js", "utf8");
const httpClient = await readFile("src/data/httpApiClient.js", "utf8");
const tauriClient = await readFile("src/data/tauriApiClient.js", "utf8");

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should be declared as a pure helper`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadSelectionHelpers() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunctionSource(main, "toggleSelection"),
      extractFunctionSource(main, "selectConversationRange"),
      extractFunctionSource(main, "reconcileConversationSelection"),
      "helpers = { toggleSelection, selectConversationRange, reconcileConversationSelection };"
    ].join("\n"),
    context
  );
  return context.helpers;
}

function loadDialogFocusHelpers() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunctionSource(main, "getNextDialogFocusIndex"),
      "helpers = { getNextDialogFocusIndex };"
    ].join("\n"),
    context
  );
  return context.helpers;
}

const selectionHelpers = loadSelectionHelpers();
const dialogFocusHelpers = loadDialogFocusHelpers();
const helperConversations = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.deepEqual(plain(selectionHelpers.toggleSelection(["a", "b"], "b")), ["a"], "Ctrl/Cmd toggle should remove only the requested export-selection id");
assert.deepEqual(plain(selectionHelpers.toggleSelection(["a"], "c")), ["a", "c"], "Ctrl/Cmd toggle should append a missing export-selection id");
assert.deepEqual(plain(selectionHelpers.selectConversationRange(helperConversations, "b", "d")), ["b", "c", "d"], "Shift range should include anchor and target");
assert.deepEqual(plain(selectionHelpers.selectConversationRange(helperConversations, "missing", "c")), ["c"], "Shift range should fall back to the target when the anchor is stale");
assert.deepEqual(
  plain(selectionHelpers.reconcileConversationSelection(helperConversations, ["a", "x", "c"], "x")),
  { selectedConversationIds: ["a", "c"], lastSelectedConversationId: "" },
  "Selection reconciliation should prune stale export ids and stale range anchor ids"
);
assert.equal(dialogFocusHelpers.getNextDialogFocusIndex(0, 0, false), -1, "Dialog focus helper should fall back to the dialog itself when there are no focusable controls");
assert.equal(dialogFocusHelpers.getNextDialogFocusIndex(-1, 3, false), 0, "Dialog focus helper should start from the first control on forward Tab");
assert.equal(dialogFocusHelpers.getNextDialogFocusIndex(-1, 3, true), 2, "Dialog focus helper should start from the last control on reverse Tab");
assert.equal(dialogFocusHelpers.getNextDialogFocusIndex(2, 3, false), 0, "Dialog focus helper should wrap forward Tab to the first control");
assert.equal(dialogFocusHelpers.getNextDialogFocusIndex(0, 3, true), 2, "Dialog focus helper should wrap reverse Tab to the last control");
assert.equal(dialogFocusHelpers.getNextDialogFocusIndex(1, 3, false), 2, "Dialog focus helper should advance to the next control within bounds");
assert.equal(dialogFocusHelpers.getNextDialogFocusIndex(1, 3, true), 0, "Dialog focus helper should move backward within bounds");

assert.equal(main.includes('aria-label="Settings"'), true, "Settings should be a real, reachable control");
assert.equal(main.includes("function SettingsDialog"), true, "Settings should render a real dialog instead of a placeholder");
assert.equal(main.includes("source-folder-input"), true, "Settings should expose the source folder field");
assert.equal(apiClient.includes("fetchSettings"), true, "Client API should fetch current runtime settings");
assert.equal(apiClient.includes("updateSettings"), true, "Client API should persist source folder updates");
assert.equal(apiClient.includes("pickSourceFolder"), true, "Client API should ask the local app server to open the native folder picker");
assert.equal(httpClient.includes("/api/pick-folder"), true, "HTTP folder selection should use the native picker endpoint");
assert.equal(httpClient.includes("local API server is running an older build"), true, "Missing new HTTP API endpoints should explain that the server process must be restarted");
assert.equal(tauriClient.includes("@tauri-apps/plugin-dialog"), true, "Desktop folder selection should use the Tauri native dialog plugin");
assert.equal(main.includes("function FolderPicker"), false, "Settings should not use an in-app folder browser when Browse is expected to open the OS picker");
assert.equal(main.includes('aria-label="Browse source folder"'), true, "Source folder settings should expose a native browse action");
assert.equal(main.includes("folder-picker"), false, "In-app folder picker UI should not render for the native Browse action");
assert.equal(main.includes("Menu,"), false, "Menu placeholder icon should not render until a real menu is implemented");
assert.equal(main.includes('aria-label="Session info"'), false, "Session info placeholder should not render without a real interaction");
assert.equal(main.includes('aria-label="Open source folder"'), false, "Open source folder placeholder should not render without a real interaction");
assert.equal(main.includes('aria-label="Filter"'), false, "Filter placeholder should not render without a real interaction");
assert.equal(main.includes("toolbar-row"), false, "Decorative chat toolbar buttons should be removed or replaced with real filters");
assert.equal(main.includes("conversationFilter"), true, "Chat list filters should be backed by real state");
assert.equal(main.includes("filter: conversationFilter"), true, "Chat list filters should be sent to the API");
assert.equal(main.includes("selectedConversationIds"), true, "Session rows should track multi-selected conversation ids");
assert.equal(main.includes("sessionContextMenu"), true, "Session rows should track context-menu popup state");
assert.equal(main.includes("onContextMenu"), true, "Session rows should handle context-menu gestures");
assert.equal(main.includes("event.shiftKey"), true, "Session row selection should support shift-range selection");
assert.equal(main.includes("event.ctrlKey || event.metaKey"), true, "Session row selection should support ctrl/cmd toggles");
assert.equal(main.includes("SessionContextMenu"), true, "Session selection should render an extracted context-menu component");
assert.equal(main.includes("sessionExportJob"), true, "Session export should track modal progress state");
assert.equal(main.includes("ExportProgressDialog"), true, "Session export should show a progress dialog");
assert.equal(main.includes("saveSessions"), true, "UI should call the session export API");
assert.equal(main.includes("openSavedSessionsFolder"), true, "Completed export dialog should expose folder opening");
assert.equal(main.includes("copyMessageText"), true, "Messages should expose a copy action");
assert.equal(main.includes("navigator.clipboard.writeText"), true, "Message copy should use the clipboard API");
assert.equal(main.includes("message-copy-button"), true, "Messages should render a hover copy button");
assert.equal(main.includes('sessionExportJob?.status === "running"'), true, "Session export actions should guard against re-entry while running");
assert.equal(main.includes('className="export-progress-backdrop"'), true, "Export progress should render a dedicated backdrop wrapper");
assert.equal(main.includes("exportDialogRef"), true, "Export dialog should keep a ref for focus management");
assert.equal(main.includes("previouslyFocusedElementRef"), true, "Export dialog should restore the previously focused element on cleanup");
assert.equal(main.includes('tabIndex={-1}'), true, "Export dialog should be focusable when no inner controls are available");
assert.equal(main.includes('event.key === "Tab"'), true, "Export dialog should trap Tab navigation while open");
assert.equal(main.includes("getNextDialogFocusIndex"), true, "Export dialog focus order should use a pure helper");
assert.equal(main.includes("reconcileConversationSelection"), true, "Session export selection should be reconciled against the loaded conversation list");
assert.equal(main.includes("aria-pressed={isExportSelected}"), true, "Session rows should expose export-selection state as pressed buttons");
assert.equal(main.includes('aria-current={isActive ? "true" : undefined}'), true, "Session rows should expose the active chat separately from export selection");
assert.equal(main.includes("aria-selected={isMultiSelected}"), false, "Session rows should not use aria-selected on normal buttons");
assert.equal(main.includes('role="menu"'), false, "Session action popover should not advertise menu semantics without full menu behavior");
assert.equal(main.includes('role="menuitem"'), false, "Session action buttons should stay normal buttons unless full menu behavior is implemented");
assert.equal(main.includes('role="group"'), true, "Session action popover should use simple grouped button semantics");
assert.equal(main.includes('aria-label="Session actions"'), true, "Session action popover should have an accessible group label");
assert.equal(main.includes("ChevronRight"), false, "Inspector panels should not show chevrons when they are not expandable");
assert.equal(main.includes("function ResizeHandle"), true, "Pane boundaries should expose resize handles");
assert.equal(main.includes('role="separator"'), true, "Resize handles should use the separator role");
assert.equal(main.includes("startResize"), true, "Resize handles should wire pointer-drag behavior");
assert.equal(main.includes("--sidebar-width"), true, "Layout should be driven by adjustable sidebar width");
assert.equal(main.includes("--inspector-width"), true, "Layout should be driven by adjustable inspector width");
assert.equal(main.includes("formatExportLabel(item)"), true, "Export selector should render readable formatted labels");
assert.equal(main.includes("formatExportLabel(selectedExport)"), true, "Inspector export name should render the same readable label");
assert.equal(main.includes("<select value={selectedExportId}"), false, "Export switcher should not leave a native select rendered inside the card");
assert.equal(main.includes("exportMenuOpen"), true, "Export switcher should open a full-card custom menu");
assert.equal(main.includes('aria-haspopup="listbox"'), true, "Export switcher trigger should advertise the listbox popup");
assert.equal(main.includes('role="listbox"'), true, "Export switcher menu should expose listbox semantics");
assert.equal(main.includes('role="option"'), true, "Export switcher menu items should expose option semantics");
assert.equal(main.includes("function useAutoLoadMore"), true, "Paged chat and library surfaces should use an automatic load-more sentinel");
assert.equal(main.includes("new IntersectionObserver"), true, "Automatic loading should be driven by viewport intersection instead of manual clicks");
assert.equal(main.includes("loadingMoreKeyRef"), true, "Automatic load-more requests should be guarded by a keyed in-flight lock");
assert.equal(main.includes("latestLoadStateRef"), true, "Automatic load-more responses should be checked against the latest selection and filters before merging");
assert.match(main, /current\.id !== payload\.id\) return current;/, "Stale message-page responses should be dropped instead of replacing the active conversation");
assert.equal(main.includes("function useVirtualList"), true, "Long vertical lists should unmount offscreen rows");
assert.equal(main.includes("function useVirtualGrid"), true, "The image grid should unmount offscreen cards");
assert.equal(main.includes("virtual-spacer"), true, "Virtualized surfaces should preserve scroll geometry with spacer elements");
assert.match(main, /virtualMessages\.items\.map/, "ChatReader should render only the virtual message window");
assert.match(main, /virtualImages\.items\.map/, "LibraryReader should render only the virtual image-card window");
assert.equal(main.includes("Load next range"), false, "Chat message pagination should not require a manual range button");
assert.equal(main.includes("Load more images"), false, "Library pagination should not require a manual image button");
assert.equal(main.includes("Load more ("), false, "Sidebar pagination should not require manual load-more buttons");
assert.equal(
  /<button className="load-more-(?:row|button)"[\s\S]*?onClick=\{onLoadMore/.test(main),
  false,
  "Load-more controls should be passive sentinels, not clickable buttons"
);

assert.match(
  styles,
  /\.snapshot-switcher-wrap\s*\{[\s\S]*?position: relative;[\s\S]*?\}/,
  "Export selector wrapper should anchor the popup menu"
);

assert.match(
  styles,
  /\.snapshot-switcher\s*\{[\s\S]*?width: 100%;[\s\S]*?cursor: pointer;[\s\S]*?\}/,
  "Export selector card should be one full-width clickable trigger"
);

assert.match(
  styles,
  /\.snapshot-menu\s*\{[\s\S]*?position: absolute;[\s\S]*?z-index: 30;[\s\S]*?overflow: auto;[\s\S]*?\}/,
  "Export selector menu should be an anchored popup instead of a native select"
);

assert.match(
  styles,
  /\.image-thumb img,\s*\.mini-thumb img\s*\{[\s\S]*?position: absolute;[\s\S]*?inset: 0;[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: cover;[\s\S]*?object-position: center center;[\s\S]*?\}/,
  "Library grid and side-list thumbnails should crop from the image center without resizing the card"
);

assert.match(
  styles,
  /\.inspector-preview img,\s*\.lightbox-image img\s*\{[\s\S]*?position: absolute;[\s\S]*?inset: 0;[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;[\s\S]*?\}/,
  "Inspector preview and lightbox images should fit fully inside their frame without overflowing it"
);

assert.match(
  styles,
  /\.auto-load-sentinel\s*\{[\s\S]*?pointer-events: none;[\s\S]*?\}/,
  "Automatic load-more sentinels should be styled as passive status rows, not clickable controls"
);

assert.match(styles, /\.resize-handle\s*\{[\s\S]*?cursor: col-resize;[\s\S]*?\}/, "Pane resize handles should be visually and behaviorally resizable");
assert.match(styles, /\.settings-dialog\s*\{[\s\S]*?background: var\(--panel\);[\s\S]*?\}/, "Settings dialog should use the dark app surface");
assert.match(styles, /\.conversation-list\s*\{[\s\S]*?overflow: auto;[\s\S]*?\}/, "Conversation list should be scrollable so its auto-load sentinel can enter view");
assert.match(styles, /\.library-side-list\s*\{[\s\S]*?overflow: auto;[\s\S]*?\}/, "Library side list should be scrollable so its auto-load sentinel can enter view");
assert.match(styles, /\.conversation-row\.multi-selected\s*\{/, "Multi-selected session rows should have a visible state");
assert.match(styles, /\.conversation-row\.selected\s*\{[\s\S]*?box-shadow: inset 3px 0 0 var\(--muted-2\);[\s\S]*?\}/, "Active-only session rows should use a neutral active marker, not the export-selection marker");
assert.match(styles, /\.conversation-row\.multi-selected\s*\{[\s\S]*?box-shadow: inset 3px 0 0 var\(--green\);[\s\S]*?\}/, "Export-selected session rows should use the export-selection marker");
assert.match(styles, /\.session-context-menu\s*\{/, "Session context menu should have fixed popup styling");
assert.match(styles, /body\.modal-open\s*\{[\s\S]*?overflow: hidden;[\s\S]*?\}/, "Modal-open body state should lock scrolling");
assert.match(styles, /\.export-progress-backdrop\s*\{[\s\S]*?z-index:\s*80;[\s\S]*?\}/, "Export progress backdrop should sit above the session context menu");
assert.match(styles, /\.export-progress-dialog\s*\{/, "Export progress dialog should use app modal styling");
assert.match(styles, /\.progress-bar\s*\{/, "Export progress dialog should show progress visually");
assert.match(styles, /\.message-copy-button/, "Message copy button should be styled");
assert.match(styles, /\.message:hover\s+\.message-copy-button/, "Message copy button should appear on hover");
assert.match(styles, /\.message:focus-within\s+\.message-copy-button/, "Message copy button should remain available on focus");
assert.match(styles, /\.message\.user[\s\S]*justify-items:\s*end/, "User messages should align to the right");
assert.match(styles, /\.message\.user\s+\.message-body[\s\S]*background:/, "User message body should have bubble styling");

console.log("ui contract tests passed");
