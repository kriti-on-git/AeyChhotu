-- =====================================================================
-- AeyChhotu! — 003_realtime.sql
-- Wires Postgres logical replication for Supabase Realtime, so channels
-- A (table_carts) and B/C (order_tracker / kds_orders) actually deliver.
--
-- WHY THIS FILE EXISTS
--   RLS policies decide WHO may read a row, but they say nothing about
--   whether a change is *streamed* at all. Streaming requires the table to
--   be a member of the `supabase_realtime` publication. Without this file
--   the browser subscribes successfully, receives ZERO events, and the app
--   silently degrades to its REST-polling fallback — the failure looks like
--   "realtime is slow", not like an error.
--
-- Tables added (exactly the two the shipped client subscribes to):
--   * orders      → kds_orders (INSERT)  + order_tracker:{id} (UPDATE)
--   * cart_items  → table_carts:{token}  (INSERT / UPDATE / DELETE)
--   menu_items is deliberately NOT added: no client channel consumes it
--   today (E14 greys a row by refetching the menu). Add it in one line here
--   if a live menu channel lands.
--
-- REPLICA IDENTITY FULL
--   On DELETE, Postgres sends only the primary key in `old` unless replica
--   identity is FULL. Supabase matches the client's `filter` (table_id=eq…)
--   against that record, so with the default identity a cart-line DELETE
--   cannot be matched to the table and the event never reaches channel A.
--   FULL is what makes DELETE propagation correct. Cost: slightly larger WAL
--   entries for these two tables — acceptable, they are small hot tables.
--
-- DEGRADES INSTEAD OF FAILING
--   `CREATE PUBLICATION` raises "logical decoding requires wal_level >=
--   logical". Supabase ships with wal_level=logical, but a plain self-hosted
--   Postgres defaults to `replica` — and on such a server Realtime simply
--   cannot work. That is a degraded-but-valid deployment (the client falls
--   back to REST polling), so this migration does NOT abort setup over it:
--   it reports the reason and leaves the rest of the schema intact.
--   Log grep target: "realtime skipped".
--
-- Apply:  psql "$DATABASE_URL" -f sql/003_realtime.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------1 + 2. Publication and membership --------------
DO $$
DECLARE
  v_wal     text;
  v_target  text;
BEGIN
  v_wal := current_setting('wal_level', true);

  IF v_wal IS DISTINCT FROM 'logical' THEN
    RAISE NOTICE
      'realtime skipped: wal_level is "%" (needs "logical"). Realtime will not stream; the app runs REST + 5s polling instead. Fix with: postgres -c wal_level=logical, then re-run.',
      COALESCE(v_wal, 'unknown');
    RETURN;
  END IF;

  -- Supabase provisions `supabase_realtime` automatically; on a bare
  -- Postgres (self-hosted / CI / local rehearsal) it may be missing.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
    RAISE NOTICE 'created publication supabase_realtime';
  ELSE
    RAISE NOTICE 'publication supabase_realtime already present — skipped';
  END IF;

  -- pg_publication_tables is the membership view, so re-running is a no-op
  -- instead of an "already member of publication" error.
  FOREACH v_target IN ARRAY ARRAY['orders', 'cart_items']
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_publication_tables
       WHERE pubname    = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename  = v_target
    ) THEN
      RAISE NOTICE 'public.% already streamed — skipped', v_target;
    ELSE
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_target);
      RAISE NOTICE 'public.% now streaming on supabase_realtime', v_target;
    END IF;
  END LOOP;
END
$$;

-- -----------------------3. Full replica identity ----------------------
-- Not gated on wal_level: this is valid on any Postgres and only affects
-- the contents of the WAL record, so it is harmless to set up front.
ALTER TABLE orders     REPLICA IDENTITY FULL;
ALTER TABLE cart_items REPLICA IDENTITY FULL;

-- -----------------------4. Prove the wiring ---------------------------
DO $$
DECLARE
  v_wal    text;
  v_listed text;
BEGIN
  v_wal := current_setting('wal_level', true);

  IF v_wal IS DISTINCT FROM 'logical' THEN
    RAISE NOTICE 'supabase_realtime: unavailable on this server (wal_level=%)', COALESCE(v_wal, 'unknown');
    RETURN;
  END IF;

  SELECT string_agg(tablename, ', ' ORDER BY tablename)
    INTO v_listed
    FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime'
     AND schemaname = 'public';

  RAISE NOTICE 'supabase_realtime streams: %', COALESCE(v_listed, '(none)');
END
$$;
