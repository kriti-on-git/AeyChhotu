/* Tickets module — repository.

   The ticket is a projection over `orders` + `order_items`; every statement
   that reads or moves it lives here. Transitions are conditional updates
   guarded by the FROM status, and prune/deny use one transaction so a ticket
   status can never move while its waiter ping is left stale (or vice versa).

   The `orders.id` is exposed under BOTH names on purpose: `ticket_id` is the
   kitchen work item, `order_id` is the customer request it belongs to. They
   are equal in today's one-round projection, but nothing here joins them into
   a single identity. */

import type {
  DbPort,
  DbTransaction,
} from "../../infrastructure/database/DatabaseManager.js";
import type {
  TicketAdvanceTarget,
  TicketLifecycleRow,
  TicketRepositoryPort,
  TicketSchemaPresence,
  TicketStatusRow,
  TicketRow,
  TicketTransactionPort,
  TicketOrderRef,
} from "./tickets.types.js";

const SCHEMA_OBJECTS = [
  "orders",
  "order_items",
  "orders_status_transition",
  "orders_one_active_uq",
  "order_items_order_idx",
] as const;

const TICKET_SELECT = `
  SELECT o.id AS ticket_id,
         o.id AS order_id,
         o.status,
         o.created_at,
         o.denial_reason,
         jsonb_build_object(
           'id', t.id,
           'code', t.code,
           'name', t.name,
           'serve_requested_at', t.serve_requested_at
         ) AS "table",
         COALESCE(
           (
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'menu_item_id', oi.menu_item_id,
                        'name',         mi.name,
                        'quantity',      oi.quantity,
                        'request_note',  oi.request_note,
                        'allergy_note',  oi.allergy_note,
                        'added_by',      oi.added_by,
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
    JOIN restaurant_tables t ON t.id = o.table_id`;

/** The live board excludes denied rounds, not just served ones. */
const ACTIVE_WHERE = "o.status IN ('pending', 'preparing', 'ready')";

export class TicketsRepository implements TicketRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  async count(status: string | undefined): Promise<number> {
    const where = status ? "o.status = $1" : ACTIVE_WHERE;
    const res = await this.db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM orders o WHERE ${where}`,
      status ? [status] : [],
    );
    return res.rows[0]?.total ?? 0;
  }

  async list(status: string | undefined, limit: number, offset: number): Promise<TicketRow[]> {
    const args: unknown[] = [];
    const where = status ? (args.push(status), "o.status = $1") : ACTIVE_WHERE;
    args.push(limit, offset);

    const res = await this.db.query<TicketRow>(
      `${TICKET_SELECT}
        WHERE ${where}
        ORDER BY o.created_at, o.id
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return res.rows;
  }

  async find(ticketId: string): Promise<TicketRow | null> {
    const res = await this.db.query<TicketRow>(`${TICKET_SELECT} WHERE o.id = $1`, [ticketId]);
    return res.rows[0] ?? null;
  }

  async advance(
    ticketId: string,
    from: string,
    target: TicketAdvanceTarget,
  ): Promise<TicketStatusRow | null> {
    const updated = await this.db.query<TicketStatusRow>(
      `UPDATE orders
          SET status = $1, updated_at = now()
        WHERE id = $2 AND status = $3
        RETURNING id, status`,
      [target, ticketId, from],
    );
    return updated.rows[0] ?? null;
  }

  /* Order port — the narrow read the service uses for association and for
     telling 404 apart from 409 without duplicating order logic. */
  async findOrder(orderId: string): Promise<TicketOrderRef | null> {
    const res = await this.db.query<TicketOrderRef>(
      "SELECT id AS order_id, table_id, status, created_at FROM orders WHERE id = $1",
      [orderId],
    );
    return res.rows[0] ?? null;
  }

  transaction<T>(work: (tx: TicketTransactionPort) => Promise<T>): Promise<T> {
    return this.db.transaction((client) =>
      work({
        lockTicket: (ticketId) => this.lockTicket(client, ticketId),
        markServed: (ticketId) => this.markServed(client, ticketId),
        markDenied: (ticketId, reason) => this.markDenied(client, ticketId, reason),
        clearWaiterPing: (tableId) => this.clearWaiterPing(client, tableId),
      }),
    );
  }

  async schemaObjects(): Promise<TicketSchemaPresence> {
    const res = await this.db.query<{
      orders: boolean;
      order_items: boolean;
      transition_trigger: boolean;
      active_unique: boolean;
      items_index: boolean;
    }>(
      `SELECT to_regclass('public.orders') IS NOT NULL AS orders,
              to_regclass('public.order_items') IS NOT NULL AS order_items,
              EXISTS (
                SELECT 1
                  FROM pg_trigger
                 WHERE tgname = 'orders_status_transition'
                   AND NOT tgisinternal
              ) AS transition_trigger,
              to_regclass('public.orders_one_active_uq') IS NOT NULL AS active_unique,
              to_regclass('public.order_items_order_idx') IS NOT NULL AS items_index`,
    );

    const row = res.rows[0];
    const found = [
      [SCHEMA_OBJECTS[0], row?.orders === true],
      [SCHEMA_OBJECTS[1], row?.order_items === true],
      [SCHEMA_OBJECTS[2], row?.transition_trigger === true],
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

  private async lockTicket(
    tx: DbTransaction,
    ticketId: string,
  ): Promise<TicketLifecycleRow | null> {
    const res = await tx.query<TicketLifecycleRow>(
      "SELECT id, table_id, status FROM orders WHERE id = $1 FOR UPDATE",
      [ticketId],
    );
    return res.rows[0] ?? null;
  }

  private async markServed(tx: DbTransaction, ticketId: string): Promise<void> {
    await tx.query("UPDATE orders SET status = 'served', updated_at = now() WHERE id = $1", [
      ticketId,
    ]);
  }

  private async markDenied(tx: DbTransaction, ticketId: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE orders
          SET status = 'denied', denial_reason = $2, updated_at = now()
        WHERE id = $1`,
      [ticketId, reason],
    );
  }

  /* The waiter's "on my way" ping was about this ticket; serving or refusing
     it makes the ping stale. */
  private async clearWaiterPing(tx: DbTransaction, tableId: string): Promise<void> {
    await tx.query("UPDATE restaurant_tables SET serve_requested_at = NULL WHERE id = $1", [
      tableId,
    ]);
  }
}
