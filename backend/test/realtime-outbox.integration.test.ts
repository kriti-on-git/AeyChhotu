import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/* REAL-POSTGRES checks for the Phase 5.2 outbox: transactional insertion,
   per-table ordering, terminal-last delivery, suppression with payload wipe,
   restart-safe pending rows, retry accounting and retention cleanup. */

import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { RealtimeOutboxDispatcher } from "../src/modules/realtime-outbox/realtime-outbox.dispatcher.js";
import { RealtimeOutboxRepository } from "../src/modules/realtime-outbox/realtime-outbox.repository.js";
import type { RealtimeOutboxPublisher } from "../src/modules/realtime-outbox/realtime-outbox.types.js";
import { TERMINAL_SESSION_EVENT } from "../src/modules/realtime-outbox/realtime-outbox.types.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres outbox checks skipped";

let manager: DatabaseManager;
let repository: RealtimeOutboxRepository;
let tableId = "";
const sessionStartedAt = new Date("2026-11-07T10:00:00.000Z");

class FakePublisher implements RealtimeOutboxPublisher {
  available = true;
  fail = false;
  hang = false;
  readonly events: Array<{ tableId: string; event: string; data: unknown }> = [];
  readonly disconnects: string[] = [];

  isAvailable(): boolean {
    return this.available;
  }

  toTable(tableId: string, event: string, data: unknown) {
    if (this.hang) {
      return new Promise<never>(() => undefined) as unknown as {
        recipients: number;
        skipped: boolean;
      };
    }
    if (this.fail) throw new Error("transport refused");
    this.events.push({ tableId, event, data });
    return { recipients: 1, skipped: false };
  }

  disconnectTable(tableId: string): void {
    this.disconnects.push(tableId);
  }
}

before(async () => {
  if (!TEST_DATABASE_URL) return;
  manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));
  repository = new RealtimeOutboxRepository(manager);

  const table = await manager.query<{ id: string }>(
    `INSERT INTO restaurant_tables (code, name, status)
     VALUES ($1, $2, 'active')
     RETURNING id`,
    [`ob${randomUUID().replace(/-/g, "").slice(0, 10)}`, "Outbox test"],
  );
  tableId = table.rows[0]?.id ?? "";
  assert.ok(tableId);
});

after(async () => {
  if (!TEST_DATABASE_URL) return;
  if (tableId) {
    await manager.query("DELETE FROM realtime_outbox WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
  }
  await manager.shutdown();
});

function dispatcher(publisher: RealtimeOutboxPublisher) {
  return new RealtimeOutboxDispatcher({
    db: manager,
    repository,
    publisher: () => publisher,
    pollMs: 5,
    publishTimeoutMs: 200,
    retryBaseMs: 1,
    maxRetryMs: 5,
    batchSize: 10,
  });
}

describe("Realtime outbox — real Postgres", { skip: skipReason }, () => {
  it("waits for Socket.IO and publishes in insertion order with event ids", async () => {
    const publisher = new FakePublisher();
    publisher.available = false;
    const queue = dispatcher(publisher);
    assert.equal(await queue.dispatchOnce(), "unavailable");
    publisher.available = true;

    await manager.transaction((tx) =>
      repository.enqueue(tx, {
        tableId,
        sessionStartedAt,
        conversationId: null,
        event: "conversation.message.created",
        payload: { table_id: tableId, text: "first" },
      }),
    );
    await manager.transaction((tx) =>
      repository.enqueue(tx, {
        tableId,
        sessionStartedAt,
        conversationId: null,
        event: "conversation.message.created",
        payload: { table_id: tableId, text: "second" },
      }),
    );
    await manager.transaction((tx) =>
      repository.enqueueSessionEnded(tx, {
        tableId,
        sessionStartedAt,
        reason: "staff_clear",
        billStatus: "paid",
      }),
    );

    assert.equal(await queue.dispatchOnce(), "published");
    assert.equal(await queue.dispatchOnce(), "published");
    assert.equal(await queue.dispatchOnce(), "published");

    assert.deepEqual(
      publisher.events.map((event) => event.event),
      [
        "conversation.message.created",
        "conversation.message.created",
        TERMINAL_SESSION_EVENT,
      ],
    );
    assert.equal(publisher.disconnects.length, 1, "terminal event disconnects the room");
    const withIds = publisher.events.map(
      (event) => (event.data as { event_id: string }).event_id,
    );
    assert.equal(new Set(withIds).size, 3);
  });

  it("suppresses pending conversation events and wipes their payload", async () => {
    const publisher = new FakePublisher();
    const queue = dispatcher(publisher);

    await manager.transaction((tx) =>
      repository.enqueue(tx, {
        tableId,
        sessionStartedAt,
        conversationId: null,
        event: "conversation.message.created",
        payload: { table_id: tableId, text: "must not leak" },
      }),
    );
    await manager.transaction((tx) =>
      repository.suppressConversationEvents(tx, tableId, sessionStartedAt),
    );
    await manager.transaction((tx) =>
      repository.enqueueSessionEnded(tx, {
        tableId,
        sessionStartedAt,
        reason: "staff_clear",
        billStatus: "paid",
      }),
    );

    await queue.dispatchOnce();

    assert.deepEqual(
      publisher.events.map((event) => event.event),
      [TERMINAL_SESSION_EVENT],
    );
    const suppressed = await manager.query<{ status: string; payload: unknown }>(
      `SELECT status, payload FROM realtime_outbox
        WHERE table_id = $1 AND event LIKE 'conversation.%'
        ORDER BY id DESC LIMIT 1`,
      [tableId],
    );
    assert.equal(suppressed.rows[0]?.status, "suppressed");
    assert.deepEqual(suppressed.rows[0]?.payload, {});
  });

  it("retries a failed publish without losing order", async () => {
    const publisher = new FakePublisher();
    const queue = dispatcher(publisher);

    await manager.transaction((tx) =>
      repository.enqueue(tx, {
        tableId,
        sessionStartedAt,
        conversationId: null,
        event: "conversation.message.created",
        payload: { table_id: tableId, text: "retry me" },
      }),
    );

    publisher.fail = true;
    assert.equal(await queue.dispatchOnce(), "retried");
    const failed = await manager.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM realtime_outbox
        WHERE table_id = $1 AND status = 'pending'
        ORDER BY id LIMIT 1`,
      [tableId],
    );
    assert.equal(failed.rows[0]?.status, "pending");
    assert.equal(failed.rows[0]?.attempts, 1);

    publisher.fail = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await queue.dispatchOnce(), "published");
    assert.equal(publisher.events.at(-1)?.event, "conversation.message.created");
  });

  it("bounds a hanging publish and retries it", async () => {
    const publisher = new FakePublisher();
    publisher.hang = true;
    const queue = dispatcher(publisher);

    await manager.transaction((tx) =>
      repository.enqueue(tx, {
        tableId,
        sessionStartedAt,
        conversationId: null,
        event: "conversation.message.created",
        payload: { table_id: tableId, text: "hang" },
      }),
    );

    const startedAt = Date.now();
    assert.equal(await queue.dispatchOnce(), "retried");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 150, `returned too early to prove the timeout (${elapsed}ms)`);
    assert.ok(elapsed < 2_000, `timeout was not bounded (${elapsed}ms)`);

    const failed = await manager.query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM realtime_outbox
        WHERE table_id = $1 AND status = 'pending'
        ORDER BY id LIMIT 1`,
      [tableId],
    );
    assert.equal(failed.rows[0]?.attempts, 1);
    assert.match(failed.rows[0]?.last_error ?? "", /timed out/);

    publisher.hang = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await queue.dispatchOnce(), "published");
  });

  it("a restarted dispatcher resumes pending rows in the same order", async () => {
    const publisher = new FakePublisher();
    publisher.available = false;
    const first = dispatcher(publisher);
    assert.equal(await first.dispatchOnce(), "unavailable");

    publisher.available = true;
    const restarted = dispatcher(publisher);
    await manager.transaction((tx) =>
      repository.enqueue(tx, {
        tableId,
        sessionStartedAt,
        conversationId: null,
        event: "conversation.voice.started",
        payload: { table_id: tableId, interaction_id: "voice-1" },
      }),
    );
    await manager.transaction((tx) =>
      repository.enqueueSessionEnded(tx, {
        tableId,
        sessionStartedAt,
        reason: "auto_release",
        billStatus: "paid",
      }),
    );

    await restarted.drain();
    assert.deepEqual(
      publisher.events.map((event) => event.event),
      ["conversation.voice.started", TERMINAL_SESSION_EVENT],
    );
  });

  it("start and shutdown are idempotent and leave no second loop", async () => {
    const queue = dispatcher(new FakePublisher());
    queue.start();
    queue.start();
    await queue.shutdown();
    await queue.shutdown();

    const health = await queue.health();
    assert.equal(health.state, "stopped");
  });

  it("deletes published and suppressed rows past their retention window", async () => {
    await manager.query(
      `UPDATE realtime_outbox
          SET published_at = clock_timestamp() - interval '25 hours'
        WHERE status = 'published'`,
    );
    const removed = await repository.cleanup({
      publishedBefore: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      suppressedBefore: new Date(Date.now() - 60 * 60 * 1_000),
    });
    assert.ok(removed > 0);
  });
});
