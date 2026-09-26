"use client";

import { useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "@/lib/api/store";

/* PUSH subscription to the shared operational state — the client-side
   stand-in for Supabase Realtime channels. */
export function useDb() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
