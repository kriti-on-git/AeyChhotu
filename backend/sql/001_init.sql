-- =====================================================================
-- AeyChhotu! — 001_init.sql
-- Tables, constraints, indexes, RLS policies, and the atomic fire RPC.
-- Field names follow docs/2-mvp-ideation.md (DB blueprint) plus the
-- additions mandated by docs/7-api-contract.md §6.
-- Apply:  psql "$DATABASE_URL" -f sql/001_init.sql
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------0. Supabase role stubs ------------------------
-- On Supabase these roles already exist; on a bare Postgres the guard
-- creates them so the RLS policies below can reference them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- -----------------------1. Tables ------------------------------------

-- Blueprint: restaurant_tables(id, code, name) + contract §6: status.
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{4,16}$'),
  name        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'empty' CHECK (status IN ('active', 'empty'))
);

-- Blueprint: menu_items(id, name, price, category, is_available)
--           + contract §6: description, vegetarian.
CREATE TABLE IF NOT EXISTS menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  price         numeric(10,2) NOT NULL CHECK (price >= 0),
  category      text NOT NULL DEFAULT 'Main Course',
  is_available  boolean NOT NULL DEFAULT true,
  description   text NOT NULL DEFAULT '',
  vegetarian    boolean NOT NULL DEFAULT true
);

-- Blueprint: cart_items(id, table_id, menu_item_id, quantity, request_note,
--           allergy_note) + contract §6: added_by (+ created_at for stable
--           offset pagination ordering, same class as orders.updated_at).
CREATE TABLE IF NOT EXISTS cart_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  menu_item_id  uuid NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  request_note  text NOT NULL DEFAULT '' CHECK (char_length(request_note) <= 500),
  allergy_note  text NOT NULL DEFAULT '' CHECK (char_length(allergy_note) <= 500),
  added_by      text NOT NULL DEFAULT 'Guest' CHECK (char_length(added_by) <= 40),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Blueprint: orders(id, table_id, status, created_at) + contract §6: updated_at.
CREATE TABLE IF NOT EXISTS orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE RESTRICT,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'preparing', 'ready', 'served')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Blueprint: order_items(id, order_id, menu_item_id, quantity, request_note,
--           allergy_note).
CREATE TABLE IF NOT EXISTS order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id  uuid NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  request_note  text NOT NULL DEFAULT '' CHECK (char_length(request_note) <= 500),
  allergy_note  text NOT NULL DEFAULT '' CHECK (char_length(allergy_note) <= 500)
);

-- Terminal sessions / master terminal setup parameters (auth feature).
-- ZERO-EXPOSURE: pin_env_var stores the environment variable NAME that
-- holds the PIN — never the PIN value itself.
CREATE TABLE IF NOT EXISTS staff_terminals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_label text NOT NULL DEFAULT '',
  role         text NOT NULL DEFAULT 'kitchen' CHECK (role IN ('kitchen', 'floor')),
  is_active    boolean NOT NULL DEFAULT true,
  pin_env_var  text NOT NULL DEFAULT 'STAFF_PIN',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------2. Indexes -----------------------------------

-- Upsert identity for POST /api/v1/cart/items (E5): lets the INSERT use
-- ON CONFLICT so concurrent "add" taps from two phones can never fork
-- duplicate rows for the same logical line.
CREATE UNIQUE INDEX IF NOT EXISTS cart_items_upsert_uq
  ON cart_items (table_id, menu_item_id, request_note, allergy_note);

CREATE INDEX IF NOT EXISTS cart_items_table_created_idx ON cart_items (table_id, created_at, id);
CREATE INDEX IF NOT EXISTS orders_table_status_idx      ON orders (table_id, status);
CREATE INDEX IF NOT EXISTS orders_active_idx            ON orders (status) WHERE status <> 'served';
CREATE INDEX IF NOT EXISTS orders_created_idx           ON orders (created_at DESC, id DESC);

-- "One active order per table" (the DB half of the duplicate-fire guard).
-- PARTIAL on purpose: only pending/preparing/ready rows are keyed, so a
-- served (closed) round falls out of the index and never blocks the next
-- fire — the same reason fire_order() guards on status IN (...).
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_active_uq
  ON orders (table_id) WHERE status IN ('pending', 'preparing', 'ready');
CREATE INDEX IF NOT EXISTS order_items_order_idx        ON order_items (order_id);
CREATE INDEX IF NOT EXISTS menu_items_category_idx      ON menu_items (category);

-- -----------------------3. Row Level Security -------------------------
-- RLS is ENABLED on every table, and each table carries explicit,
-- permanent policies for SELECT, INSERT, UPDATE and DELETE.
--
-- Design (matches docs/7 §1.4 auth tiers):
--   * SELECT → anon + authenticated, but ALWAYS claim-scoped (this is the
--     "WHERE user_id = the logged-in user" rule of this app):
--       - diner token carries claim table_token = <code> and may read only
--         that table's rows (cart, orders, order_items, table row);
--       - staff token carries claim staff = 'kitchen'|'floor' and may read
--         every row (the KDS board sees the whole floor);
--       - no token ⇒ no rows at all. The old USING (true) let anyone holding
--         the public anon key read every table's cart and allergy notes.
--     The browser needs these SELECTs for Supabase Realtime, and a missing
--     policy still fails as "[] with no error", never as a crash.
--   * INSERT/UPDATE/DELETE → service_role only. All writes go through the
--     backend (which connects as the table-owning role and therefore
--     bypasses RLS) or through server-side service_role usage; clients
--     hold only the public anon key and can READ but never write.
--     A missing anon write policy fails loudly with "permission denied",
--     it never silently returns [].
--   * service_role is never shipped to any client bundle or route that a
--     browser can reach (docs/7 §1.4).

ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_terminals    ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL    ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

-- restaurant_tables ----------------------------------------------------
DROP POLICY IF EXISTS restaurant_tables_select_public ON restaurant_tables;
CREATE POLICY restaurant_tables_select_public ON restaurant_tables
  FOR SELECT TO anon, authenticated
  USING (
    code = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'table_token')
    OR (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'staff')
       IN ('kitchen', 'floor')
  );
DROP POLICY IF EXISTS restaurant_tables_insert_service ON restaurant_tables;
CREATE POLICY restaurant_tables_insert_service ON restaurant_tables
  FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS restaurant_tables_update_service ON restaurant_tables;
CREATE POLICY restaurant_tables_update_service ON restaurant_tables
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS restaurant_tables_delete_service ON restaurant_tables;
CREATE POLICY restaurant_tables_delete_service ON restaurant_tables
  FOR DELETE TO service_role USING (true);

-- menu_items -----------------------------------------------------------
-- Menu stays world-readable: it is a public catalog (no diner data in it),
-- so the QR menu still renders when no token is presented.
DROP POLICY IF EXISTS menu_items_select_public ON menu_items;
CREATE POLICY menu_items_select_public ON menu_items
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS menu_items_insert_service ON menu_items;
CREATE POLICY menu_items_insert_service ON menu_items
  FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS menu_items_update_service ON menu_items;
CREATE POLICY menu_items_update_service ON menu_items
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS menu_items_delete_service ON menu_items;
CREATE POLICY menu_items_delete_service ON menu_items
  FOR DELETE TO service_role USING (true);

-- cart_items -----------------------------------------------------------
DROP POLICY IF EXISTS cart_items_select_public ON cart_items;
CREATE POLICY cart_items_select_public ON cart_items
  FOR SELECT TO anon, authenticated
  USING (
    (SELECT rt.code FROM restaurant_tables rt WHERE rt.id = table_id)
      = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'table_token')
    OR (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'staff')
       IN ('kitchen', 'floor')
  );
DROP POLICY IF EXISTS cart_items_insert_service ON cart_items;
CREATE POLICY cart_items_insert_service ON cart_items
  FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS cart_items_update_service ON cart_items;
CREATE POLICY cart_items_update_service ON cart_items
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS cart_items_delete_service ON cart_items;
CREATE POLICY cart_items_delete_service ON cart_items
  FOR DELETE TO service_role USING (true);

-- orders ---------------------------------------------------------------
DROP POLICY IF EXISTS orders_select_public ON orders;
CREATE POLICY orders_select_public ON orders
  FOR SELECT TO anon, authenticated
  USING (
    (SELECT rt.code FROM restaurant_tables rt WHERE rt.id = table_id)
      = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'table_token')
    OR (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'staff')
       IN ('kitchen', 'floor')
  );
DROP POLICY IF EXISTS orders_insert_service ON orders;
CREATE POLICY orders_insert_service ON orders
  FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS orders_update_service ON orders;
CREATE POLICY orders_update_service ON orders
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS orders_delete_service ON orders;
CREATE POLICY orders_delete_service ON orders
  FOR DELETE TO service_role USING (true);

-- order_items ----------------------------------------------------------
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
DROP POLICY IF EXISTS order_items_insert_service ON order_items;
CREATE POLICY order_items_insert_service ON order_items
  FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS order_items_update_service ON order_items;
CREATE POLICY order_items_update_service ON order_items
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS order_items_delete_service ON order_items;
CREATE POLICY order_items_delete_service ON order_items
  FOR DELETE TO service_role USING (true);

-- staff_terminals: server-only configuration (no secrets inside — the
-- column holds an environment variable NAME, never its value). There is
-- deliberately NO anon/authenticated policy: no browser code reads this
-- table, so a direct client query returning empty is the intended deny,
-- not the silent-RLS bug (that bug concerns tables clients DO read).
DROP POLICY IF EXISTS staff_terminals_service_select ON staff_terminals;
CREATE POLICY staff_terminals_service_select ON staff_terminals
  FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS staff_terminals_service_insert ON staff_terminals;
CREATE POLICY staff_terminals_service_insert ON staff_terminals
  FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS staff_terminals_service_update ON staff_terminals;
CREATE POLICY staff_terminals_service_update ON staff_terminals
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS staff_terminals_service_delete ON staff_terminals;
CREATE POLICY staff_terminals_service_delete ON staff_terminals
  FOR DELETE TO service_role USING (true);

-- -----------------------4. Atomic fire RPC ---------------------------
-- WHY THIS ELIMINATES RACE CONDITIONS (docs/7 §1.9):
--   * The whole E8 workflow — duplicate guard, cart freeze, availability
--     check, order + order_items insert, cart drain — runs inside ONE
--     database function = ONE transaction (single implicit BEGIN/COMMIT).
--   * Step 1 locks the table row (SELECT ... FOR UPDATE). Two phones
--     tapping "Review & Fire" at the same millisecond serialize here:
--     the loser waits, then takes its fresh statement snapshot AFTER the
--     winner committed, so step 2 sees the new active order and returns
--     DUPLICATE_ORDER. Ghost tickets are impossible.
--   * Step 3 freezes the exact cart rows it will transfer (row locks).
--     A concurrent quantity edit waits; a line added mid-fire is not in
--     the id list, so it is neither transferred nor drained — it simply
--     becomes round two's cart.
--   * The availability check (step 4) first LOCKS every menu row the cart
--     references (FOR UPDATE OF mi). 86ing (E14) must take its UPDATE lock
--     on the same rows, so it serializes against the fire transaction:
--     either the 86 committed before our snapshot (we see it and return
--     INVENTORY_FAILURE) or it waits until we commit. Check and transfer
--     can never disagree with what the kitchen actually has.
--   * Business outcomes are RETURNED as jsonb codes (not raised
--     exceptions) so an INVENTORY_FAILURE purge still COMMITS — raising
--     inside plpgsql would roll the purge back and the cart would not
--     match what the diner is told.
CREATE OR REPLACE FUNCTION fire_order(p_table_token text)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_table_id     uuid;
  v_active_id    uuid;
  v_active_status text;
  v_line_ids     uuid[];
  v_sold_out     text[] := '{}';
  v_order_id     uuid;
  v_created_at   timestamptz;
BEGIN
  -- 1) Serialize concurrent fires for this physical table.
  SELECT id INTO v_table_id
    FROM restaurant_tables
   WHERE code = p_table_token
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'TABLE_NOT_FOUND');
  END IF;

  -- 2) Duplicate guard — fresh statement snapshot taken after the lock.
  SELECT id, status INTO v_active_id, v_active_status
    FROM orders
   WHERE table_id = v_table_id
     AND status IN ('pending', 'preparing', 'ready')
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'code', 'DUPLICATE_ORDER', 'order_id', v_active_id, 'status', v_active_status);
  END IF;

  -- 3) Freeze the cart snapshot, then check it is not empty.
  SELECT array_agg(id) INTO v_line_ids
    FROM (SELECT id FROM cart_items WHERE table_id = v_table_id FOR UPDATE) AS frozen;
  IF v_line_ids IS NULL OR array_length(v_line_ids, 1) = 0 THEN
    RETURN jsonb_build_object('code', 'EMPTY_CART');
  END IF;

  -- 4) Inventory check on exactly the frozen lines. Lock every menu row the
  --    cart references first (FOR UPDATE OF mi) so a concurrent 86 (E14)
  --    serializes against this transaction instead of racing it.
  PERFORM mi.id
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
   WHERE ci.id = ANY(v_line_ids)
     FOR UPDATE OF mi;

  SELECT COALESCE(array_agg(mi.name ORDER BY mi.name), '{}') INTO v_sold_out
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
   WHERE ci.id = ANY(v_line_ids)
     AND mi.is_available = false;
  IF array_length(v_sold_out, 1) > 0 THEN
    -- Purge the sold-out lines so the cart matches the 409 the client
    -- receives. RETURN (not RAISE) so this DELETE commits.
    DELETE FROM cart_items ci
     WHERE ci.id = ANY(v_line_ids)
       AND EXISTS (SELECT 1 FROM menu_items mi
                    WHERE mi.id = ci.menu_item_id AND mi.is_available = false);
    RETURN jsonb_build_object('code', 'INVENTORY_FAILURE', 'sold_out', to_jsonb(v_sold_out));
  END IF;

  -- 5) Build the ticket from the frozen snapshot.
  INSERT INTO orders (table_id, status)
  VALUES (v_table_id, 'pending')
  RETURNING id, created_at INTO v_order_id, v_created_at;

  INSERT INTO order_items (order_id, menu_item_id, quantity, request_note, allergy_note)
  SELECT v_order_id, ci.menu_item_id, ci.quantity, ci.request_note, ci.allergy_note
    FROM cart_items ci
   WHERE ci.id = ANY(v_line_ids)
   ORDER BY ci.created_at, ci.id;

  -- 6) Drain only those same lines (a line added mid-fire survives).
  DELETE FROM cart_items WHERE id = ANY(v_line_ids);

  RETURN jsonb_build_object(
    'code', 'OK',
    'order_id', v_order_id,
    'table_id', v_table_id,
    'status', 'pending',
    'created_at', to_jsonb(v_created_at));
END
$function$;

-- Clients holding the public anon key must NOT be able to fire orders
-- directly through supabase-js .rpc(); only the backend may call this.
REVOKE ALL ON FUNCTION fire_order(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fire_order(text) TO service_role;
