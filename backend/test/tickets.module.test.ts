import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Tickets lifecycle component: health and self-test through a fake database,
   proving both are existence checks (no writes, no ticket moves) and that a
   broken Orders dependency is declared. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createTicketsModule } from "../src/modules/tickets/tickets.module.js";

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
            transition_trigger: present,
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

describe("Tickets module lifecycle", () => {
  it("reports healthy when the projection and state-machine trigger exist", async () => {
    const { db } = fakeDb(true);
    const module = createTicketsModule({ db });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual(health.details, {
      present: [
        "orders",
        "order_items",
        "orders_status_transition",
        "orders_one_active_uq",
        "order_items_order_idx",
      ],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.name, "tickets");
    assert.deepEqual(module.dependencies, ["database", "orders"]);
  });

  it("names every missing object and stays unavailable", async () => {
    const { db } = fakeDb(false);
    const module = createTicketsModule({ db });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /orders_status_transition/);
    assert.match(health.message ?? "", /order_items_order_idx/);

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, false);
  });

  it("never moves a ticket while checking its own health", async () => {
    const { db, statements } = fakeDb(true);
    const module = createTicketsModule({ db });

    await module.health();
    await module.selfTest();

    assert.ok(statements.length >= 2);
    for (const sql of statements) {
      assert.match(sql, /to_regclass|pg_trigger/);
      assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE|SELECT id, table_id/i);
    }
    assert.deepEqual(module.diagnostics(), {
      module: "tickets",
      repository: "TicketsRepository",
      schema: {
        present: [
          "orders",
          "order_items",
          "orders_status_transition",
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

    const module = createTicketsModule({ db });
    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /connection refused/);

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, false);
  });
});
