/* Tickets module — contracts.

   ARCHITECTURAL NOTE (approved design): the persisted model has ONE `orders`
   row per fired round, and the kitchen ticket is a projection of that row over
   `order_items`. There is deliberately NO second ticket table: duplicating the
   aggregate would need dual writes and could produce a served order with an
   open ticket. The Ticket module owns the ticket aggregate's identity,
   lifecycle and kitchen-facing reads; Orders owns firing, denial of a round
   from the diner side, retry and history.

   ORDER ≠ TICKET IS STILL MODELLED. `ticket_id` and `order_id` are separate
   fields, the repository is keyed by ticket id, and the board is a list — so a
   future projection that splits one order into several preparation tickets
   (courses, stations) changes the repository only, not this contract.

   Every row type is a `type` alias so the shared DbPort query generic accepts
   it without a cast. */

import type { PageMeta } from "../../lib/util.js";

export type TicketStatus = "pending" | "preparing" | "ready" | "served" | "denied";

/** Statuses that are live on the kitchen board. Denied and served are closed. */
export type ActiveTicketStatus = "pending" | "preparing" | "ready";

/** The only moves E11 may request; `served` comes only from prune. */
export type TicketAdvanceTarget = "preparing" | "ready";

export type TicketItem = {
  menu_item_id: string;
  name: string;
  quantity: number;
  request_note: string;
  allergy_note: string;
  /** Who ordered it — copied off the cart at fire time (sql/011). */
  added_by: string;
  /** Price charged at fire time, never today's menu price. */
  unit_price: number;
};

export type TicketTable = {
  id: string;
  code: string;
  name: string;
  /** Set when a floor waiter tapped "I'll serve this" (sql/018). */
  serve_requested_at: string | null;
};

/** E10 row — byte-for-byte the legacy payload. */
export type Ticket = {
  ticket_id: string;
  order_id: string;
  table: TicketTable;
  status: string;
  created_at: string;
  items: TicketItem[];
};

/** Internal identification read; the trail is not exposed on the board. */
export type TicketDetail = Ticket & {
  denial_reason: string;
};

export type TicketListParams = {
  status?: string;
  page: number;
  limit: number;
};

export type TicketPage = {
  data: Ticket[];
  meta: PageMeta;
};

export type TicketAdvanceResult = {
  ticket_id: string;
  order_id: string;
  status: string;
};

export type TicketServeResult = {
  ticket_id: string;
  order_id: string;
  status: "served";
  table_cleared: boolean;
};

export type TicketDenyResult = {
  ticket_id: string;
  order_id: string;
  status: "denied";
  denial_reason: string;
  table_cleared: boolean;
};

/* ---------------------------------------------------------- storage rows */

export type TicketRow = {
  ticket_id: string;
  order_id: string;
  status: string;
  created_at: Date;
  denial_reason: string;
  table: TicketTable;
  items: TicketItem[] | null;
};

export type TicketStatusRow = {
  id: string;
  status: string;
};

export type TicketLifecycleRow = {
  id: string;
  table_id: string;
  status: string;
};

/** The customer request a ticket prepares, resolved through a defined port. */
export type TicketOrderRef = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: Date;
};

export type TicketSchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

/* ------------------------------------------------------ cross-module ports */

/** Order side of the boundary: association + current state, read only. */
export interface TicketOrderPort {
  findOrder(orderId: string): Promise<TicketOrderRef | null>;
}

/** Billing/Table side of the boundary: is the seating now free? The legacy
    implementation is the Table module's release engine; Billing will own the
    predicate later without changing this contract. */
export interface TicketReleasePort {
  checkAndAutoReleaseTable(tableId: string): Promise<{ released: boolean }>;
}

/** Internal domain facts the Kitchen module will consume. */
export interface TicketEventPublisher {
  ticketAdvanced(payload: { ticketId: string; orderId: string; status: string }): void;
  ticketServed(payload: { ticketId: string; orderId: string; tableId: string }): void;
  ticketDenied(payload: { ticketId: string; orderId: string; reason: string }): void;
}

/* ------------------------------------------------------------- repository */

/** One transaction for prune/deny: status change and waiter-ping clear are
    both-or-neither. */
export interface TicketTransactionPort {
  lockTicket(ticketId: string): Promise<TicketLifecycleRow | null>;
  markServed(ticketId: string): Promise<void>;
  markDenied(ticketId: string, reason: string): Promise<void>;
  clearWaiterPing(tableId: string): Promise<void>;
}

export interface TicketRepositoryPort {
  count(status: string | undefined): Promise<number>;
  list(status: string | undefined, limit: number, offset: number): Promise<TicketRow[]>;
  find(ticketId: string): Promise<TicketRow | null>;
  /** Order association read (the repository also implements TicketOrderPort). */
  findOrder(orderId: string): Promise<TicketOrderRef | null>;
  /** Conditional transition; null when the row is not in `from`. */
  advance(ticketId: string, from: string, target: TicketAdvanceTarget): Promise<TicketStatusRow | null>;
  transaction<T>(work: (tx: TicketTransactionPort) => Promise<T>): Promise<T>;
  schemaObjects(): Promise<TicketSchemaPresence>;
}

/* ---------------------------------------------------------------- service */

export interface TicketServicePort {
  /** E10 — active kitchen board. */
  listTickets(params: TicketListParams): Promise<TicketPage>;
  /** Ticket identification: the ticket and its parent order, or 404. */
  getTicket(ticketId: string): Promise<TicketDetail>;
  /** E11 — pending→preparing→ready, one atomic conditional update. */
  advanceTicket(ticketId: string, target: TicketAdvanceTarget): Promise<TicketAdvanceResult>;
  /** E12 — ready→served and clear the waiter ping in one transaction. */
  pruneTicket(ticketId: string): Promise<TicketServeResult>;
  /** Chef's refusal with a reason, valid from every live status. */
  denyTicket(ticketId: string, reason: string): Promise<TicketDenyResult>;
}
