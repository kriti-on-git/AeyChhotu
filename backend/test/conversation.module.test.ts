import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Conversation lifecycle component: read-only schema probes and an honest AI
   provider state. Health checks must never create a conversation, message or
   voice interaction. */

import type { DbPort } from "../src/infrastructure/database/DatabaseManager.js";
import { createConversationModule } from "../src/modules/conversation/conversation.module.js";
import type { ConversationAiProvider } from "../src/modules/conversation/conversation.types.js";

function fakeDb(present: boolean) {
  const statements: string[] = [];
  const db = {
    async query(text: string) {
      statements.push(text);
      return {
        rows: [
          {
            conversations: present,
            messages: present,
            voice: present,
            active_voice_index: present,
          },
        ],
        rowCount: 1,
      };
    },
  } as unknown as DbPort;
  return { db, statements };
}

const ports = {
  menu: {} as never,
  cart: {} as never,
  orders: {} as never,
  tables: {} as never,
};

const provider: ConversationAiProvider = {
  async respond() {
    return { text: "unused" };
  },
};

describe("Conversation module lifecycle", () => {
  it("reports healthy when all conversation objects exist", async () => {
    const { db } = fakeDb(true);
    const module = createConversationModule({
      db,
      realtime: { toTable: () => ({ room: "table:x", event: "x.y", recipients: 0, skipped: true }) },
      ...ports,
      aiProvider: provider,
    });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.match(health.message ?? "", /AI provider is configured/);
    assert.deepEqual(health.details, {
      present: [
        "conversations",
        "conversation_messages",
        "conversation_voice_interactions",
        "conversation_one_active_voice",
      ],
      missing: [],
    });

    const selfTest = await module.selfTest();
    assert.equal(selfTest.ok, true);
    assert.equal(module.name, "conversation");
    assert.deepEqual(module.dependencies, ["database"]);
  });

  it("stays healthy without an AI provider but says so", async () => {
    const { db } = fakeDb(true);
    const module = createConversationModule({ db, realtime: { toTable: () => ({ room: "table:x", event: "x.y", recipients: 0, skipped: true }) }, ...ports });

    const health = await module.health();
    assert.equal(health.state, "HEALTHY");
    assert.match(health.message ?? "", /not configured/);
    assert.equal(
      (module.diagnostics() as { ai_provider: string }).ai_provider,
      "not_configured",
    );
  });

  it("names every missing object and stays unhealthy", async () => {
    const { db } = fakeDb(false);
    const module = createConversationModule({
      db,
      realtime: { toTable: () => ({ room: "table:x", event: "x.y", recipients: 0, skipped: true }) },
      ...ports,
    });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /conversation_messages/);
    assert.match(health.message ?? "", /conversation_one_active_voice/);
    assert.equal((await module.selfTest()).ok, false);
  });

  it("uses only read-only catalog checks", async () => {
    const { db, statements } = fakeDb(true);
    const module = createConversationModule({
      db,
      realtime: { toTable: () => ({ room: "table:x", event: "x.y", recipients: 0, skipped: true }) },
      ...ports,
    });

    await module.health();
    await module.selfTest();

    assert.ok(statements.length >= 2);
    for (const sql of statements) {
      assert.match(sql, /to_regclass|pg_indexes/);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/i);
    }
  });

  it("reports unhealthy instead of throwing when the probe fails", async () => {
    const db = {
      async query() {
        throw new Error("connection refused");
      },
    } as unknown as DbPort;
    const module = createConversationModule({
      db,
      realtime: { toTable: () => ({ room: "table:x", event: "x.y", recipients: 0, skipped: true }) },
      ...ports,
    });

    const health = await module.health();
    assert.equal(health.state, "UNHEALTHY");
    assert.match(health.message ?? "", /connection refused/);
    assert.equal((await module.selfTest()).ok, false);
  });
});
