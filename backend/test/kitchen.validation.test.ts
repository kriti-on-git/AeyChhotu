import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* The kitchen HTTP contract must remain the published one: ticket schemas are
   the same objects Ticket owns, and E13 keeps its exact shape. */

import * as kitchen from "../src/modules/kitchen/kitchen.validation.js";
import * as tickets from "../src/modules/tickets/tickets.validation.js";
import * as legacy from "../src/validation/schemas.js";

describe("kitchen request validation", () => {
  it("reuses the single ticket schema definitions", () => {
    assert.equal(kitchen.kdsTicketsQuerySchema, tickets.kdsTicketsQuerySchema);
    assert.equal(kitchen.orderParamsSchema, tickets.orderParamsSchema);
    assert.equal(kitchen.orderStatusSchema, tickets.orderStatusSchema);
    assert.equal(kitchen.denyTicketSchema, tickets.denyTicketSchema);
    assert.equal(kitchen.kdsTicketsQuerySchema, legacy.kdsTicketsQuerySchema);
    assert.equal(kitchen.shiftActivateSchema, legacy.shiftActivateSchema);
  });

  it("still accepts only the live board columns and forward targets", () => {
    assert.equal(kitchen.kdsTicketsQuerySchema.safeParse({ status: "pending" }).success, true);
    assert.equal(kitchen.kdsTicketsQuerySchema.safeParse({ status: "served" }).success, false);
    assert.equal(kitchen.orderStatusSchema.safeParse({ status: "preparing" }).success, true);
    assert.equal(kitchen.orderStatusSchema.safeParse({ status: "ready" }).success, true);
    assert.equal(kitchen.orderStatusSchema.safeParse({ status: "served" }).success, false);
  });

  it("keeps the E13 device id required and bounded", () => {
    assert.equal(kitchen.shiftActivateSchema.safeParse({ device_id: "tablet-1" }).success, true);
    assert.equal(kitchen.shiftActivateSchema.safeParse({ device_id: "" }).success, false);
    assert.equal(kitchen.shiftActivateSchema.safeParse({}).success, false);
    assert.equal(
      kitchen.shiftActivateSchema.safeParse({ device_id: "x".repeat(65) }).success,
      false,
    );
  });
});
