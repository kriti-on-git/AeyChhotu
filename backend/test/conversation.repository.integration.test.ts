import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/* REAL-POSTGRES checks for the Conversation repository: one conversation per
   seating, ordered/deduplicated messages and the partial unique index that
   permits one active voice interaction per room. Participant authorization is
   covered separately against the Table token store. */

import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { ConversationRepository } from "../src/modules/conversation/conversation.repository.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres conversation checks skipped";

const SECRET = "abcdefghijklmnopqrst";
const PARTICIPANT_A = "guest-a";
const PARTICIPANT_B = "guest-b";

let manager: DatabaseManager;
let repository: ConversationRepository;
let tableId = "";
let tableCode = "";
let sessionStartedAt: Date;

before(async () => {
  if (!TEST_DATABASE_URL) return;
  manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));
  repository = new ConversationRepository(manager);

  tableCode = `cv${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  sessionStartedAt = new Date();
  const inserted = await manager.query<{ id: string }>(
    `INSERT INTO restaurant_tables
       (code, name, status, session_pin, session_secret, session_started_at)
     VALUES ($1, $2, 'active', '42', $3, $4)
     RETURNING id`,
    [tableCode, `Conversation ${tableCode}`, SECRET, sessionStartedAt],
  );
  tableId = inserted.rows[0]?.id ?? "";
  assert.ok(tableId);

  await manager.query(
    `INSERT INTO table_members (table_id, user_id, name)
     VALUES ($1, $2, 'Asha'), ($1, $3, 'Ravi')`,
    [tableId, PARTICIPANT_A, PARTICIPANT_B],
  );

  await repository.transaction((tx) =>
    repository.findOrCreateConversation(tx, tableId, sessionStartedAt),
  );
});

after(async () => {
  if (!TEST_DATABASE_URL) return;
  if (tableId) {
    await manager.query("DELETE FROM conversation_voice_interactions WHERE conversation_id IN (SELECT id FROM conversations WHERE table_id = $1)", [tableId]);
    await manager.query("DELETE FROM conversation_messages WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM conversations WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM table_members WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
  }
  await manager.shutdown();
});

describe("ConversationRepository — real Postgres", { skip: skipReason }, () => {
  it("reports every conversation object as present", async () => {
    const schema = await repository.schemaObjects();
    assert.deepEqual(schema.missing, []);
    assert.deepEqual(schema.present, [
      "conversations",
      "conversation_messages",
      "conversation_voice_interactions",
      "conversation_one_active_voice",
    ]);
  });

  it("creates one conversation per seating and a new one after the session changes", async () => {
    const first = await repository.transaction((tx) =>
      repository.findOrCreateConversation(tx, tableId, sessionStartedAt),
    );
    const same = await repository.transaction((tx) =>
      repository.findOrCreateConversation(tx, tableId, sessionStartedAt),
    );
    assert.equal(same.id, first.id);

    const nextSession = new Date(sessionStartedAt.getTime() + 60 * 60 * 1_000);
    await manager.query("UPDATE restaurant_tables SET session_started_at = $2 WHERE id = $1", [
      tableId,
      nextSession,
    ]);
    const next = await repository.transaction((tx) =>
      repository.findOrCreateConversation(tx, tableId, nextSession),
    );
    assert.notEqual(next.id, first.id);
    await manager.query("UPDATE restaurant_tables SET session_started_at = $2 WHERE id = $1", [
      tableId,
      sessionStartedAt,
    ]);
  });

  it("stores retry-safe messages and returns the newest transcript in order", async () => {
    const conversation = await repository.transaction((tx) =>
      repository.findOrCreateConversation(tx, tableId, sessionStartedAt),
    );

    const first = await repository.transaction((tx) =>
      repository.insertMessage(tx, {
        conversationId: conversation.id,
        tableId,
        role: "guest",
        kind: "text",
        participantId: PARTICIPANT_A,
        participantName: "Asha",
        text: "first",
        clientMessageId: "retry-a",
        replyToMessageId: null,
        actions: [],
        metadata: { origin_participant_id: PARTICIPANT_A },
      }),
    );
    assert.ok(first);

    const duplicate = await repository.transaction((tx) =>
      repository.insertMessage(tx, {
        conversationId: conversation.id,
        tableId,
        role: "guest",
        kind: "text",
        participantId: PARTICIPANT_A,
        participantName: "Asha",
        text: "first again",
        clientMessageId: "retry-a",
        replyToMessageId: null,
        actions: [],
        metadata: { origin_participant_id: PARTICIPANT_A },
      }),
    );
    assert.equal(duplicate, null);

    const reply = await repository.transaction((tx) =>
      repository.insertMessage(tx, {
        conversationId: conversation.id,
        tableId,
        role: "assistant",
        kind: "text",
        participantId: null,
        participantName: "Chhotu",
        text: "answer",
        clientMessageId: null,
        replyToMessageId: first.id,
        actions: [{ kind: "info", label: "Looked it up", ok: true }],
        metadata: { origin_participant_id: PARTICIPANT_A },
      }),
    );
    assert.ok(reply);
    assert.equal((await repository.findAssistantReply(first.id))?.id, reply.id);
    assert.equal(
      (
        await repository.transaction((tx) =>
          repository.findMessageByClientId(tx, conversation.id, "retry-a"),
        )
      )?.id,
      first.id,
    );

    const latest = await repository.listMessages(conversation.id, 1);
    assert.deepEqual(latest.map((row) => row.id), [reply.id]);
    assert.equal(latest[0]?.actions instanceof Array, true);
    assert.equal((latest[0]?.metadata as { origin_participant_id?: string }).origin_participant_id, PARTICIPANT_A);
  });

  it("enforces one active voice interaction and initiator-only completion", async () => {
    const conversation = await repository.transaction((tx) =>
      repository.findOrCreateConversation(tx, tableId, sessionStartedAt),
    );

    const active = await repository.transaction((tx) =>
      repository.insertVoice(tx, {
        conversationId: conversation.id,
        participantId: PARTICIPANT_A,
        deviceId: "phone-a",
      }),
    );
    assert.ok(active);

    const overlapping = await repository.transaction((tx) =>
      repository.insertVoice(tx, {
        conversationId: conversation.id,
        participantId: PARTICIPANT_B,
        deviceId: "phone-b",
      }),
    );
    assert.equal(overlapping, null);
    assert.equal(
      (
        await repository.transaction((tx) =>
          repository.findActiveVoice(tx, conversation.id),
        )
      )?.id,
      active.id,
    );

    assert.equal(
      await repository.transaction((tx) =>
        repository.endVoice(tx, {
          interactionId: active.id,
          conversationId: conversation.id,
          participantId: PARTICIPANT_B,
          deviceId: "phone-b",
        }),
      ),
      null,
    );

    const ended = await repository.transaction((tx) =>
      repository.endVoice(tx, {
        interactionId: active.id,
        conversationId: conversation.id,
        participantId: PARTICIPANT_A,
        deviceId: "phone-a",
      }),
    );
    assert.equal(ended?.status, "completed");
    assert.ok(ended?.ended_at);

    const next = await repository.transaction((tx) =>
      repository.insertVoice(tx, {
        conversationId: conversation.id,
        participantId: PARTICIPANT_B,
        deviceId: "phone-b",
      }),
    );
    assert.ok(next);
  });
});
