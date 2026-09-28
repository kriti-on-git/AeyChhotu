"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { KitchenPinWall } from "@/components/staff/kitchen-pin-wall";
import { LoadingState } from "@/components/ui/loading-state";

/* StaffGate — the PIN wall in front of every back-of-house surface.

   Extracted from KitchenScreen so /floor gets the identical guard rather than
   a second, subtly different copy. E17 and E10–E14 all require a staff bearer
   token, so an ungated floor page would simply 401 (and the api-client's
   global guard would bounce the operator to the PIN wall anyway — better to
   ask for the PIN up front).

   Unlocking writes to sessionStorage, which emits no event we can observe,
   so each surface keeps its own listener set and pushes the new value through
   useSyncExternalStore. The server snapshot stays "checking" so hydration
   never mismatches.

   The storage key is per-surface: unlocking the kitchen must not silently
   unlock the floor, and an operator who locks one leaves the other alone. */

const listenersByKey = new Map<string, Set<() => void>>();

function listenersFor(key: string): Set<() => void> {
  let set = listenersByKey.get(key);
  if (!set) {
    set = new Set();
    listenersByKey.set(key, set);
  }
  return set;
}

function writeGate(key: string, unlocked: boolean): void {
  try {
    if (unlocked) window.sessionStorage.setItem(key, "1");
    else window.sessionStorage.removeItem(key);
  } catch {
    /* Storage blocked (private mode): the surface still opens for this page
       load, it just will not survive a refresh. */
  }

  for (const listener of listenersFor(key)) listener();
}

export interface StaffGateProps {
  /** sessionStorage key — one per surface. */
  storageKey: string;
  /** Copy shown on the PIN wall, e.g. "kitchen" or "floor". */
  surface: string;
  /** Rendered once unlocked; receives the lock action for the surface header. */
  children: (api: { lock: () => void }) => ReactNode;
}

export function StaffGate({ storageKey, surface, children }: StaffGateProps) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const set = listenersFor(storageKey);
      set.add(onStoreChange);
      return () => {
        set.delete(onStoreChange);
      };
    },
    [storageKey],
  );

  const readGate = useCallback((): "locked" | "ready" => {
    try {
      return window.sessionStorage.getItem(storageKey) === "1" ? "ready" : "locked";
    } catch {
      return "locked";
    }
  }, [storageKey]);

  const gate = useSyncExternalStore<"checking" | "locked" | "ready">(subscribe, readGate, () => "checking");

  if (gate === "checking") {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Checking board access…" />
      </main>
    );
  }

  if (gate === "locked") {
    return <KitchenPinWall surface={surface} onSuccess={() => writeGate(storageKey, true)} />;
  }

  return <>{children({ lock: () => writeGate(storageKey, false) })}</>;
}
