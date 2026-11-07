import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Cart lifecycle component: health, self-test and diagnostics through a fake
   database, proving the checks are read-only and degrade safely. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createCartModule } from "../src/modules/cart/cart.module.js";

const tables = {
  requireTable: async (token: string) => ({
    id: "table-1",
    code: token,
    name: "Window",
    status: "active",
  }),
};

const menu = {
  findCartItem: async () => ({
    menu_item_id: "item-1",
    name: "Dosa",
    is_available: true,
  }),
};

const realtime = {
  toTable: () => ({ room: "table:table-1", event: "cart.item.added", recipients: 0, skipped: true }),
};

function fakeDb(present: boolean): DbPort {
  return {
    async query() {
      return {
        rows: [{ items: present, upsert_identity: present, listing_index: present }],
        rowCount: 1,
      };
    },
  } as unknown as DbPort;
}

describe("Cart module lifecycle", () => {
  it("reports healthy when the table and both indexes exist", async () => {
    const module = createCartModule({
      db: fakeDb(true),
      tables,
      menu,
      realtime,
    });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual(health.details, {
      present: ["cart_items", "cart_items_upsert_uq", "cart_items_table_created_idx"],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.dependencies[0] ?? null, "database");
  });

  it("reports unhealthy with the missing objects named", async () => {
    const module = createCartModule({
      db: fakeDb(false),
      tables,
      menu,
      realtime,
    });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /cart_items_upsert_uq/);

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, false);
  });
});
