import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Kitchen ticket HTTP contracts: board filters, pagination, UUID params and
   the two forward-only status targets. */

import {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
} from "../src/modules/tickets/tickets.validation.js";
import * as legacy from "../src/validation/schemas.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

describe("tickets request validation", () => {
  it("defaults board pagination and accepts each live column", () => {
    const parsed = kdsTicketsQuerySchema.parse({});
    assert.equal(parsed.page, 1);
    assert.equal(parsed.limit, 20);

    for (const status of ["pending", "preparing", "ready"]) {
      assert.equal(kdsTicketsQuerySchema.safeParse({ status }).success, true);
    }
    assert.equal(kdsTicketsQuerySchema.safeParse({ status: "served" }).success, false);
    assert.equal(kdsTicketsQuerySchema.safeParse({ status: "denied" }).success, false);
  });

  it("requires a UUID ticket id", () => {
    assert.equal(orderParamsSchema.safeParse({ order_id: ORDER_ID }).success, true);
    assert.equal(orderParamsSchema.safeParse({ order_id: "not-a-uuid" }).success, false);
  });

  it("allows only preparing and ready as advance targets", () => {
    assert.equal(orderStatusSchema.safeParse({ status: "preparing" }).success, true);
    assert.equal(orderStatusSchema.safeParse({ status: "ready" }).success, true);
    assert.equal(orderStatusSchema.safeParse({ status: "served" }).success, false);
    assert.equal(orderStatusSchema.safeParse({ status: "denied" }).success, false);
    assert.equal(orderStatusSchema.safeParse({}).success, false);
  });

  it("keeps the chef's reason mandatory, trimmed and capped", () => {
    const parsed = denyTicketSchema.parse({ reason: "  Paneer ran out  " });
    assert.equal(parsed.reason, "Paneer ran out");

    assert.equal(denyTicketSchema.safeParse({ reason: "   " }).success, false);
    assert.equal(denyTicketSchema.safeParse({}).success, false);
    assert.equal(denyTicketSchema.safeParse({ reason: "x".repeat(300) }).success, true);
    assert.equal(denyTicketSchema.safeParse({ reason: "x".repeat(301) }).success, false);
  });

  it("is the same contract the legacy validation entry point re-exports", () => {
    assert.equal(legacy.kdsTicketsQuerySchema, kdsTicketsQuerySchema);
    assert.equal(legacy.orderParamsSchema, orderParamsSchema);
    assert.equal(legacy.orderStatusSchema, orderStatusSchema);
    assert.equal(legacy.denyTicketSchema, denyTicketSchema);
  });
});
