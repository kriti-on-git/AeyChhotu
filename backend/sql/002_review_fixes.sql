-- =====================================================================
-- AeyChhotu! — 002_review_fixes.sql
-- Targeted fixes from the strict DB review (docs/10-db-report.md §4 +
-- the top-5 findings). Every statement is an ALTER / policy swap on an
-- existing database — there is NO create_all / db-push equivalent here,
-- and the whole script is safe to re-run (idempotent).
--
-- Apply:  psql "$DATABASE_URL" -f sql/002_review_fixes.sql
--
-- What it changes
--   1. orders.table_id FK: ON DELETE CASCADE → ON DELETE RESTRICT, so
--      deleting a restaurant table can no longer wipe order history.
--   2. Partial UNIQUE index: only ONE active order per table (the DB
--      half of the duplicate-fire guard). Served rows fall out of the
--      index, so a finished round never blocks the next fire.
--   3. RLS SELECT policies: USING (true) → claim-scoped reads
--      (table_token claim for diners, staff claim for the KDS), which
--      closes the "anon key can read every cart" hole.
--
-- Old-data safety
--   * Step 1 can NOT fail on old data: the FK was enforced on every
--     write, so orphans are impossible; we only change what happens to
--     FUTURE deletes.
--   * Step 2 CAN fail if old data already has two active orders for one
--     table (nothing enforced this before). Step 0 refuses to run and
--     prints the cleanup statement instead of half-applying.
--   * Step 3 touches no rows at all.
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 0 — pre-flight guard for the new UNIQUE rule.
-- If any table currently has more than one active order, STOP and show
-- the cleanup. Keep the NEWEST active ticket (it is the one the kitchen
-- is working on) and close the older duplicates first:
--
--   UPDATE orders o
--      SET status = 'served', updated_at = now()
--    WHERE o.status IN ('pending', 'preparing', 'ready')
--      AND EXISTS (
--            SELECT 1 FROM orders n
--             WHERE n.table_id = o.table_id
--               AND n.status IN ('pending', 'preparing', 'ready')
--               AND (n.created_at, n.id) > (o.created_at, o.id));
--
-- (Verify with the kitchen before running it: those older tickets may be
-- real food that still has to go out. Then re-run this migration.)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes
    FROM (SELECT table_id
            FROM orders
           WHERE status IN ('pending', 'preparing', 'ready')
           GROUP BY table_id
          HAVING count(*) > 1) AS dirty;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'Step 0 blocked: % table(s) already have more than one active order. Run the cleanup UPDATE in the header of 002_review_fixes.sql first, then re-run.', v_dupes
      USING HINT = 'Keep the newest active order per table, mark the older duplicates served (confirm with the kitchen first).';
  END IF;
END
$$;


-- ---------------------------------------------------------------------
-- STEP 1 — history can no longer be wiped by a table delete.
-- ON DELETE CASCADE → ON DELETE RESTRICT. Postgres has no
-- "ALTER ... ON DELETE", so drop + re-add — guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'orders_table_id_fkey'
           AND conrelid = 'orders'::regclass
           AND contype = 'f'
           AND confdeltype = 'c'          -- 'c' = CASCADE
      ) THEN
    ALTER TABLE orders DROP CONSTRAINT orders_table_id_fkey;
    ALTER TABLE orders
      ADD CONSTRAINT orders_table_id_fkey
      FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
      ON DELETE RESTRICT;
    RAISE NOTICE 'orders.table_id: ON DELETE CASCADE -> ON DELETE RESTRICT';
  ELSE
    RAISE NOTICE 'orders.table_id: already RESTRICT (or custom name) — skipped';
  END IF;
END
$$;


-- ---------------------------------------------------------------------
-- STEP 2 — "one active order per table" as a raw SQL constraint.
-- Partial UNIQUE: only pending/preparing/ready rows take part, so
-- served/closed rounds never block a new fire (the cancelled-booking
-- requirement). fire_order() already serializes per table with
-- FOR UPDATE, so this index is a backstop, not a hot path.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_active_uq
  ON orders (table_id) WHERE status IN ('pending', 'preparing', 'ready');


-- ---------------------------------------------------------------------
-- STEP 3 — RLS: replace every "everyone may read" policy with a
-- claim-scoped one. Claims come from the JWT the browser presents
-- (minted by E1 for diners, E2 for staff, signed with
-- SUPABASE_JWT_SECRET). No token ⇒ NULL claims ⇒ zero rows.
-- Same definitions as 001_init.sql — this block only exists so an
-- ALREADY-initialized database picks the fix up.
-- ---------------------------------------------------------------------

-- 3a. restaurant_tables: own row, or any row for staff.
DROP POLICY IF EXISTS restaurant_tables_select_public ON restaurant_tables;
CREATE POLICY restaurant_tables_select_public ON restaurant_tables
  FOR SELECT TO anon, authenticated
  USING (
    code = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'table_token')
    OR (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'staff')
       IN ('kitchen', 'floor')
  );

-- 3b. menu_items: public catalog, unchanged on purpose.
DROP POLICY IF EXISTS menu_items_select_public ON menu_items;
CREATE POLICY menu_items_select_public ON menu_items
  FOR SELECT TO anon, authenticated USING (true);

-- 3c. cart_items: only the cart of the table the token names.
DROP POLICY IF EXISTS cart_items_select_public ON cart_items;
CREATE POLICY cart_items_select_public ON cart_items
  FOR SELECT TO anon, authenticated
  USING (
    (SELECT rt.code FROM restaurant_tables rt WHERE rt.id = table_id)
      = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'table_token')
    OR (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'staff')
       IN ('kitchen', 'floor')
  );

-- 3d. orders: only the orders of the table the token names.
DROP POLICY IF EXISTS orders_select_public ON orders;
CREATE POLICY orders_select_public ON orders
  FOR SELECT TO anon, authenticated
  USING (
    (SELECT rt.code FROM restaurant_tables rt WHERE rt.id = table_id)
      = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'table_token')
    OR (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'staff')
       IN ('kitchen', 'floor')
  );

-- 3e. order_items: scope walks order -> order.table_id -> table.code.
DROP POLICY IF EXISTS order_items_select_public ON order_items;
CREATE POLICY order_items_select_public ON order_items
  FOR SELECT TO anon, authenticated
  USING (
    (SELECT rt.code FROM restaurant_tables rt
      WHERE rt.id = (SELECT o.table_id FROM orders o WHERE o.id = order_items.order_id))
      = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'table_token')
    OR (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'staff')
       IN ('kitchen', 'floor')
  );

-- staff_terminals deliberately has NO anon/authenticated policy: no
-- browser reads it (unchanged from 001_init.sql).
