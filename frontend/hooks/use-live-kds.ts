"use client";

/* useLiveKds — the Kitchen Display data runtime.

   LIVE WITH MOCK FALLBACK (gated — see shouldUseDemoFallback()):
   - reads:  GET /api/v1/kds/tickets (bearer injected by the api-client)
   - writes: PATCH status / prune, with a per-ticket busy map that is the
     frontend double-tap guardrail for one-tap state modifications.
   - realtime: `kds_orders` INSERT channel → instant refetch so new tickets
     pop into Pending without a page refresh; mock store subscription keeps
     the offline demo cross-tab live (development only). */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchAllPages,
  getKdsTickets as apiGetKdsTickets,
  pruneKdsTicket as apiPruneKdsTicket,
  shouldUseDemoFallback,
  subscribeKdsOrders,
  toKdsOrder,
  updateKdsStatus as apiUpdateKdsStatus,
} from "@/lib/api-client";
import type { Order, OrderStatus } from "@/lib/api/types";
import * as mock from "@/lib/api";
import { subscribe as subscribeMockStore } from "@/lib/api/store";

export type KdsPhase = "loading" | "error" | "success";
export type KdsSource = "live" | "demo";

export interface KdsAdvanceResult {
  ok: boolean;
  message?: string;
}

export interface LiveKdsValue {
  phase: KdsPhase;
  error: ApiError | null;
  source: KdsSource;
  tickets: Order[];
  /** order_id → mutation in flight (one-tap guardrail). */
  busy: Record<string, boolean>;
  retry: () => void;
  refresh: () => Promise<void>;
  advance: (order: Order, next: OrderStatus) => Promise<KdsAdvanceResult>;
}

const LIST_LIMIT = 100;

export function useLiveKds(): LiveKdsValue {
  const [phase, setPhase] = useState<KdsPhase>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [source, setSource] = useState<KdsSource>("live");
  const [tickets, setTickets] = useState<Order[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [reloadKey, setReloadKey] = useState(0);

  const sourceRef = useRef<KdsSource>("live");
  const mountedRef = useRef(true);
  const busyRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadTickets = useCallback(async (): Promise<{ list: Order[]; source: KdsSource }> => {
    try {
      // The board must show EVERY active ticket: walk all pages so ticket
      // 101 can never be invisible to the kitchen (server caps limit at
      // 100 per request — page 1 alone was a silent truncation).
      const rows = await fetchAllPages((page) => apiGetKdsTickets({ page, limit: LIST_LIMIT }));
      return { list: rows.map(toKdsOrder), source: "live" };
    } catch (err) {
      if (shouldUseDemoFallback(err)) {
        // Backend unreachable → offline demo board from the seeded store.
        return { list: mock.getKdsTickets(), source: "demo" };
      }
      throw err;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { list, source: nextSource } = await loadTickets();
      sourceRef.current = nextSource;
      if (!mountedRef.current) return;
      setSource(nextSource);
      setTickets(list);
      if (phase === "error") setPhase("success");
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError) {
        setError(err);
        setPhase("error");
      }
    }
  }, [loadTickets, phase]);

  // ---- Initial load + retry -------------------------------------------
  // Resets (loading / clear error) happen inside `retry` — an event
  // handler — so the effect body never sets state synchronously.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { list, source: nextSource } = await loadTickets();
        if (cancelled) return;
        sourceRef.current = nextSource;
        setSource(nextSource);
        setTickets(list);
        setPhase("success");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err : new ApiError(0, "INTERNAL_ERROR", "Could not load the board."));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadTickets, reloadKey]);

  const retry = useCallback(() => {
    setPhase("loading");
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  // ---- Realtime B: kds_orders intake / mock store (demo) ----------------
  useEffect(() => {
    if (phase !== "success") return;

    if (sourceRef.current === "live") {
      return subscribeKdsOrders(() => {
        void refresh();
      });
    }

    return subscribeMockStore(() => {
      if (mountedRef.current) setTickets(mock.getKdsTickets());
    });
  }, [phase, refresh]);

  // ---- One-tap state machine with per-ticket busy guardrail -------------
  const advance = useCallback(
    async (order: Order, next: OrderStatus): Promise<KdsAdvanceResult> => {
      if (busyRef.current[order.id]) {
        // Hard frontend block: the second tap cannot double-submit.
        return { ok: false, message: "That ticket is already updating." };
      }
      busyRef.current = { ...busyRef.current, [order.id]: true };
      setBusy(busyRef.current);

      try {
        if (next === "served") {
          await apiPruneKdsTicket(order.id);
        } else {
          await apiUpdateKdsStatus(order.id, next as "preparing" | "ready");
        }
        await refresh();
        return { ok: true };
      } catch (err) {
        if (shouldUseDemoFallback(err)) {
          sourceRef.current = "demo";
          setSource("demo");
          const result = await mock.updateTicketStatus(order.id, next);
          if (result.ok) {
            setTickets(mock.getKdsTickets());
            return { ok: true };
          }
          return { ok: false, message: result.message };
        }
        if (err instanceof ApiError) {
          return { ok: false, message: err.message };
        }
        throw err;
      } finally {
        busyRef.current = { ...busyRef.current, [order.id]: false };
        if (mountedRef.current) setBusy(busyRef.current);
      }
    },
    [refresh],
  );

  return { phase, error, source, tickets, busy, retry, refresh, advance };
}
