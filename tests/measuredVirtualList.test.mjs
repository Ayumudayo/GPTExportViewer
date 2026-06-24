import assert from "node:assert/strict";
import React, { useEffect, useRef } from "react";
import { useMeasuredVirtualList } from "../src/measuredVirtualList.js";

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
console.error = (...args) => {
  if (String(args[0] ?? "").includes("react-test-renderer is deprecated")) return;
  originalConsoleError(...args);
};
console.warn = (...args) => {
  if (String(args[0] ?? "").includes("react-test-renderer is deprecated")) return;
  originalConsoleWarn(...args);
};
process.stdout.write = ((chunk, encoding, callback) => {
  if (String(chunk ?? "").includes("react-test-renderer is deprecated")) return true;
  return originalStdoutWrite(chunk, encoding, callback);
});
process.stderr.write = ((chunk, encoding, callback) => {
  if (String(chunk ?? "").includes("react-test-renderer is deprecated")) return true;
  return originalStderrWrite(chunk, encoding, callback);
});
const { default: TestRenderer, act } = await import("react-test-renderer");
console.error = originalConsoleError;
console.warn = originalConsoleWarn;
process.stdout.write = originalStdoutWrite;
process.stderr.write = originalStderrWrite;

function createWindowMock() {
  const listeners = new Map();
  const addCounts = new Map();
  const removeCounts = new Map();

  return {
    setTimeout,
    clearTimeout,
    addEventListener(type, handler) {
      listeners.set(type, handler);
      addCounts.set(type, (addCounts.get(type) ?? 0) + 1);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
      removeCounts.set(type, (removeCounts.get(type) ?? 0) + 1);
    },
    getListener(type) {
      return listeners.get(type);
    },
    getAddCount(type) {
      return addCounts.get(type) ?? 0;
    },
    getRemoveCount(type) {
      return removeCounts.get(type) ?? 0;
    }
  };
}

function createContainerNode({ scrollTop = 0, clientHeight = 120, clientWidth = 320 } = {}) {
  const listeners = new Map();
  const addCounts = new Map();
  const removeCounts = new Map();

  return {
    kind: "container",
    scrollTop,
    clientHeight,
    clientWidth,
    addEventListener(type, handler) {
      listeners.set(type, handler);
      addCounts.set(type, (addCounts.get(type) ?? 0) + 1);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
      removeCounts.set(type, (removeCounts.get(type) ?? 0) + 1);
    },
    dispatch(type) {
      listeners.get(type)?.({ type });
    },
    getAddCount(type) {
      return addCounts.get(type) ?? 0;
    },
    getRemoveCount(type) {
      return removeCounts.get(type) ?? 0;
    },
    getBoundingClientRect() {
      return { height: this.clientHeight, width: this.clientWidth };
    }
  };
}

function createItemNode(id, height) {
  return {
    kind: "item",
    id,
    getBoundingClientRect() {
      return { height, width: 280 };
    }
  };
}

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

function getLatestSnapshot(snapshots) {
  return snapshots[snapshots.length - 1];
}

function HookHarness({ items, resetKey, containerNode, itemHeights, onSnapshot }) {
  const containerRef = useRef(containerNode);
  const bindingsRef = useRef(new Map());
  const virtual = useMeasuredVirtualList(items, {
    estimatedItemSize: 80,
    overscan: 0,
    resetKey,
    getItemKey: (item) => item.id,
    containerRef
  });

  useEffect(() => {
    const activeIds = new Set();
    for (const { item } of virtual.items) {
      activeIds.add(item.id);
      if (!bindingsRef.current.has(item.id)) {
        const bind = virtual.measureItem(item.id);
        bind(createItemNode(item.id, itemHeights[item.id] ?? 60));
        bindingsRef.current.set(item.id, bind);
      }
    }

    for (const [id, bind] of bindingsRef.current) {
      if (!activeIds.has(id)) {
        bind(null);
        bindingsRef.current.delete(id);
      }
    }

    onSnapshot({
      renderedIds: virtual.items.map(({ item }) => item.id),
      beforeSize: virtual.beforeSize,
      afterSize: virtual.afterSize,
      scrollTop: containerNode.scrollTop
    });
  }, [containerNode, itemHeights, onSnapshot, virtual]);

  useEffect(
    () => () => {
      for (const bind of bindingsRef.current.values()) bind(null);
      bindingsRef.current.clear();
    },
    []
  );

  return React.createElement(
    "output",
    {
      renderedIds: virtual.items.map(({ item }) => item.id).join(","),
      beforeSize: virtual.beforeSize,
      afterSize: virtual.afterSize
    },
    virtual.items.map(({ item }) => item.id).join(",")
  );
}

const previousWindow = globalThis.window;
const previousResizeObserver = globalThis.ResizeObserver;
const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
const windowMock = createWindowMock();
let frameId = 0;

globalThis.window = windowMock;
globalThis.ResizeObserver = MockResizeObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => {
  frameId += 1;
  callback();
  return frameId;
};
globalThis.cancelAnimationFrame = () => {};

try {
  const items = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}` }));
  const itemHeights = Object.fromEntries(items.map((item) => [item.id, 60]));
  const containerNode = createContainerNode();
  const snapshots = [];
  let renderer;

  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(HookHarness, {
        items,
        resetKey: "alpha",
        containerNode,
        itemHeights,
        onSnapshot: (snapshot) => snapshots.push(snapshot)
      })
    );
  });

  assert.deepEqual(getLatestSnapshot(snapshots).renderedIds, ["row-0", "row-1"], "Measured virtual list should mount the top window first");
  assert.equal(containerNode.getAddCount("scroll"), 1, "Measured virtual list should subscribe to scroll events on mount");
  assert.equal(windowMock.getAddCount("resize"), 1, "Measured virtual list should subscribe to window resize events on mount");

  containerNode.scrollTop = 360;
  await act(async () => {
    containerNode.dispatch("scroll");
  });

  assert.equal(getLatestSnapshot(snapshots).renderedIds.includes("row-0"), false, "Far-off rows should unmount after scrolling away");
  assert.equal(getLatestSnapshot(snapshots).renderedIds.length, 2, "Measured virtual list should keep a tight rendered window after scrolling");
  assert.equal(getLatestSnapshot(snapshots).renderedIds.includes("row-5"), true, "Measured virtual list should render rows around the scrolled offset");
  const disconnectsBeforeReset = MockResizeObserver.instances.reduce((total, observer) => total + observer.disconnectCalls, 0);

  await act(async () => {
    renderer.update(
      React.createElement(HookHarness, {
        items,
        resetKey: "beta",
        containerNode,
        itemHeights,
        onSnapshot: (snapshot) => snapshots.push(snapshot)
      })
    );
  });

  assert.equal(containerNode.scrollTop, 0, "Changing resetKey should reset the scroll container back to the top");
  assert.deepEqual(getLatestSnapshot(snapshots).renderedIds, ["row-0", "row-1"], "Changing resetKey should restore the top window");
  const disconnectsAfterReset = MockResizeObserver.instances.reduce((total, observer) => total + observer.disconnectCalls, 0);
  assert.ok(disconnectsAfterReset > disconnectsBeforeReset, "Changing resetKey should tear down old ResizeObserver bindings");

  await act(async () => {
    renderer.unmount();
  });

  const totalDisconnects = MockResizeObserver.instances.reduce((total, observer) => total + observer.disconnectCalls, 0);
  assert.ok(totalDisconnects >= MockResizeObserver.instances.length, "Unmount should disconnect every ResizeObserver that was created");
  assert.equal(containerNode.getRemoveCount("scroll"), 1, "Unmount should remove the scroll listener");
  assert.equal(windowMock.getRemoveCount("resize"), 1, "Unmount should remove the window resize listener");
} finally {
  globalThis.window = previousWindow;
  globalThis.ResizeObserver = previousResizeObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
}

console.log("measured virtual list tests passed");
