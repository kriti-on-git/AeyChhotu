import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for buildMeta/iso (docs/7 §1.2 wire format) — tiny helpers,
   but pagination totals and ISO timestamps reach every screen. */

import { buildMeta, iso } from "../src/lib/util.js";

describe("buildMeta (§1.5)", () => {
  it("computes total_pages by ceiling division", () => {
    assert.deepEqual(buildMeta(1, 20, 45), { page: 1, limit: 20, total: 45, total_pages: 3 });
    assert.deepEqual(buildMeta(2, 20, 40), { page: 2, limit: 20, total: 40, total_pages: 2 });
  });

  it("returns 0 total_pages for an empty list (no NaN, no -0)", () => {
    const meta = buildMeta(1, 20, 0);
    assert.equal(meta.total_pages, 0);
    assert.ok(Number.isFinite(meta.total_pages));
  });

  it("handles a total smaller than one page", () => {
    assert.equal(buildMeta(1, 20, 7).total_pages, 1);
  });
});

describe("iso (§1.2 timestamps)", () => {
  it("formats a Date as second-precision UTC Z", () => {
    const date = new Date("2026-09-28T12:34:56.789Z");
    assert.equal(iso(date), "2026-09-28T12:34:56Z");
  });

  it("normalises an ISO string with millis", () => {
    assert.equal(iso("2026-09-28T12:34:56.789Z"), "2026-09-28T12:34:56Z");
  });

  it("converts a non-UTC input to UTC", () => {
    // 18:00 in UTC+5:30 is 12:30 UTC.
    assert.equal(iso("2026-09-28T18:00:00+05:30"), "2026-09-28T12:30:00Z");
  });

  it("maps null/undefined to the empty string (never the string 'Invalid Date')", () => {
    assert.equal(iso(null), "");
    assert.equal(iso(undefined), "");
  });
});
