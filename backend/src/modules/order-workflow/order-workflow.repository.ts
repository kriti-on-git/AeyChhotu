/* Order workflow outbox — repository. */

import type { DbPort, DbTransaction } from "../../infrastructure/database/DatabaseManager.js";
import type { OrderWorkflowOutboxRow } from "./order-workflow.types.js";

const ROW_COLUMNS = `id, event_id, order_id, table_id, event, payload,
  attempts, next_attempt_at, created_at`;

const SCHEMA_OBJECTS = [
  "order_workflow_outbox",
  "order_workflow_outbox_order_event_uq",
  "order_workflow_outbox_pending_idx",
] as const;

export class OrderWorkflowRepository {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  /** Must receive the fire transaction: the order and event commit together. */
  async enqueueOrderCreated(
    tx: DbTransaction,
    input: { orderId: string; tableId: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO order_workflow_outbox (order_id, table_id, event, payload)
       VALUES ($1, $2, 'order.created', $3::jsonb)
       ON CONFLICT (order_id, event) DO NOTHING`,
      [
        input.orderId,
        input.tableId,
        JSON.stringify({ order_id: input.orderId, table_id: input.tableId }),
      ],
    );
  }

  /**
   * Claim one eligible row in a short transaction. The row stays pending with
   * a lease; if the process dies mid-handler it becomes eligible again.
   */
  async claimNext(): Promise<OrderWorkflowOutboxRow | null> {
    return this.db.transaction(async (tx) => {
      const candidate = await tx.query<{ id: string; table_id: string }>(
        `SELECT o.id, o.table_id
           FROM order_workflow_outbox o
          WHERE o.status = 'pending'
            AND o.next_attempt_at <= clock_timestamp()
            AND NOT EXISTS (
              SELECT 1
                FROM order_workflow_outbox p
               WHERE p.table_id = o.table_id
                 AND p.status = 'pending'
                 AND p.id < o.id
            )
          ORDER BY o.id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      const row = candidate.rows[0];
      if (!row) return null;

      const claimed = await tx.query<OrderWorkflowOutboxRow>(
        `UPDATE order_workflow_outbox
            SET attempts = attempts + 1,
                next_attempt_at = clock_timestamp() + interval '30 seconds'
          WHERE id = $1
            AND status = 'pending'
          RETURNING ${ROW_COLUMNS}`,
        [row.id],
      );
      return claimed.rows[0] ?? null;
    });
  }

  async markProcessed(id: string): Promise<void> {
    await this.db.query(
      `UPDATE order_workflow_outbox
          SET status = 'processed',
              processed_at = clock_timestamp(),
              last_error = NULL
        WHERE id = $1 AND status = 'pending'`,
      [id],
    );
  }

  async markFailed(id: string, error: string, retryDelayMs: number): Promise<void> {
    await this.db.query(
      `UPDATE order_workflow_outbox
          SET next_attempt_at =
                clock_timestamp() + ($2 || ' milliseconds')::interval,
              last_error = $3
        WHERE id = $1 AND status = 'pending'`,
      [id, String(Math.max(1, Math.trunc(retryDelayMs))), error.slice(0, 500)],
    );
  }

  async countPending(): Promise<number> {
    const res = await this.db.query<{ pending: number }>(
      "SELECT count(*)::int AS pending FROM order_workflow_outbox WHERE status = 'pending'",
    );
    return res.rows[0]?.pending ?? 0;
  }

  async cleanup(processedBefore: Date): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      `DELETE FROM order_workflow_outbox
        WHERE status = 'processed' AND processed_at < $1
        RETURNING id`,
      [processedBefore],
    );
    return res.rowCount ?? res.rows.length;
  }

  async schemaObjects(): Promise<{ present: string[]; missing: string[] }> {
    const res = await this.db.query<{
      table_present: boolean;
      unique_present: boolean;
      index_present: boolean;
    }>(
      `SELECT to_regclass('public.order_workflow_outbox') IS NOT NULL AS table_present,
              EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'order_workflow_outbox_order_event_uq'
              ) AS unique_present,
              EXISTS (
                SELECT 1 FROM pg_indexes
                 WHERE schemaname = 'public'
                   AND indexname = 'order_workflow_outbox_pending_idx'
              ) AS index_present`,
    );
    const row = res.rows[0];
    const values = [
      SCHEMA_OBJECTS[0],
      row?.table_present === true,
      SCHEMA_OBJECTS[1],
      row?.unique_present === true,
      SCHEMA_OBJECTS[2],
      row?.index_present === true,
    ] as const;

    const present: string[] = [];
    const missing: string[] = [];
    for (let index = 0; index < values.length; index += 2) {
      const name = values[index] as string;
      if (values[index + 1] === true) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }
}
