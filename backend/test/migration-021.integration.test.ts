import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/* REAL-POSTGRES verification of migration 021 only. Gated on
   TEST_DATABASE_URL, which must point at a disposable database built from
   sql/001–021. No business rows are created here. */

import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — migration 021 checks skipped";

let manager: DatabaseManager;

before(async () => {
  if (!TEST_DATABASE_URL) return;
  manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));
});

after(async () => {
  if (!TEST_DATABASE_URL) return;
  await manager.shutdown();
});

describe("Migration 021 — schema, RLS and publication", { skip: skipReason }, () => {
  it("creates the credential and outbox columns with their constraints", async () => {
    const columns = await manager.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('table_participant_tokens', 'realtime_outbox')`,
    );
    const byName = new Map(
      columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
    );

    for (const [name, type, nullable] of [
      ["table_participant_tokens.member_id", "uuid", "NO"],
      ["table_participant_tokens.table_id", "uuid", "NO"],
      ["table_participant_tokens.session_started_at", "timestamp with time zone", "NO"],
      ["table_participant_tokens.token_hash", "text", "NO"],
      ["table_participant_tokens.expires_at", "timestamp with time zone", "NO"],
      ["table_participant_tokens.revoked_at", "timestamp with time zone", "YES"],
      ["realtime_outbox.id", "bigint", "NO"],
      ["realtime_outbox.event_id", "uuid", "NO"],
      ["realtime_outbox.table_id", "uuid", "NO"],
      ["realtime_outbox.event", "text", "NO"],
      ["realtime_outbox.payload", "jsonb", "NO"],
      ["realtime_outbox.status", "text", "NO"],
      ["realtime_outbox.attempts", "integer", "NO"],
      ["realtime_outbox.next_attempt_at", "timestamp with time zone", "NO"],
    ] as const) {
      const column = byName.get(name);
      assert.ok(column, `${name} is missing`);
      assert.equal(column.data_type, type, `${name} type`);
      assert.equal(column.is_nullable, nullable, `${name} nullability`);
    }

    const constraints = await manager.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid IN (
          'public.table_participant_tokens'::regclass,
          'public.realtime_outbox'::regclass
        )`,
    );
    const definitions = constraints.rows.map((row) => row.def).join("\n");
    assert.match(definitions, /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    assert.match(definitions, /'pending'::text/);
    assert.match(definitions, /'published'::text/);
    assert.match(definitions, /'suppressed'::text/);
    assert.match(definitions, /char_length\(event\) >= 3/);
    assert.match(definitions, /char_length\(event\) <= 80/);

    const presence = await manager.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.table_device_presence'::regclass
          AND pg_get_constraintdef(oid) LIKE '%participant_id%'`,
    );
    assert.match(presence.rows.map((row) => row.def).join("\n"), /table_members\(id\)/);
  });

  it("creates the token, outbox and presence indexes", async () => {
    const indexes = await manager.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const present = new Set(indexes.rows.map((row) => row.indexname));
    for (const index of [
      "table_participant_tokens_hash_uq",
      "table_participant_tokens_member_active_idx",
      "table_participant_tokens_expiry_idx",
      "table_participant_tokens_seating_idx",
      "table_device_presence_member_idx",
      "realtime_outbox_event_id_uq",
      "realtime_outbox_pending_idx",
      "realtime_outbox_retry_idx",
      "realtime_outbox_cleanup_idx",
    ]) {
      assert.equal(present.has(index), true, `${index} is missing`);
    }
  });

  it("enables RLS and leaves both tables inaccessible to browser roles", async () => {
    const flags = await manager.query<{ name: string; rls: boolean }>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('table_participant_tokens', 'realtime_outbox')`,
    );
    assert.equal(flags.rows.length, 2);
    for (const row of flags.rows) assert.equal(row.rls, true, `${row.name} RLS`);

    for (const table of ["table_participant_tokens", "realtime_outbox"]) {
      const privileges = await manager.query<{
        anon: boolean;
        authenticated: boolean;
        service: boolean;
      }>(
        `SELECT has_table_privilege('anon', $1, 'SELECT') AS anon,
                has_table_privilege('authenticated', $1, 'SELECT') AS authenticated,
                has_table_privilege('service_role', $1, 'SELECT,INSERT,UPDATE,DELETE') AS service`,
        [`public.${table}`],
      );
      assert.equal(privileges.rows[0]?.anon, false, `${table} anon`);
      assert.equal(privileges.rows[0]?.authenticated, false, `${table} authenticated`);
      assert.equal(privileges.rows[0]?.service, true, `${table} service_role`);
    }
  });

  it("keeps both tables out of the Supabase realtime publication", async () => {
    const published = await manager.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_publication_tables
          WHERE pubname = 'supabase_realtime'
            AND schemaname = 'public'
            AND tablename IN ('table_participant_tokens', 'realtime_outbox')
       ) AS present`,
    );
    assert.equal(published.rows[0]?.present, false);
  });
});
