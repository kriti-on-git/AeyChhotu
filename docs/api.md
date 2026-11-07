# API

## Envelope

Success:

```json
{ "success": true, "data": {} }
```

Error:

```json
{
  "success": false,
  "error": { "code": "SCREAMING_SNAKE_CASE", "message": "…", "fields": {} }
}
```

`fields` appears on validation failures. `meta` appears only on paginated list
endpoints. The central error handler turns unknown failures into
`INTERNAL_ERROR` without leaking stacks.

## Authentication headers

| Header | Used by |
| --- | --- |
| `Authorization: Bearer <jwt>` | staff, kitchen, floor, admin |
| `X-Participant-Token: pc_…` | conversation, roster, heartbeat, guest bill |
| `X-Table-Token` | legacy diner REST routes |

The participant header is required for conversation. A table token does not
substitute for it.

## Conversation routes

Mounted only when the conversation service is composed. All require a valid
participant token for an active seating.

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/conversations` | get or create the seating's single conversation |
| `GET /api/v1/conversations/:conversation_id` | shared transcript (latest 200 messages) |
| `POST /api/v1/conversations/:conversation_id/messages` | post a text or voice turn |
| `POST /api/v1/conversations/:conversation_id/voice/start` | claim the one active voice interaction |
| `POST /api/v1/conversations/:conversation_id/voice/:interaction_id/end` | release the caller's interaction |

Message body:

```json
{
  "client_message_id": "uuid",
  "kind": "text",
  "text": "add two chais",
  "voice_interaction_id": null,
  "device_id": null
}
```

For a voice turn: `kind: "voice"`, a valid `voice_interaction_id` owned by the
caller, and the same `device_id` used to start it. The transcript carries
`voice_playback_device_id`, which is the only device allowed to play the answer.

## Billing routes

See [billing.md](billing.md). Guest reads use the participant header; staff
reads and settlement use a staff JWT.

## Status and health

| Path | Auth | Meaning |
| --- | --- | --- |
| `GET /api/v1/health` | none | liveness, process is up |
| `GET /api/v1/ready` | none | readiness, database reachable; 503 while not |

## Conversation error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | malformed body/params/header |
| `NOT_TABLE_MEMBER` | 403 | participant missing, expired, revoked, wrong seating |
| `DUPLICATE_MESSAGE` | 409 | same client message collided without a stored record |
| `CONVERSATION_NOT_FOUND` | 404 | conversation does not belong to this seating |
| `VOICE_IN_PROGRESS` | 409 | another voice interaction is already active |
| `VOICE_NOT_FOUND` | 404 | unknown interaction for this conversation |
| `VOICE_NOT_ACTIVE` | 409 | post/end against a finished interaction |
| `VOICE_NOT_INITIATOR` | 403 | device is not the one that started the interaction |
| `SESSION_ENDED` | 409 | seating was cleared or replaced during the turn |
| `AI_UNAVAILABLE` | 502 | provider timeout, HTTP error or malformed response |
| `AI_TOOL_LIMIT` | 502 | model exceeded the four-round tool budget |

## Compatibility

Existing E1–E17 routes and payloads are unchanged. The conversation mount is
additive and is absent from a bare `createApp()` used by focused tests/scripts.
The legacy floor settlement route delegates to the same Billing service.
