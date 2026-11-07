/* Conversation module — Google Gemini text provider.

   This is the only place the server speaks to Gemini. It implements the same
   ConversationAiProvider port used by the fakes, so the service never imports
   an SDK, a key, or a vendor response shape. The provider receives only the
   persisted transcript, the guest's display name and the tool declarations;
   table tokens, table secrets and participant tokens never enter this file.

   TOOL CALLS are returned to the service, which authorizes and executes them
   through the existing business-service tools. The provider never touches a
   repository or SQL. A malformed provider response is treated as an ordinary
   provider failure (the caller returns AI_UNAVAILABLE and keeps the guest's
   message).

   TIMEOUT: one AbortController covers the whole HTTP call. A hung model must
   not hold an HTTP request open past the app's own request budget. */

import type {
  AiRespondInput,
  AiToolCall,
  AiToolResult,
  AiTurn,
  ConversationAiProvider,
} from "./conversation.types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REPLY_CHARS = 8_000;

type FetchLike = typeof fetch;

interface GeminiPart {
  text?: unknown;
  functionCall?: {
    name?: unknown;
    args?: unknown;
  };
  functionResponse?: unknown;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: unknown;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: unknown };
  error?: { message?: unknown };
}

export interface GeminiConversationProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; production uses the global fetch. */
  readonly fetchImpl?: FetchLike;
}

function systemInstruction(participantName: string): string {
  return [
    "You are Chhotu, the warm, concise waiter for one restaurant table.",
    `The guest speaking is ${participantName}.`,
    "Use the provided tools for menu questions, cart changes, order status and bill requests.",
    "Never invent a dish id, price, order status or bill total.",
    "Add dishes only after the guest clearly asks for them. Firing an order and requesting the bill need an explicit guest request.",
    "Tool results are authoritative. If a tool fails, explain the failure briefly and do not claim the change happened.",
    "Reply in the guest's language when practical. Keep answers short enough to read aloud.",
    "Never ask for or reveal table tokens, session secrets, participant tokens or API keys.",
  ].join(" ");
}

function toContents(input: AiRespondInput): unknown[] {
  const contents: unknown[] = input.messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.text }],
    }));

  /* Tool results are sent as the model call that requested them followed by
     the matching function responses. The service keeps only the final result
     list, so names from that list are enough to reconstruct the exchange in
     the order the model requested. */
  if (input.tool_results && input.tool_results.length > 0) {
    const calls = input.tool_results.map((result) => ({
      functionCall: { name: result.name, args: {} },
    }));
    const responses = input.tool_results.map((result) => ({
      functionResponse: {
        name: result.name,
        response: result.ok ? { result: result.data } : { error: result.data },
      },
    }));
    contents.push({ role: "model", parts: calls });
    contents.push({ role: "user", parts: responses });
  }

  return contents;
}

function parseToolCalls(parts: readonly GeminiPart[]): AiToolCall[] {
  const calls: AiToolCall[] = [];
  let index = 0;

  for (const part of parts) {
    const call = part.functionCall;
    if (!call) continue;
    index += 1;

    /* A malformed call is ignored rather than trusted: an empty name would
       otherwise reach the tool dispatcher as an arbitrary lookup. */
    if (typeof call.name !== "string" || call.name.trim() === "") continue;
    const args =
      call.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? (call.args as Record<string, unknown>)
        : {};

    calls.push({
      id: `gemini-call-${index}`,
      name: call.name.trim(),
      arguments: args,
    });
  }

  return calls;
}

function parseText(parts: readonly GeminiPart[]): string {
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim()
    .slice(0, MAX_REPLY_CHARS);
}

export class GeminiConversationProvider implements ConversationAiProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: GeminiConversationProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("A Gemini API key is required to create the provider.");
    }
    this.apiKey = options.apiKey;
    this.model = (options.model?.trim() || DEFAULT_MODEL).replace(/^models\//, "");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async respond(input: AiRespondInput): Promise<AiTurn> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemInstruction(input.participant_name) }],
            },
            contents: toContents(input),
            tools: [
              {
                functionDeclarations: input.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
            generationConfig: { temperature: 0.4, maxOutputTokens: 1_024 },
          }),
          signal: controller.signal,
        },
      );
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error("The Gemini request timed out.");
      }
      throw err instanceof Error ? err : new Error("The Gemini request failed.");
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => null)) as GeminiResponse | null;
    if (!response.ok) {
      const detail =
        typeof body?.error?.message === "string" ? body.error.message : response.statusText;
      throw new Error(`Gemini returned ${response.status}: ${detail}`);
    }
    if (body === null) throw new Error("Gemini returned a non-JSON response.");
    if (typeof body.promptFeedback?.blockReason === "string") {
      throw new Error("Gemini blocked the request.");
    }

    const parts = body.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
      throw new Error("Gemini returned no candidate content.");
    }

    const tool_calls = parseToolCalls(parts);
    const text = parseText(parts);
    if (text === "" && tool_calls.length === 0) {
      throw new Error("Gemini returned an empty answer.");
    }

    return { text, ...(tool_calls.length > 0 ? { tool_calls } : {}) };
  }
}

/** Exported for the focused provider tests. */
export const GEMINI_TEXT_DEFAULT_MODEL = DEFAULT_MODEL;

/** Keeps tool-result typing honest for callers that build provider fixtures. */
export type GeminiToolResult = AiToolResult;
