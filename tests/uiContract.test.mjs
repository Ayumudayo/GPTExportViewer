import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const styles = await readFile("src/styles.css", "utf8");
const main = await readFile("src/main.jsx", "utf8");
const apiClient = await readFile("src/data/apiClient.js", "utf8");

assert.equal(main.includes('aria-label="Settings"'), true, "Settings should be a real, reachable control");
assert.equal(main.includes("function SettingsDialog"), true, "Settings should render a real dialog instead of a placeholder");
assert.equal(main.includes("source-folder-input"), true, "Settings should expose the source folder field");
assert.equal(apiClient.includes("fetchSettings"), true, "Client API should fetch current runtime settings");
assert.equal(apiClient.includes("updateSettings"), true, "Client API should persist source folder updates");
assert.equal(apiClient.includes("pickSourceFolder"), true, "Client API should ask the local app server to open the native folder picker");
assert.equal(apiClient.includes("/api/pick-folder"), true, "Folder selection should use the native picker endpoint");
assert.equal(apiClient.includes("local API server is running an older build"), true, "Missing new API endpoints should explain that the server process must be restarted");
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

console.log("ui contract tests passed");
