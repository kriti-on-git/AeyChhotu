import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Kitchen lifecycle component: health and self-test are read-only existence
   checks over the kitchen's schema, and the module declares its real
   dependencies. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createKitchenModule } from "../src/modules/kitchen/kitchen.module.js";
import type { KitchenTicketPort } from "../src/modules/kitchen/kitchen.types.js";
import { buildMeta } from "../src/lib/util.js";

const tickets: KitchenTicketPort = {
  async listTickets() {
    return { data: [], meta: buildMeta(1, 20, 0) };
  },
  async advanceTicket() {
    throw new Error("not used");
  },
  async pruneTicket() {
    throw new Error("not used");
  },
  async denyTicket() {
    throw new Error("not used");
  },
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
            restaurant_tables: present,
            transition_trigger: present,
            active_unique: present,
          },
        ],
        rowCount: 1,
      };
    },
  } as unknown as DbPort;
  return { db, statements };
}

describe("Kitchen module lifecycle", () => {
  it("reports healthy when the board, association and trigger exist", async () => {
    const { db } = fakeDb(true);
    const module = createKitchenModule({ db, tickets });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual(health.details, {
      present: [
        "orders",
        "order_items",
        "restaurant_tables",
        "orders_status_transition",
        "orders_one_active_uq",
      ],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.name, "kitchen");
    assert.deepEqual(module.dependencies, ["database", "tickets"]);
  });

  it("names every missing object and stays unavailable", async () => {
    const { db } = fakeDb(false);
    const module = createKitchenModule({ db, tickets });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /restaurant_tables/);
    assert.match(health.message ?? "", /orders_status_transition/);
    assert.equal((await module.selfTest()).ok, false);
  });

  it("never reads or moves a ticket while checking its own health", async () => {
    const { db, statements } = fakeDb(true);
    const module = createKitchenModule({ db, tickets });

    await module.health();
    await module.selfTest();

    assert.ok(statements.length >= 2);
    for (const sql of statements) {
      assert.match(sql, /to_regclass|pg_trigger/);
      assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE|SELECT id, table_id/i);
    }
    assert.deepEqual(module.diagnostics(), {
      module: "kitchen",
      repository: "KitchenRepository",
      schema: {
        present: [
          "orders",
          "order_items",
          "restaurant_tables",
          "orders_status_transition",
          "orders_one_active_uq",
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

    const module = createKitchenModule({ db, tickets });
    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /connection refused/);
    assert.equal((await module.selfTest()).ok, false);
  });
});
