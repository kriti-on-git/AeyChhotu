import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Orders HTTP contracts: table-token scope, pagination defaults and UUID
   path params. These are the same schemas the legacy entry point re-exports. */

import {
  fireSchema,
  ordersListQuerySchema,
  orderStatusParamsSchema,
  orderStatusQuerySchema,
} from "../src/modules/orders/orders.validation.js";
import * as legacy from "../src/validation/schemas.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

describe("orders request validation", () => {
  it("defaults list pagination", () => {
    const parsed = ordersListQuerySchema.parse({ table_token: "k7x2p" });
    assert.equal(parsed.page, 1);
    assert.equal(parsed.limit, 20);
  });

  it("accepts a lowercase table token and rejects anything else", () => {
    assert.equal(fireSchema.safeParse({ table_token: "k7x2p" }).success, true);
    for (const token of ["", "K7X2P", "k7", "x".repeat(17)]) {
      assert.equal(fireSchema.safeParse({ table_token: token }).success, false);
    }
  });

  it("requires a UUID order id but only a token on the query", () => {
    assert.equal(orderStatusParamsSchema.safeParse({ order_id: ORDER_ID }).success, true);
    assert.equal(orderStatusParamsSchema.safeParse({ order_id: "nope" }).success, false);
    assert.equal(orderStatusQuerySchema.safeParse({ table_token: "k7x2p" }).success, true);
    assert.equal(orderStatusQuerySchema.safeParse({}).success, false);
  });

  it("is the same contract the legacy validation entry point re-exports", () => {
    assert.equal(legacy.fireSchema, fireSchema);
    assert.equal(legacy.ordersListQuerySchema, ordersListQuerySchema);
    assert.equal(legacy.orderStatusParamsSchema, orderStatusParamsSchema);
    assert.equal(legacy.orderStatusQuerySchema, orderStatusQuerySchema);
  });
});
