import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GeminiConversationProvider,
  type GeminiConversationProviderOptions,
} from "../src/modules/conversation/conversation.gemini.js";
import type { AiRespondInput } from "../src/modules/conversation/conversation.types.js";

const INPUT: AiRespondInput = {
  conversation: {
    conversation_id: "22222222-2222-4222-8222-222222222222",
    table_id: "11111111-1111-4111-8111-111111111111",
    session_started_at: "2026-01-01T10:00:00.000Z",
    created_at: "2026-01-01T10:00:00.000Z",
  },
  participant_name: "Asha",
  messages: [
    { role: "guest", text: "What is good?" },
    { role: "assistant", text: "The dosa." },
    { role: "guest", text: "Add one" },
  ],
  tools: [
    {
      name: "get_menu",
      description: "Read the menu.",
      parameters: { type: "object", properties: {} },
    },
  ],
};

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<GeminiConversationProviderOptions> = {},
) {
  return new GeminiConversationProvider({
    apiKey: "test-key",
    model: "gemini-test",
    fetchImpl,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GeminiConversationProvider", () => {
  it("sends only the transcript, guest name and tool declarations", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const gemini = provider(async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "Try the masala dosa." }] } }],
      });
    });

    const turn = await gemini.respond(INPUT);
    assert.equal(turn.text, "Try the masala dosa.");
    const request = requests[0];
    assert.equal(request?.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    assert.equal(new Headers(request?.init?.headers).get("x-goog-api-key"), "test-key");

    const body = JSON.parse(String(request?.init?.body)) as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
      systemInstruction: { parts: Array<{ text: string }> };
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
    };
    assert.deepEqual(
      body.contents.map((content) => content.role),
      ["user", "model", "user"],
    );
    assert.deepEqual(
      body.tools[0]?.functionDeclarations.map((tool) => tool.name),
      ["get_menu"],
    );
    const system = body.systemInstruction.parts.map((part) => part.text).join(" ");
    assert.match(system, /Asha/);
    assert.doesNotMatch(system, /t4b2|pc_[A-Za-z0-9]|test-key/);
  });

  it("parses valid tool calls and ignores malformed ones", async () => {
    const gemini = provider(async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "" },
                { functionCall: { name: "get_menu", args: { query: "dosa" } } },
                { functionCall: { name: "", args: {} } },
                { functionCall: { name: "get_cart" } },
              ],
            },
          },
        ],
      }),
    );

    const turn = await gemini.respond(INPUT);
    assert.equal(turn.text, "");
    assert.deepEqual(turn.tool_calls, [
      {
        id: "gemini-call-1",
        name: "get_menu",
        arguments: { query: "dosa" },
      },
      {
        id: "gemini-call-3",
        name: "get_cart",
        arguments: {},
      },
    ]);
  });

  it("returns an empty tool turn safely when the model has no text", async () => {
    const gemini = provider(async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "fire_order", args: {} } }],
            },
          },
        ],
      }),
    );

    const turn = await gemini.respond(INPUT);
    assert.equal(turn.text, "");
    assert.equal(turn.tool_calls?.[0]?.name, "fire_order");
  });

  it("reports an HTTP failure without leaking the key", async () => {
    const gemini = provider(async () =>
      jsonResponse({ error: { message: "quota exhausted" } }, 429),
    );

    await assert.rejects(gemini.respond(INPUT), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /429/);
      assert.doesNotMatch(err.message, /test-key/);
      return true;
    });
  });

  it("aborts a provider call that exceeds the timeout", async () => {
    const gemini = provider(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      { timeoutMs: 10 },
    );

    await assert.rejects(gemini.respond(INPUT), /timed out/);
  });

  it("rejects malformed responses instead of inventing an answer", async () => {
    const empty = provider(async () => jsonResponse({ candidates: [] }));
    await assert.rejects(empty.respond(INPUT), /no candidate/);

    const noText = provider(async () =>
      jsonResponse({ candidates: [{ content: { parts: [] } }] }),
    );
    await assert.rejects(noText.respond(INPUT), /empty answer/);
  });
});
