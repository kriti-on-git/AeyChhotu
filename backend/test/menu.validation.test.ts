import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Menu request contracts: pricing, descriptions, availability, folder names
   and the table-scoped retrieval query. These are the shapes the admin console
   and diner app already send, so a loosening or tightening here is a breaking
   API change and is pinned explicitly. */

import {
  adminCreateCategorySchema,
  adminCreateMenuItemSchema,
  adminUpdateCategorySchema,
  adminUpdateMenuItemSchema,
  availabilitySchema,
  menuQuerySchema,
} from "../src/modules/menu/menu.validation.js";
import {
  adminCreateMenuItemSchema as reExportedCreate,
  menuQuerySchema as reExportedQuery,
} from "../src/validation/schemas.js";

describe("menu pricing validation", () => {
  const base = { name: "Dal Makhani", description: "", vegetarian: true, is_available: true };

  it("accepts zero, decimals and numeric strings", () => {
    for (const price of [0, 199, 249.5, "320"]) {
      const parsed = adminCreateMenuItemSchema.parse({ ...base, price });
      assert.equal(parsed.price, Number(price));
    }
  });

  it("rejects negative, non-finite and unrealistically high prices", () => {
    for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001, "not-money"]) {
      assert.equal(
        adminCreateMenuItemSchema.safeParse({ ...base, price }).success,
        false,
        `price ${String(price)} must be refused`,
      );
    }
  });

  it("requires a price on create but not on a partial update", () => {
    assert.equal(adminCreateMenuItemSchema.safeParse(base).success, false);
    assert.equal(adminUpdateMenuItemSchema.safeParse({ price: 120 }).success, true);
  });
});

describe("menu description and metadata validation", () => {
  const base = { name: "Dal Makhani", price: 200 };

  it("defaults description and metadata for older clients", () => {
    const parsed = adminCreateMenuItemSchema.parse(base);
    assert.equal(parsed.description, "");
    assert.deepEqual(parsed.ingredients, []);
    assert.equal(parsed.is_available, true);
  });

  it("trims descriptions and caps them at 500 characters", () => {
    const parsed = adminCreateMenuItemSchema.parse({ ...base, description: "  creamy  " });
    assert.equal(parsed.description, "creamy");
    assert.equal(
      adminCreateMenuItemSchema.safeParse({ ...base, description: "x".repeat(501) }).success,
      false,
    );
  });

  it("refuses an empty update patch", () => {
    assert.equal(adminUpdateMenuItemSchema.safeParse({}).success, false);
  });
});

describe("menu availability validation", () => {
  it("requires a real boolean", () => {
    assert.equal(availabilitySchema.safeParse({ is_available: false }).success, true);
    assert.equal(availabilitySchema.safeParse({ is_available: "true" }).success, false);
    assert.equal(availabilitySchema.safeParse({}).success, false);
  });
});

describe("menu retrieval query", () => {
  it("applies pagination defaults and accepts filters", () => {
    const parsed = menuQuerySchema.parse({ table_token: "k7x2p", q: "paneer" });
    assert.equal(parsed.page, 1);
    assert.equal(parsed.limit, 20);
    assert.equal(parsed.q, "paneer");
  });

  it("rejects unsafe table tokens and oversized filters", () => {
    assert.equal(menuQuerySchema.safeParse({ table_token: "DROP" }).success, false);
    assert.equal(
      menuQuerySchema.safeParse({ table_token: "k7x2p", q: "x".repeat(51) }).success,
      false,
    );
    assert.equal(menuQuerySchema.safeParse({ table_token: "k7x2p", limit: 101 }).success, false);
  });
});

describe("catalog folder validation", () => {
  it("requires a non-empty name and an optional parent", () => {
    assert.equal(adminCreateCategorySchema.safeParse({ name: "  " }).success, false);
    assert.equal(adminCreateCategorySchema.safeParse({ name: "Desserts" }).success, true);
    assert.equal(adminUpdateCategorySchema.safeParse({}).success, false);
  });

  it("caps sort order and validates a cover UUID", () => {
    assert.equal(adminUpdateCategorySchema.safeParse({ sort_order: 2 }).success, true);
    assert.equal(adminUpdateCategorySchema.safeParse({ sort_order: -1 }).success, false);
    assert.equal(
      adminUpdateCategorySchema.safeParse({ thumbnail_menu_item_id: "nope" }).success,
      false,
    );
  });
});

describe("legacy schema imports", () => {
  it("re-exports the same menu contracts from validation/schemas.ts", () => {
    assert.equal(reExportedCreate, adminCreateMenuItemSchema);
    assert.equal(reExportedQuery, menuQuerySchema);
  });
});
