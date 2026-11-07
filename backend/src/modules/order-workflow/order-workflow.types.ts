/* Order workflow outbox — contracts.

   SCOPE: the Orders -> Kitchen hand-off only. Conversation/session events keep
   using their own realtime outbox.

   DELIVERY: at-least-once. The order row and this row commit together. A crash
   after the handler succeeds but before markProcessed() repeats the call; the
   Kitchen intake handler is read-only and the ticket already exists, so a
   replay cannot create a duplicate ticket.

   ORDERING: per table. A row is eligible only when no earlier pending row for
   the same table exists. */

import type { DbTransaction } from "../../infrastructure/database/DatabaseManager.js";

export type OrderWorkflowOutboxRow = {
  id: string;
  event_id: string;
  order_id: string;
  table_id: string;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
};

/** Written by Orders inside the fire transaction. */
export interface OrderWorkflowOutboxPort {
  enqueueOrderCreated(
    tx: DbTransaction,
    input: { readonly orderId: string; readonly tableId: string },
  ): Promise<void>;
}

/** Implemented by the Kitchen service (or a narrow adapter at composition). */
export interface OrderWorkflowHandler {
  handleOrderCreated(input: {
    readonly orderId: string;
    readonly tableId: string;
    readonly eventId: string;
  }): Promise<void>;
}

export interface OrderWorkflowHealth {
  readonly state: "idle" | "running" | "stopped";
  readonly pending: number;
  readonly lastProcessedAt: string | null;
  readonly lastError: string | null;
}
