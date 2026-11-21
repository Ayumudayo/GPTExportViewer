import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Trigger incremental pagination automatically when a sentinel approaches the bottom of a scroll container.
 */
export function useAutoLoadMore({ hasMore, isLoading, onLoadMore, containerRef = null, itemCount = 0, resetKey = "" }) {
  const [sentinelNode, setSentinelNode] = useState(/** @type {Element | null} */ (null));
  const sentinelRef = useMemo(() => {
    const callbackRef = Object.assign(
      (node) => {
        callbackRef.current = node;
        setSentinelNode((current) => (current === node ? current : node));
      },
      { current: /** @type {Element | null} */ (null) }
    );
    return callbackRef;
  }, []);
  const onLoadMoreRef = useRef(onLoadMore);
  const prevLoadingRef = useRef(false);
  const loadStartCountRef = useRef(-1);
  const stalledCountRef = useRef(-1);
  const prevResetKeyRef = useRef(resetKey);

  if (prevResetKeyRef.current !== resetKey) {
    prevResetKeyRef.current = resetKey;
    prevLoadingRef.current = false;
    loadStartCountRef.current = -1;
    stalledCountRef.current = -1;
  }

  if (isLoading && !prevLoadingRef.current) {
    loadStartCountRef.current = itemCount;
  } else if (!isLoading && prevLoadingRef.current) {
    if (hasMore && itemCount === loadStartCountRef.current) {
      stalledCountRef.current = itemCount;
    } else {
      stalledCountRef.current = -1;
    }
  }
  if (stalledCountRef.current !== -1 && itemCount !== stalledCountRef.current) {
    stalledCountRef.current = -1;
  }
  prevLoadingRef.current = isLoading;

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!sentinelNode || !hasMore) {
      stalledCountRef.current = -1;
      return undefined;
    }

    const isStalled = () => stalledCountRef.current === itemCount;

    if (typeof IntersectionObserver === "undefined") {
      if (!isLoading && !isStalled()) onLoadMoreRef.current();
      return undefined;
    }

    const rootNode = containerRef?.current instanceof Element ? containerRef.current : null;
    const checkNearBottom = () => {
      if (isLoading || isStalled() || !hasMore || !rootNode || rootNode.clientHeight <= 1) return;
      const remaining = rootNode.scrollHeight - (rootNode.scrollTop + rootNode.clientHeight);
      if (remaining <= 320) {
        onLoadMoreRef.current();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!isLoading && !isStalled() && entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { root: rootNode, rootMargin: "320px 0px", threshold: 0 }
    );

    observer.observe(sentinelNode);
    checkNearBottom();
    rootNode?.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => {
      observer.disconnect();
      rootNode?.removeEventListener("scroll", checkNearBottom);
    };
  }, [sentinelNode, hasMore, isLoading, containerRef, itemCount, resetKey]);

  return sentinelRef;
}
