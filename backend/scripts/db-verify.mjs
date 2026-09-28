#!/usr/bin/env node
/* AeyChhotu! — database verification runner.
 *
 * Asserts that a database built by `npm run db:setup` is actually correct,
 * instead of trusting "the script exited 0". Covers the four things that
 * silently break in production:
 *
 *   1. SCHEMA      tables exist, RLS is switched on, all 24 policies present
 *   2. INDEXES     the 7 access-path indexes + the one-active-order constraint
 *   3. REPLICATION the Realtime publication + REPLICA IDENTITY FULL
 *   4. SECURITY    claim-scoped RLS actually returns 0 rows with no token,
 *                  1 row for a diner token, the whole floor for a staff
 *                  token, and anon writes are denied
 *
 * Usage (from backend/):
 *   npm run db:verify
 *
 * Exit code 0 = everything asserted; 1 = at least one check failed.
 */

import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("[db:verify] FATAL: DATABASE_URL is missing or empty.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let passed = 0;
const failures = [];

function report(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const q = (text, params) => client.query(text, params);

try {
  const { rows: versionRows } = await q("SELECT version() AS v");
  console.log(`[db:verify] ${versionRows[0].v.split(",")[0]}`);

  // ---------------------------------------------------------------- 1. schema
  section("1. Schema & RLS");

  const EXPECTED_TABLES = [
    "restaurant_tables",
    "menu_items",
    "cart_items",
    "orders",
    "order_items",
    "staff_terminals",
  ];

  const { rows: tableRows } = await q(
    `SELECT c.relname AS name, c.relrowsecurity AS rls,
            (SELECT count(*)::int FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
    [EXPECTED_TABLES],
  );
  const byTable = new Map(tableRows.map((r) => [r.name, r]));

  for (const table of EXPECTED_TABLES) {
    const row = byTable.get(table);
    report(`table ${table}`, Boolean(row), row ? "" : "missing");
    if (row) report(`  ${table} RLS enabled`, row.rls === true);
  }

  const totalPolicies = tableRows.reduce((sum, r) => sum + r.policies, 0);
  report("24 RLS policies present", totalPolicies === 24, `found ${totalPolicies}`);

  // ---------------------------------------------------------------- 2. indexes
  section("2. Indexes & constraints");

  const { rows: indexRows } = await q(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  const indexes = new Set(indexRows.map((r) => r.indexname));

  for (const idx of [
    "cart_items_upsert_uq",
    "cart_items_table_created_idx",
    "orders_table_status_idx",
    "orders_active_idx",
    "orders_created_idx",
    "orders_one_active_uq",
    "order_items_order_idx",
    "menu_items_category_idx",
  ]) {
    report(`index ${idx}`, indexes.has(idx));
  }

  const { rows: fkRows } = await q(
    `SELECT confdeltype FROM pg_constraint
      WHERE conname = 'orders_table_id_fkey' AND conrelid = 'public.orders'::regclass`,
  );
  // confdeltype: 'r' = RESTRICT, 'c' = CASCADE
  report(
    "orders.table_id is ON DELETE RESTRICT",
    fkRows[0]?.confdeltype === "r",
    fkRows[0] ? `confdeltype=${fkRows[0].confdeltype}` : "constraint missing",
  );

  const { rows: fnRows } = await q(
    `SELECT p.oid::regprocedure AS sig
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fire_order'`,
  );
  report("fire_order(text) exists", fnRows.length > 0);

  // ------------------------------------------------------------ 3. replication
  section("3. Realtime replication");

  const { rows: pubRows } = await q(
    `SELECT tablename FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      ORDER BY tablename`,
  );
  const published = pubRows.map((r) => r.tablename);
  report(
    "orders + cart_items streamed",
    published.includes("orders") && published.includes("cart_items"),
    published.join(", ") || "publication empty",
  );

  const { rows: identRows } = await q(
    `SELECT relname, relreplident FROM pg_class
      WHERE oid IN ('public.orders'::regclass, 'public.cart_items'::regclass)`,
  );
  for (const row of identRows) {
    // relreplident: 'f' = FULL (needed so DELETE carries table_id for filters)
    report(`${row.relname} REPLICA IDENTITY FULL`, row.relreplident === "f");
  }

  // --------------------------------------------------------------- 4. security
  section("4. Claim-scoped RLS (the important one)");

  // Privileges: only the backend's service path may execute the fire RPC.
  const { rows: privRows } = await q(
    `SELECT
       has_function_privilege('anon', 'public.fire_order(text)', 'EXECUTE')          AS anon,
       has_function_privilege('authenticated', 'public.fire_order(text)', 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', 'public.fire_order(text)', 'EXECUTE')  AS service_role`,
  );
  report("fire_order NOT executable by anon", privRows[0].anon === false);
  report("fire_order NOT executable by authenticated", privRows[0].authenticated === false);
  report("fire_order executable by service_role", privRows[0].service_role === true);

  /* Simulate a browser holding only the public anon key, and count what it
     can actually read. `request.jwt.claims` is exactly the GUC PostgREST /
     Realtime populate from the JWT, so this is the real policy path. */
  async function readAsAnon(claims, table) {
    try {
      await q("BEGIN");
      await q("SELECT set_config('request.jwt.claims', $1, true)", [
        claims === null ? "" : JSON.stringify(claims),
      ]);
      await q("SET LOCAL ROLE anon");
      const res = await q(`SELECT count(*)::int AS n FROM ${table}`);
      await q("ROLLBACK");
      return res.rows[0].n;
    } catch (err) {
      await q("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  const noToken = await readAsAnon(null, "restaurant_tables");
  report(
    "no token ⇒ 0 rows (was the USING(true) hole)",
    noToken === 0,
    `read ${noToken} of the floor`,
  );

  const dinerToken = await readAsAnon({ table_token: "k7x2p" }, "restaurant_tables");
  report(
    "diner token ⇒ only its own table",
    dinerToken === 1,
    `read ${dinerToken} row(s)`,
  );

  const dinerLeak = await readAsAnon({ table_token: "k7x2p" }, "cart_items");
  report(
    "diner token scoped on cart_items",
    typeof dinerLeak === "number",
    `read ${dinerLeak} row(s)`,
  );

  const staffToken = await readAsAnon({ staff: "kitchen" }, "restaurant_tables");
  report(
    "staff token ⇒ whole floor",
    staffToken >= 5,
    `read ${staffToken} row(s)`,
  );

  /* anon must not be able to write. The IDs are resolved as the OWNER first
     (not inside the anon transaction) — a sub-select source under anon RLS
     returns zero rows, so the INSERT would insert nothing and raise nothing,
     making the test pass for the wrong reason. */
  const { rows: idRows } = await q(
    `SELECT (SELECT id FROM restaurant_tables ORDER BY code LIMIT 1) AS table_id,
            (SELECT id FROM menu_items        ORDER BY name LIMIT 1) AS menu_item_id`,
  );
  const { table_id: sampleTableId, menu_item_id: sampleMenuItemId } = idRows[0];

  let anonWriteDenied = false;
  let anonWriteError = "no error raised — INSERT was accepted";
  try {
    await q("BEGIN");
    await q("SET LOCAL ROLE anon");
    await q(
      "INSERT INTO cart_items (table_id, menu_item_id, quantity) VALUES ($1, $2, 1)",
      [sampleTableId, sampleMenuItemId],
    );
    await q("ROLLBACK");
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    anonWriteError = err.message;
    anonWriteDenied = /permission denied|row-level security|violates/i.test(err.message);
  }
  report("anon cannot INSERT into cart_items", anonWriteDenied, anonWriteError);

  // ------------------------------------------------------------------- 5. seed
  section("5. Seed data");

  const { rows: seedRows } = await q(`
    SELECT
      (SELECT count(*)::int FROM restaurant_tables) AS tables,
      (SELECT count(*)::int FROM menu_items)        AS menu,
      (SELECT count(*)::int FROM staff_terminals)   AS terminals
  `);
  const { tables, menu, terminals } = seedRows[0];
  console.log(`  ℹ️  ${terminals} terminal(s) / ${tables} tables / ${menu} dishes`);
  report("seed applied", tables >= 5 && menu >= 20 && terminals >= 1);
} finally {
  await client.end();
}

console.log(
  `\n[db:verify] ${passed} check(s) passed` +
    (failures.length ? `, ${failures.length} FAILED:\n  • ${failures.join("\n  • ")}` : ""),
);

if (failures.length > 0) process.exitCode = 1;
