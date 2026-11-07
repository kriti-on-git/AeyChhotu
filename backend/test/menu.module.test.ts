import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The Menu module as a lifecycle component: health and self-test must be
   read-only and must report missing schema instead of throwing. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createMenuModule } from "../src/modules/menu/menu.module.js";

function moduleWith(rows: Array<Record<string, unknown>>, fail = false) {
  const db = {
    query: async () => {
      if (fail) throw new Error("connection lost");
      return { rows, rowCount: rows.length };
    },
  } as unknown as DbPort;

  return createMenuModule({
    db,
    tables: {
      requireTable: async (code) => ({ id: "table-1", code, name: "Window", status: "active" }),
    },
    orders: { denyPendingOrdersForItem: async () => 0 },
    images: { toDto: (row) => ({ image_url: row.original_key, image_small_url: row.small_key, blur_data_url: "" }) },
  });
}

describe("Menu module lifecycle component", () => {
  it("declares its name and database dependency", () => {
    const module = moduleWith([{ items: true, categories: true, images: true }]);
    assert.equal(module.name, "menu");
    assert.deepEqual(module.dependencies, ["database"]);
    assert.equal(typeof module.service.listMenu, "function");
  });

  it("reports healthy when every catalogue table exists", async () => {
    const module = moduleWith([{ items: true, categories: true, images: true }]);

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.deepEqual((health.details as { missing: string[] }).missing, []);

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.deepEqual(module.diagnostics(), {
      module: "menu",
      repository: "MenuRepository",
      schema: { present: ["menu_items", "menu_categories", "menu_item_images"], missing: [] },
    });
  });

  it("reports the missing objects without throwing", async () => {
    const module = moduleWith([{ items: true, categories: false, images: true }]);

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /menu_categories/);

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, false);
  });

  it("contains a probe failure as an unhealthy self-test", async () => {
    const module = moduleWith([], true);

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.equal(health.message, "connection lost");

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, false);
    assert.equal(selfTest.message, "connection lost");
  });
});
