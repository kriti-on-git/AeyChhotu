import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Cart HTTP contracts: defaults, quantity bounds, required attribution and
   the absolute-vs-delta patch rules. */

import {
  cartAddSchema,
  cartDeleteSchema,
  cartItemParamsSchema,
  cartListQuerySchema,
  cartUpdateSchema,
} from "../src/modules/cart/cart.validation.js";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

describe("cart request validation", () => {
  it("defaults list pagination", () => {
    const parsed = cartListQuerySchema.parse({ table_token: "k7x2p" });
    assert.equal(parsed.page, 1);
    assert.equal(parsed.limit, 20);
  });

  it("defaults add quantity and trims the owner name", () => {
    const parsed = cartAddSchema.parse({
      table_token: "k7x2p",
      menu_item_id: ITEM_ID,
      added_by: "  Asha  ",
    });
    assert.equal(parsed.quantity, 1);
    assert.equal(parsed.added_by, "Asha");
  });

  it("rejects quantities outside 1..99 and a missing owner", () => {
    for (const quantity of [0, 100, 1.5]) {
      assert.equal(
        cartAddSchema.safeParse({
          table_token: "k7x2p",
          menu_item_id: ITEM_ID,
          quantity,
          added_by: "Asha",
        }).success,
        false,
      );
    }
    assert.equal(
      cartAddSchema.safeParse({
        table_token: "k7x2p",
        menu_item_id: ITEM_ID,
      }).success,
      false,
    );
  });

  it("accepts a non-zero delta and rejects delta 0 or an empty patch", () => {
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", quantity_delta: 2 }).success,
      true,
    );
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", quantity_delta: -1 }).success,
      true,
    );
    assert.equal(
      cartUpdateSchema.safeParse({ table_token: "k7x2p", quantity_delta: 0 }).success,
      false,
    );
    assert.equal(cartUpdateSchema.safeParse({ table_token: "k7x2p" }).success, false);
  });

  it("keeps the 500-character note cap", () => {
    const parsed = cartUpdateSchema.safeParse({
      table_token: "k7x2p",
      request_note: "x".repeat(501),
    });
    assert.equal(parsed.success, false);
  });

  it("requires UUIDs for path and delete ids", () => {
    assert.equal(cartItemParamsSchema.safeParse({ cart_item_id: ITEM_ID }).success, true);
    assert.equal(
      cartDeleteSchema.safeParse({ table_token: "k7x2p", cart_item_id: "nope" }).success,
      false,
    );
  });
});
