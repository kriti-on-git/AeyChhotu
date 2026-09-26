"use client";

import { useSyncExternalStore } from "react";
import { KitchenPinWall } from "@/components/staff/kitchen-pin-wall";
import { KdsBoard } from "@/components/staff/kds-board";
import { LoadingState } from "@/components/ui/loading-state";

const UNLOCKED_KEY = "aeychhotu.kds.unlocked";

type Gate = "checking" | "locked" | "ready";

/* Unlocking writes to sessionStorage, which emits no storage event we can
   listen to, so the board keeps its own tiny listener set to push the new
   value through useSyncExternalStore. The server snapshot stays "checking"
   so hydration never mismatches. */
const listeners = new Set<() => void>();

function subscribeSession(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function readGate(): Exclude<Gate, "checking"> {
  try {
    return window.sessionStorage.getItem(UNLOCKED_KEY) === "1" ? "ready" : "locked";
  } catch {
    return "locked";
  }
}

function writeGate(unlocked: boolean) {
  try {
    if (unlocked) window.sessionStorage.setItem(UNLOCKED_KEY, "1");
    else window.sessionStorage.removeItem(UNLOCKED_KEY);
  } catch {
    /* Storage blocked: the board still opens for this page load. */
  }

  for (const listener of listeners) listener();
}

export function KitchenScreen() {
  const gate = useSyncExternalStore<Gate>(subscribeSession, readGate, () => "checking");

  if (gate === "checking") {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Checking board access…" />
      </main>
    );
  }

  if (gate === "locked") return <KitchenPinWall onSuccess={() => writeGate(true)} />;

  return <KdsBoard onLock={() => writeGate(false)} />;
}
