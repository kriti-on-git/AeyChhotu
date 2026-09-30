"use client";

import { useSyncExternalStore } from "react";
import { getBills, subscribeBills, type BillMap } from "@/lib/api/bill";

/* Shared view of every table's bill state.

   This is an external store, so it reads through useSyncExternalStore rather
   than a useState/effect pair: the browser copy is authoritative and arrives
   before the first paint, the server renders EMPTY (a stable constant, so the
   snapshot never flickers), and every later request or settle is a store
   emit that React subscribes to on its own. */
const EMPTY: BillMap = {};

export function useBills(): BillMap {
  return useSyncExternalStore(subscribeBills, getBills, () => EMPTY);
}
