import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Inventory lifecycle component: read-only schema probes, an honest
   dependency list and no stock write during a check. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createInventoryModule } from "../src/modules/inventory/inventory.module.js";

function fakeDb(present: boolean) {
  const statements: string[] = [];
  const db = {
    async query(text: string) {
      statements.push(text);
      return {
        rows: [
          {
            items: present,
            movements: present,
            stock_column: present,
            threshold_column: present,
          },
        ],
        rowCount: 1,
      };
    },
  } as unknown as DbPort;
  return { db, statements };
}

describe("Inventory module lifecycle", () => {
  it("reports healthy when the stock columns and ledger exist", async () => {
    const { db } = fakeDb(true);
    const module = createInventoryModule({ db });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual(health.details, {
      present: [
        "menu_items",
        "inventory_movements",
        "menu_items.stock_quantity",
        "menu_items.low_stock_threshold",
      ],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.name, "inventory");
    assert.deepEqual(module.dependencies, ["database", "menu"]);
  });

  it("names every missing object and stays unhealthy", async () => {
    const { db } = fakeDb(false);
    const module = createInventoryModule({ db });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /inventory_movements/);
    assert.match(health.message ?? "", /stock_quantity/);
    assert.equal((await module.selfTest()).ok, false);
  });

  it("runs only read-only catalog checks", async () => {
    const { db, statements } = fakeDb(true);
    const module = createInventoryModule({ db });

    await module.health();
    await module.selfTest();

    assert.ok(statements.length >= 2);
    for (const sql of statements) {
      assert.match(sql, /to_regclass|information_schema/);
      assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE/i);
    }
    assert.deepEqual(module.diagnostics(), {
      module: "inventory",
      repository: "InventoryRepository",
      schema: {
        present: [
          "menu_items",
          "inventory_movements",
          "menu_items.stock_quantity",
          "menu_items.low_stock_threshold",
        ],
        missing: [],
      },
    });
  });

  it("reports unhealthy instead of throwing when the probe fails", async () => {
    const db = {
      async query() {
        throw new Error("connection refused");
      },
    } as unknown as DbPort;

    const module = createInventoryModule({ db });
    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /connection refused/);
    assert.equal((await module.selfTest()).ok, false);
  });
});
