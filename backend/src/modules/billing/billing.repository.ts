/* Billing module — repository.

   Read-only except for the settlement UPDATE. Money columns are cast to text
   inside the jsonb projection so no numeric value is turned into a JS float
   before the service can parse it into paise.

   The session filter is the same one the floor's `bill_unpaid` predicate
   uses: orders created at/after `session_started_at`, never a denied round. */

import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type {
  BillPaidRow,
  BillTableRow,
  BillingOrderRow,
  BillingRepositoryPort,
  BillingSchemaPresence,
} from "./billing.types.js";

const SCHEMA_OBJECTS = ["restaurant_tables", "orders", "order_items"] as const;

export class BillingRepository implements BillingRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  async findBill(tableId: string): Promise<BillTableRow | null> {
    const res = await this.db.query<BillTableRow>(
      `SELECT id, code, name, bill_status, session_started_at,
              bill_requested_at, bill_paid_at
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL`,
      [tableId],
    );
    return res.rows[0] ?? null;
  }

  async listOrders(
    tableId: string,
    sessionStartedAt: Date | null,
  ): Promise<BillingOrderRow[]> {
    const res = await this.db.query<BillingOrderRow>(
      `SELECT o.id AS order_id,
              o.created_at,
              o.total::text AS total,
              o.status,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'menu_item_id', oi.menu_item_id,
                    'name',         COALESCE(mi.name, 'Unknown dish'),
                    'quantity',     oi.quantity,
                    'unit_price',   oi.unit_price::text,
                    'added_by',     oi.added_by
                  )
                  ORDER BY oi.id
                ) FILTER (WHERE oi.id IS NOT NULL),
                '[]'::jsonb
              ) AS items
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        WHERE o.table_id = $1
          AND o.status <> 'denied'
          AND ($2::timestamptz IS NULL OR o.created_at >= $2)
        GROUP BY o.id
        ORDER BY o.created_at, o.id`,
      [tableId, sessionStartedAt],
    );
    return res.rows;
  }

  async markPaid(tableId: string): Promise<BillPaidRow | null> {
    const res = await this.db.query<BillPaidRow>(
      `UPDATE restaurant_tables
          SET bill_status  = 'paid',
              bill_paid_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, bill_status, bill_paid_at`,
      [tableId],
    );
    return res.rows[0] ?? null;
  }

  async schemaObjects(): Promise<BillingSchemaPresence> {
    const res = await this.db.query<{
      tables: boolean;
      orders: boolean;
      order_items: boolean;
    }>(
      `SELECT to_regclass('public.restaurant_tables') IS NOT NULL AS tables,
              to_regclass('public.orders') IS NOT NULL AS orders,
              to_regclass('public.order_items') IS NOT NULL AS order_items`,
    );

    const row = res.rows[0];
    const found = [
      [SCHEMA_OBJECTS[0], row?.tables === true],
      [SCHEMA_OBJECTS[1], row?.orders === true],
      [SCHEMA_OBJECTS[2], row?.order_items === true],
    ] as const;

    const present: string[] = [];
    const missing: string[] = [];
    for (const [name, exists] of found) {
      if (exists) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }
}
