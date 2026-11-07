-- 020 — Shared table conversations, messages and voice coordination
--
-- WHY: a table has ONE conversation per seating, not one per phone. Every
-- guest's message and every assistant answer is written once and read by the
-- whole room. The browser's Gemini Live session stays the audio transport;
-- these tables are the shared transcript and the server-side coordination
-- record.
--
-- SECURITY: backend-only. RLS is enabled and no browser policy or grant is
-- added, so only the service role (the API) can read or write these rows.
-- `client_message_id` is the idempotency key that stops a retried send from
-- producing a second message (and a second AI answer).

CREATE TABLE IF NOT EXISTS conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id           uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  -- The seating this conversation belongs to. A cleared table starts a new
  -- session and therefore a new conversation; old history is never exposed to
  -- the next party.
  session_started_at timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, session_started_at)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  table_id             uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  -- Global insertion order gives a stable transcript even when two guests
  -- send inside the same millisecond.
  sequence             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  role                 text NOT NULL CHECK (role IN ('guest', 'assistant', 'system')),
  kind                 text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'voice')),
  participant_id       text,
  participant_name     text NOT NULL DEFAULT '',
  text                 text NOT NULL DEFAULT '' CHECK (char_length(text) <= 4000),
  -- The client's retry key. NULL is allowed (and never conflicts) for
  -- assistant/system rows and for clients that did not send one.
  client_message_id    text,
  reply_to_message_id  uuid REFERENCES conversation_messages(id) ON DELETE SET NULL,
  actions              jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_client_dedupe
    UNIQUE (conversation_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS conversation_messages_transcript_idx
  ON conversation_messages (conversation_id, sequence);

CREATE TABLE IF NOT EXISTS conversation_voice_interactions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id          uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  initiator_participant_id text NOT NULL,
  -- The device that owns the microphone AND the speaker for this turn. The
  -- broadcast names it so only that device plays the answer.
  initiator_device_id      text NOT NULL,
  status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'completed', 'cancelled')),
  started_at               timestamptz NOT NULL DEFAULT now(),
  ended_at                 timestamptz
);

-- One active voice interaction per room/session. The partial unique index is
-- the concurrency guard; the service also returns a friendly 409.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_active_voice
  ON conversation_voice_interactions (conversation_id)
  WHERE status = 'active';

ALTER TABLE conversations                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_voice_interactions  ENABLE ROW LEVEL SECURITY;
