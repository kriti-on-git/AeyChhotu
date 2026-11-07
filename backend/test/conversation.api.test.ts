import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/* Conversation HTTP contract, exercised through the real Express app and real
   service over a repository double. Credentials are headers; no response may
   echo the table pass. */

process.env.NODE_ENV = "test";
process.env.PORT = "4000";
process.env.CLIENT_URL = "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.STAFF_PIN = "1234";
process.env.ADMIN_PIN = "998877";
process.env.KDS_TOKEN_SECRET = "conversation-api-test-secret";

const { createApp } = await import("../src/app.js");
const { ConversationService } = await import(
  "../src/modules/conversation/conversation.service.js"
);
const fakes = await import("./helpers/conversation-fakes.js");

let server: import("node:http").Server;
let baseUrl = "";
let repository: InstanceType<typeof fakes.FakeConversationRepository>;
let service: InstanceType<typeof ConversationService>;

const HEADERS = {
  "x-participant-token": fakes.TOKEN_A,
};
const B_HEADERS = { "x-participant-token": fakes.TOKEN_B };

before(async () => {
  repository = new fakes.FakeConversationRepository();
  service = new ConversationService({
    repository,
    participants: new fakes.FakeParticipantGuard(),
    outbox: new fakes.FakeOutbox(),
    tools: new fakes.FakeToolPort(),
    aiProvider: new fakes.FakeAiProvider([{ text: "Try the masala dosa." }], "Sure."),
  });

  const app = createApp({ conversationService: service });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers: Record<string, string> = { ...HEADERS, ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function ensureConversation(): Promise<string> {
  const response = await call("POST", "/api/v1/conversations");
  assert.equal(response.status, 200);
  return response.json.data.conversation.conversation_id as string;
}

describe("Conversation API — authorization", () => {
  it("requires the participant token header", async () => {
    const response = await call("POST", "/api/v1/conversations", {
      headers: { "x-participant-token": "" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "VALIDATION_ERROR");
    assert.ok(response.json.error.fields["x-participant-token"]);
  });

  it("refuses an unknown participant token", async () => {
    const response = await call("POST", "/api/v1/conversations", {
      headers: { "x-participant-token": fakes.INVALID_TOKEN },
    });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "NOT_TABLE_MEMBER");
  });

  it("ignores a client-asserted participant id", async () => {
    const response = await call("POST", "/api/v1/conversations", {
      headers: { ...B_HEADERS, "x-participant-id": fakes.PARTICIPANT_A },
    });
    assert.equal(response.status, 200);
    const posted = await call(
      "POST",
      `/api/v1/conversations/${response.json.data.conversation.conversation_id}/messages`,
      {
        headers: { ...B_HEADERS, "x-participant-id": fakes.PARTICIPANT_A },
        body: { text: "Who am I?" },
      },
    );
    assert.equal(posted.status, 200);
    assert.equal(posted.json.data.message.origin_participant_id, fakes.PARTICIPANT_B);
    assert.equal(posted.json.data.message.participant.name, "Ravi");
  });

  it("never echoes the participant token", async () => {
    const response = await call("POST", "/api/v1/conversations");
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.json), /pc_[A-Za-z0-9_-]{43}/);
  });
});

describe("Conversation API — shared history", () => {
  it("creates one room and returns the same id for both guests", async () => {
    const first = await call("POST", "/api/v1/conversations");
    const second = await call("POST", "/api/v1/conversations", {
      headers: B_HEADERS,
    });
    assert.equal(
      second.json.data.conversation.conversation_id,
      first.json.data.conversation.conversation_id,
    );
  });

  it("persists a message and exposes it to a different participant", async () => {
    const conversationId = await ensureConversation();
    const posted = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      { body: { text: "  What is good tonight?  ", client_message_id: "api-1" } },
    );
    assert.equal(posted.status, 200);
    assert.equal(posted.json.data.message.text, "What is good tonight?");
    assert.equal(posted.json.data.message.origin_participant_id, fakes.PARTICIPANT_A);
    const answer = posted.json.data.assistant.text as string;
    assert.ok(answer.length > 0);

    const history = await call(
      "GET",
      `/api/v1/conversations/${conversationId}`,
      { headers: B_HEADERS },
    );
    assert.equal(history.status, 200);
    assert.ok(
      history.json.data.messages.some(
        (message: { text: string }) => message.text === "What is good tonight?",
      ),
    );
    assert.ok(
      history.json.data.messages.some(
        (message: { text: string }) => message.text === answer,
      ),
    );
  });

  it("returns the stored reply on a duplicate send", async () => {
    const conversationId = await ensureConversation();
    const first = await call("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: { text: "One chai", client_message_id: "api-retry" },
    });
    const retry = await call("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: { text: "One chai", client_message_id: "api-retry" },
    });

    assert.equal(retry.status, 200);
    assert.equal(retry.json.data.duplicate, true);
    assert.equal(retry.json.data.message.message_id, first.json.data.message.message_id);
  });

  it("validates the body and the conversation id", async () => {
    const conversationId = await ensureConversation();
    const empty = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      { body: { text: "   " } },
    );
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, "VALIDATION_ERROR");

    const unknown = await call(
      "POST",
      `/api/v1/conversations/${fakes.CONVERSATION_ID.replace("2", "9")}/messages`,
      { body: { text: "hello" } },
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, "CONVERSATION_NOT_FOUND");
  });
});

describe("Conversation API — voice", () => {
  it("rejects overlap, protects end-of-turn and returns playback routing", async () => {
    const conversationId = await ensureConversation();

    const started = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/voice/start`,
      { body: { device_id: "phone-a" } },
    );
    assert.equal(started.status, 201);
    assert.equal(started.json.data.playback_device_id, "phone-a");
    assert.equal(started.json.data.initiator_participant_id, fakes.PARTICIPANT_A);

    const overlap = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/voice/start`,
      {
        body: { device_id: "phone-b" },
        headers: B_HEADERS,
      },
    );
    assert.equal(overlap.status, 409);
    assert.equal(overlap.json.error.code, "VOICE_IN_PROGRESS");

    const wrongDevice = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/voice/${started.json.data.interaction_id}/end`,
      { body: { device_id: "phone-b" } },
    );
    assert.equal(wrongDevice.status, 403);
    assert.equal(wrongDevice.json.error.code, "VOICE_NOT_INITIATOR");

    const ended = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/voice/${started.json.data.interaction_id}/end`,
      { body: { device_id: "phone-a" } },
    );
    assert.equal(ended.status, 200);
    assert.equal(ended.json.data.status, "completed");
  });

  it("marks a voice answer for the initiating device", async () => {
    const conversationId = await ensureConversation();
    const started = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/voice/start`,
      { body: { device_id: "phone-a" } },
    );

    const posted = await call(
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      {
        body: {
          text: "What is on the menu?",
          kind: "voice",
          voice_interaction_id: started.json.data.interaction_id,
          device_id: "phone-a",
        },
      },
    );
    assert.equal(posted.status, 200);
    assert.equal(posted.json.data.assistant.voice_playback_device_id, "phone-a");
    assert.equal(posted.json.data.assistant.origin_participant_id, fakes.PARTICIPANT_A);
  });
});
