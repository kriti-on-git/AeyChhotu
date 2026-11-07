/* Table module — repository.

   EVERY query that touches a table's session, roster, presence or seating
   cleanup lives here. The service composes transactions through
   `transaction()`; it never sees pg, a pool or SQL.

   Behaviour is a direct port of services/sessions.service.ts so the HTTP
   contract cannot drift: same columns, same locks, same cleanup order. */

import type { DbPort, DbTransaction } from "../../infrastructure/database/DatabaseManager.js";
import type {
  ActiveOrderRow,
  BillRow,
  LockedTableRow,
  MemberRow,
  OrderCounts,
  PresenceRow,
  ReleaseCandidateRow,
  SchemaPresence,
  SessionRow,
  TableMemberInput,
  TableRecord,
  TableRepositoryPort,
  TableStateRow,
} from "./table.types.js";

const SESSION_COLUMNS =
  "id, code, name, status, session_pin, session_secret, failed_pin_attempts, session_started_at, bill_status, last_cleared_at";

const MEMBER_UPSERT_SQL = `INSERT INTO table_members (table_id, user_id, name)
      VALUES ($1, $2, $3)
 ON CONFLICT (table_id, user_id)
   DO UPDATE SET name = EXCLUDED.name`;

const SCHEMA_OBJECTS = [
  "restaurant_tables",
  "table_members",
  "table_device_presence",
] as const;

export class TableRepository implements TableRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /* --------------------------------------------------------------- reads */

  async findTableByCode(code: string): Promise<TableRecord | null> {
    const res = await this.db.query<TableRecord>(
      "SELECT id, code, name, status FROM restaurant_tables WHERE code = $1 AND deleted_at IS NULL",
      [code],
    );
    return res.rows[0] ?? null;
  }

  async findSessionByCode(code: string): Promise<SessionRow | null> {
    const res = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM restaurant_tables
        WHERE code = $1 AND deleted_at IS NULL`,
      [code],
    );
    return res.rows[0] ?? null;
  }

  async lockSessionByCode(tx: DbTransaction, code: string): Promise<SessionRow | null> {
    const res = await tx.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM restaurant_tables
        WHERE code = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [code],
    );
    return res.rows[0] ?? null;
  }

  async listMembers(tableId: string): Promise<MemberRow[]> {
    const res = await this.db.query<MemberRow>(
      `SELECT user_id, name, joined_at
         FROM table_members
        WHERE table_id = $1
        ORDER BY joined_at, id`,
      [tableId],
    );
    return res.rows;
  }

  async findTableState(
    tableToken: string,
    presenceWindowSeconds: number,
  ): Promise<TableStateRow | null> {
    const res = await this.db.query<TableStateRow>(
      `SELECT t.id,
              t.code,
              t.name,
              t.status,
              t.bill_status,
              t.bill_requested_at,
              t.bill_paid_at,
              t.session_started_at,
              (SELECT count(*)::int
                 FROM table_device_presence p
                WHERE p.table_id = t.id
                  AND p.last_seen > now() - ($2 || ' seconds')::interval) AS active_devices,
              (SELECT count(*)::int
                 FROM orders o
                WHERE o.table_id = t.id
                  AND o.status IN ('pending', 'preparing', 'ready')) AS active_orders
         FROM restaurant_tables t
        WHERE t.code = $1 AND t.deleted_at IS NULL`,
      [tableToken, presenceWindowSeconds],
    );
    return res.rows[0] ?? null;
  }

  async findBill(tableId: string): Promise<BillRow | null> {
    const res = await this.db.query<BillRow>(
      `SELECT id, bill_status, bill_requested_at
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL`,
      [tableId],
    );
    return res.rows[0] ?? null;
  }

  async findActiveOrder(tableId: string): Promise<ActiveOrderRow | null> {
    const res = await this.db.query<ActiveOrderRow>(
      `SELECT id, status
         FROM orders
        WHERE table_id = $1
          AND status IN ('pending', 'preparing', 'ready')
        ORDER BY created_at DESC
        LIMIT 1`,
      [tableId],
    );
    return res.rows[0] ?? null;
  }

  /* -------------------------------------------------------------- writes */

  async startSession(
    tx: DbTransaction,
    tableId: string,
    pin: string,
    secret: string,
  ): Promise<SessionRow | null> {
    const res = await tx.query<SessionRow>(
      `UPDATE restaurant_tables
          SET status              = 'active',
              session_pin         = $2,
              session_secret      = $3,
              failed_pin_attempts = 0,
              session_started_at  = now()
        WHERE id = $1
        RETURNING ${SESSION_COLUMNS}`,
      [tableId, pin, secret],
    );
    return res.rows[0] ?? null;
  }

  async incrementPinAttempts(tx: DbTransaction, tableId: string): Promise<number> {
    const res = await tx.query<{ failed_pin_attempts: number }>(
      `UPDATE restaurant_tables
          SET failed_pin_attempts = failed_pin_attempts + 1
        WHERE id = $1
        RETURNING failed_pin_attempts`,
      [tableId],
    );
    return res.rows[0]?.failed_pin_attempts ?? 0;
  }

  async clearPinAttempts(tx: DbTransaction, tableId: string): Promise<SessionRow | null> {
    const res = await tx.query<SessionRow>(
      `UPDATE restaurant_tables
          SET failed_pin_attempts = 0
        WHERE id = $1
        RETURNING ${SESSION_COLUMNS}`,
      [tableId],
    );
    return res.rows[0] ?? null;
  }

  async upsertMember(
    tx: DbTransaction,
    tableId: string,
    member: TableMemberInput | undefined,
  ): Promise<void> {
    const userId = member?.user_id?.trim();
    if (!userId || !member) return;

    await tx.query(MEMBER_UPSERT_SQL, [tableId, userId, member.name]);
  }

  async upsertMemberBestEffort(
    tableId: string,
    member: TableMemberInput | undefined,
  ): Promise<void> {
    const userId = member?.user_id?.trim();
    if (!userId || !member) return;

    await this.db.query(MEMBER_UPSERT_SQL, [tableId, userId, member.name]);
  }

  async recordHeartbeat(tableId: string, deviceId: string): Promise<PresenceRow | null> {
    const res = await this.db.query<PresenceRow>(
      `INSERT INTO table_device_presence (table_id, device_id, last_seen)
            VALUES ($1, $2, now())
       ON CONFLICT (table_id, device_id)
         DO UPDATE SET last_seen = now()
       RETURNING device_id, last_seen`,
      [tableId, deviceId],
    );
    return res.rows[0] ?? null;
  }

  async removePresence(tableId: string, deviceId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM table_device_presence WHERE table_id = $1 AND device_id = $2",
      [tableId, deviceId],
    );
  }

  async requestBill(tableId: string): Promise<BillRow | null> {
    const res = await this.db.query<BillRow>(
      `UPDATE restaurant_tables
          SET bill_status       = 'requested',
              bill_requested_at = now()
        WHERE id = $1
          AND deleted_at IS NULL
          AND bill_status = 'unrequested'
        RETURNING id, bill_status, bill_requested_at`,
      [tableId],
    );
    return res.rows[0] ?? null;
  }

  /* ----------------------------------------------------------- lifecycle */

  async lockTable(tx: DbTransaction, tableId: string): Promise<LockedTableRow | null> {
    const res = await tx.query<LockedTableRow>(
      `SELECT id, bill_status, session_started_at
         FROM restaurant_tables
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [tableId],
    );
    return res.rows[0] ?? null;
  }

  async releaseCandidate(
    tx: DbTransaction,
    tableId: string,
    presenceWindowSeconds: number,
  ): Promise<ReleaseCandidateRow | null> {
    const res = await tx.query<ReleaseCandidateRow>(
      `SELECT t.bill_status,
              (SELECT count(*)::int
                 FROM orders o
                WHERE o.table_id = t.id
                  AND o.status IN ('pending', 'preparing', 'ready')) AS active_orders,
              (SELECT count(*)::int
                 FROM table_device_presence p
                WHERE p.table_id = t.id
                  AND p.last_seen > now() - ($2 || ' seconds')::interval) AS active_devices
         FROM restaurant_tables t
        WHERE t.id = $1`,
      [tableId, presenceWindowSeconds],
    );
    return res.rows[0] ?? null;
  }

  async countOrders(
    tx: DbTransaction,
    tableId: string,
    sessionStartedAt: Date | null,
  ): Promise<OrderCounts> {
    const res = await tx.query<OrderCounts>(
      `SELECT count(*)::int AS order_count,
              count(*) FILTER (
                WHERE created_at >= $2
                  AND status <> 'denied'
              )::int AS session_order_count,
              count(*) FILTER (
                WHERE status IN ('pending', 'preparing', 'ready')
              )::int AS active_orders
         FROM orders
        WHERE table_id = $1`,
      [tableId, sessionStartedAt],
    );
    return res.rows[0] ?? { order_count: 0, session_order_count: 0, active_orders: 0 };
  }

  async cancelActiveOrders(tx: DbTransaction, tableId: string): Promise<void> {
    await tx.query(
      `UPDATE orders
          SET status        = 'denied',
              denial_reason = COALESCE(NULLIF(denial_reason, ''), 'Table cleared by staff'),
              updated_at    = now()
        WHERE table_id = $1
          AND status IN ('pending', 'preparing', 'ready')`,
      [tableId],
    );
  }

  /** Hand the table to its next party: credentials, bill, roster, presence,
      cart and this seating's tickets all go. Served tickets were already
      rolled up into sales_day by the database trigger (sql/012). */
  async clearTableRows(tx: DbTransaction, tableId: string): Promise<void> {
    await tx.query(
      `UPDATE restaurant_tables
          SET status              = 'empty',
              session_pin         = NULL,
              session_secret      = NULL,
              failed_pin_attempts = 0,
              session_started_at  = NULL,
              bill_status         = 'unrequested',
              bill_requested_at   = NULL,
              bill_paid_at        = NULL,
              clear_requested_at  = NULL,
              last_cleared_at     = now()
        WHERE id = $1`,
      [tableId],
    );

    await tx.query("DELETE FROM cart_items WHERE table_id = $1", [tableId]);
    await tx.query("DELETE FROM table_members WHERE table_id = $1", [tableId]);
    await tx.query("DELETE FROM table_device_presence WHERE table_id = $1", [tableId]);
    await tx.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
  }

  /* -------------------------------------------------------------- health */

  async schemaObjects(): Promise<SchemaPresence> {
    const res = await this.db.query<{ tables: boolean; members: boolean; presence: boolean }>(
      `SELECT to_regclass('public.restaurant_tables') IS NOT NULL AS tables,
              to_regclass('public.table_members') IS NOT NULL AS members,
              to_regclass('public.table_device_presence') IS NOT NULL AS presence`,
    );

    const row = res.rows[0];
    const present: string[] = [];
    const missing: string[] = [];
    const found = [
      [SCHEMA_OBJECTS[0], row?.tables === true],
      [SCHEMA_OBJECTS[1], row?.members === true],
      [SCHEMA_OBJECTS[2], row?.presence === true],
    ] as const;

    for (const [name, exists] of found) {
      if (exists) present.push(name);
      else missing.push(name);
    }

    return { present, missing };
  }
}
