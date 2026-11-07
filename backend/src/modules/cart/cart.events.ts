/* Cart module — realtime facts.

   Names live with the module; the transport is injected at composition time.
   `cart.*` names satisfy the publisher's domain-event allowlist and are
   additive to the existing Supabase postgres_changes stream the browser
   already consumes. */

import type {
  CartRealtimeAction,
  CartRealtimePort,
} from "./cart.types.js";

export const CART_EVENTS: Record<CartRealtimeAction, string> = {
  added: "cart.item.added",
  updated: "cart.item.updated",
  removed: "cart.item.removed",
  cleared: "cart.cleared",
};

/** Compatibility seam when createApp() is built without the realtime server. */
export const NOOP_CART_REALTIME: CartRealtimePort = {
  toTable: () => ({ room: "", event: "", recipients: 0, skipped: true }),
};
