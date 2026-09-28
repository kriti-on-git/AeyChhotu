import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the normalizers (lib/api-client/normalize.ts) — the seam
   between the wire contract and every screen. Run with node:test; TSX is
   compiled on the fly via the project's own loader so no build step or
   extra dependency is needed. */

import { ApiError } from "../lib/api-client/errors.ts";
import {
  demoFallbackEnabled,
  isOfflineError,
  shouldUseDemoFallback,
  toCartLine,
  toFloorSummary,
  toKdsOrder,
  toMenuItem,
  toOrder,
} from "../lib/api-client/normalize.ts";

describe("toMenuItem", () => {
  it("maps the wire payload onto the UI shape", () => {
    const ui = toMenuItem({
      menu_item_id: "m1",
      name: "Masala Dosa",
      price: 130,
      category: "Mains",
      is_available: true,
      description: "Crisp",
      vegetarian: true,
    });
    assert.equal(ui.id, "m1");
    assert.equal(ui.price, 130);
    assert.equal(ui.name, "Masala Dosa");
  });
});

describe("toCartLine", () => {
  it("keeps identity and notes but drops server-only fields", () => {
    const ui = toCartLine({
      id: "c1",
      table_id: "t1",
      menu_item_id: "m1",
      quantity: 2,
      request_note: "extra butter",
      allergy_note: "NO PEANUTS",
      added_by: "Amit",
    });
    assert.deepEqual(ui, {
      id: "c1",
      table_id: "t1",
      menu_item_id: "m1",
      quantity: 2,
      request_note: "extra butter",
      allergy_note: "NO PEANUTS",
      added_by: "Amit",
    });
  });
});

describe("toOrder / toKdsOrder price snapshot", () => {
  const row = {
    order_id: "o1",
    table_id: "t1",
    status: "preparing",
    created_at: "2026-09-28T10:00:00Z",
    total: 260,
    items: [
      {
        menu_item_id: "m1",
        name: "Masala Dosa",
        quantity: 2,
        request_note: "",
        allergy_note: "",
        unit_price: 130,
      },
    ],
  };

  it("carries the fire-time unit_price into the UI (no hardcoded 0)", () => {
    const order = toOrder(row, "k7x2p");
    assert.equal(order.items[0].price, 130);
  });

  it("falls back to 0 only for payloads older than the column", () => {
    const legacy = toOrder({ ...row, items: [{ ...row.items[0], unit_price: undefined }] }, "k7x2p");
    assert.equal(legacy.items[0].price, 0);
  });

  it("maps a KDS ticket identically", () => {
    const ticket = {
      order_id: "o1",
      table: { id: "t1", code: "k7x2p", name: "Window four-top" },
      status: "ready",
      created_at: row.created_at,
      items: row.items,
    };
    const ui = toKdsOrder(ticket);
    assert.equal(ui.table_code, "k7x2p");
    assert.equal(ui.items[0].price, 130);
  });
});

describe("toFloorSummary", () => {
  it("maps a live table row with an active order", () => {
    const ui = toFloorSummary({
      table_id: "t1",
      code: "k7x2p",
      name: "Window four-top",
      status: "active",
      active_order: {
        order_id: "o1",
        status: "pending",
        created_at: "2026-09-28T10:00:00Z",
        items: [
          { menu_item_id: "m1", name: "Masala Dosa", quantity: 2, request_note: "", allergy_note: "NO PEANUTS", unit_price: 130 },
        ],
      },
      cart_line_count: 3,
    });
    assert.equal(ui.active_order.items[0].price, 130);
    assert.equal(ui.active_order.items[0].allergy_note, "NO PEANUTS");
    assert.equal(ui.cart_line_count, 3);
  });

  it("maps an empty table to a null active_order", () => {
    const ui = toFloorSummary({
      table_id: "t2",
      code: "m3q8z",
      name: "Corner booth",
      status: "empty",
      active_order: null,
      cart_line_count: 0,
    });
    assert.equal(ui.active_order, null);
  });
});

describe("demo-fallback gate", () => {
  it("flags only status-0 ApiErrors as offline", () => {
    assert.equal(isOfflineError(new ApiError(0, "NETWORK_ERROR", "down")), true);
    assert.equal(isOfflineError(new ApiError(500, "INTERNAL", "boom")), false);
    assert.equal(isOfflineError(new Error("plain")), false);
  });

  it("never enables the demo store in production by default", () => {
    const oldNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.NEXT_PUBLIC_ENABLE_DEMO_FALLBACK;
      assert.equal(demoFallbackEnabled(), false);
      assert.equal(shouldUseDemoFallback(new ApiError(0, "NETWORK_ERROR", "down")), false);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
    }
  });

  it("enables it in production only when explicitly opted in", () => {
    const oldNodeEnv = process.env.NODE_ENV;
    const oldFlag = process.env.NEXT_PUBLIC_ENABLE_DEMO_FALLBACK;
    try {
      process.env.NODE_ENV = "production";
      process.env.NEXT_PUBLIC_ENABLE_DEMO_FALLBACK = "true";
      assert.equal(demoFallbackEnabled(), true);
      assert.equal(shouldUseDemoFallback(new ApiError(0, "NETWORK_ERROR", "down")), true);
      // But a real HTTP error is never a demo case, flag or no flag.
      assert.equal(shouldUseDemoFallback(new ApiError(500, "INTERNAL", "boom")), false);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      if (oldFlag === undefined) delete process.env.NEXT_PUBLIC_ENABLE_DEMO_FALLBACK;
      else process.env.NEXT_PUBLIC_ENABLE_DEMO_FALLBACK = oldFlag;
    }
  });
});
