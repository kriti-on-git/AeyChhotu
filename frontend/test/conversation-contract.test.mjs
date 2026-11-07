import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

/* The frontend's Phase 5.5 contract: every conversation/bill call carries the
   participant credential as a header and points at the backend routes. No
   browser-local transcript or bill calculation is involved. `fetch` is
   stubbed; no server is contacted. */

class MemoryStorage {
  values = new Map();
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
globalThis.window = {
  localStorage,
  sessionStorage,
  location: { pathname: "/table/t4b2", hostname: "localhost" },
};

process.env.NEXT_PUBLIC_API_URL = "https://api.test";

const { storeParticipantCredential } = await import("../lib/api/session.ts");
const {
  createConversation,
  getConversation,
  postConversationMessage,
  startConversationVoice,
  endConversationVoice,
  getTableBill,
} = await import("../lib/api-client/endpoints.ts");

const TOKEN = "pc_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const TABLE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const INTERACTION_ID = "55555555-5555-4555-8555-555555555555";

let calls = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sessionStorage.clear();
  storeParticipantCredential({
    participant_id: "guest-a",
    participant_token: TOKEN,
    participant_expires_at: null,
  });
  calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers ?? {}) },
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("conversation API contract", () => {
  it("creates and reads the shared conversation with the participant token", async () => {
    await createConversation();
    await getConversation(CONVERSATION_ID);

    assert.equal(calls[0]?.url, "https://api.test/api/v1/conversations");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[1]?.url, `https://api.test/api/v1/conversations/${CONVERSATION_ID}`);
    for (const call of calls) {
      assert.equal(call.headers["X-Participant-Token"], TOKEN);
      assert.equal(call.url.includes(TOKEN), false);
    }
  });

  it("posts text and voice turns through the backend", async () => {
    await postConversationMessage(CONVERSATION_ID, { text: "Two dosas" });
    await startConversationVoice(CONVERSATION_ID, "phone-a");
    await postConversationMessage(CONVERSATION_ID, {
      text: "What is good?",
      kind: "voice",
      voice_interaction_id: INTERACTION_ID,
      device_id: "phone-a",
    });
    await endConversationVoice(CONVERSATION_ID, INTERACTION_ID, "phone-a");

    assert.equal(calls[0]?.body.text, "Two dosas");
    assert.equal(calls[1]?.url.endsWith(`/conversations/${CONVERSATION_ID}/voice/start`), true);
    assert.deepEqual(calls[1]?.body, { device_id: "phone-a" });
    assert.equal(calls[2]?.body.voice_interaction_id, INTERACTION_ID);
    assert.equal(calls[3]?.url.endsWith(`/voice/${INTERACTION_ID}/end`), true);
    assert.ok(calls.every((call) => call.headers["X-Participant-Token"] === TOKEN));
  });

  it("reads the backend-generated bill, never a browser calculation", async () => {
    await getTableBill(TABLE_ID);
    assert.equal(
      calls[0]?.url,
      `https://api.test/api/v1/billing/tables/${TABLE_ID}/guest`,
    );
    assert.equal(calls[0]?.headers["X-Participant-Token"], TOKEN);
  });
});
