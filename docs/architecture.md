# Architecture

## Composition

`backend/src/index.ts` is the composition root. It creates the database manager,
the internal event bus, the Socket.IO manager, the durable outboxes, every
business module, the periodic jobs and finally the HTTP server. Modules never
construct a second database pool, a second Socket.IO server or a hidden global
service.

```
backend/src/
  index.ts                 composition root
  app.ts                   Express app factory and route mounting
  bootstrap/               lifecycle graph, container, init context
  config/ + infrastructure/ config, database, logging, events, health, realtime
  modules/                 business modules with explicit ports
  routes/                  thin compatibility mounts for legacy services
  services/                compatibility facades used by older route code
  middleware/              auth, rate limits, request logging, errors
  sql/                     ordered schema migrations and optional seed
  test/                    focused unit, HTTP, realtime and PostgreSQL tests
```

## Module ownership

| Module | Owns | Depends on |
| --- | --- | --- |
| `staff` | Shift/admin login, JWT identity, permission matrix | database |
| `table` | Tables, seating lifecycle, joins, participant tokens, heartbeats, bill request, release checks | database, outbox |
| `menu` | Public catalogue, categories, item availability | database |
| `inventory` | Stock movements and low-stock state | database, menu |
| `cart` | Shared table cart and cart events | database, table, menu |
| `orders` | Firing, order history and denied-round lifecycle | database, table, menu, cart, order-workflow outbox |
| `tickets` | Kitchen ticket projection and status machine | database, orders, table |
| `kitchen` | Kitchen commands, queue view and realtime announcements | database, tickets |
| `billing` | Generated bill read model and settlement | database, orders, table |
| `conversation` | Shared transcript, AI turns, tool dispatch, voice coordination | database, table, menu, cart, orders, realtime outbox |
| `realtime-outbox` | Durable conversation/session event delivery | database, Socket.IO publisher |
| `order-workflow` | Durable Orders → Kitchen hand-off | database, tickets/kitchen handler |

A module exposes a narrow service port. Cross-module reads and writes go through
that port, not through another module's repository or SQL. The conversation tool
layer is deliberately limited to `MenuServicePort`, `CartServicePort`,
`OrdersServicePort` and `TableServicePort`.

## Compatibility layer

`routes/` and `services/` are compatibility surfaces for route paths and older
call sites that predate the module split. They delegate to the module instances
registered at the composition root. New code should import a module port from
`modules/<name>/index.ts`.

## Startup and shutdown

`AppBootstrap` starts components in dependency order. The important order is:

1. database and domain events;
2. staff and table;
3. orders, tickets, kitchen, order-workflow;
4. billing, menu, inventory, cart;
5. conversation;
6. periodic jobs and the realtime outbox dispatcher;
7. HTTP server;
8. Socket.IO attached to the listening HTTP server.

Shutdown is the reverse. The HTTP server drains in-flight requests, Socket.IO is
closed, the outbox dispatcher stops before the database closes, and periodic
timers are cleared. Boot failures roll back components already started. `/ready`
returns 503 while the database is unavailable; the process is not killed merely
because a dependency is briefly down.

## Transaction boundaries

- Every conversation write authorizes the participant and writes its outbox row
  in the same transaction.
- A guest message commits before the AI provider is called.
- The assistant reply is a second transaction that revalidates the same seating
  and conversation.
- Order firing is atomic in PostgreSQL, not assembled by the HTTP layer.
- Billing generation is a read; settlement is the only billing write.

## Ownership rules

- The AI never receives a repository, SQL handle or database credential.
- The model never receives a table token, table secret or participant token.
- The browser never validates a table capability by itself; the server resolves
  the participant's seating on every conversation/bill request.
- Money arithmetic uses integer paise in Billing and in its response.
