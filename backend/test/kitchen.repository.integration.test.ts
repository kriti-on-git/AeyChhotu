import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for the Kitchen module: queue reads, order association,
   intake notification, acceptance → preparation → completion through the real
   Ticket service, invalid transitions, duplicate taps, waiter-ping clearing,
   schema integration and health. Gated on TEST_DATABASE_URL. */

import { AppError } from "../src/errors/app-error.js";
import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import type { PublishResult } from "../src/infrastructure/realtime/RealtimePublisher.js";
import { OrdersRepository } from "../src/modules/orders/orders.repository.js";
import { OrdersService } from "../src/modules/orders/orders.service.js";
import { createKitchenModule } from "../src/modules/kitchen/kitchen.module.js";
import { KitchenRepository } from "../src/modules/kitchen/kitchen.repository.js";
import { KitchenService } from "../src/modules/kitchen/kitchen.service.js";
import type {
  KitchenEventPublisher,
  KitchenRealtimePort,
} from "../src/modules/kitchen/kitchen.types.js";
import { TableRepository } from "../src/modules/table/table.repository.js";
import { TableService } from "../src/modules/table/table.service.js";
import { TicketsRepository } from "../src/modules/tickets/tickets.repository.js";
import { TicketsService } from "../src/modules/tickets/tickets.service.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres kitchen checks skipped";

function uniqueCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
}

function result(event: string): PublishResult {
  return { room: "kitchen", event, recipients: 0, skipped: false };
}

interface Harness {
  manager: DatabaseManager;
  orders: OrdersService;
  tickets: TicketsService;
  kitchen: KitchenService;
  repository: KitchenRepository;
  module: ReturnType<typeof createKitchenModule>;
  tableId: string;
  token: string;
  itemId: string;
  realtime: Array<{ event: string; data: unknown }>;
  events: { incoming: Array<Record<string, unknown>>; completed: Array<Record<string, unknown>> };
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const token = uniqueCode("k");
  const table = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [token, `Kitchen ${token}`],
  );
  const menuItem = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 120, 'Main Course', 'Integration kitchen dish')
       RETURNING id`,
    [`Kitchen Dosa ${randomUUID().slice(0, 8)}`],
  );

  const tableId = table.rows[0]?.id;
  const itemId = menuItem.rows[0]?.id;
  assert.ok(tableId && itemId);

  const tableService = new TableService({
    repository: new TableRepository(manager),
    issueReadToken: () => null,
  });
  const orders = new OrdersService({
    repository: new OrdersRepository(manager),
    tables: tableService,
  });

  const ticketRepository = new TicketsRepository(manager);
  const tickets = new TicketsService({ repository: ticketRepository });
  const repository = new KitchenRepository(manager);

  const realtime: Array<{ event: string; data: unknown }> = [];
  const realtimePort: KitchenRealtimePort = {
    toKitchen(event, data) {
      realtime.push({ event, data });
      return result(event);
    },
  };
  const events = {
    incoming: [] as Array<Record<string, unknown>>,
    completed: [] as Array<Record<string, unknown>>,
  };
  const eventsPort: KitchenEventPublisher = {
    ticketIncoming: (payload) => events.incoming.push({ ...payload }),
    ticketCompleted: (payload) => events.completed.push({ ...payload }),
  };

  const kitchen = new KitchenService({
    tickets,
    repository,
    orders: repository,
    realtime: realtimePort,
    events: eventsPort,
  });
  const module = createKitchenModule({
    db: manager,
    tickets,
    realtime: realtimePort,
    events: eventsPort,
  });

  const harness: Harness = {
    manager,
    orders,
    tickets,
    kitchen,
    repository,
    module,
    tableId,
    token,
    itemId,
    realtime,
    events,
  };

  try {
    return await fn(harness);
  } finally {
    await manager.query("DELETE FROM cart_items WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM sales_rollup WHERE menu_item_id = $1", [itemId]);
    await manager.query("DELETE FROM menu_items WHERE id = $1", [itemId]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
    await manager.shutdown();
  }
}

async function addCartLine(
  manager: DatabaseManager,
  tableId: string,
  menuItemId: string,
  quantity = 1,
): Promise<void> {
  await manager.query(
    `INSERT INTO cart_items (table_id, menu_item_id, quantity, request_note, allergy_note, added_by)
          VALUES ($1, $2, $3, 'crisp', 'peanut', 'Asha')`,
    [tableId, menuItemId, quantity],
  );
}

async function fireRound(harness: Harness): Promise<string> {
  await addCartLine(harness.manager, harness.tableId, harness.itemId, 2);
  const fired = await harness.orders.fireOrder(harness.token);
  return fired.order_id;
}

async function boardForTable(harness: Harness) {
  const page = await harness.kitchen.getBoard({ page: 1, limit: 100 });
  return page.data.filter((ticket) => ticket.table.id === harness.tableId);
}

async function pinged(manager: DatabaseManager, tableId: string): Promise<boolean> {
  const res = await manager.query<{ pinged: boolean }>(
    "SELECT serve_requested_at IS NOT NULL AS pinged FROM restaurant_tables WHERE id = $1",
    [tableId],
  );
  return res.rows[0]?.pinged === true;
}

async function persistedStatus(manager: DatabaseManager, orderId: string): Promise<string | undefined> {
  const res = await manager.query<{ status: string }>(
    "SELECT status FROM orders WHERE id = $1",
    [orderId],
  );
  return res.rows[0]?.status;
}

describe("Kitchen module — real Postgres", { skip: skipReason }, () => {
  it("reads queue counts and the ticket→table association", async () => {
    await withHarness(async (harness) => {
      const orderId = await fireRound(harness);

      const summary = await harness.kitchen.queue();
      assert.ok(summary.active >= 1);
      assert.ok(summary.pending >= 1);
      assert.ok(summary.oldest_created_at !== null);
      assert.ok(Date.parse(summary.oldest_created_at) <= Date.now());

      const association = await harness.repository.findOrder(orderId);
      assert.equal(association?.order_id, orderId);
      assert.equal(association?.table_id, harness.tableId);
      assert.equal(association?.status, "pending");

      const schema = await harness.repository.schemaObjects();
      assert.deepEqual(schema.missing, []);
    });
  });

  it("notifies intake, then accepts, prepares and completes through Ticket", async () => {
    await withHarness(async (harness) => {
      const orderId = await fireRound(harness);
      await harness.manager.query(
        "UPDATE restaurant_tables SET serve_requested_at = now() WHERE id = $1",
        [harness.tableId],
      );

      await harness.kitchen.handleIncomingTicket({
        ticketId: orderId,
        orderId,
        tableId: harness.tableId,
      });
      assert.deepEqual(harness.realtime[0], {
        event: "kitchen.ticket.incoming",
        data: {
          ticket_id: orderId,
          order_id: orderId,
          table_id: harness.tableId,
          status: "pending",
        },
      });

      const accepted = await harness.kitchen.acceptTicket(orderId);
      assert.equal(accepted.status, "preparing");
      assert.equal(await persistedStatus(harness.manager, orderId), "preparing");

      const ready = await harness.kitchen.markTicketReady(orderId);
      assert.equal(ready.status, "ready");
      assert.equal((await boardForTable(harness))[0]?.status, "ready");

      const served = await harness.kitchen.completeTicket(orderId);
      assert.equal(served.status, "served");
      assert.equal(served.table_cleared, false);
      assert.equal(await persistedStatus(harness.manager, orderId), "served");
      assert.equal(await pinged(harness.manager, harness.tableId), false);
      assert.equal((await boardForTable(harness)).length, 0);

      assert.deepEqual(
        harness.realtime.map((entry) => entry.event),
        [
          "kitchen.ticket.incoming",
          "kitchen.ticket.accepted",
          "kitchen.ticket.ready",
          "kitchen.ticket.served",
        ],
      );
      assert.deepEqual(harness.events.incoming, [
        { ticketId: orderId, orderId, tableId: harness.tableId },
      ]);
      assert.deepEqual(harness.events.completed, [{ ticketId: orderId, orderId }]);
    });
  });

  it("refuses invalid transitions and duplicate taps without extra notifications", async () => {
    await withHarness(async (harness) => {
      const orderId = await fireRound(harness);

      await assert.rejects(
        () => harness.kitchen.markTicketReady(orderId),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.details?.current_status === "pending",
      );
      assert.equal(harness.realtime.length, 0);

      await harness.kitchen.acceptTicket(orderId);
      await assert.rejects(
        () => harness.kitchen.acceptTicket(orderId),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.details?.current_status === "preparing",
      );
      assert.deepEqual(
        harness.realtime.map((entry) => entry.event),
        ["kitchen.ticket.accepted"],
      );

      await assert.rejects(
        () => harness.kitchen.completeTicket(orderId),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.details?.current_status === "preparing",
      );
      assert.equal(harness.realtime.length, 1);

      await harness.kitchen.markTicketReady(orderId);
      await harness.kitchen.completeTicket(orderId);
      assert.deepEqual(
        harness.realtime.map((entry) => entry.event),
        ["kitchen.ticket.accepted", "kitchen.ticket.ready", "kitchen.ticket.served"],
      );
      assert.equal(harness.events.completed.length, 1);
    });
  });

  it("denies a live ticket through Ticket and notifies the kitchen", async () => {
    await withHarness(async (harness) => {
      const orderId = await fireRound(harness);

      const denied = await harness.kitchen.denyTicket(orderId, "  Paneer ran out  ");
      assert.equal(denied.status, "denied");
      assert.equal(denied.denial_reason, "Paneer ran out");
      assert.equal(await persistedStatus(harness.manager, orderId), "denied");
      assert.equal((await boardForTable(harness)).length, 0);

      assert.deepEqual(harness.realtime, [
        {
          event: "kitchen.ticket.denied",
          data: {
            ticket_id: orderId,
            order_id: orderId,
            table_id: harness.tableId,
            status: "denied",
          },
        },
      ]);
    });
  });

  it("passes health and self-test against the real schema", async () => {
    await withHarness(async ({ module }) => {
      assert.equal((await module.health()).state, "HEALTHY");
      assert.equal((await module.selfTest()).ok, true);
    });
  });
});
