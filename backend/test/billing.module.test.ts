import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Billing lifecycle component: read-only schema probes and an honest
   dependency list. No bill is generated or settled by a health check. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createBillingModule } from "../src/modules/billing/billing.module.js";

function fakeDb(present: boolean) {
  const statements: string[] = [];
  const db = {
    async query(text: string) {
      statements.push(text);
      return {
        rows: [{ tables: present, orders: present, order_items: present }],
        rowCount: 1,
      };
    },
  } as unknown as DbPort;
  return { db, statements };
}

describe("Billing module lifecycle", () => {
  it("reports healthy when its source tables exist", async () => {
    const { db } = fakeDb(true);
    const module = createBillingModule({ db });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual(health.details, {
      present: ["restaurant_tables", "orders", "order_items"],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.name, "billing");
    assert.deepEqual(module.dependencies, ["database", "orders", "table"]);
  });

  it("names missing objects and stays unavailable", async () => {
    const { db } = fakeDb(false);
    const module = createBillingModule({ db });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /restaurant_tables/);
    assert.match(health.message ?? "", /order_items/);
    assert.equal((await module.selfTest()).ok, false);
  });

  it("only runs read-only catalog checks", async () => {
    const { db, statements } = fakeDb(true);
    const module = createBillingModule({ db });

    await module.health();
    await module.selfTest();

    assert.ok(statements.length >= 2);
    for (const sql of statements) {
      assert.match(sql, /to_regclass/);
      assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE/i);
    }
    assert.deepEqual(module.diagnostics(), {
      module: "billing",
      repository: "BillingRepository",
      schema: {
        present: ["restaurant_tables", "orders", "order_items"],
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

    const module = createBillingModule({ db });
    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /connection refused/);
    assert.equal((await module.selfTest()).ok, false);
  });
});
