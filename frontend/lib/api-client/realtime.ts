/* Realtime layer — how REST and Supabase/Realtime coordinate.

   Channel map (docs/7 §3):
     A  table_carts:{table_token}     cart_items INSERT/UPDATE/DELETE  (S1/S2)
     B  kds_orders                    orders INSERT → chime + refetch  (S5)
     C  order_tracker:{order_id}      orders UPDATE  → colour shifts   (S3)
     D  table_presence:{table_token}  presence → ActiveDinersBadge     (S1)

   Fallback policy: every subscription has a REST path underneath.
   - Realtime env missing (getSupabase() → null) ⇒ REST-only mode: the
     unsubscribe handle is a no-op and callers keep their REST cadence.
   - watchOrderStatus() starts with an immediate REST read, arms the
     channel, and only keeps polling while the channel is not live —
     so a dead socket degrades to polite 5s polling instead of silence.

   SECURITY: browser holds only the public anon key (RLS-filtered events).
   The service_role key must never appear here. */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getLiveOrderStatus } from "./endpoints";
import type { CartLine, LiveOrderStatus, OrderStatus } from "./types";

let supabaseInstance: SupabaseClient | null = null;
let supabaseInitialized = false;

/** Lazy, env-driven engine client. Returns null when unconfigured so the
    app can run REST-only without throwing at import time. */
export function getSupabase(): SupabaseClient | null {
  if (supabaseInitialized) return supabaseInstance;
  supabaseInitialized = true;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  supabaseInstance = createClient(url, anonKey);
  return supabaseInstance;
}

type Detach = () => void;
const NOOP_DETACH: Detach = () => undefined;

// ---- A. Shared table cart room ----------------------------------------

export interface CartChangeEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  table_token: string;
  /** Full row for INSERT/UPDATE; null for DELETE. */
  line: CartLine | null;
  /** Old row fragment (id at minimum) for DELETE. */
  previous: Partial<CartLine> | null;
}

export function subscribeTableCart(
  tableId: string,
  tableToken: string,
  onChange: (change: CartChangeEvent) => void,
): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel(`table_carts:${tableToken}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "cart_items", filter: `table_id=eq.${tableId}` },
      (payload) => {
        const event = payload.eventType as "INSERT" | "UPDATE" | "DELETE";
        onChange({
          event,
          table_token: tableToken,
          line: event === "DELETE" ? null : (payload.new as unknown as CartLine),
          previous: (payload.old as unknown as Partial<CartLine> | null) ?? null,
        });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- B. KDS order intake ----------------------------------------------

export interface KdsIntakeEvent {
  order_id: string;
  table_id: string;
  status: OrderStatus;
}

/** INSERT on orders → new Pending ticket + audio chime (device armed via E13). */
export function subscribeKdsOrders(onInsert: (event: KdsIntakeEvent) => void): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel("kds_orders")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "orders" },
      (payload) => {
        const row = payload.new as unknown as {
          id?: string;
          table_id?: string;
          status?: OrderStatus;
        };
        if (!row.id || !row.table_id || !row.status) return;
        onInsert({ order_id: row.id, table_id: row.table_id, status: row.status });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- C. Live progress tracker -----------------------------------------

export interface OrderTrackerEvent {
  order_id: string;
  status: OrderStatus;
}

export function subscribeOrderTracker(
  orderId: string,
  onUpdate: (event: OrderTrackerEvent) => void,
): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client
    .channel(`order_tracker:${orderId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
      (payload) => {
        const row = payload.new as unknown as { id?: string; status?: OrderStatus };
        if (!row.id || !row.status) return;
        onUpdate({ order_id: row.id, status: row.status });
      },
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- D. Table presence (ActiveDinersBadge) -----------------------------

export function trackTablePresence(
  tableToken: string,
  deviceId: string,
  onCount: (activeDiners: number) => void,
): Detach {
  const client = getSupabase();
  if (!client) return NOOP_DETACH;

  const channel = client.channel(`table_presence:${tableToken}`);
  channel
    .on("presence", { event: "sync" }, () => {
      onCount(Object.keys(channel.presenceState()).length);
    })
    .track({ device_id: deviceId, table_token: tableToken });

  return () => {
    void client.removeChannel(channel);
  };
}

// ---- REST ⇄ WebSocket fallback (the coordination block) -----------------

export interface WatchOptions {
  /** Poll cadence while realtime is unavailable. Default 5000 ms. */
  pollIntervalMs?: number;
  /** Grace period before the fallback polling engages. Default 3000 ms. */
  realtimeGraceMs?: number;
}

/**
 * Tracks an order's status with realtime first and REST as the safety net:
 *   1. immediate GET /api/v1/orders/:id/status so the UI is never blank;
 *   2. channel C armed — once SUBSCRIBED, polling stands down;
 *   3. socket not live after the grace period, erroring, or closing later
 *      ⇒ polite 5 s REST polling until the next SUBSCRIBED.
 * Returns a cleanup that detaches the channel and stops all timers.
 */
export function watchOrderStatus(
  orderId: string,
  onStatus: (status: LiveOrderStatus) => void,
  options: WatchOptions = {},
): Detach {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const realtimeGraceMs = options.realtimeGraceMs ?? 3_000;

  if (typeof window === "undefined") return NOOP_DETACH;

  let stopped = false;
  let realtimeLive = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = () => {
    if (stopped || realtimeLive || pollTimer !== null) return;
    void tick();
    pollTimer = setInterval(() => void tick(), pollIntervalMs);
  };

  async function tick(): Promise<void> {
    try {
      const status = await getLiveOrderStatus(orderId);
      if (!stopped) onStatus(status);
    } catch {
      // Transient failure — the next tick retries; callers keep last state.
    }
  }

  void tick(); // 1. REST first paint

  let detach: Detach = NOOP_DETACH;
  const client = getSupabase();
  if (client) {
    const channel = client
      .channel(`order_tracker:${orderId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
        (payload) => {
          const row = payload.new as unknown as {
            id?: string;
            table_id?: string;
            status?: OrderStatus;
            created_at?: string;
          };
          if (!row.id || !row.status) return;
          realtimeLive = true;
          stopPolling(); // 2. live socket is authoritative now
          onStatus({
            order_id: row.id,
            table_id: row.table_id ?? "",
            status: row.status,
            created_at: row.created_at ?? "",
          });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          realtimeLive = true;
          stopPolling();
          if (graceTimer !== null) {
            clearTimeout(graceTimer);
            graceTimer = null;
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          realtimeLive = false;
          startPolling(); // 3. socket failed → REST safety net
        }
      });

    detach = () => {
      void client.removeChannel(channel);
    };

    // 2b. Not live within the grace window ⇒ engage the safety net.
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (!realtimeLive) startPolling();
    }, realtimeGraceMs);
  } else {
    startPolling(); // REST-only deployment
  }

  return () => {
    stopped = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    stopPolling();
    detach();
  };
}
