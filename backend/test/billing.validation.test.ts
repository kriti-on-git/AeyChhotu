import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { billingTableParamsSchema } from "../src/modules/billing/billing.validation.js";

const TABLE_ID = "11111111-1111-4111-8111-111111111111";

describe("Billing validation", () => {
  it("accepts a table UUID and returns only the parsed field", () => {
    const parsed = billingTableParamsSchema.parse({ table_id: TABLE_ID, ignored: "x" });
    assert.deepEqual(parsed, { table_id: TABLE_ID });
  });

  it("rejects a missing or malformed table id", () => {
    assert.equal(billingTableParamsSchema.safeParse({}).success, false);
    assert.equal(billingTableParamsSchema.safeParse({ table_id: "not-a-uuid" }).success, false);
  });
});
