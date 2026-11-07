import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adjustStockSchema,
  inventoryItemParamsSchema,
  inventoryMovementsQuerySchema,
  inventoryQuerySchema,
  restoreStockSchema,
  setStockSchema,
} from "../src/modules/inventory/inventory.validation.js";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

describe("Inventory validation", () => {
  it("accepts a menu-item UUID and strips extra params", () => {
    const parsed = inventoryItemParamsSchema.parse({ menu_item_id: ITEM_ID, ignored: "x" });
    assert.deepEqual(parsed, { menu_item_id: ITEM_ID });
    assert.equal(inventoryItemParamsSchema.safeParse({ menu_item_id: "nope" }).success, false);
  });

  it("coerces a known stock state and rejects an unknown one", () => {
    assert.deepEqual(inventoryQuerySchema.parse({ state: "low" }), { state: "low" });
    assert.equal(inventoryQuerySchema.safeParse({ state: "critical" }).success, false);
    assert.equal(inventoryQuerySchema.safeParse({ state: "out" }).success, true);
  });

  it("defaults and bounds the movement limit", () => {
    assert.deepEqual(inventoryMovementsQuerySchema.parse({}), { limit: 20 });
    assert.equal(inventoryMovementsQuerySchema.safeParse({ limit: "0" }).success, false);
    assert.equal(inventoryMovementsQuerySchema.safeParse({ limit: "101" }).success, false);
    assert.equal(inventoryMovementsQuerySchema.parse({ limit: "5" }).limit, 5);
  });

  it("accepts zero, a positive count or null — never a negative count", () => {
    assert.deepEqual(setStockSchema.parse({ stock_quantity: "0" }), { stock_quantity: 0 });
    assert.deepEqual(setStockSchema.parse({ stock_quantity: null }), { stock_quantity: null });
    assert.equal(setStockSchema.safeParse({ stock_quantity: -1 }).success, false);
    assert.equal(setStockSchema.safeParse({ stock_quantity: 1.5 }).success, false);
  });

  it("allows a threshold-only patch and requires at least one field", () => {
    assert.deepEqual(setStockSchema.parse({ low_stock_threshold: "2" }), {
      low_stock_threshold: 2,
    });
    assert.equal(setStockSchema.safeParse({}).success, false);
  });

  it("validates adjustment delta, reason and optional order", () => {
    assert.deepEqual(
      adjustStockSchema.parse({ delta: "-2", reason: "wastage", order_id: ITEM_ID }),
      { delta: -2, reason: "wastage", order_id: ITEM_ID },
    );
    assert.equal(adjustStockSchema.safeParse({ delta: 0, reason: "manual" }).success, false);
    assert.equal(adjustStockSchema.safeParse({ delta: 1, reason: "guess" }).success, false);
    assert.equal(
      adjustStockSchema.safeParse({ delta: 1, reason: "manual", order_id: "nope" }).success,
      false,
    );
  });

  it("requires a positive restoration quantity", () => {
    assert.deepEqual(restoreStockSchema.parse({ quantity: "2" }), { quantity: 2 });
    assert.equal(restoreStockSchema.safeParse({ quantity: 0 }).success, false);
    assert.equal(restoreStockSchema.safeParse({ quantity: -1 }).success, false);
  });
});
