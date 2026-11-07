import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES composition check for Phase 5.3.

   Proves the actual boundary, not a mock: OrdersRepository writes the order
   and order_workflow_outbox row in one transaction, the dispatcher survives
   failure, duplicate replay and a fresh dispatcher, and Kitchen receives the
   intake notification without a second ticket. Gated on TEST_DATABASE_URL. */

import { configureLegacyDatabase, createLegacyDbPort } from "../src/db/legacy-db-port.js";
import { AppError } from "../src/errors/app-error.js";
import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { HealthManager } from "../src/infrastructure/health/HealthManager.js";
import type { PublishResult } from "../src/infrastructure/realtime/RealtimePublisher.js";
import { KitchenRepository } from "../src/modules/kitchen/kitchen.repository.js";
import { KitchenService } from "../src/modules/kitchen/kitchen.service.js";
import type {
  KitchenEventPublisher,
  KitchenRealtimePort,
} from "../src/modules/kitchen/kitchen.types.js";
import {
  createOrderWorkflowModule,
  type OrderWorkflowHandler,
} from "../src/modules/order-workflow/index.js";
import { OrdersRepository } from "../src/modules/orders/orders.repository.js";
import { OrdersService } from "../src/modules/orders/orders.service.js";
import { TableRepository } from "../src/modules/table/table.repository.js";
import { TableService } from "../src/modules/table/table.service.js";
import { TicketsRepository } from "../src/modules/tickets/tickets.repository.js";
import { TicketsService } from "../src/modules/tickets/tickets.service.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — durable order workflow checks skipped";

function uniqueCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
}

function result(event: string): PublishResult {
  return { room: "kitchen", event, recipients: 0, skipped: false };
}

interface Harness {
  manager: DatabaseManager;
  orders: OrdersService;
  workflow: ReturnType<typeof createOrderWorkflowModule>;
  kitchen: KitchenService;
  tableId: string;
  emptyTableId: string;
  token: string;
  emptyToken: string;
  itemId: string;
  realtime: Array<{ event: string; data: unknown }>;
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const token = uniqueCode("w");
  const emptyToken = uniqueCode("e");
  const table = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [token, `Workflow ${token}`],
  );
  const emptyTable = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [emptyToken, `Workflow ${emptyToken}`],
  );
  const menuItem = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 120, 'Main Course', 'Integration workflow dish')
       RETURNING id`,
    [`Workflow Dosa ${randomUUID().slice(0, 8)}`],
  );

  const tableId = table.rows[0]?.id;
  const emptyTableId = emptyTable.rows[0]?.id;
  const itemId = menuItem.rows[0]?.id;
  assert.ok(tableId && emptyTableId && itemId);

  const tableService = new TableService({
    repository: new TableRepository(manager),
    issueReadToken: () => null,
  });

  let handler: OrderWorkflowHandler | null = null;
  const workflow = createOrderWorkflowModule({
    db: manager,
    handler: () => handler,
    pollMs: 10,
  });

  const orders = new OrdersService({
    repository: new OrdersRepository(manager, workflow.service),
    tables: tableService,
  });

  const tickets = new TicketsService({ repository: new TicketsRepository(manager) });
  const realtime: Array<{ event: string; data: unknown }> = [];
  const realtimePort: KitchenRealtimePort = {
    toKitchen(event, data) {
      realtime.push({ event, data });
      return result(event);
    },
  };
  const events: KitchenEventPublisher = {
    ticketIncoming: () => undefined,
    ticketCompleted: () => undefined,
  };
  const kitchen = new KitchenService({
    tickets,
    repository: new KitchenRepository(manager),
    realtime: realtimePort,
    events,
  });

  handler = {
    handleOrderCreated: async ({ orderId, tableId: orderTableId }) => {
      await kitchen.handleIncomingTicket({
        ticketId: orderId,
        orderId,
        tableId: orderTableId,
      });
    },
  };

  try {
    return await fn({
      manager,
      orders,
      workflow,
      kitchen,
      tableId,
      emptyTableId,
      token,
      emptyToken,
      itemId,
      realtime,
    });
  } finally {
    await manager.query("DELETE FROM cart_items WHERE table_id = ANY($1::uuid[])", [
      [tableId, emptyTableId],
    ]);
    await manager.query("DELETE FROM orders WHERE table_id = ANY($1::uuid[])", [
      [tableId, emptyTableId],
    ]);
    await manager.query("DELETE FROM menu_items WHERE id = $1", [itemId]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = ANY($1::uuid[])", [
      [tableId, emptyTableId],
    ]);
    await manager.shutdown();
  }
}

async function addCartLine(
  manager: DatabaseManager,
  tableId: string,
  menuItemId: string,
): Promise<void> {
  await manager.query(
    `INSERT INTO cart_items (table_id, menu_item_id, quantity, request_note, allergy_note, added_by)
          VALUES ($1, $2, 1, '', '', 'Asha')`,
    [tableId, menuItemId],
  );
}

async function outbox(manager: DatabaseManager, orderId: string) {
  const res = await manager.query<{
    status: string;
    attempts: number;
    last_error: string | null;
  }>(
    `SELECT status, attempts, last_error
       FROM order_workflow_outbox
      WHERE order_id = $1`,
    [orderId],
  );
  return res.rows[0];
}

async function readyNow(manager: DatabaseManager, orderId: string): Promise<void> {
  await manager.query(
    `UPDATE order_workflow_outbox
        SET status = 'pending', processed_at = NULL,
            next_attempt_at = clock_timestamp()
      WHERE order_id = $1`,
    [orderId],
  );
}

async function boardCount(harness: Harness): Promise<number> {
  const page = await harness.kitchen.getBoard({ page: 1, limit: 100 });
  return page.data.filter((ticket) => ticket.table.id === harness.tableId).length;
}

describe("Orders -> Tickets -> Kitchen durable workflow", { skip: skipReason }, () => {
  it("commits the order, ticket and outbox row together, then notifies Kitchen", async () => {
    await withHarness(async (harness) => {
      await addCartLine(harness.manager, harness.tableId, harness.itemId);
      const fired = await harness.orders.fireOrder(harness.token);

      assert.equal((await outbox(harness.manager, fired.order_id))?.status, "pending");
      assert.equal(await boardCount(harness), 1);
      assert.equal(harness.realtime.length, 0);

      assert.equal(await harness.workflow.dispatcher.dispatchOnce(), "processed");
      assert.equal((await outbox(harness.manager, fired.order_id))?.status, "processed");
      assert.equal(harness.realtime.length, 1);
      assert.equal(harness.realtime[0]?.event, "kitchen.ticket.incoming");
      assert.equal(await boardCount(harness), 1);
    });
  });

  it("retries a failed hand-off and processes it after recovery", async () => {
    await withHarness(async (harness) => {
      await addCartLine(harness.manager, harness.tableId, harness.itemId);
      const fired = await harness.orders.fireOrder(harness.token);

      const good = {
        handleOrderCreated: async ({ orderId, tableId }: { orderId: string; tableId: string }) => {
          await harness.kitchen.handleIncomingTicket({
            ticketId: orderId,
            orderId,
            tableId,
          });
        },
      };
      const failing: OrderWorkflowHandler = {
        handleOrderCreated: async () => {
          throw new Error("kitchen intake unavailable");
        },
      };
      // The module closes over a mutable handler supplied by withHarness; a
      // failing dispatcher is modelled by a one-shot wrapper queue below.
      const failingModule = createOrderWorkflowModule({
        db: harness.manager,
        handler: () => failing,
      });
      assert.equal(await failingModule.dispatcher.dispatchOnce(), "retried");
      const failed = await outbox(harness.manager, fired.order_id);
      assert.equal(failed?.status, "pending");
      assert.equal(failed?.attempts, 1);
      assert.match(failed?.last_error ?? "", /kitchen intake unavailable/);

      await readyNow(harness.manager, fired.order_id);
      const recovering = createOrderWorkflowModule({
        db: harness.manager,
        handler: () => good,
      });
      assert.equal(await recovering.dispatcher.dispatchOnce(), "processed");
      assert.equal((await outbox(harness.manager, fired.order_id))?.status, "processed");
      assert.equal(harness.realtime.length, 1);
    });
  });

  it("replays without creating a duplicate ticket", async () => {
    await withHarness(async (harness) => {
      await addCartLine(harness.manager, harness.tableId, harness.itemId);
      const fired = await harness.orders.fireOrder(harness.token);

      assert.equal(await harness.workflow.dispatcher.dispatchOnce(), "processed");
      await readyNow(harness.manager, fired.order_id);
      assert.equal(await harness.workflow.dispatcher.dispatchOnce(), "processed");

      const count = await harness.manager.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM orders WHERE table_id = $1",
        [harness.tableId],
      );
      assert.equal(count.rows[0]?.total, 1);
      assert.equal(await boardCount(harness), 1);
      assert.equal(harness.realtime.length, 2); // at-least-once notification
    });
  });

  it("recovers a pending hand-off with a fresh dispatcher (restart)", async () => {
    await withHarness(async (harness) => {
      await addCartLine(harness.manager, harness.tableId, harness.itemId);
      const fired = await harness.orders.fireOrder(harness.token);

      const restarted = createOrderWorkflowModule({
        db: harness.manager,
        handler: () => ({
          handleOrderCreated: ({ orderId, tableId }) =>
            harness.kitchen.handleIncomingTicket({ ticketId: orderId, orderId, tableId }),
        }),
      });
      assert.equal(await restarted.dispatcher.dispatchOnce(), "processed");
      assert.equal((await outbox(harness.manager, fired.order_id))?.status, "processed");
    });
  });

  it("does not enqueue a hand-off for a failed fire", async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        () => harness.orders.fireOrder(harness.emptyToken),
        (err: unknown) => err instanceof AppError && err.code === "EMPTY_CART",
      );
      const rows = await harness.manager.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM order_workflow_outbox WHERE table_id = $1",
        [harness.emptyTableId],
      );
      assert.equal(rows.rows[0]?.total, 0);
    });
  });

  it("uses the configured DatabaseManager for legacy consumers", async () => {
    await withHarness(async (harness) => {
      /* Captured before configuration, as a service import would be. */
      const legacy = createLegacyDbPort();
      configureLegacyDatabase(harness.manager);
      const one = await legacy.query<{ one: number }>("SELECT 1 AS one");
      assert.equal(one.rows[0]?.one, 1);
    });
  });

  it("passes real database health and readiness", async () => {
    await withHarness(async (harness) => {
      const health = new HealthManager({ checkTimeoutMs: 500 });
      health.register(harness.manager);
      await health.init(initContext());
      await health.checkAll();
      assert.equal(health.readiness().ready, true);
      await health.shutdown();
    });
  });
});
