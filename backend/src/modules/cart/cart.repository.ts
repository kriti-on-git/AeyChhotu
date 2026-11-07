/* Cart module — repository.

   Every cart_items statement lives here. Writes that need more than one
   statement expose a narrow transaction port, so the service can keep its
   business rules (delta arithmetic, note-collision merge) without seeing SQL.
   The unique index on (table_id, menu_item_id, request_note, allergy_note)
   remains the concurrency backstop for simultaneous add taps. */

import type {
  DbPort,
  DbTransaction,
} from "../../infrastructure/database/DatabaseManager.js";
import type {
  CartLineInsert,
  CartRepositoryPort,
  CartRow,
  CartSchemaPresence,
  CartTransactionPort,
} from "./cart.types.js";

const CART_COLUMNS =
  "id, table_id, menu_item_id, quantity, request_note, allergy_note, added_by";

const SCHEMA_OBJECTS = [
  "cart_items",
  "cart_items_upsert_uq",
  "cart_items_table_created_idx",
] as const;

export class CartRepository implements CartRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  async countForTable(tableId: string): Promise<number> {
    const res = await this.db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM cart_items WHERE table_id = $1",
      [tableId],
    );
    return res.rows[0]?.total ?? 0;
  }

  async listForTable(tableId: string, limit: number, offset: number): Promise<CartRow[]> {
    const res = await this.db.query<CartRow>(
      `SELECT ${CART_COLUMNS}
         FROM cart_items
        WHERE table_id = $1
        ORDER BY created_at, id
        LIMIT $2 OFFSET $3`,
      [tableId, limit, offset],
    );
    return res.rows;
  }

  async addLine(tableId: string, input: CartLineInsert): Promise<CartRow> {
    const res = await this.db.query<CartRow>(
      `INSERT INTO cart_items (table_id, menu_item_id, quantity, request_note, allergy_note, added_by)
            VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (table_id, menu_item_id, request_note, allergy_note)
         DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity,
                       added_by = EXCLUDED.added_by
       RETURNING ${CART_COLUMNS}`,
      [
        tableId,
        input.menuItemId,
        input.quantity,
        input.requestNote,
        input.allergyNote,
        input.addedBy,
      ],
    );

    const row = res.rows[0];
    if (!row) throw new Error("cart insert returned no row");
    return row;
  }

  async findLine(tableId: string, cartItemId: string): Promise<CartRow | null> {
    const res = await this.db.query<CartRow>(
      `SELECT ${CART_COLUMNS}
         FROM cart_items
        WHERE id = $1 AND table_id = $2`,
      [cartItemId, tableId],
    );
    return res.rows[0] ?? null;
  }

  async deleteLine(tableId: string, cartItemId: string): Promise<boolean> {
    const res = await this.db.query<{ id: string }>(
      "DELETE FROM cart_items WHERE id = $1 AND table_id = $2 RETURNING id",
      [cartItemId, tableId],
    );
    return res.rows.length > 0;
  }

  async deleteForTable(tableId: string): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      "DELETE FROM cart_items WHERE table_id = $1 RETURNING id",
      [tableId],
    );
    return res.rows.length;
  }

  async totalForTableItem(tableId: string, menuItemId: string): Promise<number> {
    const res = await this.db.query<{ total: number }>(
      `SELECT COALESCE(sum(quantity), 0)::int AS total
         FROM cart_items
        WHERE table_id = $1 AND menu_item_id = $2`,
      [tableId, menuItemId],
    );
    return res.rows[0]?.total ?? 0;
  }

  transaction<T>(work: (tx: CartTransactionPort) => Promise<T>): Promise<T> {
    return this.db.transaction((client) =>
      work({
        lockLine: (tableId, cartItemId) => this.lockLine(client, tableId, cartItemId),
        findClashingLine: (tableId, menuItemId, requestNote, allergyNote, excludeId) =>
          this.findClashingLine(
            client,
            tableId,
            menuItemId,
            requestNote,
            allergyNote,
            excludeId,
          ),
        mergeLine: (existingId, addQuantity) =>
          this.mergeLine(client, existingId, addQuantity),
        updateLine: (lineId, tableId, quantity, requestNote, allergyNote) =>
          this.updateLine(client, lineId, tableId, quantity, requestNote, allergyNote),
        deleteLine: (lineId) => this.deleteLineWith(client, lineId),
      }),
    );
  }

  async schemaObjects(): Promise<CartSchemaPresence> {
    const res = await this.db.query<{
      items: boolean;
      upsert_identity: boolean;
      listing_index: boolean;
    }>(
      `SELECT to_regclass('public.cart_items') IS NOT NULL AS items,
              to_regclass('public.cart_items_upsert_uq') IS NOT NULL AS upsert_identity,
              to_regclass('public.cart_items_table_created_idx') IS NOT NULL AS listing_index`,
    );

    const row = res.rows[0];
    const found = [
      [SCHEMA_OBJECTS[0], row?.items === true],
      [SCHEMA_OBJECTS[1], row?.upsert_identity === true],
      [SCHEMA_OBJECTS[2], row?.listing_index === true],
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

  private async lockLine(
    tx: DbTransaction,
    tableId: string,
    cartItemId: string,
  ): Promise<CartRow | null> {
    const res = await tx.query<CartRow>(
      `SELECT ${CART_COLUMNS}
         FROM cart_items
        WHERE id = $1 AND table_id = $2
          FOR UPDATE`,
      [cartItemId, tableId],
    );
    return res.rows[0] ?? null;
  }

  private async findClashingLine(
    tx: DbTransaction,
    tableId: string,
    menuItemId: string,
    requestNote: string,
    allergyNote: string,
    excludeId: string,
  ): Promise<CartRow | null> {
    const res = await tx.query<CartRow>(
      `SELECT ${CART_COLUMNS}
         FROM cart_items
        WHERE table_id = $1
          AND menu_item_id = $2
          AND request_note = $3
          AND allergy_note = $4
          AND id <> $5
          FOR UPDATE`,
      [tableId, menuItemId, requestNote, allergyNote, excludeId],
    );
    return res.rows[0] ?? null;
  }

  private async mergeLine(
    tx: DbTransaction,
    existingId: string,
    addQuantity: number,
  ): Promise<CartRow | null> {
    const res = await tx.query<CartRow>(
      `UPDATE cart_items
          SET quantity = LEAST(quantity + $2, 99)
        WHERE id = $1
        RETURNING ${CART_COLUMNS}`,
      [existingId, addQuantity],
    );
    return res.rows[0] ?? null;
  }

  private async updateLine(
    tx: DbTransaction,
    lineId: string,
    tableId: string,
    quantity: number,
    requestNote: string,
    allergyNote: string,
  ): Promise<CartRow | null> {
    const res = await tx.query<CartRow>(
      `UPDATE cart_items
          SET quantity     = $3,
              request_note = $4,
              allergy_note = $5
        WHERE id = $1 AND table_id = $2
        RETURNING ${CART_COLUMNS}`,
      [lineId, tableId, quantity, requestNote, allergyNote],
    );
    return res.rows[0] ?? null;
  }

  private async deleteLineWith(tx: DbTransaction, lineId: string): Promise<void> {
    await tx.query("DELETE FROM cart_items WHERE id = $1", [lineId]);
  }
}
