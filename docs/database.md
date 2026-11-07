# Database and migrations

## Source of schema

`backend/sql/` is the ordered schema source. Files `001` through `022` are
applied in filename order by `backend/scripts/db-setup.mjs`. The collation is
intentional: do not renumber an applied migration.

Recent migrations relevant to the current architecture:

| Migration | Purpose |
| --- | --- |
| `020_conversations.sql` | conversations, messages, voice interactions and one-active-voice index |
| `021_participant_tokens_and_realtime_outbox.sql` | hashed participant credentials, realtime outbox and session cleanup plumbing |
| `022_order_workflow_outbox.sql` | durable Orders → Kitchen hand-off |

`backend/sql/seed.sql` is optional demo data. It is **not** required to boot the
API, but `npm run db:verify` expects the seeded database for its seed-dependent
checks.

## Setup

```bash
cd backend
cp .env.example .env          # fill DATABASE_URL and the required PIN/secrets
npm install
npm run db:setup              # apply migrations + seed
# or: npm run db:setup:noseed
```

The setup script is safe to re-run: migrations are written to be idempotent and
the script reports each file it applies.

## Verification

```bash
cd backend
npm run db:verify
```

A seeded database should pass every check. On a deliberately seedless database,
the seed, demo-table and sample-order checks will fail; that is an environment
choice, not a schema pass. Do not report a seedless run as a complete pass.

## Real-PostgreSQL tests

Repository and migration tests are skipped unless `TEST_DATABASE_URL` is set.
Use a disposable database, not the development database:

```bash
createdb aeychhotu_test
export TEST_DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/aeychhotu_test'
cd backend
npm test
```

The Docker pattern used in this repository is PostgreSQL 16 on a non-default
port, with `DATABASE_URL` and `TEST_DATABASE_URL` pointed at that container.
Remove the container after the run.

## Data rules that matter

- `restaurant_tables.session_started_at` identifies the seating. Conversation
  rows and participant tokens are bound to it.
- A clear rotates the seating, purges the old conversation and revokes its
  participant tokens in the same transaction.
- `orders.total` and `order_items.unit_price` are frozen at fire time; a later
  menu price change must not rewrite an existing bill.
- Denied orders are excluded from the bill projection.
- `realtime_outbox` rows and the order-workflow outbox are written in the same
  business transaction as the state change they announce.
