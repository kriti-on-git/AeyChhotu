-- =====================================================================
-- 021 — Participant credentials and the Phase 5.2 realtime outbox
--
-- WHY
--   1. PHASE 5.2 removes client-asserted participant identity. A guest
--      presents a server-issued bearer credential (`pc_...`) instead of
--      `X-Participant-Id` + the shared table pass. Only the SHA-256 hash is
--      stored; the raw token exists once, in the grant response.
--   2. Conversation and session realtime events must not be emitted from a
--      service after its transaction commits. They are written to an outbox
--      in the SAME transaction as the business row and published later by a
--      single per-table ordered dispatcher.
--
-- SECURITY
--   * Both tables are backend-only: RLS enabled, browser roles explicitly
--     revoked, no realtime publication. A leaked anon key reads nothing.
--   * Outbox payloads are validated in application code; no token material,
--     table secret, provider credential or unnecessary personal data is
--     written here.
--
-- LIFECYCLE
--   * A token is bound to `table_members.id` AND the exact seating
--     (`session_started_at`). Reuse after a clear fails even while the row is
--     still present.
--   * Expiry is 12 hours, non-sliding. `last_used_at` is diagnostic only.
--   * Deleting a member (clear deletes every member) cascades its tokens.
--
-- Apply:  psql "$DATABASE_URL" -f sql/021_participant_tokens_and_realtime_outbox.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------1. Participant credentials ----------------------
CREATE TABLE IF NOT EXISTS table_participant_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The roster row this credential authenticates. CASCADE means clearing a
  -- table (which deletes its members) can never strand a credential.
  member_id          uuid NOT NULL REFERENCES table_members(id) ON DELETE CASCADE,
  table_id           uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  -- The exact seating. A token from the previous party fails validation even
  -- if its member row somehow survived a clear.
  session_started_at timestamptz NOT NULL,
  -- Only the digest. The raw `pc_...` value is never persisted.
  token_hash         text NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,
  last_used_at       timestamptz,
  CONSTRAINT table_participant_tokens_hash_shape
    CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

-- Unique hash lookup. This is also the authorization index.
CREATE UNIQUE INDEX IF NOT EXISTS table_participant_tokens_hash_uq
  ON table_participant_tokens (token_hash);

-- Active-token lookup for the 5-token cap and self/staff revocation.
CREATE INDEX IF NOT EXISTS table_participant_tokens_member_active_idx
  ON table_participant_tokens (member_id, issued_at DESC)
  WHERE revoked_at IS NULL;

-- Expiry cleanup / operational sweep.
CREATE INDEX IF NOT EXISTS table_participant_tokens_expiry_idx
  ON table_participant_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- Clearing a seating deletes by table + seating.
CREATE INDEX IF NOT EXISTS table_participant_tokens_seating_idx
  ON table_participant_tokens (table_id, session_started_at);

ALTER TABLE table_participant_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE table_participant_tokens FROM anon, authenticated;
GRANT ALL ON TABLE table_participant_tokens TO service_role;

-- -----------------------2. Presence ownership ---------------------------
-- Presence used to be keyed by a client-supplied device id alone, so one
-- guest could keep another guest's seat "alive" or delete it. The row now
-- records the authenticated member; heartbeat writes and removals are
-- accepted only from that exact member.
ALTER TABLE table_device_presence
  ADD COLUMN IF NOT EXISTS participant_id uuid
    REFERENCES table_members(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS table_device_presence_member_idx
  ON table_device_presence (table_id, participant_id);

-- No legacy presence row can be tied to a member without trusting the
-- client-supplied device id. Presence is ephemeral, so the safe backfill is
-- to discard every unowned row instead of leaving it claimable. From here on
-- an authenticated heartbeat always writes its own member id.
DELETE FROM table_device_presence WHERE participant_id IS NULL;

-- -----------------------3. Realtime outbox ------------------------------
-- Bigint identity supplies the total order the dispatcher relies on. The
-- UUID is the client-facing dedupe id and survives retries.
CREATE TABLE IF NOT EXISTS realtime_outbox (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  table_id           uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  -- The seating the event belongs to. A terminal event carries the seating
  -- that just ended; suppression compares on the same value.
  session_started_at timestamptz,
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  event              text NOT NULL CHECK (char_length(event) BETWEEN 3 AND 80),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'published', 'suppressed')),
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at       timestamptz,
  suppressed_at      timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS realtime_outbox_event_id_uq
  ON realtime_outbox (event_id);

-- The dispatcher's work queue: oldest pending row per table, in id order.
CREATE INDEX IF NOT EXISTS realtime_outbox_pending_idx
  ON realtime_outbox (table_id, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS realtime_outbox_retry_idx
  ON realtime_outbox (next_attempt_at)
  WHERE status = 'pending';

-- Retention sweep of terminal rows.
CREATE INDEX IF NOT EXISTS realtime_outbox_cleanup_idx
  ON realtime_outbox (status, COALESCE(published_at, suppressed_at));

ALTER TABLE realtime_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE realtime_outbox FROM anon, authenticated;
GRANT ALL ON TABLE realtime_outbox TO service_role;

-- Never published through Supabase Realtime: the API dispatcher owns it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'table_participant_tokens'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.table_participant_tokens;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'realtime_outbox'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.realtime_outbox;
  END IF;
  RAISE NOTICE 'credential/outbox tables are not published through supabase_realtime';
END
$$;

-- -----------------------4. Prove the shape ------------------------------
DO $$
BEGIN
  IF to_regclass('public.table_participant_tokens') IS NULL THEN
    RAISE EXCEPTION 'table_participant_tokens is missing';
  END IF;
  IF to_regclass('public.realtime_outbox') IS NULL THEN
    RAISE EXCEPTION 'realtime_outbox is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'table_device_presence'
       AND column_name = 'participant_id'
  ) THEN
    RAISE EXCEPTION 'table_device_presence.participant_id is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'table_participant_tokens_hash_uq'
  ) THEN
    RAISE EXCEPTION 'token hash unique index is missing';
  END IF;
  RAISE NOTICE 'participant credentials and realtime outbox ready';
END
$$;
