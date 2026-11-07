/* Phase 5.2 realtime outbox — contracts.

   SCOPE: conversation and session-lifecycle events only. The general
   Orders → Tickets → Kitchen outbox is deliberately Phase 5.3 and is not
   implemented here.

   DELIVERY SEMANTICS: at-least-once. A publish can succeed before the
   transaction commits, so a crash between publish and commit duplicates an
   event. Every payload carries the stable `event_id` (the outbox row's UUID)
   so consumers deduplicate. Exactly-once is not claimed.

   ORDERING: one dispatcher, per-table serialization by locking the table row
   (SHARE) before the outbox row (FOR UPDATE). The clear path locks the table
   FOR UPDATE, so publishing and clearing cannot interleave: either the event
   is published before the clear, or it is suppressed and never published. */

import type { DbTransaction } from "../../infrastructure/database/DatabaseManager.js";

export type RealtimeOutboxStatus = "pending" | "published" | "suppressed";

export type RealtimeOutboxRow = {
  id: string;
  event_id: string;
  table_id: string;
  session_started_at: Date | null;
  conversation_id: string | null;
  event: string;
  payload: Record<string, unknown>;
  status: RealtimeOutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
};

export interface OutboxEnqueueInput {
  readonly tableId: string;
  readonly sessionStartedAt: Date | null;
  readonly conversationId: string | null;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The transport surface the dispatcher needs. Never a raw Socket.IO handle. */
export interface RealtimeOutboxPublisher {
  /** False while Socket.IO is not listening: rows stay pending, not lost. */
  isAvailable(): boolean;
  toTable(
    tableId: string,
    event: string,
    data: unknown,
  ): { readonly recipients: number; readonly skipped: boolean };
  /** Called AFTER the terminal event is emitted, never before. */
  disconnectTable?(tableId: string): void;
}

/** Written by the Conversation service in the business transaction. */
export interface ConversationOutboxPort {
  enqueueConversationEvent(tx: DbTransaction, input: OutboxEnqueueInput): Promise<void>;
}

export interface RealtimeOutboxHealth {
  readonly state: "idle" | "running" | "stopped";
  readonly pending: number;
  readonly lastDispatchAt: string | null;
  readonly lastError: string | null;
}

export const TERMINAL_SESSION_EVENT = "table.session.ended";
export const CONVERSATION_EVENT_PREFIX = "conversation.";
