import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Orders lifecycle component: health and self-test through a fake database,
   proving both are existence checks (no writes) and degrade safely. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createOrdersModule } from "../src/modules/orders/orders.module.js";

const tables = {
  requireTable: async (token: string) => ({
    id: "table-1",
    code: token,
    name: "Window",
    status: "active",
  }),
};

function fakeDb(present: boolean) {
  const statements: string[] = [];
  const db = {
    async query(text: string) {
      statements.push(text);
      return {
        rows: [
          {
            orders: present,
            order_items: present,
            fire_order: present,
            active_unique: present,
            items_index: present,
          },
        ],
        rowCount: 1,
      };
    },
  } as unknown as DbPort;

  return { db, statements };
}

describe("Orders module lifecycle", () => {
  it("reports healthy when the tables, function and indexes exist", async () => {
    const { db } = fakeDb(true);
    const module = createOrdersModule({ db, tables });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual(health.details, {
      present: [
        "orders",
        "order_items",
        "fire_order",
        "orders_one_active_uq",
        "order_items_order_idx",
      ],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.name, "orders");
    assert.deepEqual(module.dependencies, ["database"]);
  });

  it("names every missing object and stays unavailable", async () => {
    const { db } = fakeDb(false);
    const module = createOrdersModule({ db, tables });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /fire_order/);
    assert.match(health.message ?? "", /orders_one_active_uq/);

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, false);
    assert.match(selfTest.message ?? "", /order_items_order_idx/);
  });

  it("never writes while checking its own health", async () => {
    const { db, statements } = fakeDb(true);
    const module = createOrdersModule({ db, tables });

    await module.health();
    await module.selfTest();

    assert.ok(statements.length >= 2);
    for (const sql of statements) {
      assert.match(sql, /to_regclass|pg_proc/);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/i);
    }
    assert.deepEqual(module.diagnostics(), {
      module: "orders",
      repository: "OrdersRepository",
      schema: {
        present: [
          "orders",
          "order_items",
          "fire_order",
          "orders_one_active_uq",
          "order_items_order_idx",
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

    const module = createOrdersModule({ db, tables });
    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /connection refused/);

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, false);
  });
});
