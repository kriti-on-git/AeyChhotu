# Conversation AI

## Ownership

`backend/src/modules/conversation/` owns one conversation per seating, the
shared transcript, voice interaction coordination and the AI provider boundary.
The browser no longer owns the diner transcript or executes diner tools.

## Provider

`GeminiConversationProvider` implements `ConversationAiProvider` with the
Gemini `generateContent` HTTP API. It is constructed only when
`GEMINI_API_KEY` is configured.

| Environment | Meaning |
| --- | --- |
| `GEMINI_API_KEY` | Server-side key. Never sent to the browser for the diner waiter. |
| `GEMINI_TEXT_MODEL` | Text model name; defaults to `gemini-2.5-flash`. |

The provider receives only:

- the conversation id and timestamps;
- the guest's display name;
- the persisted transcript;
- tool declarations.

It does **not** receive the table code/token, table secret, participant token or
any database handle. The old membership object was removed from the provider
input for this reason.

Provider calls have a 15-second abort timeout. HTTP errors, timeouts, blocked
prompts, empty candidates and malformed responses all become a provider failure.
The guest message is already committed; the API returns `AI_UNAVAILABLE` and
never invents an assistant answer.

## Tools

Eight declarations are exposed:

`get_menu`, `get_cart`, `add_to_cart`, `update_cart_item`,
`remove_cart_item`, `fire_order`, `get_orders`, `request_bill`.

Each tool is a thin adapter over an existing module port. Argument validation is
performed in the tool layer; business refusals are returned as tool errors
instead of throwing. The model cannot name a table: the caller binds the table
capability from the authenticated seating.

Before every tool execution the service re-authorizes the participant and
revalidates the conversation's seating. A clear/revocation during provider
thinking stops the tool with `SESSION_ENDED`.

At most four tool rounds are allowed per guest turn. Exceeding that returns
`AI_TOOL_LIMIT`; no assistant message is persisted.

## History and late responses

- AI context is the persisted transcript (latest 50 guest/assistant messages).
- The HTTP transcript view returns up to 200 messages.
- A guest message is persisted with its outbox event before the provider call.
- The assistant reply is inserted in a second transaction that rechecks the same
  table and `session_started_at`.
- A clear or new seating makes the late reply a no-op: no row, no outbox event,
  no recreated conversation.
- `client_message_id` makes retries idempotent; the stored assistant reply is
  returned for a duplicate guest message.

## Voice

Voice is one active interaction per conversation, enforced by a partial unique
index. The interaction belongs to the participant and device that started it.
`POST /messages` with `kind: "voice"` requires that interaction id and device id.
An answer carries `voice_playback_device_id`; only that device may play audio.

The diner frontend currently uses browser speech recognition for input and
speech synthesis for output, but still starts/ends the server interaction and
posts the transcript through the same conversation contract. The older
Gemini Live diner path is no longer used for the waiter's tools or history.
Kitchen and manager voice surfaces remain separate Gemini Live features.

## Health

The module health/self-test checks only schema existence. It never creates a
conversation, sends a message, starts a voice interaction or calls Gemini.
