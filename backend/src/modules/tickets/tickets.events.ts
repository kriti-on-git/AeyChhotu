/* Tickets module — internal domain facts.

   The Kitchen module (board orchestration) consumes these later; the module
   itself never imports the bus. Composition injects the publisher. */

import type { TicketEventPublisher } from "./tickets.types.js";

export const TICKET_EVENTS = {
  advanced: "ticket.status.changed",
  served: "ticket.served",
  denied: "ticket.denied",
} as const;

/** Used by createApp()'s compatibility seam, where no bus is composed. */
export const NOOP_TICKET_EVENTS: TicketEventPublisher = {
  ticketAdvanced: () => undefined,
  ticketServed: () => undefined,
  ticketDenied: () => undefined,
};
