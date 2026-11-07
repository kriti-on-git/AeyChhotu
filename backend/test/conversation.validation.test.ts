import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Conversation request contracts. Credentials are headers so the table pass
   never appears in a URL; voice messages must carry the interaction and the
   originating device. */

import {
  conversationCredentialHeadersSchema,
  conversationParamsSchema,
  endVoiceParamsSchema,
  postConversationMessageSchema,
  startVoiceSchema,
} from "../src/modules/conversation/conversation.validation.js";
import { TOKEN_A, CONVERSATION_ID } from "./helpers/conversation-fakes.js";

const headers = { "x-participant-token": TOKEN_A };

describe("conversation credential headers", () => {
  it("accepts only the server-issued participant token", () => {
    assert.deepEqual(conversationCredentialHeadersSchema.parse(headers), headers);
    assert.equal(
      conversationCredentialHeadersSchema.safeParse({
        "x-table-token": "t4b2",
        "x-table-secret": "abcdefghijklmnopqrst",
        "x-participant-id": "guest-a",
      }).success,
      false,
    );
  });

  it("rejects malformed or empty participant tokens", () => {
    assert.equal(
      conversationCredentialHeadersSchema.safeParse({ "x-participant-token": "BAD" }).success,
      false,
    );
    assert.equal(
      conversationCredentialHeadersSchema.safeParse({ "x-participant-token": "  " }).success,
      false,
    );
  });
});

describe("conversation message validation", () => {
  it("defaults to a text message and trims the text", () => {
    const parsed = postConversationMessageSchema.parse({ text: "  two dosas  " });
    assert.equal(parsed.text, "two dosas");
    assert.equal(parsed.kind, "text");
  });

  it("caps text at 4000 characters and refuses empty messages", () => {
    assert.equal(postConversationMessageSchema.safeParse({ text: "" }).success, false);
    assert.equal(
      postConversationMessageSchema.safeParse({ text: "x".repeat(4001) }).success,
      false,
    );
  });

  it("requires an interaction and device for a voice message", () => {
    assert.equal(
      postConversationMessageSchema.safeParse({ text: "hello", kind: "voice" }).success,
      false,
    );
    assert.equal(
      postConversationMessageSchema.safeParse({
        text: "hello",
        kind: "voice",
        voice_interaction_id: CONVERSATION_ID,
        device_id: "phone-a",
      }).success,
      true,
    );
  });

  it("rejects non-UUID conversation and voice ids", () => {
    assert.equal(
      conversationParamsSchema.safeParse({ conversation_id: "nope" }).success,
      false,
    );
    assert.equal(
      endVoiceParamsSchema.safeParse({
        conversation_id: CONVERSATION_ID,
        interaction_id: "nope",
      }).success,
      false,
    );
  });

  it("requires a non-empty device id for voice start", () => {
    assert.equal(startVoiceSchema.safeParse({ device_id: " " }).success, false);
    assert.equal(startVoiceSchema.safeParse({ device_id: "phone-a" }).success, true);
  });
});
