"use client";

/* useStaffMenuCatalog — the 86 drawer's catalog, shared by the kitchen board
   and the floor view.

   THE PROBLEM: E14 (86 an item) needs a `menu_item_id`, which means the drawer
   must render the catalog. The only catalog endpoint is E3, and E3 requires a
   valid `table_token` — the trigger for the diner's QR session. Staff screens
   have a bearer token, not a table token, so historically they rendered the
   drawer from the offline demo store and the live menu could not be 86'd from
   the UI at all.

   THE FIX, with no contract change: discover a real table code from E17 (the
   staff floor list — every staff screen may call it) and ask E3 with that.
   The catalog itself is global, so any valid table works. Callers that already
   fetched table codes (the floor view) pass one in via `tokenHint` and skip
   the extra request entirely. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchAllPages,
  getFloorTables as apiGetFloorTables,
  getMenu as apiGetMenu,
  shouldUseDemoFallback,
  toMenuItem,
  toggleItemAvailability,
} from "@/lib/api-client";
import type { MenuItem } from "@/lib/api/types";
import * as mock from "@/lib/api";
import { getSnapshot } from "@/lib/api/store";

const LIST_LIMIT = 100;

export interface StaffMenuCatalog {
  menu: MenuItem[];
  /** Flips true once the first load settles (live, demo, or empty). */
  ready: boolean;
  source: "live" | "demo";
  refresh: () => Promise<void>;
  setAvailability: (
    menuItemId: string,
    isAvailable: boolean,
  ) => Promise<{ ok: boolean; message?: string }>;
}

export function useStaffMenuCatalog(tokenHint?: string | null): StaffMenuCatalog {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState<"live" | "demo">("live");

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    let token = tokenHint ?? null;

    if (!token) {
      const rows = await fetchAllPages((page) => apiGetFloorTables({ page, limit: LIST_LIMIT }));
      token = rows[0]?.code ?? null;
    }

    // No tables at all ⇒ no token to ask with, and nothing to 86 anyway.
    if (!token) return { catalog: [] as MenuItem[], source: "live" as const };

    const rows = await fetchAllPages((page) => apiGetMenu(token, { page, limit: LIST_LIMIT }));
    return { catalog: rows.map(toMenuItem), source: "live" as const };
  }, [tokenHint]);

  const refresh = useCallback(async () => {
    try {
      const { catalog, source: nextSource } = await load();
      if (!mountedRef.current) return;
      setSource(nextSource);
      setMenu(catalog);
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        if (!mountedRef.current) return;
        setSource("demo");
        setMenu(getSnapshot().menu);
      }
      /* Otherwise stay quiet: the catalog is a secondary panel, and blanking
         the board because the drawer's list failed would be worse. The toggle
         itself reports its own failure through the toast layer. */
    } finally {
      if (mountedRef.current) setReady(true);
    }
  }, [load]);

  /* Loaded via an async IIFE rather than by calling refresh() directly: the
     effect body must not setState synchronously (react-hooks/
     set-state-in-effect), and every setState here happens after an await. */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { catalog, source: nextSource } = await load();
        if (cancelled) return;
        setSource(nextSource);
        setMenu(catalog);
      } catch (err) {
        if (cancelled) return;
        if (shouldUseDemoFallback(err)) {
          setSource("demo");
          setMenu(getSnapshot().menu);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  const setAvailability = useCallback(async (menuItemId: string, isAvailable: boolean) => {
    try {
      await toggleItemAvailability(menuItemId, isAvailable);
      if (mountedRef.current) {
        setMenu((current) =>
          current.map((item) =>
            item.id === menuItemId ? { ...item, is_available: isAvailable } : item,
          ),
        );
      }
      return { ok: true };
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        const result = await mock.setMenuItemAvailability(menuItemId, isAvailable);
        if (mountedRef.current) {
          setSource("demo");
          setMenu(getSnapshot().menu);
        }
        return result.ok ? { ok: true } : { ok: false, message: result.message };
      }
      return {
        ok: false,
        message: err instanceof ApiError ? err.message : "Could not update availability.",
      };
    }
  }, []);

  return { menu, ready, source, refresh, setAvailability };
}
