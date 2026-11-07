/* Inventory module — repository.

   This file owns all SQL for the stock columns and the movement ledger. The
   only writes are `setStock` and `adjustStock`, each wrapped in one
   transaction that locks the menu_items row first. The lock is what makes
   concurrent decrements safe: the second waiter re-reads the committed count
   instead of overwriting it from a stale snapshot.

   `menu_items` is read here rather than through the Menu module because the
   three stock columns are Inventory-owned (see inventory.types.ts). */
import { AppError } from "../../errors/app-error.js";
import type {
  DbPort,
  DbTransaction,
} from "../../infrastructure/database/DatabaseManager.js";
import type {
  AdjustStockInput,
  AvailabilityRow,
  InventoryItemRow,
  InventoryMovementRow,
  InventoryRepositoryPort,
  InventorySchemaPresence,
  SetStockInput,
} from "./inventory.types.js";

const ITEM_COLUMNS = `id, name, category, is_available, stock_quantity,
       low_stock_threshold, stock_updated_at`;

const MOVEMENT_COLUMNS = `id, menu_item_id, order_id, delta,
       previous_quantity, new_quantity, reason, created_at`;

const SCHEMA_OBJECTS = [
  "menu_items",
  "inventory_movements",
  "menu_items.stock_quantity",
  "menu_items.low_stock_threshold",
] as const;

export class InventoryRepository implements InventoryRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  async listStock(): Promise<InventoryItemRow[]> {
    const res = await this.db.query<InventoryItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM menu_items
        WHERE deleted_at IS NULL
        ORDER BY (stock_quantity IS NULL), stock_quantity ASC, name`,
    );
    return res.rows;
  }

  async findItem(menuItemId: string): Promise<InventoryItemRow | null> {
    const res = await this.db.query<InventoryItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM menu_items
        WHERE id = $1 AND deleted_at IS NULL`,
      [menuItemId],
    );
    return res.rows[0] ?? null;
  }

  async listMovements(menuItemId: string, limit: number): Promise<InventoryMovementRow[]> {
    const res = await this.db.query<InventoryMovementRow>(
      `SELECT ${MOVEMENT_COLUMNS}
         FROM inventory_movements
        WHERE menu_item_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [menuItemId, limit],
    );
    return res.rows;
  }

  async setStock(
    menuItemId: string,
    input: SetStockInput,
  ): Promise<{ item: InventoryItemRow; movement: InventoryMovementRow } | null> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockItem(tx, menuItemId);
      if (!current) return null;

      const threshold = input.low_stock_threshold ?? current.low_stock_threshold;
      /* Omitted means "leave the count alone" — a threshold-only patch. */
      const nextQuantity =
        input.stock_quantity === undefined
          ? current.stock_quantity
          : input.stock_quantity;
      /* No delta when either side is untracked, or when only the threshold
         changed: the ledger CHECK rejects a zero movement. */
      const delta =
        current.stock_quantity === null ||
        nextQuantity === null ||
        nextQuantity === current.stock_quantity
          ? null
          : nextQuantity - current.stock_quantity;

      const item = await this.writeStock(tx, menuItemId, nextQuantity, threshold);
      if (!item) return null;

      const movement = await this.appendMovement(tx, {
        menuItemId,
        orderId: null,
        delta,
        previous: current.stock_quantity,
        next: nextQuantity,
        reason: "manual",
      });

      return { item, movement };
    });
  }

  async adjustStock(
    menuItemId: string,
    input: AdjustStockInput,
  ): Promise<{ item: InventoryItemRow; movement: InventoryMovementRow } | null> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockItem(tx, menuItemId);
      if (!current) return null;

      if (current.stock_quantity === null) {
        throw new AppError(
          409,
          "STOCK_UNTRACKED",
          `${current.name} has no tracked count. Set a stock level before adjusting it.`,
          { menu_item_id: menuItemId },
        );
      }

      const next = current.stock_quantity + input.delta;
      if (next < 0) {
        throw new AppError(
          409,
          "NEGATIVE_STOCK",
          `Only ${current.stock_quantity} of ${current.name} remain.`,
          {
            menu_item_id: menuItemId,
            available: current.stock_quantity,
            requested: Math.abs(input.delta),
          },
        );
      }

      const item = await this.writeStock(
        tx,
        menuItemId,
        next,
        current.low_stock_threshold,
      );
      if (!item) return null;

      const movement = await this.appendMovement(tx, {
        menuItemId,
        orderId: input.order_id ?? null,
        delta: input.delta,
        previous: current.stock_quantity,
        next,
        reason: input.reason,
      });

      return { item, movement };
    });
  }

  async findAvailability(menuItemIds: readonly string[]): Promise<AvailabilityRow[]> {
    if (menuItemIds.length === 0) return [];

    const res = await this.db.query<AvailabilityRow>(
      `SELECT id AS menu_item_id, name, is_available, stock_quantity
         FROM menu_items
        WHERE id = ANY($1::uuid[])
          AND deleted_at IS NULL`,
      [menuItemIds],
    );
    return res.rows;
  }

  async schemaObjects(): Promise<InventorySchemaPresence> {
    const res = await this.db.query<{
      items: boolean;
      movements: boolean;
      stock_column: boolean;
      threshold_column: boolean;
    }>(
      `SELECT to_regclass('public.menu_items') IS NOT NULL AS items,
              to_regclass('public.inventory_movements') IS NOT NULL AS movements,
              EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'menu_items'
                   AND column_name = 'stock_quantity'
              ) AS stock_column,
              EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'menu_items'
                   AND column_name = 'low_stock_threshold'
              ) AS threshold_column`,
    );

    const row = res.rows[0];
    const found = [
      [SCHEMA_OBJECTS[0], row?.items === true],
      [SCHEMA_OBJECTS[1], row?.movements === true],
      [SCHEMA_OBJECTS[2], row?.stock_column === true],
      [SCHEMA_OBJECTS[3], row?.threshold_column === true],
    ] as const;

    const present: string[] = [];
    const missing: string[] = [];
    for (const [name, exists] of found) {
      if (exists) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }

  /* ------------------------------------------------------------ internals */

  private async lockItem(
    tx: DbTransaction,
    menuItemId: string,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM menu_items
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [menuItemId],
    );
    return res.rows[0] ?? null;
  }

  private async writeStock(
    tx: DbTransaction,
    menuItemId: string,
    quantity: number | null,
    threshold: number,
  ): Promise<InventoryItemRow | null> {
    const res = await tx.query<InventoryItemRow>(
      `UPDATE menu_items
          SET stock_quantity      = $2,
              low_stock_threshold = $3,
              stock_updated_at    = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${ITEM_COLUMNS}`,
      [menuItemId, quantity, threshold],
    );
    return res.rows[0] ?? null;
  }

  private async appendMovement(
    tx: DbTransaction,
    input: {
      menuItemId: string;
      orderId: string | null;
      delta: number | null;
      previous: number | null;
      next: number | null;
      reason: string;
    },
  ): Promise<InventoryMovementRow> {
    const res = await tx.query<InventoryMovementRow>(
      `INSERT INTO inventory_movements
         (menu_item_id, order_id, delta, previous_quantity, new_quantity, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${MOVEMENT_COLUMNS}`,
      [
        input.menuItemId,
        input.orderId,
        input.delta,
        input.previous,
        input.next,
        input.reason,
      ],
    );

    const row = res.rows[0];
    if (!row) {
      throw new Error("inventory movement insert returned no row");
    }
    return row;
  }
}
