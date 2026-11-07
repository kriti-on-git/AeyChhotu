import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Currency arithmetic is integer-only. These checks pin the parser/formatter
   boundary and the half-up tax rounding rule, including the classic float trap
   (0.10 × 3) and a .5-paise tax case. */

import { formatMinor, roundHalfUp, taxMinor, toMinor } from "../src/modules/billing/billing.money.js";

describe("Billing money — integer paise", () => {
  it("parses decimal strings without floating point", () => {
    assert.equal(toMinor("120.00"), 12_000);
    assert.equal(toMinor("40.5"), 4_050);
    assert.equal(toMinor("0.10"), 10);
    assert.equal(toMinor("0.01"), 1);
    assert.equal(toMinor(240), 24_000);
    assert.equal(toMinor("0"), 0);
  });

  it("rejects malformed or negative money", () => {
    for (const value of ["1.234", "-1.00", "", " 1,20", "not-money", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => toMinor(value), /Money/);
    }
  });

  it("formats exactly two decimal places", () => {
    assert.equal(formatMinor(0), "0.00");
    assert.equal(formatMinor(1), "0.01");
    assert.equal(formatMinor(30), "0.30");
    assert.equal(formatMinor(4_050), "40.50");
    assert.equal(formatMinor(12_000), "120.00");
  });

  it("keeps 0.10 × 3 exact", () => {
    const line = toMinor("0.10") * 3;
    assert.equal(line, 30);
    assert.equal(formatMinor(line), "0.30");
  });

  it("rounds tax half up at the paise boundary", () => {
    assert.equal(roundHalfUp(14_475_000, 10_000), 1_448);
    assert.equal(taxMinor(199, 500), 10); // 9.95 paise → 10
    assert.equal(taxMinor(101, 250), 3); // 2.525 → 3
    assert.equal(taxMinor(100, 0), 0);
    assert.equal(taxMinor(100, 10_000), 100);
  });
});
