import { pool } from "../db/pool.js";
import { buildMeta, iso, type PageMeta } from "../lib/util.js";

/* Module 4 — E17 GET /api/v1/floor/tables (Floor View summary). */

export interface FloorTable {
  table_id: string;
  code: string;
  name: string;
  status: string;
  active_order: {
    order_id: string;
    status: string;
    created_at: string;
    /** Ticket lines, same shape as E10 — lets the floor card surface allergy
        alerts without a second round trip. */
    items: Array<{
      menu_item_id: string;
      name: string;
      quantity: number;
      request_note: string;
      allergy_note: string;
      /** Frozen at fire time — see sql/004_hardening.sql. */
      unit_price: number;
    }>;
  } | null;
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
    active_order: FloorTable["active_order"];
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
                       'created_at', to_jsonb(o.created_at),
                       'items',      COALESCE(
                         (
                           SELECT jsonb_agg(
                                    jsonb_build_object(
                                      'menu_item_id', oi.menu_item_id,
                                      'name',         mi.name,
                                      'quantity',     oi.quantity,
                                      'request_note', oi.request_note,
                                      'allergy_note', oi.allergy_note,
                                      -- price charged at fire time (sql/004_hardening.sql)
                                      'unit_price',   oi.unit_price
                                    )
                                    ORDER BY oi.id
                                  )
                             FROM order_items oi
                             JOIN menu_items mi ON mi.id = oi.menu_item_id
                            WHERE oi.order_id = o.id
                         ),
                         '[]'::jsonb
                       )
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
          items: row.active_order.items ?? [],
        }
      : null,
    cart_line_count: row.cart_line_count,
  }));

  return { data, meta: buildMeta(params.page, params.limit, countRes.rows[0]?.total ?? 0) };
}
