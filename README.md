<div align="center">

# 🍛 AeyChhotu!

### One table, one order, live from the kitchen.

A zero-install QR ordering and kitchen-operations app: every phone at a table
shares one cart, the kitchen gets one ticket, and diners, floor and kitchen see
the same state.

</div>

## Current status

The application is implemented and tested, with three current runtime
boundaries worth knowing before deploying:

- **Conversation AI is server-authoritative.** The diner waiter's history,
  tools and provider call live in the backend; the browser holds no Gemini key
  for that surface and cannot execute tools.
- **Billing is server-authoritative.** The diner bill renders backend-calculated
  line items, allocations and totals. Local cart lines are labelled estimates.
- **Run exactly one API instance.** Socket.IO uses the in-memory adapter and the
  durable outbox dispatcher is process-local. Multi-instance delivery is not
  implemented.

Supabase Realtime/Presence remains active for cart, catalogue, order and
presence updates; conversation and session lifecycle use Socket.IO.

## Documentation

[`docs/`](docs/README.md) is authoritative:

- [Architecture and lifecycle](docs/architecture.md)
- [Database and migrations](docs/database.md)
- [Authentication and sessions](docs/auth-and-sessions.md)
- [Realtime and single-instance restriction](docs/realtime.md)
- [Conversation AI and tools](docs/conversation.md)
- [Billing](docs/billing.md)
- [API contracts](docs/api.md)
- [Frontend integration](docs/frontend.md)
- [Development and testing](docs/development.md)

Historical design and delivery records live in [`old_docs/`](old_docs/). They
are useful context but do not describe the current implementation; do not follow
their setup or architecture instructions.

## Quick start

Prerequisites: Node.js ≥ 20 (backend) / ≥ 22 (frontend), PostgreSQL 15+.

```bash
cd backend && npm install
cd ../frontend && npm install

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
# fill DATABASE_URL, STAFF_PIN, ADMIN_PIN, KDS_TOKEN_SECRET, CLIENT_URL

cd backend && npm run db:setup
cd backend && npm run dev          # http://localhost:4000
cd frontend && npm run dev         # http://localhost:3000
```

Seeded demo table: <http://localhost:3000/table/k7x2p>. Kitchen and floor use
`STAFF_PIN`; the manager console uses `ADMIN_PIN`.

For disposable-database tests, environment details and all verification
commands, see [docs/development.md](docs/development.md).

## Repository layout

```
backend/    Express 5 REST API + Socket.IO + PostgreSQL access
  sql/      ordered, idempotent migrations (001–022) and optional seed
  src/      bootstrap, infrastructure, modules, compatibility routes/services
  test/     unit, HTTP, realtime and PostgreSQL integration tests
frontend/   Next.js 16 App Router application
  app/      diner, kitchen, floor and admin routes
  components/ diner, staff, layout and UI
  hooks/    live table, live KDS, conversation
  lib/      API client, realtime, conversation helpers, AI surfaces
docs/       authoritative current documentation
old_docs/   archived design and delivery records
```

## Verification

```bash
cd backend  && npm run typecheck && npm test && npm run build
cd frontend && npm run typecheck && npm test && npm run build
```

Database integration tests require `TEST_DATABASE_URL`; without it they skip.
`npm run db:verify` requires the seed for its seed-dependent checks. See
[docs/development.md](docs/development.md) for the disposable PostgreSQL
procedure.
