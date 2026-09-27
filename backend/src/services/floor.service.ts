import { pool } from "../db/pool.js";
import { buildMeta, iso, type PageMeta } from "../lib/util.js";

/* Module 4 — E17 GET /api/v1/floor/tables (Floor View summary). */

export interface FloorTable {
  table_id: string;
  code: string;
  name: string;
  status: string;
  active_order: { order_id: string; status: string; created_at: string } | null;
  cart_line_count: number;
}

export async function listFloorTables(params: {
  page: number;
  limit: number;
}): Promise<{ data: FloorTable[]; meta: PageMeta }> {
  const countRes = await pool.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM restaurant_tables",
  );

  const rows = await pool.query<{
    table_id: string;
    code: string;
    name: string;
    status: string;
    active_order: { order_id: string; status: string; created_at: string } | null;
    cart_line_count: number;
  }>(
    `SELECT t.id AS table_id,
            t.code,
            t.name,
            t.status,
            (
              SELECT jsonb_build_object(
                       'order_id',   o.id,
                       'status',     o.status,
                       'created_at', to_jsonb(o.created_at)
                     )
                FROM orders o
               WHERE o.table_id = t.id
                 AND o.status IN ('pending', 'preparing', 'ready')
               ORDER BY o.created_at DESC
               LIMIT 1
            ) AS active_order,
            (
              SELECT count(*)::int FROM cart_items ci WHERE ci.table_id = t.id
            ) AS cart_line_count
       FROM restaurant_tables t
      ORDER BY t.code
      LIMIT $1 OFFSET $2`,
    [params.limit, (params.page - 1) * params.limit],
  );

  const data: FloorTable[] = rows.rows.map((row) => ({
    table_id: row.table_id,
    code: row.code,
    name: row.name,
    status: row.status,
    active_order: row.active_order
      ? {
          order_id: row.active_order.order_id,
          status: row.active_order.status,
          created_at: iso(row.active_order.created_at),
        }
      : null,
    cart_line_count: row.cart_line_count,
  }));

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}
