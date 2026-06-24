import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeMeasuredVirtualRange } from "./chatReaderHelpers.js";

export function useScrollViewport(resetKey, externalContainerRef = null) {
  const ownedContainerRef = useRef(null);
  const containerRef = externalContainerRef ?? ownedContainerRef;
  const [viewport, setViewport] = useState({ scrollOffset: 0, viewportSize: 1, width: 1 });

  const updateViewport = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    const nextViewport = {
      scrollOffset: node.scrollTop,
      viewportSize: node.clientHeight || 1,
      width: node.clientWidth || 1
    };
    setViewport((current) =>
      current.scrollOffset === nextViewport.scrollOffset &&
      current.viewportSize === nextViewport.viewportSize &&
      current.width === nextViewport.width
        ? current
        : nextViewport
    );
  }, [containerRef]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      const run = () => {
        frame = 0;
        updateViewport();
      };
      frame =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(run)
          : (globalThis.window ?? globalThis).setTimeout(run, 0);
    };
    const ResizeObserverImpl = globalThis.ResizeObserver;
    const resizeObserver = typeof ResizeObserverImpl === "function" ? new ResizeObserverImpl(scheduleUpdate) : null;

    updateViewport();
    node.addEventListener("scroll", scheduleUpdate, { passive: true });
    resizeObserver?.observe(node);
    globalThis.window?.addEventListener("resize", scheduleUpdate);

    return () => {
      node.removeEventListener("scroll", scheduleUpdate);
      resizeObserver?.disconnect();
      globalThis.window?.removeEventListener("resize", scheduleUpdate);
      if (frame) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
        else (globalThis.window ?? globalThis).clearTimeout(frame);
      }
    };
  }, [containerRef, updateViewport]);

  useEffect(() => {
    const node = containerRef.current;
    if (node) node.scrollTop = 0;
    updateViewport();
  }, [containerRef, resetKey, updateViewport]);

  return { containerRef, viewport };
}

export function useMeasuredVirtualList(
  items,
  { estimatedItemSize, overscan = 8, resetKey = "", getItemKey = (_, index) => index, containerRef: externalContainerRef = null }
) {
  const { containerRef, viewport } = useScrollViewport(resetKey, externalContainerRef);
  const [measuredHeights, setMeasuredHeights] = useState({});
  const measuredHeightsRef = useRef({});
  const observerEntriesRef = useRef(new Map());
  const itemRefCallbacksRef = useRef(new Map());
  const frameRef = useRef(0);

  const syncMeasuredHeights = useCallback(() => {
    if (frameRef.current) return;
    const host = globalThis.window ?? globalThis;
    const schedule =
      typeof host.requestAnimationFrame === "function" ? host.requestAnimationFrame.bind(host) : (callback) => host.setTimeout(callback, 0);

    frameRef.current = schedule(() => {
      frameRef.current = 0;
      const nextHeights = measuredHeightsRef.current;
      setMeasuredHeights((current) => {
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(nextHeights);
        if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === nextHeights[key])) {
          return current;
        }
        return nextHeights;
      });
    });
  }, []);

  const disconnectMeasuredNode = useCallback((key) => {
    const entry = observerEntriesRef.current.get(key);
    if (!entry) return;
    entry.observer?.disconnect();
    observerEntriesRef.current.delete(key);
  }, []);

  const rememberMeasuredHeight = useCallback(
    (key, height) => {
      const nextHeight = Math.max(1, Math.ceil(Number(height) || 0));
      if (!Number.isFinite(nextHeight) || measuredHeightsRef.current[key] === nextHeight) return;
      measuredHeightsRef.current = { ...measuredHeightsRef.current, [key]: nextHeight };
      syncMeasuredHeights();
    },
    [syncMeasuredHeights]
  );

  const bindMeasuredNode = useCallback(
    (key, node) => {
      const currentEntry = observerEntriesRef.current.get(key);
      if (currentEntry?.node === node) return;
      disconnectMeasuredNode(key);
      if (!node) return;

      const ResizeObserverImpl = globalThis.ResizeObserver;
      const measureNode = () => rememberMeasuredHeight(key, node.getBoundingClientRect().height);
      let observer = null;
      if (typeof ResizeObserverImpl === "function") {
        observer = new ResizeObserverImpl((entries) => {
          const nextHeight = entries[0]?.contentRect?.height ?? node.getBoundingClientRect().height;
          rememberMeasuredHeight(key, nextHeight);
        });
        observer.observe(node);
      }

      observerEntriesRef.current.set(key, { node, observer });
      measureNode();
    },
    [disconnectMeasuredNode, rememberMeasuredHeight]
  );

  const measureItem = useCallback(
    (key) => {
      if (!itemRefCallbacksRef.current.has(key)) {
        itemRefCallbacksRef.current.set(key, (node) => bindMeasuredNode(key, node));
      }
      return itemRefCallbacksRef.current.get(key);
    },
    [bindMeasuredNode]
  );

  useEffect(() => {
    for (const key of observerEntriesRef.current.keys()) disconnectMeasuredNode(key);
    itemRefCallbacksRef.current.clear();
    measuredHeightsRef.current = {};
    setMeasuredHeights({});
  }, [disconnectMeasuredNode, resetKey]);

  useEffect(
    () => () => {
      for (const key of observerEntriesRef.current.keys()) disconnectMeasuredNode(key);
      if (frameRef.current) {
        if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(frameRef.current);
        else (globalThis.window ?? globalThis).clearTimeout(frameRef.current);
      }
    },
    [disconnectMeasuredNode]
  );

  const itemKeys = useMemo(() => items.map((item, index) => String(getItemKey(item, index))), [getItemKey, items]);
  const range = useMemo(
    () =>
      computeMeasuredVirtualRange({
        itemKeys,
        measuredHeights,
        estimatedItemSize,
        scrollOffset: viewport.scrollOffset,
        viewportSize: viewport.viewportSize,
        overscan
      }),
    [estimatedItemSize, itemKeys, measuredHeights, overscan, viewport.scrollOffset, viewport.viewportSize]
  );

  return {
    containerRef,
    beforeSize: range.beforeSize,
    afterSize: range.afterSize,
    items: items.slice(range.startIndex, range.endIndex).map((item, offset) => ({ item, index: range.startIndex + offset })),
    measureItem
  };
}
