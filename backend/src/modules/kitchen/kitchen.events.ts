/* Kitchen module — event names and their no-op publisher.

   INTERNAL events are the two facts Kitchen itself originates: a ticket
   reached the board, and a ticket was completed from the kitchen. Ticket
   already publishes `ticket.status.changed` for acceptance and ready, so
   Kitchen does not duplicate those facts on the bus.

   REALTIME events are transport-facing and deliberately finer-grained: each
   board move nudges the kitchen room so a second display can reconcile
   without waiting for the 15 s poll. A dropped socket is normal; the facts
   above are the durable path. */

import type { KitchenEventPublisher } from "./kitchen.types.js";

export const KITCHEN_EVENTS = {
  incoming: "kitchen.ticket.incoming",
  completed: "kitchen.ticket.completed",
} as const;

export const KITCHEN_REALTIME_EVENTS = {
  incoming: "kitchen.ticket.incoming",
  accepted: "kitchen.ticket.accepted",
  ready: "kitchen.ticket.ready",
  served: "kitchen.ticket.served",
  denied: "kitchen.ticket.denied",
} as const;

/** Used by createApp()'s compatibility seam, where no bus is composed. */
export const NOOP_KITCHEN_EVENTS: KitchenEventPublisher = {
  ticketIncoming: () => undefined,
  ticketCompleted: () => undefined,
};
