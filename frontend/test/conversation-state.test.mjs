import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mergeConversationMessages,
  shouldPlayVoice,
} from "../lib/conversation/messages.ts";

const base = {
  conversation_id: "c1",
  role: "guest",
  kind: "text",
  participant: null,
  origin_participant_id: null,
  client_message_id: null,
  reply_to_message_id: null,
  actions: [],
  voice_playback_device_id: null,
};

const first = { ...base, message_id: "m1", text: "one", created_at: "2026-01-01T10:00:00.000Z" };
const second = { ...base, message_id: "m2", text: "two", created_at: "2026-01-01T10:00:02.000Z" };

describe("conversation state", () => {
  it("merges REST history and socket events without duplicate bubbles", () => {
    assert.deepEqual(
      mergeConversationMessages([second], [first, second]).map((message) => message.message_id),
      ["m1", "m2"],
    );
  });

  it("keeps the newest server copy of a replayed message", () => {
    const replay = { ...first, text: "edited by the server" };
    assert.equal(mergeConversationMessages([first], [replay])[0]?.text, "edited by the server");
  });

  it("routes voice playback only to the initiating device", () => {
    const voice = {
      ...second,
      kind: "voice",
      voice_playback_device_id: "phone-a",
    };
    assert.equal(shouldPlayVoice(voice, "phone-a"), true);
    assert.equal(shouldPlayVoice(voice, "phone-b"), false);
    assert.equal(shouldPlayVoice({ ...second, kind: "text" }, "phone-a"), false);
    assert.equal(shouldPlayVoice(null, "phone-a"), false);
  });
});
