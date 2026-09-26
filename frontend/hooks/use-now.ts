"use client";

import { useCallback, useSyncExternalStore } from "react";

/* Returns the current time floored to intervalMs, or null before hydration.
   Used for ticket timers so server HTML never disagrees with the client. */
export function useNow(intervalMs = 1000) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const timer = window.setInterval(onStoreChange, intervalMs);
      return () => window.clearInterval(timer);
    },
    [intervalMs],
  );

  const getSnapshot = useCallback(
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    [intervalMs],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
