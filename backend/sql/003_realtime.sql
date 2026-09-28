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
-- Apply:  psql "$DATABASE_URL" -f sql/003_realtime.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------1. Ensure the publication exists ---------------
-- Supabase provisions `supabase_realtime` automatically; on a bare
-- Postgres (self-hosted / local rehearsal) it may be missing entirely.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
    RAISE NOTICE 'created publication supabase_realtime';
  ELSE
    RAISE NOTICE 'publication supabase_realtime already present — skipped';
  END IF;
END
$$;

-- -----------------------2. Add the streamed tables ---------------------
-- pg_publication_tables is the membership view, so re-running is a no-op
-- instead of an "already member of publication" error.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['orders', 'cart_items']
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_publication_tables
       WHERE pubname    = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename  = target
    ) THEN
      RAISE NOTICE 'public.% already streamed — skipped', target;
    ELSE
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', target);
      RAISE NOTICE 'public.% now streaming on supabase_realtime', target;
    END IF;
  END LOOP;
END
$$;

-- -----------------------3. Full replica identity ----------------------
-- Required for DELETE events to carry table_id so the client-side
-- `filter: table_id=eq.<uuid>` can match them.
ALTER TABLE orders     REPLICA IDENTITY FULL;
ALTER TABLE cart_items REPLICA IDENTITY FULL;

-- -----------------------4. Prove the wiring ---------------------------
-- Prints the resulting membership so a green run is verifiable, not assumed.
DO $$
DECLARE
  listed text;
BEGIN
  SELECT string_agg(tablename, ', ' ORDER BY tablename)
    INTO listed
    FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime'
     AND schemaname = 'public';

  RAISE NOTICE 'supabase_realtime streams: %', COALESCE(listed, '(none)');
END
$$;
