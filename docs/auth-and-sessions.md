# Authentication and session lifecycle

## Two different credentials

| Credential | Where it lives | What it authorizes |
| --- | --- | --- |
| Table token / table secret / PIN | QR URL and device storage | joining or reconnecting to a table session |
| Participant token (`pc_…`) | browser `sessionStorage`, `X-Participant-Token` header, Socket.IO handshake | conversation, roster, heartbeat and guest bill reads for one member of one seating |

A table token is **not** sufficient to post a conversation message or read the
guest bill. The participant token is the only conversation credential.

## Participant token properties

- 32 random bytes, base64url, prefixed `pc_`.
- Only the SHA-256 digest is stored in `table_participant_tokens`.
- Bound to `table_members.id` and the exact `session_started_at`.
- Twelve-hour expiry, non-sliding.
- At most five live tokens per member; issuing a sixth revokes the oldest.
- Revoked on self-revocation, staff revocation or table clear.
- Never logged, placed in a URL, or returned by a staff payload.

## Join and reconnect

`POST /api/v1/sessions/initialize` claims an empty table or reports it locked.
`join-pin`, `join-pass` and `reconnect` return the granted session plus a fresh
participant token. `reconnect` is for a returning device with stored table
credentials; it does not bypass the table's seating state.

The browser stores the participant token in `sessionStorage`, not
`localStorage`, so closing the tab ends the credential without outliving the
seating. `apiRequest({ participantAuth: true })` adds the header; a missing
token is sent as no header, and the server answers 403 rather than falling back
to a table token.

## Authorization on writes

Conversation writes open a transaction, lock the table through Table's
authorizer, and only then read or write conversation rows. The participant
resolver returns null for unknown, expired, revoked, wrong-seating or inactive
table credentials. The service maps that to `NOT_TABLE_MEMBER` without
distinguishing the cause.

The AI provider runs outside the transaction. Immediately before every tool
call the service re-authorizes the same seating and conversation. A clear or
revocation that wins during provider thinking therefore makes the queued tool
a `SESSION_ENDED` no-op; it cannot mutate the next party's table.

## Session clear

Table's clear transaction:

1. locks the table;
2. purges conversation messages, voice interactions and the conversation;
3. revokes participant tokens;
4. purges pending conversation outbox rows;
5. inserts the terminal `table.session.ended` event;
6. resets the table and releases it.

Socket.IO revalidates guest credentials periodically and disconnects revoked
sockets. A late AI response is rejected by the second transaction because the
old conversation or seating no longer matches.
