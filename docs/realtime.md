# Realtime

## Transport

Socket.IO is attached to the API's existing HTTP listener (default path
`/socket.io`). It has no separate port. Guest handshakes use:

```js
io(apiOrigin, {
  path: "/socket.io",
  auth: { kind: "guest", participant_token: "pc_..." },
  withCredentials: true,
});
```

The server resolves the participant to a table and joins the socket to exactly
`table:<table_id>` and the public `menu` room. A client cannot request a room it
was not granted; room requests are allowlisted.

Server-to-client messages use one channel:

```ts
socket.on("realtime:event", (envelope) => {
  // { id, event, room, at, sequence, data }
});
```

Conversation events currently published:

- `conversation.message.created`
- `conversation.voice.started`
- `conversation.voice.ended`
- `table.session.ended`

The event payload names the table/conversation and, for voice, the initiating
device. The message payload's `voice_playback_device_id` is the only device that
may play the answer.

## Outbox

Conversation and session events are written to `realtime_outbox` inside the
business transaction. A single dispatcher publishes them in per-table order.
Delivery is at-least-once; every payload carries an `event_id`, so consumers
deduplicate by id. The dispatcher waits for Socket.IO readiness and retries with
bounded attempts. Clear suppresses pending conversation rows before writing the
terminal session event.

The general Orders → Tickets → Kitchen outbox is separate and durable
(`order_workflow_outbox`).

## Single-instance restriction

**Run exactly one API instance.** The Socket.IO adapter is in-memory and the
outbox dispatcher is a process-local loop. PostgreSQL locks serialize the
dispatcher, but they do not make delivery work across multiple Socket.IO
servers: a socket connected to instance A never receives an event emitted by
instance B.

Horizontal scaling requires a shared Socket.IO adapter plus a durable
work-queue design. Neither is implemented. Do not remove this restriction from
deployment documentation until both exist and are tested.

## Supabase status

Supabase Realtime/Presence remains active for:

- table cart changes;
- catalogue/menu updates;
- order status/feed updates;
- heartbeat-based diner presence.

It is not the conversation transport and it is not the session-lifecycle
transport. Do not remove the Supabase dependency until each remaining
subscription has a verified Socket.IO or REST replacement. Heartbeat presence is
preserved through the existing `sessions/:token/heartbeat` API.
