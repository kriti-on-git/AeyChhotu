/* Domain event catalog — the internal language of the application.

   Names answer "what happened in the restaurant?", not "which channel should
   hear about it". They are deliberately NOT Socket.IO channel names: sockets
   broadcast to a room (`table:{id}`) and tolerate a dropped message; these
   events drive side-effects that must not be silently lost.

   The catalog starts with the four events the MVP needs and grows one module
   at a time. When a module lands, it adds its events here — one declaration
   site, so duplicate registration is caught at boot.

   Payloads carry IDs and the minimum scalars a consumer needs; they are not
   database rows. Keep them small and stable: a listener elsewhere in the app
   may depend on them. */

import { defineEvent, type EventDefinition, type EventManager } from "../infrastructure/events/EventManager.js";

export interface DomainEventMap {
  /** A guest put a menu item in the table's cart. */
  "cart.item.added": {
    readonly tableId: string;
    readonly cartItemId: string;
    readonly menuItemId: string;
    readonly quantity: number;
  };
  /** A table submitted its cart; an order row now exists. */
  "order.created": {
    readonly orderId: string;
    readonly tableId: string;
    readonly itemCount: number;
  };
  /** A round was refused by the kitchen or by an automatic 86. */
  "order.denied": {
    readonly orderId: string;
    readonly tableId: string;
    readonly reason: string;
  };
  /** The kitchen received a ticket for a fired order. */
  "ticket.created": {
    readonly ticketId: string;
    readonly orderId: string;
    readonly tableId: string;
  };
  /** A fired order's ticket reached the kitchen board. */
  "kitchen.ticket.incoming": {
    readonly ticketId: string;
    readonly orderId: string;
    readonly tableId: string;
  };
  /** The kitchen finished a ticket. */
  "kitchen.ticket.completed": {
    readonly ticketId: string;
    readonly orderId: string;
  };
  /** A kitchen ticket moved along its state machine. */
  "ticket.status.changed": {
    readonly ticketId: string;
    readonly orderId: string;
    readonly status: string;
  };
  /** A kitchen ticket was served and left the board. */
  "ticket.served": {
    readonly ticketId: string;
    readonly orderId: string;
    readonly tableId: string;
  };
  /** The kitchen refused a ticket, with a reason the diner can read. */
  "ticket.denied": {
    readonly ticketId: string;
    readonly orderId: string;
    readonly reason: string;
  };
  /** A guest claimed an empty table; a new seating exists. */
  "table.session.started": {
    readonly tableId: string;
    readonly code: string;
  };
  /** A seating ended; the table is empty for the next party. */
  "table.session.cleared": {
    readonly tableId: string;
    readonly reason: "auto_release" | "staff_clear" | "admin_clear";
    readonly billStatus: "unrequested" | "requested" | "paid";
  };
  /** A diner asked for the bill. */
  "table.bill.requested": {
    readonly tableId: string;
    readonly code: string;
  };
  /** Payment was recorded for a table's bill. */
  "bill.settled": {
    readonly tableId: string;
    readonly billPaidAt: string;
  };
}

export const DOMAIN_EVENTS = {
  cartItemAdded: defineEvent(
    "cart.item.added",
    "A guest added a menu item to the table's cart.",
  ),
  orderCreated: defineEvent("order.created", "A table submitted its cart as an order."),
  orderDenied: defineEvent("order.denied", "A round was refused, with a reason the diner can read."),
  ticketCreated: defineEvent(
    "ticket.created",
    "A kitchen ticket was created from a fired order.",
  ),
  kitchenTicketIncoming: defineEvent(
    "kitchen.ticket.incoming",
    "A fired order's ticket reached the kitchen board.",
  ),
  kitchenTicketCompleted: defineEvent(
    "kitchen.ticket.completed",
    "The kitchen marked a ticket as completed.",
  ),
  ticketStatusChanged: defineEvent(
    "ticket.status.changed",
    "A kitchen ticket moved to its next preparation state.",
  ),
  ticketServed: defineEvent("ticket.served", "A kitchen ticket was served and left the board."),
  ticketDenied: defineEvent(
    "ticket.denied",
    "The kitchen refused a ticket with a diner-readable reason.",
  ),
  tableSessionStarted: defineEvent(
    "table.session.started",
    "A guest claimed an empty table and started a seating.",
  ),
  tableSessionCleared: defineEvent(
    "table.session.cleared",
    "A seating ended and the table is empty for the next party.",
  ),
  tableBillRequested: defineEvent(
    "table.bill.requested",
    "A diner asked for the bill.",
  ),
  billSettled: defineEvent(
    "bill.settled",
    "Payment was recorded for a table's bill.",
  ),
} as const satisfies Record<string, EventDefinition>;

/** Every declared name as a typed list, for assertions and diagnostics. */
export const DOMAIN_EVENT_NAMES: readonly (keyof DomainEventMap & string)[] = [
  DOMAIN_EVENTS.cartItemAdded.name,
  DOMAIN_EVENTS.orderCreated.name,
  DOMAIN_EVENTS.orderDenied.name,
  DOMAIN_EVENTS.ticketCreated.name,
  DOMAIN_EVENTS.kitchenTicketIncoming.name,
  DOMAIN_EVENTS.kitchenTicketCompleted.name,
  DOMAIN_EVENTS.ticketStatusChanged.name,
  DOMAIN_EVENTS.ticketServed.name,
  DOMAIN_EVENTS.ticketDenied.name,
  DOMAIN_EVENTS.tableSessionStarted.name,
  DOMAIN_EVENTS.tableSessionCleared.name,
  DOMAIN_EVENTS.tableBillRequested.name,
  DOMAIN_EVENTS.billSettled.name,
];

/** Declares every domain event on the bus. Called once, from the composition
    root; a second call is a duplicate-registration error by design. */
export function registerDomainEvents(manager: EventManager<DomainEventMap>): void {
  manager.registerAll(Object.values(DOMAIN_EVENTS));
}
