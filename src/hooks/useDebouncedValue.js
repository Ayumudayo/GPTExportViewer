import { useEffect, useState } from "react";

/**
 * Delay propagating non-empty search input updates by `delayMs` while clearing immediately.
 */
export function useDebouncedValue(value, delayMs = 200) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === "") {
      setDebounced("");
      return undefined;
    }
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
