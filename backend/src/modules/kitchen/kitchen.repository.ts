/* Kitchen module — repository.

   READ-ONLY by construction. The board rows come from the Ticket module's
   read model (it owns the projection and its item shape); this repository
   owns the small kitchen-specific reads that would otherwise become ad-hoc
   SQL in the service: queue counts, the ticket→table association, and the
   schema existence probe used by health/self-test.

   No statement here writes an order, a ticket or a table. */

import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { iso } from "../../lib/util.js";
import type {
  KitchenOrderRef,
  KitchenQueueRow,
  KitchenQueueSummary,
  KitchenRepositoryPort,
  KitchenSchemaPresence,
} from "./kitchen.types.js";

const SCHEMA_OBJECTS = [
  "orders",
  "order_items",
  "restaurant_tables",
  "orders_status_transition",
  "orders_one_active_uq",
] as const;

const ACTIVE = "status IN ('pending', 'preparing', 'ready')";

export class KitchenRepository implements KitchenRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  /** One aggregate query behind the board; never mutates anything. */
  async summary(): Promise<KitchenQueueSummary> {
    const res = await this.db.query<KitchenQueueRow>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int   AS pending,
              count(*) FILTER (WHERE status = 'preparing')::int AS preparing,
              count(*) FILTER (WHERE status = 'ready')::int     AS ready,
              count(*)::int                                     AS active,
              min(created_at)                                   AS oldest_created_at
         FROM orders
        WHERE ${ACTIVE}`,
    );

    const row = res.rows[0];
    return {
      pending: row?.pending ?? 0,
      preparing: row?.preparing ?? 0,
      ready: row?.ready ?? 0,
      active: row?.active ?? 0,
      oldest_created_at: row?.oldest_created_at ? iso(row.oldest_created_at) : null,
    };
  }

  /** Order association for a notification payload. Read-only. */
  async findOrder(orderId: string): Promise<KitchenOrderRef | null> {
    const res = await this.db.query<KitchenOrderRef>(
      "SELECT id AS order_id, table_id, status, created_at FROM orders WHERE id = $1",
      [orderId],
    );
    return res.rows[0] ?? null;
  }

  async schemaObjects(): Promise<KitchenSchemaPresence> {
    const res = await this.db.query<{
      orders: boolean;
      order_items: boolean;
      restaurant_tables: boolean;
      transition_trigger: boolean;
      active_unique: boolean;
    }>(
      `SELECT to_regclass('public.orders') IS NOT NULL AS orders,
              to_regclass('public.order_items') IS NOT NULL AS order_items,
              to_regclass('public.restaurant_tables') IS NOT NULL AS restaurant_tables,
              EXISTS (
                SELECT 1
                  FROM pg_trigger
                 WHERE tgname = 'orders_status_transition'
                   AND NOT tgisinternal
              ) AS transition_trigger,
              to_regclass('public.orders_one_active_uq') IS NOT NULL AS active_unique`,
    );

    const row = res.rows[0];
    const found = [
      [SCHEMA_OBJECTS[0], row?.orders === true],
      [SCHEMA_OBJECTS[1], row?.order_items === true],
      [SCHEMA_OBJECTS[2], row?.restaurant_tables === true],
      [SCHEMA_OBJECTS[3], row?.transition_trigger === true],
      [SCHEMA_OBJECTS[4], row?.active_unique === true],
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
