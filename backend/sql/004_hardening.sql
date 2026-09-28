-- =====================================================================
-- AeyChhotu! — 004_hardening.sql
-- Closes the three open items from docs/10-db-report.md §4 that were left
-- "by design" in the MVP. Each one is a data-integrity defect, not polish.
--
--   1. PRICE SNAPSHOT — tickets stored no money at all. E10/E16 joined
--      menu_items.name live, so re-pricing (or renaming) a dish silently
--      rewrote the contents of every historical ticket. `order_items` now
--      carries the unit price charged at fire time, and `orders` carries the
--      frozen total. A bill can no longer change after it was fired.
--
--   2. AUDIT TIMESTAMPS — menu_items, restaurant_tables and order_items had
--      no created_at/updated_at at all, cart_items had no updated_at, and
--      orders.updated_at was written by hand in each UPDATE (so any future
--      query that forgot it left a silently wrong audit field). One shared
--      BEFORE UPDATE trigger now maintains updated_at everywhere, so no
--      statement can forget it.
--
--   3. STATUS TRANSITION GUARD (Rule 13) — "pending → preparing → ready →
--      served" lived only in app code, so a script or a second backend could
--      jump states. A BEFORE UPDATE trigger now rejects illegal moves.
--      Backwards and skipping moves are refused; closing a ticket from any
--      live state stays allowed because the documented duplicate-cleanup in
--      002_review_fixes.sql relies on it.
--
-- Apply:  psql "$DATABASE_URL" -f sql/004_hardening.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================


-- -----------------------1. Missing audit columns -----------------------
-- ADD COLUMN IF NOT EXISTS keeps re-runs free; the defaults backfill
-- existing rows with "now", which is the only honest value available
-- (the real creation time was never recorded).
ALTER TABLE menu_items        ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE menu_items        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE order_items       ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE cart_items        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();


-- -----------------------2. Shared updated_at trigger -------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

-- Attach to every table that has an updated_at column. DROP IF EXISTS first
-- so the migration is re-runnable without stacking duplicate triggers.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['orders', 'menu_items', 'restaurant_tables', 'cart_items']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_set_updated_at', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target || '_set_updated_at', target
    );
    RAISE NOTICE 'trigger %_set_updated_at ensured', target;
  END LOOP;
END
$$;


-- -----------------------3. Price snapshot ------------------------------
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_price numeric(10,2);
ALTER TABLE orders      ADD COLUMN IF NOT EXISTS total      numeric(10,2);

-- Backfill what already exists. The current menu price is the best available
-- approximation for old tickets — the true charged price was never stored,
-- which is exactly the bug this migration prevents going forward.
UPDATE order_items oi
   SET unit_price = mi.price
  FROM menu_items mi
 WHERE mi.id = oi.menu_item_id
   AND oi.unit_price IS NULL;

UPDATE order_items SET unit_price = 0 WHERE unit_price IS NULL;
UPDATE orders o
   SET total = COALESCE(
         (SELECT sum(oi.quantity * oi.unit_price) FROM order_items oi WHERE oi.order_id = o.id),
         0
       )
 WHERE o.total IS NULL;

ALTER TABLE order_items ALTER COLUMN unit_price SET NOT NULL;
ALTER TABLE order_items ALTER COLUMN unit_price SET DEFAULT 0;
ALTER TABLE orders      ALTER COLUMN total      SET NOT NULL;
ALTER TABLE orders      ALTER COLUMN total      SET DEFAULT 0;


-- -----------------------4. Status transition guard (Rule 13) -----------
CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Untouched status (e.g. the total backfill above, or set_updated_at) is
  -- not a transition and must sail through.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'pending'   AND NEW.status = 'preparing')
     OR (OLD.status = 'preparing' AND NEW.status = 'ready')
     -- Closing a ticket is allowed from any live state: E12 does it from
     -- 'ready', and the documented duplicate cleanup in 002_review_fixes.sql
     -- closes stale rounds from wherever they are.
     OR (NEW.status = 'served' AND OLD.status IN ('pending', 'preparing', 'ready'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal order status transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation',
          HINT = 'Allowed: pending->preparing, preparing->ready, or ->served (close).';
END
$function$;

DROP TRIGGER IF EXISTS orders_status_transition ON orders;
CREATE TRIGGER orders_status_transition
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION enforce_order_status_transition();


-- -----------------------5. fire_order() — snapshot the price -----------
-- Same atomic workflow as 001_init.sql (lock, guard, freeze, check, build,
-- drain) with one addition: the unit price is copied off menu_items at the
-- moment of firing, and the order total is frozen with it.
CREATE OR REPLACE FUNCTION fire_order(p_table_token text)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_table_id      uuid;
  v_active_id     uuid;
  v_active_status text;
  v_line_ids      uuid[];
  v_sold_out      text[] := '{}';
  v_order_id      uuid;
  v_created_at    timestamptz;
  v_total         numeric(10,2);
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
    DELETE FROM cart_items ci
     WHERE ci.id = ANY(v_line_ids)
       AND EXISTS (SELECT 1 FROM menu_items mi
                    WHERE mi.id = ci.menu_item_id AND mi.is_available = false);
    RETURN jsonb_build_object('code', 'INVENTORY_FAILURE', 'sold_out', to_jsonb(v_sold_out));
  END IF;

  -- 5) Build the ticket from the frozen snapshot, BEFORE any cart drain, so
  --    a failure here leaves the cart intact for the next attempt.
  --
  --    NOTE: the orders INSERT never sees a cart line that is not in the
  --    cart, so freezing the price here is the same instant as charging it.
  INSERT INTO orders (table_id, status)
  VALUES (v_table_id, 'pending')
  RETURNING id, created_at INTO v_order_id, v_created_at;

  INSERT INTO order_items (order_id, menu_item_id, quantity, request_note, allergy_note, unit_price)
  SELECT v_order_id,
         ci.menu_item_id,
         ci.quantity,
         ci.request_note,
         ci.allergy_note,
         mi.price              -- ← the price snapshot
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
   WHERE ci.id = ANY(v_line_ids)
   ORDER BY ci.created_at, ci.id;

  -- 6) Freeze the bill.
  SELECT COALESCE(sum(quantity * unit_price), 0)
    INTO v_total
    FROM order_items
   WHERE order_id = v_order_id;
  UPDATE orders SET total = v_total WHERE id = v_order_id;

  -- 7) Drain only those same lines (a line added mid-fire survives).
  DELETE FROM cart_items WHERE id = ANY(v_line_ids);

  RETURN jsonb_build_object(
    'code', 'OK',
    'order_id', v_order_id,
    'table_id', v_table_id,
    'status', 'pending',
    'created_at', to_jsonb(v_created_at));
END
$function$;

REVOKE ALL ON FUNCTION fire_order(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fire_order(text) TO service_role;
