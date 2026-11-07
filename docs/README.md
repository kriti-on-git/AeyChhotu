# AeyChhotu! documentation

This directory is the authoritative documentation for the repository. Documents
in [`old_docs/`](../old_docs/) are historical design and delivery records; they
are useful context, not a description of the current implementation.

## Start here

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | Module boundaries, ownership, dependency direction, startup and shutdown |
| [database.md](database.md) | Schema migrations, setup, verification and test databases |
| [auth-and-sessions.md](auth-and-sessions.md) | Table joins, participant tokens, seating lifecycle and revocation |
| [realtime.md](realtime.md) | Socket.IO rooms, outbox delivery, Supabase status and the single-instance rule |
| [conversation.md](conversation.md) | Server-owned conversation history, Gemini provider, tools and voice coordination |
| [billing.md](billing.md) | Authoritative bill arithmetic, allocations, guest/staff reads and settlement |
| [api.md](api.md) | Response envelopes, current conversation/billing routes and errors |
| [frontend.md](frontend.md) | Diner data flow, conversation UI, voice playback and bill rendering |
| [development.md](development.md) | Local setup, environment, tests and disposable PostgreSQL |

## Current runtime shape

- **One Express API process** serves REST and Socket.IO on the same HTTP listener.
- **One PostgreSQL database** owns sessions, conversations, orders, billing state
  and the durable outboxes.
- **One Socket.IO server with the in-memory adapter.** Horizontal scaling is not
  supported. See [realtime.md](realtime.md).
- **Conversation AI runs on the server.** The browser holds no Gemini key for the
  diner waiter and cannot execute its tools.
- **Billing arithmetic runs on the server.** The diner bill drawer renders the
  backend response; staged cart lines are labelled as estimates.
- **Supabase Realtime/Presence is still active** for cart, catalogue, order and
  presence updates. Conversation and session-lifecycle events use Socket.IO.
  Supabase is not removed until every remaining usage has an equivalent and has
  been verified.
