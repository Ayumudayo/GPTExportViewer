import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const styles = await readFile("src/styles.css", "utf8");
const baseStyles = styles.slice(0, styles.indexOf("@media"));
const main = await readFile("src/main.jsx", "utf8");
const chatReaderHelpers = await readFile("src/chatReaderHelpers.js", "utf8");
const measuredVirtualList = await readFile("src/measuredVirtualList.js", "utf8");
const apiClient = await readFile("src/data/apiClient.js", "utf8");
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

function extractCssRule(source, selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `${selector} should exist in styles`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${selector}`);
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

function loadImageDisplayHelpers() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunctionSource(main, "formatImageResolution"),
      extractFunctionSource(main, "lightboxSizeStyle"),
      "helpers = { formatImageResolution, lightboxSizeStyle };"
    ].join("\n"),
    context
  );
  return context.helpers;
}

const selectionHelpers = loadSelectionHelpers();
const dialogFocusHelpers = loadDialogFocusHelpers();
const imageDisplayHelpers = loadImageDisplayHelpers();
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
assert.equal(imageDisplayHelpers.formatImageResolution({ width: 1024, height: 1536 }), "1024x1536", "Image resolution helper should format pixel dimensions");
assert.equal(imageDisplayHelpers.formatImageResolution({}), "Unknown resolution", "Image resolution helper should handle missing dimensions");
assert.equal(imageDisplayHelpers.lightboxSizeStyle({ width: 1024, height: 1536 })["--lightbox-aspect"], "1024 / 1536", "Lightbox sizing should preserve the original image aspect ratio");
assert.match(imageDisplayHelpers.lightboxSizeStyle({ width: 1024, height: 1536 })["--lightbox-width"], /px$/, "Lightbox sizing should emit a concrete preferred width");
assert.match(imageDisplayHelpers.lightboxSizeStyle({ width: 1024, height: 1536 })["--lightbox-height"], /px$/, "Lightbox sizing should emit a concrete preferred height");
assert.ok(Number.parseInt(imageDisplayHelpers.lightboxSizeStyle({ width: 2048, height: 1152 })["--lightbox-width"], 10) >= 1520, "Large landscape images should get a wider preferred lightbox");
assert.ok(Number.parseInt(imageDisplayHelpers.lightboxSizeStyle({ width: 2048, height: 1152 })["--lightbox-height"], 10) >= 1000, "Large landscape images should get a taller preferred lightbox");

assert.equal(main.includes('aria-label="Settings"'), true, "Settings should be a real, reachable control");
assert.equal(main.includes("function SettingsDialog"), true, "Settings should render a real dialog instead of a placeholder");
assert.equal(main.includes("source-folder-input"), true, "Settings should expose the source folder field");
assert.equal(apiClient.includes("fetchSettings"), true, "Client API should fetch current runtime settings");
assert.equal(apiClient.includes("updateSettings"), true, "Client API should persist source folder updates");
assert.equal(apiClient.includes("rescanExports"), true, "Client API should expose source folder rescanning");
assert.equal(apiClient.includes("updatePreferences"), true, "Client API should persist selected export and window size without rewriting the source folder");
assert.equal(apiClient.includes("pickSourceFolder"), true, "Client API should ask the desktop runtime to open the native folder picker");
assert.equal(apiClient.includes("httpApiClient"), false, "Client API should not keep the removed HTTP transport");
assert.equal(tauriClient.includes("@tauri-apps/plugin-dialog"), true, "Desktop folder selection should use the Tauri native dialog plugin");
assert.equal(main.includes("function FolderPicker"), false, "Settings should not use an in-app folder browser when Browse is expected to open the OS picker");
assert.equal(main.includes('aria-label="Browse source folder"'), true, "Source folder settings should expose a native browse action");
assert.equal(main.includes("folder-picker"), false, "In-app folder picker UI should not render for the native Browse action");
assert.equal(main.includes("function OnboardingDialog"), true, "First-run startup should render a dedicated source-folder onboarding dialog");
assert.equal(main.includes("onboardingOpen"), true, "App should track whether source-folder onboarding is active");
assert.match(main, /settingsPayload\.settings\?\.sourceRoot[\s\S]*?setOnboardingOpen/, "Startup should open onboarding when no source folder has been configured");
assert.match(main, /settingsPayload\.settings\?\.selectedExportId/, "Startup should restore the last selected export from persisted settings");
assert.equal(main.includes("window.location.reload"), false, "Refresh should not reload the WebView");
assert.equal(main.includes("rescanExports"), true, "Refresh should call the source folder rescan API");
assert.equal(main.includes('aria-label="Rescan source folder"'), true, "Refresh button should be labeled as a folder rescan");
assert.match(main, /applySourcePayload\(payload,\s*selectedExportId,\s*\{\s*resetContent:\s*false\s*\}\)/, "Successful source-folder rescan should preserve the current reader state instead of behaving like a full app reload");
assert.match(main, /if \(resetContent\) \{[\s\S]*?setSelectedConversationId\(""\)/, "Source-folder changes should still be able to clear stale reader state when the folder actually changes");
assert.equal(main.includes("getCurrentWindow"), true, "App should use the Tauri window API for window-size restore and persistence");
assert.equal(main.includes("PhysicalSize"), true, "App should restore saved window dimensions with Tauri PhysicalSize");
assert.equal(main.includes("setSize(new PhysicalSize"), true, "Startup should apply persisted window size to the desktop window");
assert.equal(main.includes("onResized"), true, "App should listen for window resize events");
assert.match(main, /updatePreferences\(\{\s*windowSize:/, "Window resize events should persist window size through the API");
assert.match(main, /updatePreferences\(\{\s*selectedExportId:/, "Export selection should persist through the API");
assert.equal(main.includes("\n  Menu,"), false, "Menu placeholder icon should not render until a real menu is implemented");
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
assert.equal(main.includes("preventNativeContextMenu"), true, "The app should suppress the native WebView context menu globally");
assert.match(main, /addEventListener\("contextmenu",\s*preventNativeContextMenu,\s*\{\s*capture:\s*true\s*\}\)/, "Native context-menu suppression should run during capture");
assert.match(main, /preventNativeContextMenu[\s\S]*?event\.preventDefault\(\)/, "Native context-menu suppression should prevent the default browser/WebView menu");
assert.equal(main.includes("copyMessageText"), true, "Messages should expose a copy action");
assert.equal(main.includes("copyMessageTextToClipboard"), true, "ChatReader should delegate message copy to the extracted helper");
assert.equal(chatReaderHelpers.includes("navigator?.clipboard"), true, "Message copy helper should target the clipboard API when available");
assert.equal(chatReaderHelpers.includes("writeText(text)"), true, "Message copy helper should pass the full message text to the clipboard API");
assert.equal(main.includes("message-copy-button"), true, "Messages should render a hover copy button");
assert.match(main, /\{isLong && \(\s*<div className="message-actions">[\s\S]*?message-expand-button/, "Only long messages should render an action row for expand controls");
assert.equal(
  /<div className="message-actions">(?:(?!<\/div>)[\s\S])*message-copy-button/.test(main),
  false,
  "Message copy button should not live in the layout-consuming action row"
);
assert.equal(main.includes("MESSAGE_COLLAPSE_LIMIT"), true, "ChatReader should keep a named threshold for long collapsible messages");
assert.equal(main.includes("expandedMessageIds"), true, "ChatReader should track expanded long-message state");
assert.equal(main.includes("isMessageExpanded"), true, "ChatReader should derive per-message expanded state");
assert.equal(main.includes("renderMessagePart"), true, "ChatReader should render structured message parts instead of only plain text");
assert.equal(main.includes("message.parts ??"), true, "ChatReader should use normalized message parts when available");
assert.equal(main.includes("chat-image"), true, "ChatReader should render user-uploaded image parts inline");
assert.equal(main.includes("chat-image-button"), true, "Inline chat images should be clickable controls");
assert.equal(main.includes("onOpenImage"), true, "ChatReader should receive a callback for opening inline images");
assert.equal(main.includes("formatChatTimestamp"), true, "ChatReader should use a timestamp formatter that includes the year");
assert.equal(main.includes("Show full message"), true, "Long messages should expose an explicit expand action");
assert.equal(main.includes("truncate(message.text"), false, "Long chat messages should not be permanently truncated");
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
assert.equal(main.includes('from "./measuredVirtualList.js"'), true, "ChatReader should import the measured virtual list hook from a dedicated module");
assert.equal(measuredVirtualList.includes("export function useMeasuredVirtualList"), true, "Variable-height chat rows should use a measured virtual list");
assert.equal(measuredVirtualList.includes("export function useScrollViewport"), true, "Measured virtual list module should own scroll viewport tracking");
assert.equal(main.includes("function useVirtualGrid"), true, "The image grid should unmount offscreen cards");
assert.equal(main.includes("virtual-spacer"), true, "Virtualized surfaces should preserve scroll geometry with spacer elements");
assert.match(main, /virtualMessages\.items\.map/, "ChatReader should render only the virtual message window");
assert.equal(main.includes("useMeasuredVirtualList(messages"), true, "ChatReader should use measured virtualization for variable-height messages");
assert.equal(main.includes("const virtualMessages = useVirtualList(messages"), false, "ChatReader should not use fixed-height virtualization for messages");
assert.equal(main.includes("ESTIMATED_MESSAGE_ROW_SIZE"), true, "Measured message virtualization should keep an explicit estimated row size");
assert.equal(main.includes("virtualMessages.measureItem"), true, "Rendered messages should attach a stable measurement ref for height tracking");
assert.equal(measuredVirtualList.includes("containerRef: externalContainerRef = null"), true, "Measured virtual list should allow a testable container-ref seam");
assert.equal(measuredVirtualList.includes("disconnectMeasuredNode"), true, "Measured virtual list should explicitly tear down measurement observers");
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
  /\.inspector-preview img\s*\{[\s\S]*?position: absolute;[\s\S]*?inset: 0;[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;[\s\S]*?\}/,
  "Inspector preview images should fit fully inside their frame without overflowing it"
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
assert.match(
  styles,
  /\.message-copy-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?\}/,
  "Message copy button should float without reserving message layout space"
);
assert.match(
  styles,
  /\.message-copy-button\s*\{(?=[\s\S]*?right:\s*-40px;)[\s\S]*?\}/,
  "Message copy button should sit outside the message bubble so it cannot cover content"
);
assert.match(styles, /\.message:hover\s+\.message-copy-button/, "Message copy button should appear on hover");
assert.match(styles, /\.message:focus-within\s+\.message-copy-button/, "Message copy button should remain available on focus");
assert.match(styles, /\.message-actions/, "Long-message expand controls should sit in an action row");
assert.match(styles, /\.message-body\.collapsed/, "Collapsed long messages should have a distinct body state");
assert.match(styles, /\.message-expand-button/, "Long messages should have a styled expand/collapse control");
assert.match(styles, /\.chat-image/, "Inline chat images should have dedicated styling");
assert.match(styles, /\.chat-image-button/, "Clickable inline chat images should reset button chrome");
assert.match(styles, /\.message\.user[\s\S]*justify-items:\s*end/, "User messages should align to the right");
assert.match(styles, /\.message\.user\s+\.message-body[\s\S]*background:/, "User message body should have bubble styling");
assert.match(
  styles,
  /\.message\.user\s+\.message-body\s*\{(?=[\s\S]*?justify-self:\s*end;)(?=[\s\S]*?width:\s*fit-content;)[\s\S]*?\}/,
  "User message bubbles should shrink to content inside the actual user body rule"
);

assert.equal(main.includes("ImageContextMenu"), true, "Image previews should use an app-owned image context menu");
assert.equal(main.includes("imageContextMenu"), true, "ImageLightbox should track image context-menu position");
assert.match(main, /onContextMenu=\{openImageContextMenu\}/, "ImageLightbox should open the image-only context menu on right-click");
assert.match(main, /className="lightbox-backdrop"[\s\S]*?onClick=\{onClose\}/, "ImageLightbox backdrop clicks should close the preview");
assert.match(main, /className="lightbox-shell"[\s\S]*?stopPropagation/, "ImageLightbox shell clicks should not close the preview");
assert.match(main, /className="lightbox-shell"[\s\S]*?style=\{lightboxSizeStyle\(image\)\}/, "ImageLightbox shell should size itself from image dimensions");
assert.match(main, /<dt>Resolution<\/dt>[\s\S]*?formatImageResolution\(image\)/, "Inspector image details should show resolution");
assert.match(main, /<footer className="lightbox-footer">[\s\S]*?formatImageResolution\(image\)/, "ImageLightbox footer should show resolution");
assert.equal(main.includes("Save original image"), true, "Image context menu and inspector should expose original image saving");
assert.equal(main.includes("saveOriginalImage"), true, "UI should call the image save API");
assert.equal(main.includes("onSaveImage"), true, "Inspector and lightbox should receive an image save callback");
assert.match(styles, /\.image-context-menu\s*\{/, "Image context menu should have dedicated popup styling");
assert.match(styles, /\.inspector-actions\s*\{/, "Inspector image actions should have a dedicated layout");
assert.match(
  styles,
  /\.lightbox-shell\s*\{(?=[\s\S]*?--lightbox-width)(?=[\s\S]*?--lightbox-height)(?=[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;)[\s\S]*?\}/,
  "Lightbox shell should use dimension-driven CSS variables"
);
assert.match(styles, /\.lightbox-image\s*\{[\s\S]*?aspect-ratio:\s*var\(--lightbox-aspect/, "Lightbox image frame should preserve the source aspect ratio when dimensions are known");
const lightboxImageRule = extractCssRule(styles, ".lightbox-image");
const lightboxImageElementRule = extractCssRule(styles, ".lightbox-image img");
const lightboxStageRule = extractCssRule(styles, ".lightbox-stage");
assert.equal(/min-height:\s*\d+px/.test(lightboxImageRule), false, "Lightbox image frame should not force a minimum height that can overflow short images");
assert.equal(/border:/.test(lightboxImageRule), false, "Lightbox image frame should not draw an inner rectangle around the image");
assert.equal(/background:/.test(lightboxImageRule), false, "Lightbox image frame should not draw a fake image background");
assert.equal(styles.includes(".lightbox-image::before"), false, "Lightbox image frame should not render a decorative pseudo background");
assert.match(lightboxImageElementRule, /position:\s*absolute;/, "Lightbox image element should fill the clipped lightbox frame for reliable object-fit scaling");
assert.match(lightboxImageElementRule, /inset:\s*0;/, "Lightbox image element should be pinned to the clipped lightbox frame");
assert.match(lightboxImageElementRule, /(?:^|\n)\s*width:\s*100%;/, "Lightbox image element should use the full stage box so object-fit can scale tall images down");
assert.match(lightboxImageElementRule, /(?:^|\n)\s*height:\s*100%;/, "Lightbox image element should use the full stage box so object-fit can scale wide images down");
assert.match(lightboxImageElementRule, /(?:^|\n)\s*max-width:\s*100%;/, "Lightbox image element should be constrained to the stage width");
assert.match(lightboxImageElementRule, /(?:^|\n)\s*max-height:\s*100%;/, "Lightbox image element should be constrained to the stage height");
assert.match(lightboxStageRule, /position:\s*relative;/, "Lightbox stage should anchor navigation controls");
assert.match(lightboxStageRule, /grid-template-columns:\s*minmax\(0,\s*1fr\);/, "Lightbox stage should let the image use the full available width");
assert.match(lightboxStageRule, /overflow:\s*hidden;/, "Lightbox stage should clip the image before it reaches the footer");
assert.match(baseStyles, /(?:^|\n)\.lightbox-footer\s*\{[^}]*min-height:\s*44px;[^}]*position:\s*relative;[^}]*\}/, "Lightbox footer should reserve its own row and paint above the stage boundary");
assert.match(styles, /\.lightbox-step\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?\}/, "Lightbox navigation buttons should overlay the image area instead of reserving side columns");

console.log("ui contract tests passed");
