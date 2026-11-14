import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Trigger incremental pagination automatically when a sentinel approaches the bottom of a scroll container.
 */
export function useAutoLoadMore({ hasMore, isLoading, onLoadMore, containerRef = null, itemCount = 0 }) {
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

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!sentinelNode || !hasMore) return undefined;

    if (typeof IntersectionObserver === "undefined") {
      if (!isLoading) onLoadMoreRef.current();
      return undefined;
    }

    const rootNode = containerRef?.current instanceof Element ? containerRef.current : null;
    const checkNearBottom = () => {
      if (isLoading || !hasMore || !rootNode || rootNode.clientHeight <= 1) return;
      const remaining = rootNode.scrollHeight - (rootNode.scrollTop + rootNode.clientHeight);
      if (remaining <= 320) {
        onLoadMoreRef.current();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!isLoading && entries.some((entry) => entry.isIntersecting)) {
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
  }, [sentinelNode, hasMore, isLoading, containerRef, itemCount]);

  return sentinelRef;
}
