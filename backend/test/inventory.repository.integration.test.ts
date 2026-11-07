import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for Inventory: untracked reads, absolute counts,
   signed adjustments, the movement ledger, negative-stock refusal and
   rollback, row-lock serialization of concurrent decrements, restoration,
   availability decisions and schema health. Gated on TEST_DATABASE_URL. */

import { AppError } from "../src/errors/app-error.js";
import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { createInventoryModule } from "../src/modules/inventory/inventory.module.js";
import { InventoryRepository } from "../src/modules/inventory/inventory.repository.js";
import { InventoryService } from "../src/modules/inventory/inventory.service.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres inventory checks skipped";

interface Harness {
  manager: DatabaseManager;
  repository: InventoryRepository;
  service: InventoryService;
  module: ReturnType<typeof createInventoryModule>;
  itemId: string;
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const item = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 120.00, 'Main Course', 'Inventory integration dish')
       RETURNING id`,
    [`Inventory Dosa ${randomUUID().slice(0, 8)}`],
  );
  const itemId = item.rows[0]?.id;
  assert.ok(itemId);

  const repository = new InventoryRepository(manager);
  const service = new InventoryService({ repository });
  const module = createInventoryModule({ db: manager });

  try {
    return await fn({ manager, repository, service, module, itemId });
  } finally {
    await manager.query("DELETE FROM inventory_movements WHERE menu_item_id = $1", [itemId]);
    await manager.query("DELETE FROM menu_items WHERE id = $1", [itemId]);
    await manager.shutdown();
  }
}

describe("Inventory module — real Postgres", () => {
  it("reads an untracked dish without treating NULL as zero", async () => {
    await withHarness(async ({ service, itemId }) => {
      const item = await service.getItem(itemId);
      assert.equal(item.stock_quantity, null);
      assert.equal(item.state, "untracked");
      assert.equal(item.low_stock_threshold, 5);

      /* The seed database has other untracked dishes, so assert on this item
         and on the ledger's presence rather than a global count. */
      const stock = await service.listStock({ state: "untracked" });
      assert.ok(stock.summary.untracked >= 1);
      assert.equal(stock.items.find((row) => row.menu_item_id === itemId)?.state, "untracked");
    });
  });

  it("sets a count, reduces it and records both movements", async () => {
    await withHarness(async ({ service, itemId }) => {
      const set = await service.setStock(itemId, { stock_quantity: 10 });
      assert.equal(set.stock_quantity, 10);
      assert.equal(set.state, "ok");

      const reduced = await service.adjustStock(itemId, {
        delta: -4,
        reason: "wastage",
      });
      assert.equal(reduced.stock_quantity, 6);

      const movements = await service.listMovements(itemId, 10);
      assert.deepEqual(
        movements.map((movement) => [
          movement.delta,
          movement.previous_quantity,
          movement.new_quantity,
          movement.reason,
        ]),
        [
          [-4, 10, 6, "wastage"],
          [null, null, 10, "manual"],
        ],
      );
    });
  });

  it("keeps a threshold-only patch valid (no zero-delta movement)", async () => {
    await withHarness(async ({ service, itemId }) => {
      await service.setStock(itemId, { stock_quantity: 8 });
      const item = await service.setStock(itemId, { low_stock_threshold: 2 });

      assert.equal(item.stock_quantity, 8);
      assert.equal(item.low_stock_threshold, 2);
      assert.equal(item.state, "ok");

      const movements = await service.listMovements(itemId, 10);
      assert.equal(movements[0]?.delta, null);
      assert.equal(movements[0]?.previous_quantity, 8);
      assert.equal(movements[0]?.new_quantity, 8);
    });
  });

  it("serializes concurrent decrements and never goes negative", async () => {
    await withHarness(async ({ service, itemId }) => {
      await service.setStock(itemId, { stock_quantity: 1 });

      const results = await Promise.allSettled([
        service.adjustStock(itemId, { delta: -1, reason: "order" }),
        service.adjustStock(itemId, { delta: -1, reason: "order" }),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0]?.reason as AppError).code, "NEGATIVE_STOCK");

      const item = await service.getItem(itemId);
      assert.equal(item.stock_quantity, 0);
      assert.equal(item.state, "out");

      const reductions = (await service.listMovements(itemId, 100)).filter(
        (movement) => movement.delta === -1,
      );
      assert.equal(reductions.length, 1);
    });
  });

  it("rolls back a refused reduction and leaves the ledger untouched", async () => {
    await withHarness(async ({ service, manager, itemId }) => {
      await service.setStock(itemId, { stock_quantity: 2 });

      await assert.rejects(
        service.adjustStock(itemId, { delta: -3, reason: "wastage" }),
        (err) => err instanceof AppError && err.code === "NEGATIVE_STOCK",
      );

      const item = await service.getItem(itemId);
      assert.equal(item.stock_quantity, 2);
      assert.equal((await service.listMovements(itemId, 10)).length, 1);

      const row = await manager.query<{ stock_quantity: number }>(
        "SELECT stock_quantity FROM menu_items WHERE id = $1",
        [itemId],
      );
      assert.equal(row.rows[0]?.stock_quantity, 2);
    });
  });

  it("refuses to adjust an untracked dish and writes nothing", async () => {
    await withHarness(async ({ service, itemId }) => {
      await assert.rejects(
        service.adjustStock(itemId, { delta: 1, reason: "delivery" }),
        (err) => err instanceof AppError && err.code === "STOCK_UNTRACKED",
      );
      assert.equal((await service.listMovements(itemId, 10)).length, 0);
      assert.equal((await service.getItem(itemId)).stock_quantity, null);
    });
  });

  it("restores stock through a positive order_restore movement", async () => {
    await withHarness(async ({ service, itemId }) => {
      await service.setStock(itemId, { stock_quantity: 3 });
      await service.adjustStock(itemId, { delta: -2, reason: "order" });

      const restored = await service.restoreStock(itemId, { quantity: 2 });
      assert.equal(restored.stock_quantity, 3);

      const movements = await service.listMovements(itemId, 10);
      assert.equal(movements[0]?.reason, "order_restore");
      assert.equal(movements[0]?.delta, 2);
      assert.equal(movements[0]?.new_quantity, 3);
    });
  });

  it("explains out-of-stock, insufficient, 86'd and unknown lines", async () => {
    await withHarness(async ({ service, manager, itemId }) => {
      await service.setStock(itemId, { stock_quantity: 0 });
      const [out] = await service.checkAvailability([{ menu_item_id: itemId }]);
      assert.equal(out?.reason, "out_of_stock");

      await service.setStock(itemId, { stock_quantity: 2 });
      const [insufficient] = await service.checkAvailability([
        { menu_item_id: itemId, quantity: 3 },
      ]);
      assert.equal(insufficient?.reason, "insufficient_stock");

      await manager.query("UPDATE menu_items SET is_available = false WHERE id = $1", [itemId]);
      const [unavailable] = await service.checkAvailability([{ menu_item_id: itemId }]);
      assert.equal(unavailable?.reason, "unavailable");

      const [unknown] = await service.checkAvailability([
        { menu_item_id: "99999999-9999-4999-8999-999999999999" },
      ]);
      assert.equal(unknown?.reason, "unknown_item");
    });
  });

  it("passes its schema health check", async () => {
    await withHarness(async ({ repository, module }) => {
      assert.deepEqual(await repository.schemaObjects(), {
        present: [
          "menu_items",
          "inventory_movements",
          "menu_items.stock_quantity",
          "menu_items.low_stock_threshold",
        ],
        missing: [],
      });
      assert.equal((await module.health()).state, "HEALTHY");
      assert.equal((await module.selfTest()).ok, true);
    });
  });
});
