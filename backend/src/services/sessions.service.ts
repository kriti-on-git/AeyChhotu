import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";

/* Module 1 — Session & Access Control. */

export interface TableRecord {
  id: string;
  code: string;
  name: string;
  status: string;
}

/** Resolves a table_token (restaurant_tables.code) or throws 404. */
export async function requireTable(tableToken: string): Promise<TableRecord> {
  const res = await pool.query<TableRecord>(
    "SELECT id, code, name, status FROM restaurant_tables WHERE code = $1",
    [tableToken],
  );
  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
  }
  return row;
}

/* E1 — POST /api/v1/sessions/initialize.
   Verifies the scanned token and flips the table to 'active' on first scan. */
export async function initializeSession(tableToken: string) {
  const table = await requireTable(tableToken);

  if (table.status !== "active") {
    const updated = await pool.query<TableRecord>(
      "UPDATE restaurant_tables SET status = 'active' WHERE id = $1 RETURNING id, code, name, status",
      [table.id],
    );
    const row = updated.rows[0] ?? table;
    return { table_id: row.id, code: row.code, name: row.name, status: row.status };
  }

  return { table_id: table.id, code: table.code, name: table.name, status: table.status };
}

export type ActiveCheckResult =
  | { has_active_order: true; order_id: string; status: string; message: string }
  | { has_active_order: false; message: string };

/* E9 — GET /api/v1/sessions/:table_token/active-check.
   Read-only guardrail: never 409s, just reports the processing block. */
export async function activeCheck(tableToken: string): Promise<ActiveCheckResult> {
  const table = await requireTable(tableToken);

  const res = await pool.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM orders
      WHERE table_id = $1
        AND status IN ('pending', 'preparing', 'ready')
      ORDER BY created_at DESC
      LIMIT 1`,
    [table.id],
  );

  const order = res.rows[0];
  if (!order) {
    return { has_active_order: false, message: "Ready for new order round initialization." };
  }

  return {
    has_active_order: true,
    order_id: order.id,
    status: order.status,
    message: "Order already sent",
  };
}
