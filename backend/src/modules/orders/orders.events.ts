/* Orders module — internal domain facts.

   These names are already declared (or now declared) in the application's
   event catalog. The module never imports the bus: composition injects a
   publisher, which keeps the order service testable with a fake and prevents
   a dropped listener from becoming a failed order. */

import type { OrdersEventPublisher } from "./orders.types.js";

export const ORDER_EVENTS = {
  created: "order.created",
  ticketCreated: "ticket.created",
  denied: "order.denied",
} as const;

/** Used by createApp()'s compatibility seam, where no bus is composed. */
export const NOOP_ORDER_EVENTS: OrdersEventPublisher = {
  orderCreated: () => undefined,
  ticketCreated: () => undefined,
  orderDenied: () => undefined,
};
