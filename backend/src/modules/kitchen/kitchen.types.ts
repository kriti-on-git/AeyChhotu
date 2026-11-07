/* Kitchen module — contracts.

   ARCHITECTURAL NOTE (approved design): the Ticket module owns the ticket
   aggregate and every state transition. The Kitchen module owns the
   kitchen-facing surface around it: the board read, shift arming, the intake
   feed and realtime notifications. It never writes `orders` rows itself; each
   command is delegated to the Ticket port, which performs the conditional
   update and its own 409 validation.

   ORDER INTEGRATION stays behind a narrow read port. The kitchen only needs
   the table a ticket belongs to, so it asks for that association instead of
   importing Orders' repository or reading `orders` in a second place. */

import type { PageMeta } from "../../lib/util.js";
import type { RealtimePublisher } from "../../infrastructure/realtime/RealtimePublisher.js";
import type {
  TicketAdvanceResult,
  TicketAdvanceTarget,
  TicketDenyResult,
  TicketListParams,
  TicketPage,
  TicketServeResult,
  TicketServicePort,
  TicketStatus,
} from "../tickets/index.js";

/** Exactly the Ticket capabilities the kitchen orchestration needs. */
export type KitchenTicketPort = Pick<
  TicketServicePort,
  "listTickets" | "advanceTicket" | "pruneTicket" | "denyTicket"
>;

export type KitchenBoardParams = TicketListParams;
export type KitchenBoard = TicketPage;
export type KitchenAdvanceTarget = TicketAdvanceTarget;
export type KitchenAdvanceResult = TicketAdvanceResult;
export type KitchenServeResult = TicketServeResult;
export type KitchenDenyResult = TicketDenyResult;

/** Internal queue read: counts behind the board, oldest ticket age. */
export type KitchenQueueSummary = {
  pending: number;
  preparing: number;
  ready: number;
  active: number;
  oldest_created_at: string | null;
};

export type KitchenOrderRef = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: Date;
};

/** The Order side of the boundary: association only, read-only. */
export interface KitchenOrderPort {
  findOrder(orderId: string): Promise<KitchenOrderRef | null>;
}

export type KitchenQueueRow = {
  pending: number;
  preparing: number;
  ready: number;
  active: number;
  oldest_created_at: Date | null;
};

export type KitchenSchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

/** What the Kitchen repository owns. The board itself is read through the
    Ticket contract, so this stays a small, read-only projection: queue
    counts, order association and schema presence for health. */
export interface KitchenRepositoryPort {
  summary(): Promise<KitchenQueueSummary>;
  findOrder(orderId: string): Promise<KitchenOrderRef | null>;
  schemaObjects(): Promise<KitchenSchemaPresence>;
}

/** The only transport surface a module may touch. No Socket.IO handle. */
export type KitchenRealtimePort = Pick<RealtimePublisher, "toKitchen">;

export type KitchenRealtimePayload = {
  ticket_id: string;
  order_id: string;
  table_id: string | null;
  status: TicketStatus;
};

/** Internal facts. Accept/ready are already announced by Ticket as
    `ticket.status.changed`; Kitchen adds only its intake and completion facts. */
export interface KitchenEventPublisher {
  ticketIncoming(payload: {
    readonly ticketId: string;
    readonly orderId: string;
    readonly tableId: string;
  }): void;
  ticketCompleted(payload: {
    readonly ticketId: string;
    readonly orderId: string;
  }): void;
}

/** E13 response — unchanged from the pre-module route. */
export type ShiftActivation = {
  device_id: string;
  audio_armed: true;
  message: string;
};

export type KitchenIncomingTicket = {
  readonly ticketId: string;
  readonly orderId: string;
  readonly tableId: string;
};

export interface KitchenServicePort {
  /** E10 — active kitchen board, delegated to Ticket. */
  getBoard(params: KitchenBoardParams): Promise<KitchenBoard>;
  /** Internal workflow read used by diagnostics and future voice tools. */
  queue(): Promise<KitchenQueueSummary>;
  /** Ticket acceptance: pending → preparing. */
  acceptTicket(ticketId: string): Promise<KitchenAdvanceResult>;
  /** Preparation complete: preparing → ready. */
  markTicketReady(ticketId: string): Promise<KitchenAdvanceResult>;
  /** Completion/service: ready → served (prune). */
  completeTicket(ticketId: string): Promise<KitchenServeResult>;
  /** Chef's refusal with a diner-readable reason. */
  denyTicket(ticketId: string, reason: string): Promise<KitchenDenyResult>;
  /** A fired order reached the kitchen; notify the room and the bus. */
  handleIncomingTicket(event: KitchenIncomingTicket): Promise<void>;
  /** E13 — arm audio chimes for one device (process-local by design). */
  activateShift(deviceId: string): ShiftActivation;
  /** GET /kds/assistant/key — configured Gemini key or null. */
  assistantKey(): string | null;
}

export type { PageMeta, TicketStatus };
