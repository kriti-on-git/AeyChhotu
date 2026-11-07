# Development and testing

## Prerequisites

- Node.js ≥ 20 for the backend, ≥ 22 for the frontend.
- PostgreSQL 15+ (or Supabase).
- Two terminals: API on `4000`, Next.js on `3000`.

## Install and run

```bash
cd backend && npm install
cd ../frontend && npm install

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
# fill DATABASE_URL, STAFF_PIN, ADMIN_PIN, KDS_TOKEN_SECRET, CLIENT_URL
# optional: GEMINI_API_KEY, GEMINI_TEXT_MODEL

cd backend && npm run dev
cd frontend && npm run dev
```

`GET http://localhost:4000/api/v1/health` should return success and
`/api/v1/ready` should return 200 once the database is reachable.

## Environment notes

| Variable | Needed for |
| --- | --- |
| `DATABASE_URL` | API boot |
| `CLIENT_URL` | CORS and Socket.IO origin allow-list (comma-separated) |
| `STAFF_PIN`, `ADMIN_PIN`, `KDS_TOKEN_SECRET` | staff/auth surfaces |
| `GEMINI_API_KEY` | server-side conversation AI and existing Live surfaces |
| `GEMINI_TEXT_MODEL` | optional, defaults to `gemini-2.5-flash` |
| `TEST_DATABASE_URL` | real-PostgreSQL tests; tests skip without it |
| `NEXT_PUBLIC_API_URL` | frontend REST base URL |
| `NEXT_PUBLIC_SUPABASE_*` | remaining Supabase realtime surfaces |

Never put `GEMINI_API_KEY` in `NEXT_PUBLIC_*` for the diner waiter.

## Checks

```bash
# backend
cd backend
npm run typecheck
npm test                 # compiles tests, then node --test
npm run build

# frontend
cd frontend
npm run typecheck
npm test
npm run build
```

`npm test` in the backend compiles with `tsconfig.test.json` and runs
`dist-test/test/*.test.js`. Tests that need PostgreSQL skip unless
`TEST_DATABASE_URL` is set; a skip is not a pass and should be reported.

## Disposable PostgreSQL

Use a database that can be thrown away:

```bash
docker run --name aeychhotu-pg54 -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=aeychhotu_test -p 55432:5432 -d postgres:16

export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/aeychhotu_test'
export TEST_DATABASE_URL="$DATABASE_URL"

cd backend
npm run db:setup:noseed
npm test
npm run db:verify
```

`db:setup:noseed` applies migrations without demo rows. `db:verify` expects the
seed for its seed-dependent assertions, so on a seedless database those checks
will fail by design; either run `npm run db:setup` first or report the expected
seed failures explicitly.

Remove the container when finished:

```bash
docker rm -f aeychhotu-pg54
```

## Manual lifecycle check

Start the API, wait for `/ready`, make one request, then send `SIGTERM`. The
process should stop accepting connections, close Socket.IO, stop the outbox
dispatcher, close the database and exit without an unhandled rejection.
