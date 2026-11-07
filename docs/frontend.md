# Frontend integration

## Diner data flow

`hooks/use-live-table.ts` loads the table session, cart, catalogue and orders.
The browser stores the table capability and the participant token separately:

- table credentials identify the seating for legacy diner REST calls;
- `pc_…` in `sessionStorage` authenticates conversation, heartbeat and guest
  bill reads.

`use-conversation.ts` is the conversation runtime:

1. `POST /conversations` gets or creates the shared conversation;
2. `GET /conversations/:id` hydrates history and deduplicates by message id;
3. `subscribeConversation` joins the participant-authenticated Socket.IO room;
4. `conversation.message.created` merges the shared transcript across devices;
5. reconnect re-fetches history and the active voice interaction, because
   Socket.IO delivery is at-least-once and events can be missed while offline;
6. `table.session.ended` stops sending, clears the local conversation state and
   returns the screen to the ended-session state.

The transcript is never written to `localStorage` as the source of truth.
Backend history wins on every reconnect.

## Voice

`components/diner/chhotu-assistant.tsx` keeps a voice experience but no longer
runs Gemini Live or diner tools in the browser:

- input uses browser `SpeechRecognition` where available;
- the interaction is claimed through `voice/start` before listening;
- only one voice request is active per conversation; a second attempt is
  refused by the backend and surfaced in the UI;
- the answer is spoken with `SpeechSynthesis` **only** when
  `voice_playback_device_id` equals this device's id;
- text input uses the same message contract and the same backend tools.

Kitchen and manager Gemini Live surfaces are unchanged and are not part of the
diner conversation runtime.

## Bill

`components/diner/bill-drawer.tsx` fetches
`GET /billing/tables/:table_id/guest` with the participant token and renders:

- backend line items and their frozen unit prices;
- backend per-guest allocations, including the shared `Table` entry;
- backend subtotal, tax, discount and total.

The local cart is shown separately and explicitly labelled **estimate** until
it is fired. It is never added to or substituted for the backend total.
`diner-nav-bar.tsx` no longer computes bill arithmetic; it opens the backend
bill.

## Realtime

Conversation/session lifecycle uses Socket.IO (`lib/api-client/realtime.ts`).
Cart, catalogue, order-status and presence subscriptions still use Supabase
Realtime; heartbeat presence remains through the existing sessions heartbeat.
`lib/api-client/realtime.ts` owns both transports while they coexist.

Cleanup rules:

- every effect unsubscribes its socket listener on unmount;
- a reconnect replaces the socket's listeners rather than stacking a second
  subscription for the same conversation;
- messages are deduplicated by id, so a REST refresh and a realtime event for
  the same message render once;
- a stale conversation id from a previous seating is discarded after a session
  end.

## Failure behaviour

- Provider failure: guest message stays committed, UI shows "assistant
  unavailable" and offers retry; no fabricated answer.
- Lost participant token: conversation and guest bill return 403; UI returns to
  the join/reconnect flow.
- Session ended: conversation input is disabled and stale audio is not played.
- Backend unreachable: existing demo fallback policy is unchanged; the
  conversation does not pretend to be backend-authoritative while offline.
