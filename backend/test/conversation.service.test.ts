import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Conversation service: one shared transcript per seating, membership
   authorization, retry dedupe, AI/tool handling and initiator-only voice
   coordination. No HTTP, no SQL and no Socket.IO. */

import { AppError } from "../src/errors/app-error.js";
import { ConversationService } from "../src/modules/conversation/conversation.service.js";
import type { ConversationToolPort } from "../src/modules/conversation/conversation.types.js";
import {
  FakeAiProvider,
  FakeConversationRepository,
  FakeRealtime,
  FakeToolPort,
  ThrowingAiProvider,
  CONVERSATION_ID,
  MENU_ITEM_ID,
  PARTICIPANT_A,
  PARTICIPANT_B,
  TABLE_ID,
  credentials,
} from "./helpers/conversation-fakes.js";

function harness(options: {
  turns?: ConstructorParameters<typeof FakeAiProvider>[0];
  provider?: "fake" | "throwing" | "none";
  tools?: ConversationToolPort;
} = {}) {
  const repository = new FakeConversationRepository();
  const realtime = new FakeRealtime();
  const tools = options.tools ?? new FakeToolPort();
  const provider =
    options.provider === "none"
      ? null
      : options.provider === "throwing"
        ? new ThrowingAiProvider()
        : new FakeAiProvider(options.turns ?? [{ text: "Namaste! Try the dosa." }]);
  const service = new ConversationService({
    repository,
    realtime,
    tools,
    aiProvider: provider,
  });
  return { repository, realtime, tools, provider, service };
}

async function expectAppError(promise: Promise<unknown>, code: string, status: number) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError ${code}, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return err;
  }
  assert.fail(`expected AppError ${code}, but the call resolved`);
}

describe("conversation creation and membership", () => {
  it("creates exactly one conversation per table session", async () => {
    const { service } = harness();
    const first = await service.getOrCreate(credentials(PARTICIPANT_A));
    const second = await service.getOrCreate(credentials(PARTICIPANT_B));

    assert.equal(first.conversation.conversation_id, CONVERSATION_ID);
    assert.equal(second.conversation.conversation_id, first.conversation.conversation_id);
    assert.deepEqual(first.messages, []);
  });

  it("refuses a participant who is not on the table roster", async () => {
    const { service } = harness();
    await expectAppError(service.getOrCreate(credentials("stranger")), "NOT_TABLE_MEMBER", 403);
  });

  it("hides a conversation from the next seating", async () => {
    const { service, repository } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    repository.sessionStartedAt = new Date("2026-01-01T12:00:00.000Z");
    await expectAppError(
      service.getConversation(created.conversation.conversation_id, credentials(PARTICIPANT_A)),
      "CONVERSATION_NOT_FOUND",
      404,
    );
  });
});

describe("shared messages", () => {
  it("persists a guest message and the assistant answer, broadcasting both", async () => {
    const { service, repository, realtime, provider } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    const result = await service.postMessage(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      { text: "What is good tonight?", client_message_id: "m-1" },
    );

    assert.equal(result.duplicate, false);
    assert.equal(result.message.role, "guest");
    assert.equal(result.message.text, "What is good tonight?");
    assert.equal(result.message.participant?.name, "Asha");
    assert.equal(result.assistant?.role, "assistant");
    assert.equal(result.assistant?.text, "Namaste! Try the dosa.");
    assert.equal(repository.messages.length, 2);
    assert.equal((provider as FakeAiProvider).inputs.length, 1);
    assert.equal(
      (provider as FakeAiProvider).inputs[0]?.messages.at(-1)?.text,
      "What is good tonight?",
    );

    assert.deepEqual(
      realtime.events.map((event) => event.event),
      ["conversation.message.created", "conversation.message.created"],
    );
    assert.ok(realtime.events.every((event) => event.tableId === TABLE_ID));
  });

  it("shows the same history to every member of the room", async () => {
    const { service } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));
    await service.postMessage(created.conversation.conversation_id, credentials(PARTICIPANT_A), {
      text: "Two dosas please",
    });

    const view = await service.getConversation(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_B),
    );
    assert.deepEqual(
      view.messages.map((message) => [message.role, message.text]),
      [
        ["guest", "Two dosas please"],
        ["assistant", "Namaste! Try the dosa."],
      ],
    );
  });

  it("stores a retried client message once and never answers it twice", async () => {
    const { service, repository, realtime, provider } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    const first = await service.postMessage(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      { text: "One chai", client_message_id: "retry-1" },
    );
    const retry = await service.postMessage(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      { text: "One chai", client_message_id: "retry-1" },
    );

    assert.equal(retry.duplicate, true);
    assert.equal(retry.message.message_id, first.message.message_id);
    assert.equal(retry.assistant?.message_id, first.assistant?.message_id);
    assert.equal(repository.messages.length, 2);
    assert.equal((provider as FakeAiProvider).inputs.length, 1);
    assert.equal(realtime.events.length, 2);
  });

  it("handles concurrent retries with one persisted message", async () => {
    const { service, repository } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    const results = await Promise.allSettled([
      service.postMessage(created.conversation.conversation_id, credentials(PARTICIPANT_A), {
        text: "Same message",
        client_message_id: "race-1",
      }),
      service.postMessage(created.conversation.conversation_id, credentials(PARTICIPANT_B), {
        text: "Same message",
        client_message_id: "race-1",
      }),
    ]);

    assert.ok(results.every((result) => result.status === "fulfilled"));
    assert.equal(
      repository.messages.filter((message) => message.client_message_id === "race-1").length,
      1,
    );
    assert.equal(repository.messages.filter((message) => message.role === "assistant").length, 1);
  });

  it("keeps the guest message when the AI provider fails", async () => {
    const { service, repository, realtime } = harness({ provider: "throwing" });
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    await expectAppError(
      service.postMessage(created.conversation.conversation_id, credentials(PARTICIPANT_A), {
        text: "Hello?",
      }),
      "AI_UNAVAILABLE",
      502,
    );
    assert.equal(repository.messages.length, 1);
    assert.equal(repository.messages[0]?.role, "guest");
    assert.equal(realtime.events.length, 1);
  });

  it("stores the guest message without an answer when no provider is configured", async () => {
    const { service } = harness({ provider: "none" });
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    const result = await service.postMessage(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      { text: "Just the menu then" },
    );
    assert.equal(result.assistant, null);
    assert.equal(result.message.text, "Just the menu then");
  });
});

describe("AI tool execution", () => {
  it("executes a tool through the port and sends the result back to the provider", async () => {
    const tools = new FakeToolPort();
    const provider = new FakeAiProvider([
      {
        text: "",
        tool_calls: [
          {
            id: "call-1",
            name: "add_to_cart",
            arguments: { menu_item_id: MENU_ITEM_ID, quantity: 2 },
          },
        ],
      },
      { text: "Added two dosas for the table." },
    ]);
    const { service, repository, realtime } = harness({ provider: "fake", tools });
    // Replace the provider created by the harness with the scripted one.
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    // The harness's default provider answered the first turn; use a fresh
    // service so this test controls every turn precisely.
    const scriptedService = new ConversationService({
      repository,
      realtime,
      tools,
      aiProvider: provider,
    });
    const result = await scriptedService.postMessage(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      { text: "Add two dosas" },
    );

    assert.equal(result.assistant?.text, "Added two dosas for the table.");
    assert.deepEqual(result.assistant?.actions, [
      { kind: "cart", label: "Added 1 dish", ok: true },
    ]);
    assert.equal(tools.calls.length, 1);
    assert.equal(tools.calls[0]?.name, "add_to_cart");
    assert.equal(tools.calls[0]?.context.tableToken, "t4b2");
    assert.equal(tools.calls[0]?.context.participantName, "Asha");
    assert.equal(provider.inputs.length, 2);
    assert.deepEqual(provider.inputs[1]?.tool_results, [
      {
        tool_call_id: "call-1",
        name: "add_to_cart",
        ok: true,
        data: { added: true },
      },
    ]);
    assert.equal(repository.messages.filter((message) => message.role === "assistant").length, 1);
  });

  it("refuses an endless tool loop without persisting a bogus answer", async () => {
    const provider: import("../src/modules/conversation/conversation.types.js").ConversationAiProvider = {
      async respond() {
        return {
          text: "",
          tool_calls: [{ id: "loop", name: "add_to_cart", arguments: {} }],
        };
      },
    };
    const repository = new FakeConversationRepository();
    const service = new ConversationService({
      repository,
      realtime: new FakeRealtime(),
      tools: new FakeToolPort(),
      aiProvider: provider,
    });
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    await expectAppError(
      service.postMessage(created.conversation.conversation_id, credentials(PARTICIPANT_A), {
        text: "Loop",
      }),
      "AI_TOOL_LIMIT",
      502,
    );
    assert.equal(repository.messages.filter((message) => message.role === "assistant").length, 0);
  });
});

describe("voice coordination", () => {
  it("allows one active interaction and names the initiating device", async () => {
    const { service, realtime } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));

    const started = await service.startVoice(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      "phone-a",
    );
    assert.equal(started.playback_device_id, "phone-a");
    assert.equal(started.playback_participant_id, PARTICIPANT_A);

    assert.equal(realtime.events.at(-1)?.event, "conversation.voice.started");
    assert.deepEqual(realtime.events.at(-1)?.data, {
      ...started,
      playback_scope: "initiator",
    });

    await expectAppError(
      service.startVoice(
        created.conversation.conversation_id,
        credentials(PARTICIPANT_B),
        "phone-b",
      ),
      "VOICE_IN_PROGRESS",
      409,
    );
  });

  it("lets only the initiating device end the interaction", async () => {
    const { service, realtime } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));
    const started = await service.startVoice(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      "phone-a",
    );

    await expectAppError(
      service.endVoice(
        created.conversation.conversation_id,
        started.interaction_id,
        credentials(PARTICIPANT_B),
        "phone-b",
      ),
      "VOICE_NOT_INITIATOR",
      403,
    );

    const ended = await service.endVoice(
      created.conversation.conversation_id,
      started.interaction_id,
      credentials(PARTICIPANT_A),
      "phone-a",
    );
    assert.equal(ended.status, "completed");
    assert.equal(realtime.events.at(-1)?.event, "conversation.voice.ended");
  });

  it("marks a voice answer for the initiating device only", async () => {
    const { service, realtime } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));
    const started = await service.startVoice(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      "phone-a",
    );

    const result = await service.postMessage(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      {
        text: "What is on the menu?",
        kind: "voice",
        voice_interaction_id: started.interaction_id,
        device_id: "phone-a",
      },
    );

    assert.equal(result.assistant?.kind, "voice");
    assert.equal(result.assistant?.voice_playback_device_id, "phone-a");
    assert.equal(realtime.events.at(-1)?.event, "conversation.message.created");
    assert.equal(
      (realtime.events.at(-1)?.data as { voice_playback_device_id?: string })
        .voice_playback_device_id,
      "phone-a",
    );
  });

  it("refuses a voice message from another device", async () => {
    const { service } = harness();
    const created = await service.getOrCreate(credentials(PARTICIPANT_A));
    const started = await service.startVoice(
      created.conversation.conversation_id,
      credentials(PARTICIPANT_A),
      "phone-a",
    );

    await expectAppError(
      service.postMessage(created.conversation.conversation_id, credentials(PARTICIPANT_A), {
        text: "I am not the initiator",
        kind: "voice",
        voice_interaction_id: started.interaction_id,
        device_id: "phone-b",
      }),
      "VOICE_NOT_INITIATOR",
      403,
    );
  });
});
