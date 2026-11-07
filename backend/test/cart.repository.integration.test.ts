import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for the Cart repository and service: shared rows,
   concurrent adds/steppers, note merging, ownership, 86 refusal, clearing and
   schema health. Gated on TEST_DATABASE_URL. */

import { AppError } from "../src/errors/app-error.js";
import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { CartRepository } from "../src/modules/cart/cart.repository.js";
import { CartService } from "../src/modules/cart/cart.service.js";
import type { CartRealtimePort } from "../src/modules/cart/cart.types.js";
import { MenuRepository } from "../src/modules/menu/menu.repository.js";
import { MenuService } from "../src/modules/menu/menu.service.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres cart checks skipped";

function uniqueCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
}

interface Harness {
  manager: DatabaseManager;
  service: CartService;
  repository: CartRepository;
  tableId: string;
  otherTableId: string;
  token: string;
  otherToken: string;
  itemId: string;
  unavailableItemId: string;
  published: Array<{ tableId: string; event: string }>;
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const token = uniqueCode("c");
  const otherToken = uniqueCode("d");
  const first = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [token, `Cart ${token}`],
  );
  const second = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [otherToken, `Cart ${otherToken}`],
  );
  const tableId = first.rows[0]?.id;
  const otherTableId = second.rows[0]?.id;
  assert.ok(tableId && otherTableId);

  const itemName = `Cart Dosa ${randomUUID().slice(0, 8)}`;
  const item = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 120, 'Main Course', 'Integration cart dish')
       RETURNING id`,
    [itemName],
  );
  const unavailable = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description, is_available)
          VALUES ($1, 90, 'Main Course', 'Sold out dish', false)
       RETURNING id`,
    [`Sold Out ${randomUUID().slice(0, 8)}`],
  );
  const itemId = item.rows[0]?.id;
  const unavailableItemId = unavailable.rows[0]?.id;
  assert.ok(itemId && unavailableItemId);

  const menuService = new MenuService({
    repository: new MenuRepository(manager),
    tables: {
      requireTable: async (code) => ({ id: tableId, code, name: "Window", status: "active" }),
    },
    orders: { denyPendingOrdersForItem: async () => 0 },
    images: {
      toDto: (row) => ({
        image_url: `/img/${row.menu_item_id}`,
        image_small_url: `/img/${row.menu_item_id}/small`,
        blur_data_url: row.blur_data_url,
      }),
    },
  });

  const published: Array<{ tableId: string; event: string }> = [];
  const realtime: CartRealtimePort = {
    toTable: (publishedTableId, event) => {
      published.push({ tableId: publishedTableId, event });
      return { room: `table:${publishedTableId}`, event, recipients: 0, skipped: true };
    },
  };

  const repository = new CartRepository(manager);
  const service = new CartService({
    repository,
    tables: {
      requireTable: async (code) => {
        if (code === token) {
          return { id: tableId, code, name: "Window", status: "active" };
        }
        if (code === otherToken) {
          return { id: otherTableId, code, name: "Corner", status: "active" };
        }
        throw new AppError(404, "TABLE_NOT_FOUND", "That table is not open.");
      },
    },
    menu: menuService,
    realtime,
  });

  const harness: Harness = {
    manager,
    service,
    repository,
    tableId,
    otherTableId,
    token,
    otherToken,
    itemId,
    unavailableItemId,
    published,
  };

  try {
    return await fn(harness);
  } finally {
    await manager.query("DELETE FROM cart_items WHERE table_id = ANY($1::uuid[])", [
      [tableId, otherTableId],
    ]);
    await manager.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [
      [itemId, unavailableItemId],
    ]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = ANY($1::uuid[])", [
      [tableId, otherTableId],
    ]);
    await manager.shutdown();
  }
}

describe("CartRepository/CartService — real Postgres", { skip: skipReason }, () => {
  it("reports the cart table and its indexes", async () => {
    await withHarness(async ({ repository }) => {
      const schema = await repository.schemaObjects();
      assert.deepEqual(schema.missing, []);
      assert.deepEqual(schema.present, [
        "cart_items",
        "cart_items_upsert_uq",
        "cart_items_table_created_idx",
      ]);
    });
  });

  it("persists one shared line, lists it and keeps attribution", async () => {
    await withHarness(async ({ service, token, itemId, tableId }) => {
      const first = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 2,
        request_note: "less spicy",
        added_by: " Asha ",
      });
      assert.equal(first.quantity, 2);
      assert.equal(first.added_by, "Asha");
      assert.equal(first.table_id, tableId);

      const second = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 1,
        request_note: "less spicy",
        added_by: "Ravi",
      });
      assert.equal(second.id, first.id);
      assert.equal(second.quantity, 3);
      assert.equal(second.total_table_quantity, 3);
      assert.equal(second.added_by, "Ravi");

      const listed = await service.listCart({ table_token: token, page: 1, limit: 20 });
      assert.equal(listed.data.length, 1);
      assert.equal(listed.meta.total, 1);
    });
  });

  it("serializes concurrent add taps and stepper deltas", async () => {
    await withHarness(async ({ service, token, itemId, repository, tableId }) => {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          service.addItem({
            table_token: token,
            menu_item_id: itemId,
            quantity: 1,
            added_by: "Asha",
          }),
        ),
      );

      const rows = await repository.listForTable(tableId, 20, 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.quantity, 8);

      const lineId = rows[0]?.id;
      assert.ok(lineId);

      await Promise.all(
        Array.from({ length: 8 }, () =>
          service.updateItem(lineId, { table_token: token, quantity_delta: 1 }),
        ),
      );

      const after = await repository.findLine(tableId, lineId);
      assert.equal(after?.quantity, 16);
      assert.equal(await repository.totalForTableItem(tableId, itemId), 16);
    });
  });

  it("rejects invalid quantities without changing the row", async () => {
    await withHarness(async ({ service, token, itemId, repository, tableId }) => {
      const line = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 2,
        added_by: "Asha",
      });

      await assert.rejects(
        () => service.updateItem(line.id, { table_token: token, quantity_delta: -2 }),
        (err: unknown) => err instanceof AppError && err.code === "VALIDATION_ERROR",
      );
      assert.equal((await repository.findLine(tableId, line.id))?.quantity, 2);
    });
  });

  it("merges note collisions atomically", async () => {
    await withHarness(async ({ service, token, itemId, repository, tableId }) => {
      const plain = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 2,
        added_by: "Asha",
      });
      const noted = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 1,
        request_note: "extra chutney",
        added_by: "Ravi",
      });
      assert.notEqual(plain.id, noted.id);

      const merged = await service.updateItem(noted.id, {
        table_token: token,
        quantity: 1,
        request_note: "",
      });

      assert.equal(merged.id, plain.id);
      assert.equal(merged.quantity, 3);
      assert.equal((await repository.listForTable(tableId, 20, 0)).length, 1);
    });
  });

  it("proves ownership, 86s unavailable dishes and clears only one table", async () => {
    await withHarness(async ({ service, token, otherToken, itemId, unavailableItemId, tableId, repository }) => {
      const own = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 1,
        added_by: "Asha",
      });
      const neighbour = await service.addItem({
        table_token: otherToken,
        menu_item_id: itemId,
        quantity: 2,
        added_by: "Ravi",
      });

      await assert.rejects(
        () => service.removeItem(otherToken, own.id),
        (err: unknown) => err instanceof AppError && err.code === "CART_ITEM_NOT_FOUND",
      );
      await assert.rejects(
        () =>
          service.addItem({
            table_token: token,
            menu_item_id: unavailableItemId,
            quantity: 1,
            added_by: "Asha",
          }),
        (err: unknown) => err instanceof AppError && err.code === "ITEM_UNAVAILABLE",
      );
      await assert.rejects(
        () => service.listCart({ table_token: "missing", page: 1, limit: 20 }),
        (err: unknown) => err instanceof AppError && err.code === "TABLE_NOT_FOUND",
      );

      const cleared = await service.clearCart(token);
      assert.equal(cleared.removed, 1);
      assert.equal((await repository.findLine(tableId, own.id)) ?? null, null);
      assert.equal((await repository.findLine(neighbour.table_id, neighbour.id))?.quantity, 2);
    });
  });

  it("removes one line and leaves the rest of the shared cart", async () => {
    await withHarness(async ({ service, token, itemId, unavailableItemId, tableId, repository }) => {
      const first = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 1,
        added_by: "Asha",
      });
      const second = await service.addItem({
        table_token: token,
        menu_item_id: itemId,
        quantity: 2,
        request_note: "no onion",
        added_by: "Ravi",
      });

      const removed = await service.removeItem(token, first.id);
      assert.equal(removed.id, first.id);
      assert.equal((await repository.listForTable(tableId, 20, 0)).length, 1);
      assert.equal((await repository.findLine(tableId, second.id))?.quantity, 2);
      assert.ok(unavailableItemId);
    });
  });
});
