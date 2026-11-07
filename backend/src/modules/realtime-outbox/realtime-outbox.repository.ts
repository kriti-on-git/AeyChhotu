/* Realtime outbox — repository.

   Every statement here is short and explicit. The dispatcher composes the
   transaction; suppression and terminal insertion are called by Table's clear
   transaction through the same `DbTransaction`, so they commit or roll back
   with the seating change. */

import type { DbPort, DbTransaction } from "../../infrastructure/database/DatabaseManager.js";
import type {
  OutboxEnqueueInput,
  RealtimeOutboxRow,
  RealtimeOutboxStatus,
} from "./realtime-outbox.types.js";

const ROW_COLUMNS = `id, event_id, table_id, session_started_at, conversation_id,
  event, payload, status, attempts, next_attempt_at, created_at`;

const SCHEMA_OBJECTS = [
  "realtime_outbox",
  "realtime_outbox_pending_idx",
] as const;

export class RealtimeOutboxRepository {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  async enqueue(tx: DbTransaction, input: OutboxEnqueueInput): Promise<void> {
    await tx.query(
      `INSERT INTO realtime_outbox
         (table_id, session_started_at, conversation_id, event, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.tableId,
        input.sessionStartedAt,
        input.conversationId,
        input.event,
        JSON.stringify(input.payload),
      ],
    );
  }

  /**
   * Clear: pending conversation events for the ended seating are no longer
   * deliverable. The payload is wiped at the same time, so a suppressed row
   * cannot retain transcript text.
   */
  async suppressConversationEvents(
    tx: DbTransaction,
    tableId: string,
    sessionStartedAt: Date | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE realtime_outbox
          SET status = 'suppressed',
              payload = '{}'::jsonb,
              suppressed_at = clock_timestamp()
        WHERE table_id = $1
          AND session_started_at IS NOT DISTINCT FROM $2
          AND status = 'pending'
          AND event LIKE 'conversation.%'`,
      [tableId, sessionStartedAt],
    );
  }

  async enqueueSessionEnded(
    tx: DbTransaction,
    input: {
      tableId: string;
      sessionStartedAt: Date | null;
      reason: "auto_release" | "staff_clear" | "admin_clear";
      billStatus: string;
    },
  ): Promise<void> {
    await this.enqueue(tx, {
      tableId: input.tableId,
      sessionStartedAt: input.sessionStartedAt,
      conversationId: null,
      event: "table.session.ended",
      payload: {
        table_id: input.tableId,
        session_started_at: input.sessionStartedAt?.toISOString() ?? null,
        reason: input.reason,
        bill_status: input.billStatus,
      },
    });
  }

  /** Oldest eligible pending row that has no earlier pending sibling. */
  async findNextEligible(tx: DbTransaction): Promise<RealtimeOutboxRow | null> {
    const res = await tx.query<RealtimeOutboxRow>(
      `SELECT ${ROW_COLUMNS}
         FROM realtime_outbox o
        WHERE o.status = 'pending'
          AND o.next_attempt_at <= clock_timestamp()
          AND NOT EXISTS (
            SELECT 1
              FROM realtime_outbox p
             WHERE p.table_id = o.table_id
               AND p.status = 'pending'
               AND p.id < o.id
          )
        ORDER BY o.id
        LIMIT 1`,
    );
    return res.rows[0] ?? null;
  }

  /** Lock order step 1: the table row, shared with normal writes. */
  async lockTable(tx: DbTransaction, tableId: string): Promise<boolean> {
    const res = await tx.query<{ id: string }>(
      `SELECT id
         FROM restaurant_tables
        WHERE id = $1
          FOR SHARE`,
      [tableId],
    );
    return res.rows[0] !== undefined;
  }

  /** Lock order step 2: the outbox row being published. */
  async lockRow(tx: DbTransaction, id: string): Promise<RealtimeOutboxRow | null> {
    const res = await tx.query<RealtimeOutboxRow>(
      `SELECT ${ROW_COLUMNS}
         FROM realtime_outbox
        WHERE id = $1
          AND status = 'pending'
          AND next_attempt_at <= clock_timestamp()
          FOR UPDATE`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async hasEarlierPending(
    tx: DbTransaction,
    tableId: string,
    id: string,
  ): Promise<boolean> {
    const res = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM realtime_outbox
          WHERE table_id = $1
            AND status = 'pending'
            AND id < $2
       ) AS present`,
      [tableId, id],
    );
    return res.rows[0]?.present === true;
  }

  async markPublished(tx: DbTransaction, id: string): Promise<void> {
    await tx.query(
      `UPDATE realtime_outbox
          SET status = 'published',
              published_at = clock_timestamp(),
              last_error = NULL
        WHERE id = $1`,
      [id],
    );
  }

  async markFailed(
    tx: DbTransaction,
    id: string,
    error: string,
    retryDelayMs: number,
  ): Promise<void> {
    await tx.query(
      `UPDATE realtime_outbox
          SET attempts = attempts + 1,
              next_attempt_at =
                clock_timestamp() + ($2 || ' milliseconds')::interval,
              last_error = $3
        WHERE id = $1`,
      [id, String(Math.max(1, Math.trunc(retryDelayMs))), error.slice(0, 500)],
    );
  }

  async countPending(): Promise<number> {
    const res = await this.db.query<{ pending: number }>(
      "SELECT count(*)::int AS pending FROM realtime_outbox WHERE status = 'pending'",
    );
    return res.rows[0]?.pending ?? 0;
  }

  /** Retention: published rows are replayable history, not permanent storage. */
  async cleanup(input: {
    publishedBefore: Date;
    suppressedBefore: Date;
  }): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      `DELETE FROM realtime_outbox
        WHERE (status = 'published' AND published_at < $1)
           OR (status = 'suppressed' AND suppressed_at < $2)
        RETURNING id`,
      [input.publishedBefore, input.suppressedBefore],
    );
    return res.rowCount ?? res.rows.length;
  }

  async statusOf(id: string): Promise<RealtimeOutboxStatus | null> {
    const res = await this.db.query<{ status: RealtimeOutboxStatus }>(
      "SELECT status FROM realtime_outbox WHERE id = $1",
      [id],
    );
    return res.rows[0]?.status ?? null;
  }

  async schemaObjects(): Promise<{ present: string[]; missing: string[] }> {
    const res = await this.db.query<{ table_present: boolean; index_present: boolean }>(
      `SELECT to_regclass('public.realtime_outbox') IS NOT NULL AS table_present,
              EXISTS (
                SELECT 1 FROM pg_indexes
                 WHERE schemaname = 'public'
                   AND indexname = 'realtime_outbox_pending_idx'
              ) AS index_present`,
    );
    const row = res.rows[0];
    const present: string[] = [];
    const missing: string[] = [];
    const values = [
      SCHEMA_OBJECTS[0],
      row?.table_present === true,
      SCHEMA_OBJECTS[1],
      row?.index_present === true,
    ] as const;

    for (let index = 0; index < values.length; index += 2) {
      const name = values[index] as string;
      if (values[index + 1] === true) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }
}
