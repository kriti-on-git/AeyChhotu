/* Orders module — repository.

   Every order and order_item statement lives here. Creation delegates to the
   `fire_order()` Postgres function: the duplicate guard, cart freeze,
   inventory check, ticket build, price snapshot, total and cart drain all run
   in ONE server-side transaction, so a partially created order is impossible.

   Denial/requeue/retry expose a narrow transaction port instead of leaking a
   client: the service keeps the business rules (which statuses may move,
   which lines survive) and this file keeps the SQL. */

import type {
  DbPort,
  DbTransaction,
} from "../../infrastructure/database/DatabaseManager.js";
import type { OrdersWorkflowPort } from "./orders.types.js";
import type {
  CartLineMove,
  DeniedLineRow,
  DeniedOrderRef,
  FireResult,
  LockedOrderRow,
  OrderListRow,
  OrdersRepositoryPort,
  OrdersSchemaPresence,
  OrdersTransactionPort,
  OrderStatusRow,
} from "./orders.types.js";

const SCHEMA_OBJECTS = [
  "orders",
  "order_items",
  "fire_order",
  "orders_one_active_uq",
  "order_items_order_idx",
] as const;

export class OrdersRepository implements OrdersRepositoryPort {
  private readonly db: DbPort;
  private readonly workflow?: OrdersWorkflowPort;

  constructor(db: DbPort, workflow?: OrdersWorkflowPort) {
    this.db = db;
    this.workflow = workflow;
  }

  /* The order and its kitchen hand-off commit together. Without a workflow
     port (focused repository tests) this is the original single statement. */
  async fire(tableToken: string): Promise<FireResult | null> {
    if (this.workflow === undefined) {
      return this.fireWith(this.db, tableToken);
    }
    return this.db.transaction((tx) => this.fireWith(tx, tableToken));
  }

  async countItems(orderId: string): Promise<number> {
    const res = await this.db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM order_items WHERE order_id = $1",
      [orderId],
    );
    return res.rows[0]?.total ?? 0;
  }

  async findOrderForTable(orderId: string, tableId: string): Promise<OrderStatusRow | null> {
    const res = await this.db.query<OrderStatusRow>(
      "SELECT id AS order_id, table_id, status, created_at FROM orders WHERE id = $1 AND table_id = $2",
      [orderId, tableId],
    );
    return res.rows[0] ?? null;
  }

  async countForTable(tableId: string): Promise<number> {
    const res = await this.db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM orders WHERE table_id = $1",
      [tableId],
    );
    return res.rows[0]?.total ?? 0;
  }

  async listForTable(tableId: string, limit: number, offset: number): Promise<OrderListRow[]> {
    const res = await this.db.query<OrderListRow>(
      `SELECT o.id AS order_id,
              o.table_id,
              o.status,
              o.created_at,
              o.denial_reason,
              o.total,
              COALESCE(
                (
                  SELECT jsonb_agg(
                           jsonb_build_object(
                             'menu_item_id', oi.menu_item_id,
                             'name',         mi.name,
                             'quantity',      oi.quantity,
                             'request_note',  oi.request_note,
                             'allergy_note',  oi.allergy_note,
                             -- attribution copied off the cart at fire time
                             'added_by',     oi.added_by,
                             -- price CHARGED at fire time, not today's menu
                             -- price: a re-priced dish must not rewrite an
                             -- old ticket's bill (sql/004_hardening.sql)
                             'unit_price',    oi.unit_price
                           )
                           ORDER BY oi.id
                         )
                    FROM order_items oi
                    JOIN menu_items mi ON mi.id = oi.menu_item_id
                   WHERE oi.order_id = o.id
                ),
                '[]'::jsonb
              ) AS items
         FROM orders o
        WHERE o.table_id = $1
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $2 OFFSET $3`,
      [tableId, limit, offset],
    );
    return res.rows;
  }

  async denyPendingForItem(menuItemId: string, reason: string): Promise<DeniedOrderRef[]> {
    const res = await this.db.query<DeniedOrderRef>(
      `UPDATE orders o
          SET status        = 'denied',
              denial_reason = $2,
              updated_at    = now()
        WHERE o.status = 'pending'
          AND EXISTS (
                SELECT 1
                  FROM order_items oi
                 WHERE oi.order_id = o.id
                   AND oi.menu_item_id = $1
              )
        RETURNING o.id AS order_id, o.table_id`,
      [menuItemId, reason],
    );
    return res.rows;
  }

  async dismiss(orderId: string): Promise<void> {
    await this.db.query("DELETE FROM orders WHERE id = $1 AND status = 'denied'", [orderId]);
  }

  transaction<T>(work: (tx: OrdersTransactionPort) => Promise<T>): Promise<T> {
    return this.db.transaction((client) =>
      work({
        lockOrderForTable: (orderId, tableToken) =>
          this.lockOrderForTable(client, orderId, tableToken),
        listLines: (orderId) => this.listLines(client, orderId),
        addCartLine: (tableId, line) => this.addCartLine(client, tableId, line),
        deleteOrder: (orderId) => this.deleteOrderWith(client, orderId),
        fire: (tableToken) => this.fireWith(client, tableToken),
      }),
    );
  }

  async schemaObjects(): Promise<OrdersSchemaPresence> {
    const res = await this.db.query<{
      orders: boolean;
      order_items: boolean;
      fire_order: boolean;
      active_unique: boolean;
      items_index: boolean;
    }>(
      `SELECT to_regclass('public.orders') IS NOT NULL AS orders,
              to_regclass('public.order_items') IS NOT NULL AS order_items,
              EXISTS (
                SELECT 1 FROM pg_proc WHERE proname = 'fire_order'
              ) AS fire_order,
              to_regclass('public.orders_one_active_uq') IS NOT NULL AS active_unique,
              to_regclass('public.order_items_order_idx') IS NOT NULL AS items_index`,
    );

    const row = res.rows[0];
    const found = [
      [SCHEMA_OBJECTS[0], row?.orders === true],
      [SCHEMA_OBJECTS[1], row?.order_items === true],
      [SCHEMA_OBJECTS[2], row?.fire_order === true],
      [SCHEMA_OBJECTS[3], row?.active_unique === true],
      [SCHEMA_OBJECTS[4], row?.items_index === true],
    ] as const;

    const present: string[] = [];
    const missing: string[] = [];
    for (const [name, exists] of found) {
      if (exists) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }

  /* --------------------------------------------------------- transaction */

  private async lockOrderForTable(
    tx: DbTransaction,
    orderId: string,
    tableToken: string,
  ): Promise<LockedOrderRow | null> {
    const res = await tx.query<LockedOrderRow>(
      `SELECT o.id, o.table_id, o.status
         FROM orders o
         JOIN restaurant_tables t ON t.id = o.table_id
        WHERE o.id = $1
          AND t.code = $2
          AND t.deleted_at IS NULL
          FOR UPDATE OF o`,
      [orderId, tableToken],
    );
    return res.rows[0] ?? null;
  }

  private async listLines(tx: DbTransaction, orderId: string): Promise<DeniedLineRow[]> {
    const res = await tx.query<DeniedLineRow>(
      `SELECT oi.menu_item_id,
              mi.name,
              oi.quantity,
              oi.request_note,
              oi.allergy_note,
              oi.added_by,
              mi.is_available
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
        WHERE oi.order_id = $1
        ORDER BY oi.id`,
      [orderId],
    );
    return res.rows;
  }

  /* Same upsert key as the Cart module, so two guests requeueing at once
     cannot fork duplicate lines. quantity is clamped to the cart's 1..99
     CHECK with LEAST() rather than letting a merge fail the whole requeue. */
  private async addCartLine(
    tx: DbTransaction,
    tableId: string,
    line: CartLineMove,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO cart_items (table_id, menu_item_id, quantity, request_note, allergy_note, added_by)
            VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (table_id, menu_item_id, request_note, allergy_note)
         DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, 99),
                       added_by = EXCLUDED.added_by`,
      [tableId, line.menuItemId, line.quantity, line.requestNote, line.allergyNote, line.addedBy],
    );
  }

  private async deleteOrderWith(tx: DbTransaction, orderId: string): Promise<void> {
    await tx.query("DELETE FROM orders WHERE id = $1", [orderId]);
  }

  private async fireWith(tx: DbTransaction, tableToken: string): Promise<FireResult | null> {
    const res = await tx.query<{ result: FireResult }>(
      "SELECT fire_order($1) AS result",
      [tableToken],
    );
    const result = res.rows[0]?.result ?? null;

    if (
      result?.code === "OK" &&
      result.order_id !== undefined &&
      result.table_id !== undefined &&
      this.workflow !== undefined
    ) {
      await this.workflow.enqueueOrderCreated(tx, {
        orderId: result.order_id,
        tableId: result.table_id,
      });
    }

    return result;
  }
}
