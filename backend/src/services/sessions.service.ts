import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { signReadToken } from "../lib/jwt.js";

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
   Verifies the scanned token and flips the table to 'active' on first scan.

   The response also carries `realtime_token` — a Supabase-scoped READ
   token whose `table_token` claim is what the RLS policies in
   sql/001_init.sql match on (diner scope). It is issued only when
   SUPABASE_JWT_SECRET is configured; without it the client runs REST-only
   and the field is null. The token grants READ scope and no authority:
   writes still go through this backend only. */

const READ_TOKEN_TTL_SECONDS = 12 * 60 * 60; // one long dining session

function issueTableReadToken(table: TableRecord): string | null {
  if (!env.supabaseJwtSecret) return null;
  const now = Math.floor(Date.now() / 1000);
  return signReadToken(
    {
      sub: table.id,
      role: "authenticated",
      table_token: table.code,
      iat: now,
      exp: now + READ_TOKEN_TTL_SECONDS,
    },
    env.supabaseJwtSecret,
  );
}

export async function initializeSession(tableToken: string) {
  const table = await requireTable(tableToken);
  const realtimeToken = issueTableReadToken(table);

  if (table.status !== "active") {
    const updated = await pool.query<TableRecord>(
      "UPDATE restaurant_tables SET status = 'active' WHERE id = $1 RETURNING id, code, name, status",
      [table.id],
    );
    const row = updated.rows[0] ?? table;
    return {
      table_id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      realtime_token: realtimeToken,
    };
  }

  return {
    table_id: table.id,
    code: table.code,
    name: table.name,
    status: table.status,
    realtime_token: realtimeToken,
  };
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
