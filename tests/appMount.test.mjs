import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundled = await build({
  stdin: {
    contents: [
      'import React, { act } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { App, AppErrorBoundary } from "./src/main.jsx";',
      "export { React, act, createRoot, App, AppErrorBoundary };"
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "jsx",
    sourcefile: "app-mount-entry.jsx"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  loader: { ".css": "empty" },
  define: {
    "process.env.NODE_ENV": '"test"'
  }
});

const bundleCode = bundled.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundleCode, "utf8").toString("base64")}`;

async function mountAppWithBackend(handler, { intersectionObserver = undefined } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="mount-host"></div></body></html>', {
    url: "http://localhost/"
  });
  const { window } = dom;
  const originalDescriptors = new Map();
  const assignGlobal = (key, value) => {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  };

  let callbackSeq = 0;
  const invokeCalls = [];
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" }
    },
    transformCallback: () => {
      callbackSeq += 1;
      return callbackSeq;
    },
    invoke: async (cmd, args = {}) => {
      invokeCalls.push({ cmd, args });
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "plugin:window|current_monitor") {
        return {
          name: "Primary",
          size: { width: 1920, height: 1080 },
          position: { x: 0, y: 0 },
          workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
          scaleFactor: 1
        };
      }
      if (cmd === "plugin:window|set_size") return null;
      if (cmd === "plugin:window|is_minimized" || cmd === "plugin:window|is_maximized") return false;
      return handler(cmd, args);
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {}
  };

  assignGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  assignGlobal("window", window);
  assignGlobal("document", window.document);
  assignGlobal("Element", window.Element);
  assignGlobal("HTMLElement", window.HTMLElement);
  assignGlobal("Node", window.Node);
  assignGlobal("Event", window.Event);
  assignGlobal("MouseEvent", window.MouseEvent);
  assignGlobal("KeyboardEvent", window.KeyboardEvent);
  assignGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  assignGlobal("navigator", window.navigator);
  assignGlobal("requestAnimationFrame", (cb) => window.setTimeout(cb, 0));
  assignGlobal("cancelAnimationFrame", (id) => window.clearTimeout(id));
  assignGlobal("ResizeObserver", undefined);
  assignGlobal("IntersectionObserver", intersectionObserver);
  if (intersectionObserver) {
    window.IntersectionObserver = intersectionObserver;
  }
  const OriginalMessageChannel = globalThis.MessageChannel;
  const createdChannels = [];
  if (OriginalMessageChannel) {
    assignGlobal(
      "MessageChannel",
      class TrackedMessageChannel extends OriginalMessageChannel {
        constructor() {
          super();
          createdChannels.push(this);
        }
      }
    );
  }

  const pageErrors = [];
  window.addEventListener("error", (event) => pageErrors.push(event.error ?? event.message));

  const mod = await import(`${moduleUrl}#run=${Date.now()}-${Math.random()}`);
  const { React, act, createRoot, App, AppErrorBoundary } = mod;
  const host = window.document.getElementById("mount-host");
  const root = createRoot(host);

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  await act(async () => {
    root.render(React.createElement(AppErrorBoundary, null, React.createElement(App)));
  });
  await flush();

  return {
    dom,
    window,
    host,
    act,
    flush,
    invokeCalls,
    pageErrors,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
      for (const ch of createdChannels) {
        ch.port1?.close?.();
        ch.port2?.close?.();
      }
      for (const [key, desc] of originalDescriptors.entries()) {
        if (!desc) {
          delete globalThis[key];
        } else {
          Object.defineProperty(globalThis, key, desc);
        }
      }
    }
  };
}

// 1. First-run onboarding mount (no configured sourceRoot)
{
  const mounted = await mountAppWithBackend(async (cmd) => {
    if (cmd === "get_settings") {
      return {
        settings: {
          sourceRoot: null,
          cacheDir: "C:\\cache",
          exportCount: 0,
          selectedExportId: null,
          windowSize: null
        }
      };
    }
    if (cmd === "get_exports") {
      return { exports: [] };
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });

  try {
    assert.equal(mounted.pageErrors.length, 0, "First-run mount should not produce uncaught page errors");
    assert.equal(mounted.host.querySelector(".app-crash-fallback"), null, "ErrorBoundary fallback must not appear on mount");
    assert.match(mounted.host.textContent, /GPTExportViewer/, "First-run mount should render app header");
    assert.match(mounted.host.textContent, /Choose source folder/, "First-run mount should open onboarding dialog");
  } finally {
    await mounted.cleanup();
  }
}

// 2. Configured export mount: conversations, Markdown message, Library mode switch, and Reset filters
{
  const exportItem = {
    id: "exp-1",
    name: "chatgpt-export-test",
    modifiedAt: "2026-06-09T10:00:20.000Z",
    warnings: []
  };

  const mounted = await mountAppWithBackend(async (cmd, args) => {
    if (cmd === "get_settings") {
      return {
        settings: {
          sourceRoot: "E:\\Exports",
          cacheDir: "C:\\cache",
          exportCount: 1,
          selectedExportId: "exp-1",
          windowSize: { width: 1280, height: 820 }
        }
      };
    }
    if (cmd === "get_exports") {
      return { exports: [exportItem] };
    }
    if (cmd === "get_stats") {
      return {
        export: exportItem,
        conversations: { totalConversations: 1, totalMessages: 2, totalAttachments: 0, archived: 0, starred: 0, maxMessages: 2 },
        library: { totalImages: 1, linkedImages: 0, libraryOnlyImages: 1, missingFiles: 0 },
        cache: { hit: true, dir: "C:\\cache\\exp-1" }
      };
    }
    if (cmd === "get_conversations") {
      const items = args?.filter === "archived"
        ? []
        : [
            {
              id: "conv-1",
              title: "First test session",
              updatedAt: "2026-06-09T10:00:20.000Z",
              createdAt: "2026-06-09T09:50:00.000Z",
              model: "gpt-4o",
              messageCount: 2,
              attachmentCount: 0,
              archived: false,
              starred: false
            }
          ];
      return {
        export: exportItem,
        items,
        page: { cursor: 0, limit: 80, total: items.length, nextCursor: null },
        stats: { totalConversations: 1, totalMessages: 2 }
      };
    }
    if (cmd === "get_conversation") {
      return {
        id: "conv-1",
        title: "First test session",
        createdAt: "2026-06-09T09:50:00.000Z",
        updatedAt: "2026-06-09T10:00:20.000Z",
        model: "gpt-4o",
        archived: false,
        starred: false,
        totalMessages: 2,
        messages: [
          {
            id: "m1",
            role: "user",
            createdAt: "2026-06-09T10:00:00.000Z",
            text: "Hello viewer",
            parts: [{ partType: "text", text: "Hello viewer" }],
            assetRefs: []
          },
          {
            id: "m2",
            role: "assistant",
            createdAt: "2026-06-09T10:00:20.000Z",
            text: "### Heading\n\n```js\nconst ok = true;\n```",
            parts: [{ partType: "text", text: "### Heading\n\n```js\nconst ok = true;\n```" }],
            assetRefs: []
          }
        ],
        range: { start: 0, limit: 120, total: 2, nextStart: null }
      };
    }
    if (cmd === "get_library") {
      return {
        export: exportItem,
        items: [
          {
            fileId: "file-img-1",
            displayName: "sample.png",
            mime: "image/png",
            sizeLabel: "8 B",
            sourceState: "library-only",
            status: "ready",
            exists: true,
            width: 640,
            height: 480
          }
        ],
        page: { cursor: 0, limit: 120, total: 1, nextCursor: null },
        stats: { totalImages: 1, linkedImages: 0, libraryOnlyImages: 1, missingFiles: 0 }
      };
    }
    return {};
  });

  try {
    assert.equal(mounted.pageErrors.length, 0, "Configured mount should not produce uncaught page errors");
    assert.equal(mounted.host.querySelector(".app-crash-fallback"), null, "Configured mount should render without fallback");
    assert.match(mounted.host.textContent, /First test session/, "Conversation row should render after initial fetch");
    assert.ok(mounted.host.querySelector(".md-heading"), "Markdown heading should render in chat reader");
    assert.ok(mounted.host.querySelector(".code-block"), "Fenced code block should render in chat reader");

    // Trigger empty filter state and click Reset filters (exercises resetFilters -> setChatQuery/setLibraryQuery)
    const archivedBtn = Array.from(mounted.host.querySelectorAll(".chat-filter button")).find(
      (btn) => btn.textContent?.trim() === "Archived"
    );
    assert.ok(archivedBtn, "Archived filter button should render");
    await mounted.act(async () => {
      archivedBtn.click();
    });
    await mounted.flush();

    const resetBtn = Array.from(mounted.host.querySelectorAll(".empty-state button")).find(
      (btn) => btn.textContent?.trim() === "Reset filters"
    );
    assert.ok(resetBtn, "Empty state should render Reset filters button");
    await mounted.act(async () => {
      resetBtn.click();
    });
    await mounted.flush();
    assert.match(mounted.host.textContent, /First test session/, "Reset filters should restore conversations without crashing");

    // Switch to Library mode and click Reset filters there too
    const libraryBtn = Array.from(mounted.host.querySelectorAll(".mode-switcher button")).find((btn) =>
      btn.textContent?.includes("Library")
    );
    assert.ok(libraryBtn, "Library mode button should render");
    await mounted.act(async () => {
      libraryBtn.click();
    });
    await mounted.flush();
    assert.match(mounted.host.textContent, /sample\.png/, "Library view should render image card");

    const thumbImg = mounted.host.querySelector(".image-thumb img");
    assert.ok(thumbImg, "Library card should render thumbnail image");
    assert.ok(
      thumbImg.getAttribute("src")?.endsWith("?thumb=1"),
      `Library thumbnail should request resized thumbUrl, got ${thumbImg.getAttribute("src")}`,
    );

    const themeBtn = mounted.host.querySelector('button[aria-label="Toggle color theme"]');
    assert.ok(themeBtn, "Sidebar should render color theme toggle button");
    assert.equal(mounted.window.document.documentElement.dataset.theme, "dark");
    await mounted.act(async () => {
      themeBtn.click();
    });
    await mounted.flush();
    assert.equal(mounted.window.document.documentElement.dataset.theme, "light");
    await mounted.act(async () => {
      themeBtn.click();
    });
    await mounted.flush();
    assert.equal(mounted.window.document.documentElement.dataset.theme, "dark");
  } finally {
    await mounted.cleanup();
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setInputValue(window, input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  descriptor.set.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

// 3. Loading indicator feedback while sessions & conversation fetches are pending
{
  const exportItem = {
    id: "exp-slow",
    name: "chatgpt-export-slow",
    modifiedAt: "2026-06-09T10:00:20.000Z",
    warnings: []
  };
  const deferredConversations = createDeferred();
  const deferredConversation = createDeferred();

  const mounted = await mountAppWithBackend(async (cmd) => {
    if (cmd === "get_settings") {
      return {
        settings: {
          sourceRoot: "E:\\Exports",
          cacheDir: "C:\\cache",
          exportCount: 1,
          selectedExportId: "exp-slow",
          windowSize: { width: 1280, height: 820 }
        }
      };
    }
    if (cmd === "get_exports") {
      return { exports: [exportItem] };
    }
    if (cmd === "get_stats") {
      return {
        export: exportItem,
        conversations: { totalConversations: 1, totalMessages: 1, totalAttachments: 0, archived: 0, starred: 0, maxMessages: 1 },
        library: { totalImages: 0, linkedImages: 0, libraryOnlyImages: 0, missingFiles: 0 },
        cache: { hit: true, dir: "C:\\cache\\exp-slow" }
      };
    }
    if (cmd === "get_conversations") {
      return deferredConversations.promise;
    }
    if (cmd === "get_conversation") {
      return deferredConversation.promise;
    }
    if (cmd === "get_library") {
      return {
        export: exportItem,
        items: [],
        page: { cursor: 0, limit: 120, total: 0, nextCursor: null },
        stats: { totalImages: 0, linkedImages: 0, libraryOnlyImages: 0, missingFiles: 0 }
      };
    }
    return {};
  });

  try {
    assert.ok(mounted.host.querySelector(".top-loading-bar"), "Top loading bar should appear while session index is loading");
    assert.ok(
      mounted.host.querySelector(".conversation-list .loading-state"),
      "Sidebar should render loading state while sessions are pending"
    );

    deferredConversations.resolve({
      export: exportItem,
      items: [
        {
          id: "conv-slow",
          title: "Deferred session",
          updatedAt: "2026-06-09T10:00:20.000Z",
          createdAt: "2026-06-09T09:50:00.000Z",
          model: "gpt-4o",
          messageCount: 1,
          attachmentCount: 0,
          archived: false,
          starred: false
        }
      ],
      page: { cursor: 0, limit: 80, total: 1, nextCursor: null },
      stats: { totalConversations: 1, totalMessages: 1 }
    });
    await mounted.flush();

    assert.equal(
      mounted.host.querySelector(".conversation-list .loading-state"),
      null,
      "Sidebar loading state should clear after conversations arrive"
    );
    assert.match(mounted.host.textContent, /Deferred session/, "Session list item should appear once loaded");
    assert.ok(
      mounted.host.querySelector(".message-window .loading-state"),
      "Reader should render loading state while selected conversation is pending"
    );
    assert.ok(mounted.host.querySelector(".top-loading-bar"), "Top loading bar should stay active while conversation loads");

    deferredConversation.resolve({
      id: "conv-slow",
      title: "Deferred session",
      createdAt: "2026-06-09T09:50:00.000Z",
      updatedAt: "2026-06-09T10:00:20.000Z",
      model: "gpt-4o",
      archived: false,
      starred: false,
      totalMessages: 1,
      messages: [
        {
          id: "m-slow-1",
          role: "user",
          createdAt: "2026-06-09T10:00:00.000Z",
          text: "Loaded message body",
          parts: [{ partType: "text", text: "Loaded message body" }],
          assetRefs: []
        }
      ],
      range: { start: 0, limit: 120, total: 1, nextStart: null }
    });
    await mounted.flush();

    assert.equal(mounted.host.querySelector(".message-window .loading-state"), null, "Reader loading state should clear after load");
    assert.equal(mounted.host.querySelector(".top-loading-bar"), null, "Top loading bar should clear when all requests finish");
    assert.match(mounted.host.textContent, /Loaded message body/, "Conversation body should render after resolving");
  } finally {
    deferredConversations.resolve({ export: exportItem, items: [], page: { cursor: 0, limit: 80, total: 0, nextCursor: null } });
    deferredConversation.resolve({});
    await mounted.cleanup();
  }
}

// 4. Desktop Details toggle button, Inspector close button, multi-page in-chat search stepping, and Sidebar query sync
{
  const exportItem = {
    id: "exp-search",
    name: "chatgpt-export-search",
    modifiedAt: "2026-06-09T10:00:20.000Z",
    warnings: []
  };
  const longMessageText = `${"Filler prose. ".repeat(110)}tail second needle and third needle`;

  const mounted = await mountAppWithBackend(async (cmd, args) => {
    if (cmd === "get_settings") {
      return {
        settings: {
          sourceRoot: "E:\\Exports",
          cacheDir: "C:\\cache",
          exportCount: 1,
          selectedExportId: "exp-search",
          windowSize: { width: 1280, height: 820 }
        }
      };
    }
    if (cmd === "get_exports") {
      return { exports: [exportItem] };
    }
    if (cmd === "get_stats") {
      return {
        export: exportItem,
        conversations: { totalConversations: 1, totalMessages: 3, totalAttachments: 0, archived: 0, starred: 0, maxMessages: 3 },
        library: { totalImages: 0, linkedImages: 0, libraryOnlyImages: 0, missingFiles: 0 },
        cache: { hit: true, dir: "C:\\cache\\exp-search" }
      };
    }
    if (cmd === "get_conversations") {
      return {
        export: exportItem,
        items: [
          {
            id: "conv-search",
            title: "Search pagination test",
            updatedAt: "2026-06-09T10:00:20.000Z",
            createdAt: "2026-06-09T09:50:00.000Z",
            model: "gpt-4o",
            messageCount: 3,
            attachmentCount: 0,
            archived: false,
            starred: false
          }
        ],
        page: { cursor: 0, limit: 80, total: 1, nextCursor: null },
        stats: { totalConversations: 1, totalMessages: 3 }
      };
    }
    if (cmd === "get_conversation") {
      const start = Number(args?.start ?? 0);
      if (start >= 2) {
        return {
          id: "conv-search",
          title: "Search pagination test",
          createdAt: "2026-06-09T09:50:00.000Z",
          updatedAt: "2026-06-09T10:00:20.000Z",
          model: "gpt-4o",
          archived: false,
          starred: false,
          totalMessages: 3,
          messages: [
            {
              id: "m3",
              role: "assistant",
              createdAt: "2026-06-09T10:00:20.000Z",
              text: "Fourth needle in page two.",
              parts: [{ partType: "text", text: "Fourth needle in page two." }],
              assetRefs: []
            }
          ],
          range: { start: 2, limit: 2, total: 3, nextStart: null }
        };
      }
      return {
        id: "conv-search",
        title: "Search pagination test",
        createdAt: "2026-06-09T09:50:00.000Z",
        updatedAt: "2026-06-09T10:00:20.000Z",
        model: "gpt-4o",
        archived: false,
        starred: false,
        totalMessages: 3,
        messages: [
          {
            id: "m1",
            role: "user",
            createdAt: "2026-06-09T10:00:00.000Z",
            text: "First needle here.",
            parts: [{ partType: "text", text: "First needle here." }],
            assetRefs: []
          },
          {
            id: "m2",
            role: "assistant",
            createdAt: "2026-06-09T10:00:10.000Z",
            text: longMessageText,
            parts: [{ partType: "text", text: longMessageText }],
            assetRefs: []
          }
        ],
        range: { start: 0, limit: 2, total: 3, nextStart: 2 }
      };
    }
    if (cmd === "get_library") {
      return {
        export: exportItem,
        items: [],
        page: { cursor: 0, limit: 120, total: 0, nextCursor: null },
        stats: { totalImages: 0, linkedImages: 0, libraryOnlyImages: 0, missingFiles: 0 }
      };
    }
    return {};
  });

  try {
    assert.equal(mounted.pageErrors.length, 0, "Search/Inspector mount should not raise page errors");

    // 4a. Desktop Details toggle & Close details panel button
    const appShell = mounted.host.querySelector(".app-shell");
    const detailsBtn = mounted.host.querySelector('button[aria-label="Toggle details panel"]');
    assert.ok(appShell, "App shell should render");
    assert.ok(detailsBtn, "Details toggle button should render");
    assert.equal(appShell.classList.contains("inspector-collapsed"), false, "Inspector should start expanded on desktop");
    assert.equal(detailsBtn.getAttribute("aria-expanded"), "true", "Details button should report aria-expanded=true initially");

    await mounted.act(async () => {
      detailsBtn.click();
    });
    await mounted.flush();
    assert.equal(appShell.classList.contains("inspector-collapsed"), true, "Clicking Details should collapse desktop inspector");
    assert.equal(detailsBtn.getAttribute("aria-expanded"), "false", "Details button should report aria-expanded=false when collapsed");

    await mounted.act(async () => {
      detailsBtn.click();
    });
    await mounted.flush();
    assert.equal(appShell.classList.contains("inspector-collapsed"), false, "Clicking Details again should expand desktop inspector");
    assert.equal(detailsBtn.getAttribute("aria-expanded"), "true", "Details button should report aria-expanded=true after reopen");

    const closeDetailsBtn = mounted.host.querySelector('button[aria-label="Close details panel"]');
    assert.ok(closeDetailsBtn, "Inspector header close button should render");
    await mounted.act(async () => {
      closeDetailsBtn.click();
    });
    await mounted.flush();
    assert.equal(appShell.classList.contains("inspector-collapsed"), true, "Inspector close button should collapse details panel");

    // 4b. Open in-chat search, auto-load page 2, expand long match, and step Prev/Next across all 4 matches
    const openFindBtn = mounted.host.querySelector('button[aria-label="Find in conversation"]');
    assert.ok(openFindBtn, "Find button should render");
    await mounted.act(async () => {
      openFindBtn.click();
    });
    await mounted.flush();

    const findInput = mounted.host.querySelector('input[aria-label="Find in conversation query"]');
    assert.ok(findInput, "In-chat search input should open");
    await mounted.act(async () => {
      setInputValue(mounted.window, findInput, "needle");
    });
    await mounted.flush();
    await mounted.flush();

    const countEl = () => mounted.host.querySelector(".in-chat-search-count")?.textContent?.trim();
    const prevBtn = () => mounted.host.querySelector('button[aria-label="Previous match"]');
    const nextBtn = () => mounted.host.querySelector('button[aria-label="Next match"]');

    assert.equal(countEl(), "1 / 4", "Find bar should aggregate occurrences across all pages including tail of long messages");
    assert.equal(mounted.host.querySelectorAll('mark[data-active-match="true"]').length, 1, "Exactly one match mark should be active");

    await mounted.act(async () => {
      nextBtn().click();
    });
    await mounted.flush();
    assert.equal(countEl(), "2 / 4", "Next match button should advance from 1 / 4 to 2 / 4 and keep long match visible");
    assert.equal(mounted.host.querySelectorAll('mark[data-active-match="true"]').length, 1, "Match 2 in expanded long message should have active mark");

    await mounted.act(async () => {
      nextBtn().click();
    });
    await mounted.flush();
    assert.equal(countEl(), "3 / 4", "Next match button should advance within the same message to 3 / 4");

    await mounted.act(async () => {
      nextBtn().click();
    });
    await mounted.flush();
    assert.equal(countEl(), "4 / 4", "Next match button should advance to page 2 match 4 / 4");

    await mounted.act(async () => {
      nextBtn().click();
    });
    await mounted.flush();
    assert.equal(countEl(), "1 / 4", "Next match on last result should wrap to 1 / 4");

    await mounted.act(async () => {
      prevBtn().click();
    });
    await mounted.flush();
    assert.equal(countEl(), "4 / 4", "Previous match on 1 / 4 should wrap to 4 / 4");

    await mounted.act(async () => {
      prevBtn().click();
    });
    await mounted.flush();
    assert.equal(countEl(), "3 / 4", "Previous match on 4 / 4 should step back to 3 / 4");

    // 4c. Sidebar chat search query syncs badge & find bar query
    const closeFindBtn = mounted.host.querySelector('button[aria-label="Close find bar"]');
    assert.ok(closeFindBtn, "Close find bar button should render");
    await mounted.act(async () => {
      closeFindBtn.click();
    });
    await mounted.flush();

    const sidebarSearch = mounted.host.querySelector('.search-field input');
    assert.ok(sidebarSearch, "Sidebar search input should render");
    await mounted.act(async () => {
      setInputValue(mounted.window, sidebarSearch, "needle");
    });
    await mounted.flush();
    await mounted.flush();

    const badgeText = mounted.host.querySelector(".search-count-badge")?.textContent?.trim();
    assert.equal(badgeText, "1", "Sidebar search should show matching session count badge");
    const syncedFindInput = mounted.host.querySelector('input[aria-label="Find in conversation query"]');
    assert.ok(syncedFindInput, "Typing in Sidebar search should sync and open the in-chat find bar");
    assert.equal(syncedFindInput.value, "needle", "In-chat find query should mirror Sidebar search");
    assert.equal(countEl(), "1 / 4", "Synced in-chat find bar should highlight and count all matches");
  } finally {
    await mounted.cleanup();
  }
}

// 5. Switching from Sessions to Library must attach scroll virtualization & paginate multi-page library lists
{
  const exportItem = {
    id: "exp-lib-scroll",
    name: "chatgpt-export-library-scroll",
    modifiedAt: "2026-06-09T10:00:20.000Z",
    warnings: []
  };
  const allImages = Array.from({ length: 160 }, (_, index) => ({
    fileId: `img-${index}`,
    displayName: `img-${index}.png`,
    mime: "image/png",
    sizeLabel: "120 KB",
    sourceState: "library-only",
    status: "ready",
    exists: true,
    width: 512,
    height: 512
  }));
  const getLibraryCalls = [];
  class PassiveIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
    }
    observe(node) {
      this.observed.push(node);
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }

  const mounted = await mountAppWithBackend(
    async (cmd, args) => {
      if (cmd === "get_settings") {
        return {
          settings: {
            sourceRoot: "E:\\Exports",
            cacheDir: "C:\\cache",
            exportCount: 1,
            selectedExportId: "exp-lib-scroll",
            windowSize: { width: 1280, height: 820 }
          }
        };
      }
      if (cmd === "get_exports") {
        return { exports: [exportItem] };
      }
      if (cmd === "get_stats") {
        return {
          export: exportItem,
          conversations: { totalConversations: 1, totalMessages: 1, totalAttachments: 0, archived: 0, starred: 0, maxMessages: 1 },
          library: { totalImages: allImages.length, linkedImages: 0, libraryOnlyImages: allImages.length, missingFiles: 0 },
          cache: { hit: true, dir: "C:\\cache\\exp-lib-scroll" }
        };
      }
      if (cmd === "get_conversations") {
        return {
          export: exportItem,
          items: [
            {
              id: "conv-1",
              title: "Initial chat session",
              updatedAt: "2026-06-09T10:00:20.000Z",
              createdAt: "2026-06-09T09:50:00.000Z",
              model: "gpt-4o",
              messageCount: 1,
              attachmentCount: 0,
              archived: false,
              starred: false
            }
          ],
          page: { cursor: 0, limit: 80, total: 1, nextCursor: null },
          stats: { totalConversations: 1, totalMessages: 1 }
        };
      }
      if (cmd === "get_conversation") {
        return {
          id: "conv-1",
          title: "Initial chat session",
          createdAt: "2026-06-09T09:50:00.000Z",
          updatedAt: "2026-06-09T10:00:20.000Z",
          model: "gpt-4o",
          archived: false,
          starred: false,
          totalMessages: 1,
          messages: [
            {
              id: "m-1",
              role: "user",
              createdAt: "2026-06-09T10:00:00.000Z",
              text: "Hello",
              parts: [{ partType: "text", text: "Hello" }],
              assetRefs: []
            }
          ],
          range: { start: 0, limit: 120, total: 1, nextStart: null }
        };
      }
      if (cmd === "get_library") {
        const cursor = Number(args?.cursor ?? 0) || 0;
        const limit = Number(args?.limit ?? 120) || 120;
        getLibraryCalls.push({ cursor: args?.cursor ?? null, limit });
        const slice = allImages.slice(cursor, cursor + limit);
        const nextOffset = cursor + slice.length;
        return {
          export: exportItem,
          items: slice,
          page: {
            cursor,
            limit,
            total: allImages.length,
            nextCursor: nextOffset < allImages.length ? nextOffset : null
          },
          stats: { totalImages: allImages.length, linkedImages: 0, libraryOnlyImages: allImages.length, missingFiles: 0 }
        };
      }
      return {};
    },
    { intersectionObserver: PassiveIntersectionObserver }
  );

  try {
    assert.ok(mounted.host.querySelector(".conversation-list"), "App should mount in Sessions mode before switching");
    assert.equal(mounted.host.querySelector(".library-side-list"), null, "Library sidebar list should not be mounted initially");

    const libraryBtn = Array.from(mounted.host.querySelectorAll(".mode-switcher button")).find((btn) =>
      btn.textContent?.includes("Library")
    );
    assert.ok(libraryBtn, "Library mode button should render");
    await mounted.act(async () => {
      libraryBtn.click();
    });
    await mounted.flush();

    const sideList = mounted.host.querySelector(".library-side-list");
    assert.ok(sideList, "Switching to Library mode should mount the library side list");
    assert.equal(sideList.textContent.includes("img-0.png"), true, "Initial Library view should render the first item");
    assert.equal(sideList.textContent.includes("img-50.png"), false, "Offscreen item 50 should not mount before scrolling");

    let dynamicScrollHeight = 120 * 68;
    Object.defineProperty(sideList, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(sideList, "clientWidth", { configurable: true, get: () => 340 });
    Object.defineProperty(sideList, "scrollHeight", { configurable: true, get: () => dynamicScrollHeight });

    sideList.scrollTop = 50 * 68;
    await mounted.act(async () => {
      sideList.dispatchEvent(new mounted.window.Event("scroll"));
    });
    await mounted.flush();

    assert.equal(sideList.textContent.includes("img-50.png"), true, "Scrolling Library list after tab switch should render item 50");
    assert.equal(sideList.textContent.includes("img-0.png"), false, "Scrolling Library list should unmount far-above top items");

    sideList.scrollTop = 120 * 68 - 400;
    await mounted.act(async () => {
      sideList.dispatchEvent(new mounted.window.Event("scroll"));
    });
    await mounted.flush();

    assert.equal(
      getLibraryCalls.some((call) => call.cursor === 120),
      true,
      "Scrolling near bottom of page 1 should auto-load page 2 with cursor 120"
    );

    dynamicScrollHeight = 160 * 68;
    sideList.scrollTop = 160 * 68 - 400;
    await mounted.act(async () => {
      sideList.dispatchEvent(new mounted.window.Event("scroll"));
    });
    await mounted.flush();

    assert.equal(sideList.textContent.includes("img-159.png"), true, "Scrolling to bottom of page 2 should render final loaded item");

    const galleryWindow = mounted.host.querySelector(".gallery-window");
    assert.ok(galleryWindow, "Right library gallery window should mount");
    Object.defineProperty(galleryWindow, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(galleryWindow, "clientWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(galleryWindow, "scrollHeight", { configurable: true, get: () => 160 * 284 });
    await mounted.act(async () => {
      mounted.window.dispatchEvent(new mounted.window.Event("resize"));
    });
    await mounted.flush();

    const targetSideRow = Array.from(sideList.querySelectorAll(".image-side-row")).find((btn) =>
      btn.textContent?.includes("img-155.png")
    );
    assert.ok(targetSideRow, "Loaded side list should include img-155.png near the bottom");
    await mounted.act(async () => {
      targetSideRow.click();
    });
    await mounted.flush();

    assert.ok(
      galleryWindow.scrollTop > 0,
      `Clicking an item in the left Library panel should scroll the right gallery to it (got scrollTop=${galleryWindow.scrollTop})`
    );

    galleryWindow.scrollTop = 568;
    await mounted.act(async () => {
      galleryWindow.dispatchEvent(new mounted.window.Event("scroll"));
    });
    await mounted.flush();

    assert.equal(
      galleryWindow.scrollTop,
      568,
      "Scrolling the right gallery after selecting an item from the left panel must not snap back"
    );

    const visibleCard = galleryWindow.querySelector(".image-card");
    const visibleCardName = visibleCard?.querySelector("strong")?.textContent?.trim();
    assert.ok(visibleCard && visibleCardName, "Right gallery should render cards at the scrolled position");
    await mounted.act(async () => {
      visibleCard.click();
    });
    await mounted.flush();

    assert.equal(
      galleryWindow.scrollTop,
      568,
      "Clicking a card in the right gallery must preserve the scrolled position"
    );
    assert.ok(
      sideList.scrollTop < 10480,
      `Clicking a gallery card near the top should scroll the left Library panel back into view (got sideList.scrollTop=${sideList.scrollTop})`
    );
    assert.equal(
      sideList.textContent.includes(visibleCardName),
      true,
      `Left Library panel should render the clicked gallery card (${visibleCardName})`
    );
  } finally {
    await mounted.cleanup();
  }
}

// 6. Multi-session selection bar, Inspector session media, Lightbox cross-page navigation, and Open source session sync
{
  const exportItem = {
    id: "exp-sync-ux",
    name: "chatgpt-export-sync-ux",
    modifiedAt: "2026-06-09T10:00:20.000Z",
    warnings: []
  };
  const allImages = Array.from({ length: 160 }, (_, index) => ({
    fileId: `img-${index}`,
    displayName: `img-${index}.png`,
    mime: "image/png",
    sizeLabel: "120 KB",
    sourceState: index === 119 ? "linked" : "library-only",
    inChat: index === 119,
    sourceConversationId: index === 119 ? "conv-offpage" : null,
    sourceConversationTitle: index === 119 ? "Off-page linked session" : null,
    status: "ready",
    exists: true,
    width: 640,
    height: 480
  }));

  class PassiveIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
    }
    observe(node) {
      this.observed.push(node);
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }

  const mounted = await mountAppWithBackend(
    async (cmd, args) => {
      if (cmd === "get_settings") {
        return {
          settings: {
            sourceRoot: "E:\\Exports",
            cacheDir: "C:\\cache",
            exportCount: 1,
            selectedExportId: "exp-sync-ux",
            windowSize: { width: 1280, height: 820 }
          }
        };
      }
      if (cmd === "get_exports") {
        return { exports: [exportItem] };
      }
      if (cmd === "get_stats") {
        return {
          export: exportItem,
          conversations: { totalConversations: 3, totalMessages: 3, totalAttachments: 1, archived: 0, starred: 0, maxMessages: 2 },
          library: { totalImages: allImages.length, linkedImages: 1, libraryOnlyImages: allImages.length - 1, missingFiles: 0 },
          cache: { hit: true, dir: "C:\\cache\\exp-sync-ux" }
        };
      }
      if (cmd === "get_conversations") {
        return {
          export: exportItem,
          items: [
            {
              id: "conv-1",
              title: "First session",
              updatedAt: "2026-06-09T10:00:20.000Z",
              createdAt: "2026-06-09T09:50:00.000Z",
              model: "gpt-4o",
              messageCount: 1,
              attachmentCount: 2,
              archived: false,
              starred: false
            },
            {
              id: "conv-2",
              title: "Second session",
              updatedAt: "2026-06-09T09:40:00.000Z",
              createdAt: "2026-06-09T09:30:00.000Z",
              model: "gpt-4o",
              messageCount: 1,
              attachmentCount: 0,
              archived: false,
              starred: false
            }
          ],
          page: { cursor: 0, limit: 80, total: 3, nextCursor: null },
          stats: { totalConversations: 3, totalMessages: 3 }
        };
      }
      if (cmd === "get_conversation") {
        if (args?.conversationId === "conv-offpage") {
          const start = Number(args?.start ?? 0) || 0;
          if (start >= 1) {
            return {
              id: "conv-offpage",
              title: "Off-page linked session",
              createdAt: "2026-06-01T10:00:00.000Z",
              updatedAt: "2026-06-01T10:05:00.000Z",
              model: "gpt-4o",
              archived: false,
              starred: false,
              totalMessages: 2,
              messages: [
                {
                  id: "m-off-2",
                  role: "assistant",
                  createdAt: "2026-06-01T10:05:00.000Z",
                  text: "Second page linked image message",
                  parts: [
                    { partType: "text", text: "Second page linked image message" },
                    { partType: "image", fileId: "img-119", name: "img-119.png", mimeType: "image/png", width: 800, height: 600 }
                  ],
                  assetRefs: []
                }
              ],
              range: { start: 1, limit: 1, total: 2, nextStart: null }
            };
          }
          return {
            id: "conv-offpage",
            title: "Off-page linked session",
            createdAt: "2026-06-01T10:00:00.000Z",
            updatedAt: "2026-06-01T10:05:00.000Z",
            model: "gpt-4o",
            archived: false,
            starred: false,
            totalMessages: 2,
            messages: [
              {
                id: "m-off-1",
                role: "user",
                createdAt: "2026-06-01T10:00:00.000Z",
                text: "Linked off-page message",
                parts: [{ partType: "text", text: "Linked off-page message" }],
                assetRefs: []
              }
            ],
            range: { start: 0, limit: 1, total: 2, nextStart: 1 }
          };
        }
        return {
          id: args?.conversationId ?? "conv-1",
          title: args?.conversationId === "conv-2" ? "Second session" : "First session",
          createdAt: "2026-06-09T09:50:00.000Z",
          updatedAt: "2026-06-09T10:00:20.000Z",
          model: "gpt-4o",
          archived: false,
          starred: false,
          totalMessages: 1,
          messages: [
            {
              id: "m-1",
              role: "user",
              createdAt: "2026-06-09T10:00:00.000Z",
              text: "Session media message",
              parts: [
                { partType: "text", text: "Session media message" },
                { partType: "image", fileId: "img-0", name: "sample-inline.png", mimeType: "image/png", width: 640, height: 480 },
                { partType: "file", fileId: "file-notes-1", name: "notes.txt", mimeType: "text/plain" }
              ],
              assetRefs: []
            }
          ],
          range: { start: 0, limit: 120, total: 1, nextStart: null }
        };
      }
      if (cmd === "get_library") {
        const cursor = Number(args?.cursor ?? 0) || 0;
        const limit = Number(args?.limit ?? 120) || 120;
        const slice = allImages.slice(cursor, cursor + limit);
        const nextOffset = cursor + slice.length;
        return {
          export: exportItem,
          items: slice,
          page: {
            cursor,
            limit,
            total: allImages.length,
            nextCursor: nextOffset < allImages.length ? nextOffset : null
          },
          stats: { totalImages: allImages.length, linkedImages: 1, libraryOnlyImages: allImages.length - 1, missingFiles: 0 }
        };
      }
      return {};
    },
    { intersectionObserver: PassiveIntersectionObserver }
  );

  try {
    assert.equal(mounted.pageErrors.length, 0, "Sync/UX mount should not produce uncaught errors");

    // 6a. Warnings hidden when empty; Session media and Attached files are separated and jump to message
    assert.equal(mounted.host.querySelector(".utility-panel.warning"), null, "Warnings panel should be hidden when there are 0 warnings");
    const panels = Array.from(mounted.host.querySelectorAll(".inspector .utility-panel"));
    const mediaPanel = panels.find((panel) => panel.querySelector("header")?.textContent?.includes("Session media"));
    const filesPanel = panels.find((panel) => panel.querySelector("header")?.textContent?.includes("Attached files"));
    assert.ok(mediaPanel, "Inspector should render a dedicated Session media panel");
    assert.ok(filesPanel, "Inspector should render a dedicated Attached files panel");
    assert.equal(mediaPanel.textContent?.includes("notes.txt"), false, "Session media panel should not mix in non-image attached files");
    assert.equal(filesPanel.querySelectorAll(".inspector-file-item").length, 1, "Attached files panel should list notes.txt as a file item");

    const mediaThumbBtn = Array.from(mediaPanel.querySelectorAll(".inspector-media-item")).find((btn) =>
      btn.textContent?.includes("sample-inline.png")
    );
    assert.ok(mediaThumbBtn, "Inspector should show Session media image item for active chat");
    await mounted.act(async () => {
      mediaThumbBtn.click();
    });
    await mounted.flush();
    assert.equal(mounted.host.querySelector(".lightbox-backdrop"), null, "Clicking Session media item should jump to message instead of opening Lightbox");
    assert.ok(
      mounted.host.querySelector('.message-window [data-message-id="m-1"].jump-highlight'),
      "Clicking Session media item should highlight its source message in ChatReader"
    );
    assert.ok(
      mounted.host.querySelector('.message-window [data-file-id="img-0"].jump-highlight-target'),
      "Clicking Session media item should highlight the exact image target in ChatReader"
    );

    const fileItemBtn = Array.from(filesPanel.querySelectorAll(".inspector-file-item")).find((btn) =>
      btn.textContent?.includes("notes.txt")
    );
    assert.ok(fileItemBtn, "Inspector should show Attached file item notes.txt");
    await mounted.act(async () => {
      fileItemBtn.click();
    });
    await mounted.flush();
    assert.ok(
      mounted.host.querySelector('.message-window [data-file-id="file-notes-1"].jump-highlight-target'),
      "Clicking Attached file item should jump to and highlight notes.txt in ChatReader"
    );

    const previewMediaBtn = mediaPanel.querySelector('button[aria-label="Preview sample-inline.png"]');
    assert.ok(previewMediaBtn, "Session media row should retain a secondary preview button for Lightbox");
    await mounted.act(async () => {
      previewMediaBtn.click();
    });
    await mounted.flush();
    assert.ok(mounted.host.querySelector(".lightbox-backdrop"), "Clicking Session media preview icon should open Lightbox");
    const closePreviewBtn = mounted.host.querySelector('button[aria-label="Close preview"]');
    assert.ok(closePreviewBtn, "Close preview button should render");
    await mounted.act(async () => {
      closePreviewBtn.click();
    });
    await mounted.flush();

    // 6b. Multi-session selection action bar
    const rows = Array.from(mounted.host.querySelectorAll(".conversation-row"));
    assert.equal(rows.length, 2, "Both initial sessions should render");
    await mounted.act(async () => {
      rows[1].dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    await mounted.flush();

    const actionBar = mounted.host.querySelector(".selection-action-bar");
    assert.ok(actionBar, "Ctrl-clicking session rows should show sidebar selection action bar");
    assert.match(actionBar.textContent ?? "", /2 selected/, "Selection action bar should display selected session count");

    const clearSelBtn = actionBar.querySelector('button[aria-label="Clear session selection"]');
    assert.ok(clearSelBtn, "Selection action bar should include Clear button");
    await mounted.act(async () => {
      clearSelBtn.click();
    });
    await mounted.flush();
    assert.equal(mounted.host.querySelector(".selection-action-bar"), null, "Clear button should dismiss selection action bar");

    // 6c. Library Lightbox total count (120 / 160), cross-page Next (121 / 160), and Open source session sync
    const libraryBtn = Array.from(mounted.host.querySelectorAll(".mode-switcher button")).find((btn) =>
      btn.textContent?.includes("Library")
    );
    await mounted.act(async () => {
      libraryBtn.click();
    });
    await mounted.flush();

    const sideList = mounted.host.querySelector(".library-side-list");
    assert.ok(sideList, "Library side list should mount");
    Object.defineProperty(sideList, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(sideList, "clientWidth", { configurable: true, get: () => 340 });
    Object.defineProperty(sideList, "scrollHeight", { configurable: true, get: () => 120 * 68 });
    sideList.scrollTop = 7100;
    await mounted.act(async () => {
      sideList.dispatchEvent(new mounted.window.Event("scroll"));
    });
    await mounted.flush();

    const row119 = Array.from(sideList.querySelectorAll(".image-side-row")).find((btn) =>
      btn.textContent?.includes("img-119.png")
    );
    assert.ok(row119, "Library side list should render page-1 boundary item img-119.png");
    await mounted.act(async () => {
      row119.click();
    });
    await mounted.flush();

    const openSelectedBtn = mounted.host.querySelector('button[aria-label="Open selected image"]');
    assert.ok(openSelectedBtn, "Open selected image button should render");
    await mounted.act(async () => {
      openSelectedBtn.click();
    });
    await mounted.flush();

    const lightboxCounter = () => mounted.host.querySelector(".lightbox-header span")?.textContent?.trim();
    assert.equal(lightboxCounter(), "120 / 160", "Lightbox should display total filtered library count across pages");

    const nextImgBtn = mounted.host.querySelector('button[aria-label="Next image"]');
    await mounted.act(async () => {
      nextImgBtn.click();
    });
    await mounted.flush();
    assert.equal(lightboxCounter(), "121 / 160", "Next image on page boundary should load page 2 and advance to 121 / 160");
    assert.equal(mounted.host.querySelector(".lightbox-header strong")?.textContent?.trim(), "img-120.png", "Next image should advance to img-120.png");

    const prevImgBtn = mounted.host.querySelector('button[aria-label="Previous image"]');
    await mounted.act(async () => {
      prevImgBtn.click();
    });
    await mounted.flush();
    assert.equal(lightboxCounter(), "120 / 160", "Previous image should return to linked img-119.png");

    const closeBtn2 = mounted.host.querySelector('button[aria-label="Close preview"]');
    await mounted.act(async () => {
      closeBtn2.click();
    });
    await mounted.flush();

    // Right-click a linked Library item to verify ImageContextMenu -> "Go to message in chat"
    const row119Updated = Array.from(sideList.querySelectorAll(".image-side-row")).find((btn) =>
      btn.textContent?.includes("img-119.png")
    );
    assert.ok(row119Updated, "Linked img-119.png row should remain rendered in Library sidebar");
    await mounted.act(async () => {
      row119Updated.dispatchEvent(
        new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 160, clientY: 220 })
      );
    });
    await mounted.flush();

    const libCtxMenu = mounted.host.querySelector(".image-context-menu");
    assert.ok(libCtxMenu, "Right-clicking a Library image should open the image context menu");
    const goToChatBtn = Array.from(libCtxMenu.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Go to message in chat")
    );
    assert.ok(goToChatBtn, "Linked Library image context menu should expose Go to message in chat");
    assert.match(libCtxMenu.textContent ?? "", /Save original image/, "Library image context menu should keep Save original image");

    await mounted.act(async () => {
      goToChatBtn.click();
    });
    await mounted.flush();
    await mounted.flush();

    const activeRow = mounted.host.querySelector('.conversation-row[aria-current="true"]');
    assert.ok(activeRow, "Jumping from linked Library image should render an active session row in Sidebar");
    assert.match(activeRow.textContent ?? "", /Off-page linked session/, "Off-page source session should be surfaced and highlighted in Sidebar");
    const readerText = mounted.host.querySelector(".message-window")?.textContent ?? "";
    assert.match(readerText, /Second page linked image message/, "Jump target should auto-load later message pages until the linked image message appears");
    assert.ok(
      mounted.host.querySelector('.message-window [data-message-id="m-off-2"].jump-highlight'),
      "Auto-loaded target message should be highlighted after jumping from Library context menu"
    );
    assert.ok(
      mounted.host.querySelector('.message-window [data-file-id="img-119"].jump-highlight-target'),
      "Linked image element inside target message should be highlighted"
    );
  } finally {
    await mounted.cleanup();
  }
}

console.log("app mount tests passed");
