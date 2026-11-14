import assert from "node:assert/strict";
import React, { useEffect, useMemo, useRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useMeasuredVirtualList } from "../src/measuredVirtualList.js";

class MockResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnectCalls = 0;
    MockResizeObserver.instances.push(this);
  }

  observe(node) {
    this.observed.push(node);
  }

  disconnect() {
    this.disconnectCalls += 1;
  }
}

function patchElementMetrics(node, { height = 0, width = 0 } = {}) {
  Object.defineProperty(node, "clientHeight", {
    configurable: true,
    get: () => height
  });
  Object.defineProperty(node, "clientWidth", {
    configurable: true,
    get: () => width
  });
  node.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height
  });
}

function getLatestSnapshot(snapshots) {
  return snapshots[snapshots.length - 1];
}

async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function HookHarness({ items, resetKey, itemHeights, onSnapshot }) {
  const containerRef = useRef(null);
  const virtual = useMeasuredVirtualList(items, {
    estimatedItemSize: 80,
    overscan: 0,
    resetKey,
    getItemKey: (item) => item.id,
    containerRef
  });

  const itemRefs = useMemo(() => new Map(), []);

  useEffect(() => {
    onSnapshot({
      renderedIds: virtual.items.map(({ item }) => item.id),
      beforeSize: virtual.beforeSize,
      afterSize: virtual.afterSize,
      scrollTop: containerRef.current?.scrollTop ?? 0
    });
  }, [onSnapshot, virtual.afterSize, virtual.beforeSize, virtual.items]);

  return React.createElement(
    "div",
    {
      ref: (node) => {
        containerRef.current = node;
        if (node) patchElementMetrics(node, { height: 120, width: 320 });
      }
    },
    React.createElement("div", { "data-before-size": virtual.beforeSize }),
    virtual.items.map(({ item }) =>
      React.createElement("article", {
        key: item.id,
        "data-row-id": item.id,
        ref: (node) => {
          const bind = virtual.measureItem(item.id);
          if (!node) {
            bind(null);
            itemRefs.delete(item.id);
            return;
          }
          patchElementMetrics(node, { height: itemHeights[item.id] ?? 60, width: 280 });
          bind(node);
          itemRefs.set(item.id, node);
        }
      })
    ),
    React.createElement("div", { "data-after-size": virtual.afterSize })
  );
}

function ConditionalMountHarness({ visible, items, onSnapshot }) {
  const virtual = useMeasuredVirtualList(items, {
    estimatedItemSize: 80,
    overscan: 0,
    getItemKey: (item) => item.id
  });

  useEffect(() => {
    onSnapshot({
      renderedIds: virtual.items.map(({ item }) => item.id),
      beforeSize: virtual.beforeSize,
      afterSize: virtual.afterSize
    });
  }, [onSnapshot, virtual.afterSize, virtual.beforeSize, virtual.items]);

  if (!visible) return null;
  return React.createElement(
    "div",
    {
      ref: (node) => {
        if (node) patchElementMetrics(node, { height: 120, width: 320 });
        virtual.containerRef(node);
      }
    },
    React.createElement("div", { "data-before-size": virtual.beforeSize }),
    virtual.items.map(({ item }) => React.createElement("article", { key: item.id, "data-row-id": item.id })),
    React.createElement("div", { "data-after-size": virtual.afterSize })
  );
}

const previousWindow = globalThis.window;
const previousDocument = globalThis.document;
const previousNavigator = globalThis.navigator;
const previousHTMLElement = globalThis.HTMLElement;
const previousNode = globalThis.Node;
const previousMutationObserver = globalThis.MutationObserver;
const previousResizeObserver = globalThis.ResizeObserver;
const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  pretendToBeVisual: true
});

Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, "Node", { configurable: true, writable: true, value: dom.window.Node });
Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: dom.window.MutationObserver });
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: MockResizeObserver });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: (callback) => setTimeout(() => callback(Date.now()), 0)
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  writable: true,
  value: (handle) => clearTimeout(handle)
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
dom.window.ResizeObserver = MockResizeObserver;

try {
  const host = document.getElementById("root");
  const root = createRoot(host);
  const items = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}` }));
  const itemHeights = Object.fromEntries(items.map((item) => [item.id, 60]));
  const snapshots = [];

  await act(async () => {
    root.render(
      React.createElement(HookHarness, {
        items,
        resetKey: "alpha",
        itemHeights,
        onSnapshot: (snapshot) => snapshots.push(snapshot)
      })
    );
  });
  await flushFrame();

  const scroller = host.firstElementChild;
  assert.ok(scroller, "Mounted harness should render a scroll container");
  assert.deepEqual(getLatestSnapshot(snapshots).renderedIds, ["row-0", "row-1"], "Measured virtual list should mount the top window first");

  scroller.scrollTop = 360;
  await act(async () => {
    scroller.dispatchEvent(new window.Event("scroll"));
  });
  await flushFrame();

  const scrolledSnapshot = getLatestSnapshot(snapshots);
  assert.equal(scrolledSnapshot.renderedIds.includes("row-0"), false, "Far-off rows should unmount after scrolling away");
  assert.equal(scrolledSnapshot.renderedIds.length, 2, "Measured virtual list should keep a tight rendered window after scrolling");
  assert.equal(scrolledSnapshot.renderedIds.includes("row-5"), true, "Measured virtual list should render rows around the scrolled offset");
  const disconnectsBeforeReset = MockResizeObserver.instances.reduce((total, observer) => total + observer.disconnectCalls, 0);

  await act(async () => {
    root.render(
      React.createElement(HookHarness, {
        items,
        resetKey: "beta",
        itemHeights,
        onSnapshot: (snapshot) => snapshots.push(snapshot)
      })
    );
  });
  await flushFrame();

  assert.equal(scroller.scrollTop, 0, "Changing resetKey should reset the scroll container back to the top");
  assert.deepEqual(getLatestSnapshot(snapshots).renderedIds, ["row-0", "row-1"], "Changing resetKey should restore the top window");
  const disconnectsAfterReset = MockResizeObserver.instances.reduce((total, observer) => total + observer.disconnectCalls, 0);
  assert.ok(disconnectsAfterReset > disconnectsBeforeReset, "Changing resetKey should tear down old ResizeObserver bindings");

  await act(async () => {
    root.unmount();
  });

  const totalDisconnects = MockResizeObserver.instances.reduce((total, observer) => total + observer.disconnectCalls, 0);
  assert.ok(totalDisconnects >= MockResizeObserver.instances.length, "Unmount should disconnect every ResizeObserver that was created");

  const conditionalSnapshots = [];
  const conditionalHost = document.createElement("div");
  host.appendChild(conditionalHost);
  const conditionalRoot = createRoot(conditionalHost);

  await act(async () => {
    conditionalRoot.render(
      React.createElement(ConditionalMountHarness, {
        visible: false,
        items,
        onSnapshot: (snapshot) => conditionalSnapshots.push(snapshot)
      })
    );
  });
  await flushFrame();

  await act(async () => {
    conditionalRoot.render(
      React.createElement(ConditionalMountHarness, {
        visible: true,
        items,
        onSnapshot: (snapshot) => conditionalSnapshots.push(snapshot)
      })
    );
  });
  await flushFrame();

  const conditionalScroller = conditionalHost.firstElementChild;
  assert.ok(conditionalScroller, "Conditionally mounted scroller should render when visible");
  conditionalScroller.scrollTop = 360;
  await act(async () => {
    conditionalScroller.dispatchEvent(new window.Event("scroll"));
  });
  await flushFrame();

  const conditionalScrolled = getLatestSnapshot(conditionalSnapshots);
  assert.equal(conditionalScrolled.renderedIds.includes("row-5"), true, "Scrolling after deferred mount should render scrolled rows");
  assert.equal(conditionalScrolled.renderedIds.includes("row-0"), false, "Scrolling after deferred mount should unmount top rows");

  await act(async () => {
    conditionalRoot.unmount();
  });
} finally {
  dom.window.close();
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: previousDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: previousNavigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: previousHTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, writable: true, value: previousNode });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, writable: true, value: previousMutationObserver });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: previousResizeObserver });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: previousRequestAnimationFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: previousCancelAnimationFrame });
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
}

console.log("measured virtual list tests passed");
