#!/usr/bin/env node
/* AeyChhotu! — end-to-end API contract smoke test.
 *
 * Replaces the hand-run 18/18 curl sweep recorded in docs/9 with something
 * repeatable. Talks to a RUNNING backend and walks the real diner + kitchen
 * journey in order, asserting the contract envelope and the exact error
 * codes from docs/7-api-contract.md.
 *
 * Usage:
 *   1. terminal A:  cd backend && npm run dev
 *   2. terminal B:  cd backend && npm run smoke
 *
 *   SMOKE_BASE_URL=http://localhost:4000   (default)
 *   SMOKE_KEEP=1                           (leave the test order in place)
 *
 * Needs STAFF_PIN from backend/.env to log in as the kitchen.
 */

import "dotenv/config";
import pg from "pg";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const TABLE_TOKEN = "k7x2p";
const KEEP = Boolean(process.env.SMOKE_KEEP);

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** One HTTP call → { status, body }. Never throws on non-2xx. */
async function api(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  if (res.status !== 204) json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

console.log(`[smoke] target ${BASE}`);

try {
  // ------------------------------------------------------------------ health
  section("Health");
  {
    const r = await api("/api/v1/health");
    check("GET /health → 200", r.status === 200, `got ${r.status}`);
  }

  // ------------------------------------------------------------------ module 1
  section("Module 1 — Session & Access");
  const pin = process.env.STAFF_PIN;
  let staffToken = null;

  {
    const r = await api("/api/v1/sessions/initialize", {
      method: "POST",
      body: { table_token: TABLE_TOKEN },
    });
    check("E1 initialize → 200", r.status === 200, `got ${r.status}`);
    check("E1 returns the table code", r.body?.data?.code === TABLE_TOKEN);
    check("E1 returns a realtime_token field", "realtime_token" in (r.body?.data ?? {}));

    const bad = await api("/api/v1/sessions/initialize", {
      method: "POST",
      body: { table_token: "zzzz" },
    });
    check("E1 unknown token → 404 TABLE_NOT_FOUND", bad.body?.error?.code === "TABLE_NOT_FOUND");

    const malformed = await api("/api/v1/sessions/initialize", {
      method: "POST",
      body: { table_token: "BAD TOKEN!" },
    });
    check("E1 malformed token → 400 VALIDATION_ERROR", malformed.body?.error?.code === "VALIDATION_ERROR");
    check("E1 validation carries error.fields", Boolean(malformed.body?.error?.fields));
  }

  {
    const wrong = await api("/api/v1/auth/kds-login", { method: "POST", body: { pin: "000000" } });
    check("E2 wrong PIN → 401 INVALID_PIN", wrong.body?.error?.code === "INVALID_PIN", `got ${wrong.body?.error?.code}`);

    if (!pin) {
      check("STAFF_PIN available in backend/.env", false, "var missing");
    } else {
      const ok = await api("/api/v1/auth/kds-login", { method: "POST", body: { pin } });
      check("E2 correct PIN → 200", ok.status === 200, `got ${ok.status}`);
      check("E2 role claim is kitchen", ok.body?.data?.role === "kitchen");
      staffToken = ok.body?.data?.token ?? null;
      check("E2 issues a bearer token", typeof staffToken === "string" && staffToken.split(".").length === 3);

      const me = await api("/api/v1/auth/me", { token: staffToken });
      check("E2b /auth/me → 200 authenticated", me.body?.data?.authenticated === true);
      check("E2b never echoes a secret", !JSON.stringify(me.body).toLowerCase().includes("pin"));
    }
  }

  // ------------------------------------------------------------------ module 2
  section("Module 2 — Menu & Shared Cart");
  let menu = [];

  {
    const r = await api(`/api/v1/menu?table_token=${TABLE_TOKEN}&limit=100`);
    menu = r.body?.data ?? [];
    check("E3 menu → 200", r.status === 200, `got ${r.status}`);
    check("E3 menu walk returns 20 dishes", menu.length === 20, `got ${menu.length}`);
    check("E3 meta.total is 20", r.body?.meta?.total === 20, `got ${r.body?.meta?.total}`);
    check("E3 rows use menu_item_id naming", menu[0] && "menu_item_id" in menu[0]);
  }

  const target = menu.find((m) => m.name === "Masala Dosa") ?? menu[0];
  let cartLineId = null;

  {
    const r = await api(`/api/v1/cart/items?table_token=${TABLE_TOKEN}&limit=100`);
    check("E4 cart read → 200", r.status === 200, `got ${r.status}`);
    check("E4 meta is present", Boolean(r.body?.meta));
  }

  {
    // 86 the target first so the availability guard is provable.
    const off = await api(`/api/v1/menu/items/${target.menu_item_id}/availability`, {
      method: "PATCH",
      token: staffToken,
      body: { is_available: false },
    });
    check("E14 86 an item → 200", off.body?.data?.is_available === false);

    const blocked = await api("/api/v1/cart/items", {
      method: "POST",
      body: { table_token: TABLE_TOKEN, menu_item_id: target.menu_item_id, quantity: 1 },
    });
    check("E5 86'd item → 409 ITEM_UNAVAILABLE", blocked.body?.error?.code === "ITEM_UNAVAILABLE", `got ${blocked.body?.error?.code}`);

    const on = await api(`/api/v1/menu/items/${target.menu_item_id}/availability`, {
      method: "PATCH",
      token: staffToken,
      body: { is_available: true },
    });
    check("E14 un-86 → 200", on.body?.data?.is_available === true);
  }

  {
    const add = await api("/api/v1/cart/items", {
      method: "POST",
      body: {
        table_token: TABLE_TOKEN,
        menu_item_id: target.menu_item_id,
        quantity: 2,
        added_by: "smoke",
        allergy_note: "NO PEANUTS - SMOKE TEST",
      },
    });
    cartLineId = add.body?.data?.id ?? null;
    check("E5 add to cart → 200", add.status === 200, `got ${add.status}`);
    check("E5 quantity is 2", add.body?.data?.quantity === 2, `got ${add.body?.data?.quantity}`);
    check("E5 returns total_table_quantity", typeof add.body?.data?.total_table_quantity === "number");

    // Same columns → the UNIQUE index + ON CONFLICT must MERGE, not fork.
    const merge = await api("/api/v1/cart/items", {
      method: "POST",
      body: {
        table_token: TABLE_TOKEN,
        menu_item_id: target.menu_item_id,
        quantity: 1,
        allergy_note: "NO PEANUTS - SMOKE TEST",
      },
    });
    check("E5 duplicate tap merges (2+1=3)", merge.body?.data?.quantity === 3, `got ${merge.body?.data?.quantity}`);
    check("E5 merge reuses the same row id", merge.body?.data?.id === cartLineId);
  }

  {
    const delta = await api(`/api/v1/cart/items/${cartLineId}`, {
      method: "PATCH",
      body: { table_token: TABLE_TOKEN, quantity_delta: 2 },
    });
    check("E6 quantity_delta applied atomically", delta.body?.data?.quantity === 5, `got ${delta.body?.data?.quantity}`);

    const over = await api(`/api/v1/cart/items/${cartLineId}`, {
      method: "PATCH",
      body: { table_token: TABLE_TOKEN, quantity_delta: 200 },
    });
    check("E6 out-of-range delta → 400", over.status === 400, `got ${over.status}`);
  }

  // Foreign-table isolation: a different token must not see or touch this line.
  {
    const foreign = await api(`/api/v1/cart/items/${cartLineId}`, {
      method: "PATCH",
      body: { table_token: "m9b3x", quantity: 1 },
    });
    check("E6 foreign table → 404 CART_ITEM_NOT_FOUND", foreign.body?.error?.code === "CART_ITEM_NOT_FOUND", `got ${foreign.body?.error?.code}`);
  }

  // ------------------------------------------------------------------ module 3 + fire
  section("Module 3 — Fire & Kitchen Display");
  let orderId = null;

  {
    const fire = await api("/api/v1/orders/fire", { method: "POST", body: { table_token: TABLE_TOKEN } });
    orderId = fire.body?.data?.order_id ?? null;
    check("E8 fire → 201", fire.status === 201, `got ${fire.status}`);
    check("E8 status is pending", fire.body?.data?.status === "pending");
    check("E8 cart drained after fire", (await api(`/api/v1/cart/items?table_token=${TABLE_TOKEN}`)).body?.data?.length === 0);

    const dupe = await api("/api/v1/orders/fire", { method: "POST", body: { table_token: TABLE_TOKEN } });
    check("E8 duplicate fire → 409 DUPLICATE_ORDER", dupe.body?.error?.code === "DUPLICATE_ORDER", `got ${dupe.body?.error?.code}`);
    check("E8 duplicate carries error.order_id", dupe.body?.error?.order_id === orderId);

    const active = await api(`/api/v1/sessions/${TABLE_TOKEN}/active-check`);
    check("E9 active-check reports the block", active.body?.data?.has_active_order === true);

    const status = await api(`/api/v1/orders/${orderId}/status?table_token=${TABLE_TOKEN}`);
    check("E15 status → 200 pending", status.body?.data?.status === "pending");

    const unscoped = await api(`/api/v1/orders/${orderId}/status?table_token=m9b3x`);
    check("E15 foreign table → 404 ORDER_NOT_FOUND", unscoped.body?.error?.code === "ORDER_NOT_FOUND");
  }

  {
    const noAuth = await api("/api/v1/kds/tickets");
    check("E10 without token → 401 UNAUTHORIZED", noAuth.body?.error?.code === "UNAUTHORIZED", `got ${noAuth.body?.error?.code}`);

    const garbage = await api("/api/v1/kds/tickets", { token: "not.a.jwt" });
    check("E10 garbage token → 401 UNAUTHORIZED", garbage.body?.error?.code === "UNAUTHORIZED");

    const board = await api("/api/v1/kds/tickets?limit=100", { token: staffToken });
    check("E10 with staff token → 200", board.status === 200, `got ${board.status}`);
    const ticket = (board.body?.data ?? []).find((t) => t.order_id === orderId);
    check("E10 board contains the fired ticket", Boolean(ticket));
    check("E10 ticket joins the table code", ticket?.table?.code === TABLE_TOKEN);
    check("E10 ticket carries the allergy note", ticket?.items?.[0]?.allergy_note === "NO PEANUTS - SMOKE TEST");
  }

  {
    const early = await api(`/api/v1/kds/tickets/${orderId}/prune`, { method: "PATCH", token: staffToken });
    check("E12 prune before ready → 409 INVALID_STATUS_TRANSITION", early.body?.error?.code === "INVALID_STATUS_TRANSITION", `got ${early.body?.error?.code}`);
    check("E12 carries current_status", early.body?.error?.current_status === "pending");

    const skip = await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token: staffToken,
      body: { status: "ready" },
    });
    check("E11 skipping a step → 409", skip.body?.error?.code === "INVALID_STATUS_TRANSITION");

    const prep = await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token: staffToken,
      body: { status: "preparing" },
    });
    check("E11 pending→preparing → 200", prep.body?.data?.status === "preparing");

    const repeat = await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token: staffToken,
      body: { status: "preparing" },
    });
    check("E11 repeating a step → 409", repeat.body?.error?.code === "INVALID_STATUS_TRANSITION");

    const ready = await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token: staffToken,
      body: { status: "ready" },
    });
    check("E11 preparing→ready → 200", ready.body?.data?.status === "ready");

    const prune = await api(`/api/v1/kds/tickets/${orderId}/prune`, { method: "PATCH", token: staffToken });
    check("E12 prune → served", prune.body?.data?.status === "served");
    check("E12 clears the table", prune.body?.data?.table_cleared === true);
  }

  {
    const after = await api(`/api/v1/sessions/${TABLE_TOKEN}/active-check`);
    check("E9 table is free again after serving", after.body?.data?.has_active_order === false);
  }

  // ------------------------------------------------------------------ module 4
  section("Module 4 — Floor, history, shift");

  {
    const noAuth = await api("/api/v1/floor/tables");
    check("E17 without token → 401 UNAUTHORIZED", noAuth.body?.error?.code === "UNAUTHORIZED");

    const floor = await api("/api/v1/floor/tables?limit=100", { token: staffToken });
    check("E17 with staff token → 200", floor.status === 200, `got ${floor.status}`);
    check("E17 returns all 5 tables", (floor.body?.data ?? []).length === 5, `got ${(floor.body?.data ?? []).length}`);
    check("E17 table exposes cart_line_count", "cart_line_count" in (floor.body?.data?.[0] ?? {}));

    const history = await api(`/api/v1/orders?table_token=${TABLE_TOKEN}&limit=100`);
    check("E16 history contains the served order", (history.body?.data ?? []).some((o) => o.order_id === orderId));
    check("E16 newest-first ordering", (history.body?.data?.[0]?.order_id ?? null) === orderId);

    const shift = await api("/api/v1/kds/shift/activate", {
      method: "POST",
      token: staffToken,
      body: { device_id: "smoke-runner" },
    });
    check("E13 activate shift → audio_armed", shift.body?.data?.audio_armed === true);

    const badStatus = await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token: staffToken,
      body: { status: "served" },
    });
    check("E11 rejects `served` (prune-only)", badStatus.status === 400, `got ${badStatus.status}`);
  }

  {
    const unknown = await api("/api/v1/nope");
    check("unknown route → 404 NOT_FOUND", unknown.body?.error?.code === "NOT_FOUND");
    check("error envelope carries success:false", unknown.body?.success === false);
  }
} catch (err) {
  console.error(`\n[smoke] aborted: ${err.message}`);
  failures.push(`runner crashed: ${err.message}`);
}

// ------------------------------------------------------------------- cleanup
if (!KEEP && process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL.trim() });
  try {
    await client.connect();
    const { rows } = await client.query(
      `DELETE FROM orders
        WHERE table_id = (SELECT id FROM restaurant_tables WHERE code = $1)
        RETURNING id`,
      [TABLE_TOKEN],
    );
    await client.query(
      `DELETE FROM cart_items
        WHERE table_id = (SELECT id FROM restaurant_tables WHERE code = $1)`,
      [TABLE_TOKEN],
    );
    await client.query(
      `UPDATE restaurant_tables SET status = 'empty' WHERE code = $1`,
      [TABLE_TOKEN],
    );
    console.log(`\n[smoke] cleaned up ${rows.length} test order(s) — demo state restored`);
  } catch (err) {
    console.warn(`[smoke] cleanup skipped: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

console.log(
  `\n[smoke] ${passed} check(s) passed` +
    (failures.length ? `, ${failures.length} FAILED:\n  • ${failures.join("\n  • ")}` : ""),
);

if (failures.length > 0) process.exitCode = 1;
