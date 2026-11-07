import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for the Tickets module: creation through the atomic
   order fire, identification, order↔ticket association, item fidelity, the
   status machine, duplicate prevention, concurrency, rollback safety,
   repository/schema integration and health. Gated on TEST_DATABASE_URL. */

import { AppError } from "../src/errors/app-error.js";
import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { OrdersRepository } from "../src/modules/orders/orders.repository.js";
import { OrdersService } from "../src/modules/orders/orders.service.js";
import { TableRepository } from "../src/modules/table/table.repository.js";
import { TableService } from "../src/modules/table/table.service.js";
import { createTicketsModule } from "../src/modules/tickets/tickets.module.js";
import { TicketsRepository } from "../src/modules/tickets/tickets.repository.js";
import { TicketsService } from "../src/modules/tickets/tickets.service.js";
import type { TicketEventPublisher } from "../src/modules/tickets/tickets.types.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres ticket checks skipped";

function uniqueCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
}

interface Harness {
  manager: DatabaseManager;
  orders: OrdersService;
  service: TicketsService;
  repository: TicketsRepository;
  module: ReturnType<typeof createTicketsModule>;
  tableId: string;
  token: string;
  itemId: string;
  otherItemId: string;
  events: Array<Record<string, unknown>>;
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const token = uniqueCode("t");
  const table = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [token, `Tickets ${token}`],
  );
  const menuItem = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 120, 'Main Course', 'Integration ticket dish')
       RETURNING id`,
    [`Ticket Dosa ${randomUUID().slice(0, 8)}`],
  );
  const otherItem = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 40, 'Beverages', 'Integration ticket drink')
       RETURNING id`,
    [`Ticket Coffee ${randomUUID().slice(0, 8)}`],
  );

  const tableId = table.rows[0]?.id;
  const itemId = menuItem.rows[0]?.id;
  const otherItemId = otherItem.rows[0]?.id;
  assert.ok(tableId && itemId && otherItemId);

  const tableService = new TableService({
    repository: new TableRepository(manager),
    issueReadToken: () => null,
  });

  const orders = new OrdersService({
    repository: new OrdersRepository(manager),
    tables: tableService,
  });

  const events: Array<Record<string, unknown>> = [];
  const eventsPort: TicketEventPublisher = {
    ticketAdvanced: (payload) => events.push({ event: "ticket.status.changed", ...payload }),
    ticketServed: (payload) => events.push({ event: "ticket.served", ...payload }),
    ticketDenied: (payload) => events.push({ event: "ticket.denied", ...payload }),
  };

  const repository = new TicketsRepository(manager);
  const service = new TicketsService({
    repository,
    orders: repository,
    release: tableService,
    events: eventsPort,
  });
  const module = createTicketsModule({
    db: manager,
    release: tableService,
    events: eventsPort,
  });

  const harness: Harness = {
    manager,
    orders,
    service,
    repository,
    module,
    tableId,
    token,
    itemId,
    otherItemId,
    events,
  };

  try {
    return await fn(harness);
  } finally {
    await manager.query("DELETE FROM cart_items WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
    /* Serving posts to the sales rollup, which references the fixture dishes. */
    await manager.query("DELETE FROM sales_rollup WHERE menu_item_id = ANY($1::uuid[])", [
      [itemId, otherItemId],
    ]);
    await manager.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [
      [itemId, otherItemId],
    ]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
    await manager.shutdown();
  }
}

async function addCartLine(
  manager: DatabaseManager,
  tableId: string,
  menuItemId: string,
  quantity = 1,
  note = "",
): Promise<void> {
  await manager.query(
    `INSERT INTO cart_items (table_id, menu_item_id, quantity, request_note, allergy_note, added_by)
          VALUES ($1, $2, $3, $4, 'peanut', 'Asha')`,
    [tableId, menuItemId, quantity, note],
  );
}

/** One fired round is one order and, today, one ticket for it. */
async function fireRound(
  harness: Harness,
  lines: Array<{ itemId?: string; quantity?: number; note?: string }> = [{}],
): Promise<string> {
  for (const line of lines) {
    await addCartLine(
      harness.manager,
      harness.tableId,
      line.itemId ?? harness.itemId,
      line.quantity ?? 1,
      line.note ?? "",
    );
  }
  const fired = await harness.orders.fireOrder(harness.token);
  return fired.order_id;
}

async function board(harness: Harness) {
  return harness.service.listTickets({ page: 1, limit: 100 });
}

/** The board is shared by every table, so assertions scope to this fixture. */
async function tableTickets(harness: Harness) {
  return (await board(harness)).data.filter((ticket) => ticket.table.id === harness.tableId);
}

async function requestPing(manager: DatabaseManager, tableId: string): Promise<boolean> {
  const res = await manager.query<{ pinged: boolean }>(
    "SELECT serve_requested_at IS NOT NULL AS pinged FROM restaurant_tables WHERE id = $1",
    [tableId],
  );
  return res.rows[0]?.pinged === true;
}

async function persist(manager: DatabaseManager, ticketId: string) {
  const res = await manager.query<{ status: string; denial_reason: string }>(
    "SELECT status, denial_reason FROM orders WHERE id = $1",
    [ticketId],
  );
  return res.rows[0];
}

describe("Tickets module — real Postgres", { skip: skipReason }, () => {
  it("reports its projection, trigger and indexes", async () => {
    await withHarness(async ({ repository }) => {
      const schema = await repository.schemaObjects();
      assert.deepEqual(schema.missing, []);
      assert.deepEqual(schema.present, [
        "orders",
        "order_items",
        "orders_status_transition",
        "orders_one_active_uq",
        "order_items_order_idx",
      ]);
    });
  });

  it("creates one ticket atomically with its order and faithful items", async () => {
    await withHarness(async (harness) => {
      const { manager, service, tableId, itemId, otherItemId } = harness;
      const before = await manager.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM orders WHERE table_id = $1",
        [tableId],
      );
      assert.equal(before.rows[0]?.total, 0, "no ticket may exist before the fire");

      const orderId = await fireRound(harness, [
        { itemId, quantity: 2, note: "crisp" },
        { itemId: otherItemId, quantity: 1 },
      ]);

      const tickets = await tableTickets(harness);
      assert.equal(tickets.length, 1);

      const ticket = tickets[0];
      assert.ok(ticket);
      assert.equal(ticket.ticket_id, orderId);
      assert.equal(ticket.order_id, orderId);
      assert.equal(ticket.status, "pending");
      assert.equal(ticket.table.id, tableId);

      const dosa = ticket.items.find((item) => item.menu_item_id === itemId);
      assert.ok(dosa);
      assert.equal(dosa.name.startsWith("Ticket Dosa"), true);
      assert.equal(dosa.quantity, 2);
      assert.equal(dosa.request_note, "crisp");
      assert.equal(dosa.allergy_note, "peanut");
      assert.equal(dosa.added_by, "Asha");
      assert.equal(dosa.unit_price, 120);

      const coffee = ticket.items.find((item) => item.menu_item_id === otherItemId);
      assert.ok(coffee);
      assert.equal(coffee.quantity, 1);
      assert.equal(coffee.unit_price, 40);

      const association = await service.getTicket(orderId);
      assert.equal(association.ticket_id, orderId);
      assert.equal(association.table.id, tableId);
    });
  });

  it("identifies a ticket and its parent order, and 404s for an unknown id", async () => {
    await withHarness(async (harness) => {
      const { manager, service, tableId, repository } = harness;
      const orderId = await fireRound(harness);

      const ticket = await service.getTicket(orderId);
      assert.equal(ticket.order_id, orderId);
      assert.equal(ticket.status, "pending");
      assert.equal(ticket.denial_reason, "");

      const ref = await repository.findOrder(orderId);
      assert.equal(ref?.order_id, orderId);
      assert.equal(ref?.table_id, tableId);
      assert.equal(ref?.status, "pending");

      const unknown = randomUUID();
      await assert.rejects(
        () => service.getTicket(unknown),
        (err: unknown) => err instanceof AppError && err.status === 404,
      );
      await assert.rejects(
        () => service.advanceTicket(unknown, "preparing"),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "ORDER_NOT_FOUND" &&
          err.message === "That ticket no longer exists.",
      );

      const rows = await manager.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM orders WHERE table_id = $1",
        [tableId],
      );
      assert.equal(rows.rows[0]?.total, 1);
    });
  });

  it("prevents a duplicate ticket while a round is live", async () => {
    await withHarness(async (harness) => {
      const { manager, orders, tableId, token, itemId } = harness;
      const first = await fireRound(harness);

      await addCartLine(manager, tableId, itemId, 1);
      await assert.rejects(
        () => orders.fireOrder(token),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "DUPLICATE_ORDER" &&
          err.details?.order_id === first,
      );

      const tickets = await tableTickets(harness);
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0]?.ticket_id, first);

      const rows = await manager.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM orders WHERE table_id = $1",
        [tableId],
      );
      assert.equal(rows.rows[0]?.total, 1);
    });
  });

  it("allows a second ticket for the same table once the first is served", async () => {
    await withHarness(async (harness) => {
      const first = await fireRound(harness);
      await harness.service.advanceTicket(first, "preparing");
      await harness.service.advanceTicket(first, "ready");
      await harness.service.pruneTicket(first);

      const second = await fireRound(harness);
      assert.notEqual(second, first, "a new round gets its own ticket identity");

      const tickets = await tableTickets(harness);
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0]?.ticket_id, second);
      assert.equal(tickets[0]?.order_id, second);

      /* The served ticket stays identifiable in history; it is not overwritten
         by the next ticket for the same table. */
      const served = await harness.service.getTicket(first);
      assert.equal(served.status, "served");
      assert.equal(served.order_id, first);
    });
  });

  it("walks pending→preparing→ready and refuses skipped or repeated moves", async () => {
    await withHarness(async (harness) => {
      const { manager, service, events } = harness;
      const ticketId = await fireRound(harness);

      const preparing = await service.advanceTicket(ticketId, "preparing");
      assert.deepEqual(preparing, {
        ticket_id: ticketId,
        order_id: ticketId,
        status: "preparing",
      });

      /* Re-asking for the state it is already in is a refused move, not a
         silent success. */
      await assert.rejects(
        () => service.advanceTicket(ticketId, "preparing"),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.status === 409 &&
          err.message === "Ticket cannot move from preparing to preparing." &&
          err.details?.current_status === "preparing",
      );

      const ready = await service.advanceTicket(ticketId, "ready");
      assert.equal(ready.status, "ready");

      await assert.rejects(
        () => service.advanceTicket(ticketId, "preparing"),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.details?.current_status === "ready",
      );

      assert.equal((await persist(manager, ticketId))?.status, "ready");

      const advanced = events.filter((event) => event.event === "ticket.status.changed");
      assert.deepEqual(
        advanced.map((event) => event.status),
        ["preparing", "ready"],
      );
      assert.ok(advanced.every((event) => event.ticketId === ticketId));
      assert.ok(advanced.every((event) => event.orderId === ticketId));
    });
  });

  it("serves only a ready ticket, clears the waiter ping and commits once", async () => {
    await withHarness(async (harness) => {
      const { manager, service, tableId, events } = harness;
      const ticketId = await fireRound(harness);
      await service.advanceTicket(ticketId, "preparing");
      await service.advanceTicket(ticketId, "ready");
      await manager.query("UPDATE restaurant_tables SET serve_requested_at = now() WHERE id = $1", [
        tableId,
      ]);
      assert.equal(await requestPing(manager, tableId), true);

      const pruned = await service.pruneTicket(ticketId);
      assert.equal(pruned.status, "served");
      assert.equal(pruned.ticket_id, ticketId);
      assert.equal(pruned.order_id, ticketId);
      assert.equal(pruned.table_cleared, false, "an unpaid bill keeps the seating");

      assert.equal((await persist(manager, ticketId))?.status, "served");
      assert.equal(await requestPing(manager, tableId), false);

      assert.equal((await tableTickets(harness)).length, 0);

      assert.deepEqual(
        events.filter((event) => event.event === "ticket.served"),
        [
          {
            event: "ticket.served",
            ticketId,
            orderId: ticketId,
            tableId,
          },
        ],
      );
    });
  });

  it("does not move a ticket when a prune is refused", async () => {
    await withHarness(async (harness) => {
      const { manager, service, tableId, events } = harness;
      const ticketId = await fireRound(harness);
      await manager.query("UPDATE restaurant_tables SET serve_requested_at = now() WHERE id = $1", [
        tableId,
      ]);

      await assert.rejects(
        () => service.pruneTicket(ticketId),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.status === 409 &&
          err.message.includes("only Ready tickets can be served") &&
          err.details?.current_status === "pending",
      );

      /* Status and ping are untouched: the transaction rolled back, so a
         refused serve can never clear the floor's request. */
      assert.equal((await persist(manager, ticketId))?.status, "pending");
      assert.equal(await requestPing(manager, tableId), true);
      assert.equal((await tableTickets(harness)).length, 1);
      assert.equal(events.filter((event) => event.event === "ticket.served").length, 0);
    });
  });

  it("denies a live ticket, persists the reason and clears the ping", async () => {
    await withHarness(async (harness) => {
      const { manager, service, tableId, events } = harness;
      const ticketId = await fireRound(harness);
      await manager.query("UPDATE restaurant_tables SET serve_requested_at = now() WHERE id = $1", [
        tableId,
      ]);

      const denied = await service.denyTicket(ticketId, "  Paneer ran out  ");
      assert.equal(denied.status, "denied");
      assert.equal(denied.denial_reason, "Paneer ran out");
      assert.equal(denied.table_cleared, false);

      const row = await persist(manager, ticketId);
      assert.equal(row?.status, "denied");
      assert.equal(row?.denial_reason, "Paneer ran out");
      assert.equal(await requestPing(manager, tableId), false);
      assert.equal((await tableTickets(harness)).length, 0);

      await assert.rejects(
        () => service.denyTicket(ticketId, "too late"),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.details?.current_status === "denied",
      );

      const deniedEvents = events.filter((event) => event.event === "ticket.denied");
      assert.deepEqual(deniedEvents.map((event) => event.reason), ["Paneer ran out"]);
    });
  });

  it("moves exactly one of two concurrent advances", async () => {
    await withHarness(async (harness) => {
      const { manager, service, events } = harness;
      const ticketId = await fireRound(harness);

      const results = await Promise.allSettled([
        service.advanceTicket(ticketId, "preparing"),
        service.advanceTicket(ticketId, "preparing"),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(
        rejected[0]?.reason instanceof AppError &&
          rejected[0].reason.code === "INVALID_STATUS_TRANSITION",
      );

      assert.equal((await persist(manager, ticketId))?.status, "preparing");
      assert.equal(
        events.filter((event) => event.event === "ticket.status.changed").length,
        1,
        "only the winning move is announced",
      );
    });
  });

  it("passes health and self-test against the real schema", async () => {
    await withHarness(async ({ module }) => {
      const health = await module.health();
      assert.equal(health.state, "HEALTHY");

      const selfTest = await module.selfTest();
      assert.equal(selfTest.ok, true);
    });
  });
});
