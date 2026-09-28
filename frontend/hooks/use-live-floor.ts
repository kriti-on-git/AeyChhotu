"use client";

/* useLiveFloor — the Floor view's data runtime (screen S6).

   LIVE WITH MOCK FALLBACK, identical ladder to useLiveTable / useLiveKds:
   1. GET /api/v1/floor/tables (E17, staff bearer) is the single source of
      pacing for every table — active order, status, staged cart lines. The
      response also carries `active_order.items`, so each floor card can show
      the table's allergy alerts without a second request.
   2. Realtime: the staff-wide `orders` feed (INSERT / UPDATE / DELETE)
      refreshes the board the instant a ticket is fired, moved or pruned.
      Where Realtime is unavailable (no Supabase env, or RLS matching no rows)
      a slow REST poll keeps the board honest instead of leaving it frozen.
   3. If the backend is unreachable AND the demo fallback is permitted
      (development only — see shouldUseDemoFallback), the seeded store stands
      in so the prototype still runs.

   The 86 drawer's catalog is NOT here — see useStaffMenuCatalog, which both
   staff surfaces share so the catalog is fetched once per screen.

   E17 requires a staff token, so this hook is only ever mounted inside the
   floor's StaffGate. A 401 there is handled by the api-client's global guard,
   which wipes the token and returns the operator to the PIN wall. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchAllPages,
  getFloorTables as apiGetFloorTables,
  shouldUseDemoFallback,
  subscribeOrdersFeed,
  toFloorSummary,
} from "@/lib/api-client";
import type { FloorTableSummary } from "@/lib/api/types";
import * as mock from "@/lib/api";
import { getSnapshot, subscribe as subscribeMockStore } from "@/lib/api/store";

export type FloorPhase = "loading" | "error" | "success";
export type FloorSource = "live" | "demo";

/** Safety-net cadence when Realtime cannot stream. Slow on purpose: the feed
    above is the fast path, this only stops the board going stale. */
const POLL_INTERVAL_MS = 15_000;
const LIST_LIMIT = 100;

export interface LiveFloorValue {
  phase: FloorPhase;
  error: ApiError | null;
  source: FloorSource;
  tables: FloorTableSummary[];
  retry: () => void;
  refresh: () => Promise<void>;
}

export function useLiveFloor(): LiveFloorValue {
  const [phase, setPhase] = useState<FloorPhase>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [source, setSource] = useState<FloorSource>("live");
  const [tables, setTables] = useState<FloorTableSummary[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const sourceRef = useRef<FloorSource>("live");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* One load of the live data. Returns null when the backend is unreachable
     AND demo fallback is allowed, signalling "use the demo store instead". */
  const loadLive = useCallback(async (): Promise<FloorTableSummary[]> => {
    const rows = await fetchAllPages((page) => apiGetFloorTables({ page, limit: LIST_LIMIT }));
    return rows.map(toFloorSummary);
  }, []);

  const loadDemo = useCallback(async (): Promise<FloorTableSummary[]> => {
    const result = await mock.fetchFloorSummaries();
    if (!result.ok) {
      throw new ApiError(500, "INTERNAL_ERROR", "Could not load the demo floor.");
    }
    return result.data;
  }, []);

  const apply = useCallback((next: FloorTableSummary[]) => {
    if (!mountedRef.current) return;
    setTables(next);
  }, []);

  // ---- Initial load + every retry --------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setPhase("loading");
      setError(null);

      try {
        let data: FloorTableSummary[];
        try {
          data = await loadLive();
          sourceRef.current = "live";
          setSource("live");
        } catch (err) {
          if (shouldUseDemoFallback(err)) {
            data = await loadDemo();
            sourceRef.current = "demo";
            setSource("demo");
          } else {
            throw err;
          }
        }
        if (cancelled) return;
        apply(data);
        setPhase("success");
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err
            : new ApiError(0, "INTERNAL_ERROR", "Could not load the floor."),
        );
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadLive, loadDemo, apply, reloadKey]);

  // ---- REST refresh (used by the feed, the poll and manual retry) -------
  const refresh = useCallback(async () => {
    if (sourceRef.current === "demo") {
      const result = await mock.fetchFloorSummaries();
      if (result.ok) apply(result.data);
      return;
    }

    try {
      apply(await loadLive());
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        sourceRef.current = "demo";
        if (mountedRef.current) setSource("demo");
        const result = await mock.fetchFloorSummaries();
        if (result.ok) apply(result.data);
        return;
      }
      if (err instanceof ApiError && mountedRef.current) {
        setError(err);
        setPhase("error");
      }
    }
  }, [loadLive, apply]);

  // ---- Realtime: staff-wide order feed + polling safety net -------------
  useEffect(() => {
    if (phase !== "success") return;

    if (sourceRef.current === "demo") {
      return subscribeMockStore(() => {
        if (mountedRef.current) setTables(mock.getFloorSummaries());
      });
    }

    /* The feed can arrive in bursts (a fire inserts one order row, then a
       status tap updates it). Collapse them so a busy service does not turn
       into a request storm. */
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const detach = subscribeOrdersFeed(() => {
      if (debounce !== null) return;
      debounce = setTimeout(() => {
        debounce = null;
        void refresh();
      }, 400);
    });

    const poll = setInterval(() => void refresh(), POLL_INTERVAL_MS);

    return () => {
      if (debounce !== null) clearTimeout(debounce);
      clearInterval(poll);
      detach();
    };
  }, [phase, refresh]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return useMemo(
    () => ({ phase, error, source, tables, retry, refresh }),
    [phase, error, source, tables, retry, refresh],
  );
}
