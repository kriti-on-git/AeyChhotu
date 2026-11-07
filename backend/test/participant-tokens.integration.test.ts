import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/* REAL-POSTGRES checks for participant credentials: only hashes persisted,
   the five-token cap (including concurrent issuance), 12-hour expiry,
   revocation, and rejection after a new seating starts. */

import {
  DatabaseManager,
  type DbTransaction,
} from "../src/infrastructure/database/DatabaseManager.js";
import {
  MAX_ACTIVE_PARTICIPANT_TOKENS,
  ParticipantTokenStore,
  hashParticipantToken,
} from "../src/modules/table/table.participant-tokens.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres participant-token checks skipped";

let manager: DatabaseManager;
let store: ParticipantTokenStore;
let tableId = "";
let tableCode = "";
let otherTableId = "";
let memberA = "";
let memberB = "";
let sessionStartedAt: Date;

before(async () => {
  if (!TEST_DATABASE_URL) return;
  manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));
  store = new ParticipantTokenStore(manager);

  tableCode = `pc${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  sessionStartedAt = new Date();
  const table = await manager.query<{ id: string }>(
    `INSERT INTO restaurant_tables
       (code, name, status, session_pin, session_secret, session_started_at)
     VALUES ($1, $2, 'active', '42', 'abcdefghijklmnopqrst', $3)
     RETURNING id`,
    [tableCode, `Tokens ${tableCode}`, sessionStartedAt],
  );
  tableId = table.rows[0]?.id ?? "";
  assert.ok(tableId);

  const other = await manager.query<{ id: string }>(
    `INSERT INTO restaurant_tables
       (code, name, status, session_pin, session_secret, session_started_at)
     VALUES ($1, $2, 'active', '43', 'abcdefghijklmnopqrst', $3)
     RETURNING id`,
    [`${tableCode}x`, `Tokens other`, sessionStartedAt],
  );
  otherTableId = other.rows[0]?.id ?? "";
  assert.ok(otherTableId);

  const members = await manager.query<{ id: string; user_id: string }>(
    `INSERT INTO table_members (table_id, user_id, name)
     VALUES ($1, 'token-a', 'Asha'), ($1, 'token-b', 'Ravi')
     RETURNING id, user_id`,
    [tableId],
  );
  memberA = members.rows.find((row) => row.user_id === "token-a")?.id ?? "";
  memberB = members.rows.find((row) => row.user_id === "token-b")?.id ?? "";
  assert.ok(memberA && memberB);
});

after(async () => {
  if (!TEST_DATABASE_URL) return;
  if (tableId) {
    await manager.query("DELETE FROM table_participant_tokens WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM table_members WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
  }
  if (otherTableId) {
    await manager.query("DELETE FROM table_participant_tokens WHERE table_id = $1", [otherTableId]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [otherTableId]);
  }
  await manager.shutdown();
});

async function issueFor(memberId: string) {
  return store.transaction((tx) =>
    store.issue(tx, {
      memberId,
      tableId,
      sessionStartedAt,
    }),
  );
}

/** Hold the table row FOR UPDATE while `work` runs, so a concurrent
    authorization blocks on the same lock order the real writers use. */
async function holdTableWhile(
  work: (tx: DbTransaction) => Promise<void>,
): Promise<{ done: Promise<void>; release: () => void }> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockedPromise = new Promise<void>((resolve) => {
    locked = resolve;
  });

  const done = store.transaction(async (tx) => {
    await tx.query("SELECT id FROM restaurant_tables WHERE id = $1 FOR UPDATE", [tableId]);
    await work(tx);
    locked();
    await hold;
  });

  await lockedPromise;
  return { done, release };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ParticipantTokenStore — real Postgres", { skip: skipReason }, () => {
  it("persists only the SHA-256 digest and returns the raw token once", async () => {
    const issued = await issueFor(memberA);
    assert.match(issued.participant_token, /^pc_[A-Za-z0-9_-]{43}$/);
    assert.ok(issued.participant_expires_at instanceof Date);

    const stored = await manager.query<{
      token_hash: string;
      raw_present: boolean;
      hours: number;
    }>(
      `SELECT token_hash,
              token_hash = $2 AS raw_present,
              (EXTRACT(EPOCH FROM (expires_at - issued_at)) / 3600)::int AS hours
         FROM table_participant_tokens
        WHERE token_hash = $1`,
      [hashParticipantToken(issued.participant_token), issued.participant_token],
    );
    assert.equal(stored.rows[0]?.raw_present, false);
    assert.equal(stored.rows[0]?.hours, 12);

    /* Use shortens only last_used_at; the absolute expiry never slides. */
    const expiresAt = issued.participant_expires_at.getTime();
    await store.touch(issued.participant_token);
    const touched = await manager.query<{ expires_at: Date }>(
      "SELECT expires_at FROM table_participant_tokens WHERE token_hash = $1",
      [hashParticipantToken(issued.participant_token)],
    );
    assert.equal(touched.rows[0]?.expires_at.getTime(), expiresAt);

    const principal = await store.authorizeByHash(hashParticipantToken(issued.participant_token));
    assert.equal(principal?.participant_id, memberA);
    assert.equal(principal?.table_id, tableId);
  });

  it("caps live tokens at five and revokes the oldest on the sixth", async () => {
    await store.transaction((tx) => store.deleteForTable(tx, otherTableId));
    await store.transaction((tx) =>
      tx.query("DELETE FROM table_participant_tokens WHERE member_id = $1", [memberB]),
    );

    const issued: string[] = [];
    for (let index = 0; index < MAX_ACTIVE_PARTICIPANT_TOKENS; index += 1) {
      issued.push((await issueFor(memberB)).participant_token);
    }
    const sixth = await issueFor(memberB);
    issued.push(sixth.participant_token);

    const live = await manager.query<{ live: number }>(
      `SELECT count(*)::int AS live
         FROM table_participant_tokens
        WHERE member_id = $1
          AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`,
      [memberB],
    );
    assert.equal(live.rows[0]?.live, MAX_ACTIVE_PARTICIPANT_TOKENS);

    const oldest = await manager.query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM table_participant_tokens WHERE token_hash = $1",
      [hashParticipantToken(issued[0]!)],
    );
    assert.equal(oldest.rows[0]?.revoked_reason, "token_cap");
    assert.equal(await store.authorizeByHash(hashParticipantToken(issued[0]!)), null);
    assert.ok(await store.authorizeByHash(hashParticipantToken(sixth.participant_token)));

    /* Concurrent issuance must not exceed the cap either: the member row
       lock serializes it. */
    await Promise.all(
      Array.from({ length: MAX_ACTIVE_PARTICIPANT_TOKENS + 3 }, () => issueFor(memberB)),
    );
    const afterRace = await manager.query<{ live: number }>(
      `SELECT count(*)::int AS live
         FROM table_participant_tokens
        WHERE member_id = $1
          AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`,
      [memberB],
    );
    assert.equal(afterRace.rows[0]?.live, MAX_ACTIVE_PARTICIPANT_TOKENS);
  });

  it("rejects expired and revoked tokens", async () => {
    const expired = await issueFor(memberA);
    await manager.query(
      "UPDATE table_participant_tokens SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",
      [hashParticipantToken(expired.participant_token)],
    );
    assert.equal(await store.authorizeByHash(hashParticipantToken(expired.participant_token)), null);

    const revoked = await issueFor(memberA);
    const count = await store.revokeSelf(revoked.participant_token);
    assert.ok(count >= 1);
    assert.equal(await store.authorizeByHash(hashParticipantToken(revoked.participant_token)), null);
  });

  it("re-evaluates expiry and revocation after waiting for the table lock", async () => {
    const expiring = await issueFor(memberA);
    const expiringHash = hashParticipantToken(expiring.participant_token);
    const expiryHolder = await holdTableWhile(async (tx) => {
      await tx.query(
        "UPDATE table_participant_tokens SET expires_at = clock_timestamp() + interval '250 milliseconds' WHERE token_hash = $1",
        [expiringHash],
      );
    });

    const expiryAuth = store.transaction((tx) =>
      store.authorizeInTransaction(tx, expiring.participant_token),
    );
    await sleep(300);
    expiryHolder.release();
    await expiryHolder.done;
    assert.equal(await expiryAuth, null, "the expiry must be read after the lock wait");

    const revoking = await issueFor(memberA);
    const revokingHash = hashParticipantToken(revoking.participant_token);
    const revokeHolder = await holdTableWhile(async (tx) => {
      await tx.query(
        "UPDATE table_participant_tokens SET revoked_at = clock_timestamp(), revoked_reason = 'self' WHERE token_hash = $1",
        [revokingHash],
      );
    });

    const revokeAuth = store.transaction((tx) =>
      store.authorizeInTransaction(tx, revoking.participant_token),
    );
    await sleep(100);
    revokeHolder.release();
    await revokeHolder.done;
    assert.equal(await revokeAuth, null, "a revocation committed during the wait must win");
  });

  it("binds the token to the exact seating and table", async () => {
    const token = await issueFor(memberA);
    const principal = await store.authorizeByHash(hashParticipantToken(token.participant_token));
    assert.equal(principal?.table_id, tableId);

    await manager.query(
      "UPDATE restaurant_tables SET session_started_at = $2 WHERE id = $1",
      [tableId, new Date(sessionStartedAt.getTime() + 60 * 60 * 1_000)],
    );
    assert.equal(await store.authorizeByHash(hashParticipantToken(token.participant_token)), null);

    await manager.query(
      "UPDATE restaurant_tables SET session_started_at = $2 WHERE id = $1",
      [tableId, sessionStartedAt],
    );
    assert.ok(await store.authorizeByHash(hashParticipantToken(token.participant_token)));
  });

  it("staff revocation is scoped to the member on that table", async () => {
    const token = await issueFor(memberB);
    assert.equal(await store.revokeForMember(`${tableCode}x`, memberB), 0);
    assert.ok(await store.authorizeByHash(hashParticipantToken(token.participant_token)));

    const revoked = await store.revokeForMember(tableCode, memberB);
    assert.ok(revoked >= 1);
    assert.equal(await store.authorizeByHash(hashParticipantToken(token.participant_token)), null);
  });
});
