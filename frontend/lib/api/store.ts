import { seedMenu, seedTables } from "@/lib/api/seed";
import type { CartLine, MenuItem, Order, RestaurantTable } from "@/lib/api/types";

/* Realtime transport stand-in.

   The documented transport is Supabase Realtime (docs/1-real-problems.md).
   Until the backend is wired up, this module keeps the same shape: a single
   shared state snapshot, a subscribe() PUSH channel that screens render from,
   and cross-tab propagation so two phones on the same table observe one cart.
   Swap this file for Supabase channels without touching component code. */

export interface PresenceEntry {
  last_seen: number;
  table_token: string | null;
}

export interface DbState {
  tables: RestaurantTable[];
  menu: MenuItem[];
  cart: CartLine[];
  orders: Order[];
  /** device_id → presence. Drives the active-diners badge on a table. */
  clients: Record<string, PresenceEntry>;
}

const STORAGE_KEY = "aeychhotu.db.v1";
const CHANNEL_NAME = "aeychhotu.realtime.v1";
export const PRESENCE_TTL_MS = 45_000;

function createSeedState(): DbState {
  return { tables: seedTables, menu: seedMenu, cart: [], orders: [], clients: {} };
}

/* Frozen snapshot used for server rendering so hydration always matches. */
const serverSnapshot: DbState = createSeedState();

function loadState(): DbState {
  if (typeof window === "undefined") return createSeedState();

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createSeedState();

    const parsed = JSON.parse(raw) as Partial<DbState>;
    const seed = createSeedState();

    return {
      tables: parsed.tables?.length ? parsed.tables : seed.tables,
      menu: parsed.menu?.length ? parsed.menu : seed.menu,
      cart: parsed.cart ?? [],
      orders: parsed.orders ?? [],
      clients: parsed.clients ?? {},
    };
  } catch {
    return createSeedState();
  }
}

let state: DbState = loadState();
const listeners = new Set<() => void>();

const channel: BroadcastChannel | null =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

if (channel) {
  channel.onmessage = (event: MessageEvent<{ state?: DbState }>) => {
    if (!event.data?.state) return;
    state = event.data.state;
    emit();
  };
}

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage can be full or blocked; the in-memory state stays authoritative. */
  }
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): DbState {
  return state;
}

export function getServerSnapshot(): DbState {
  return serverSnapshot;
}

export function mutate(mutator: (draft: DbState) => void) {
  const draft = structuredClone(state);
  mutator(draft);
  state = draft;
  persist();
  emit();
  channel?.postMessage({ state });
}

export function heartbeat(deviceId: string, tableToken: string | null) {
  const now = Date.now();
  const current = state.clients[deviceId];

  // Skip the write when nothing but this device's own clock moved.
  if (current && now - current.last_seen < 5000 && current.table_token === tableToken) return;

  mutate((draft) => {
    const pruned: Record<string, PresenceEntry> = {};
    for (const [id, entry] of Object.entries(draft.clients)) {
      if (now - entry.last_seen < PRESENCE_TTL_MS) pruned[id] = entry;
    }
    pruned[deviceId] = { last_seen: now, table_token: tableToken };
    draft.clients = pruned;
  });
}

export function countActiveDiners(state: DbState, tableToken: string, now: number) {
  return Object.values(state.clients).filter(
    (entry) => entry.table_token === tableToken && now - entry.last_seen < PRESENCE_TTL_MS,
  ).length;
}

export function releasePresence(deviceId: string) {
  mutate((draft) => {
    delete draft.clients[deviceId];
  });
}
