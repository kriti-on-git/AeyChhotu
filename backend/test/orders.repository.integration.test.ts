import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for the Orders module: atomic creation, duplicate
   prevention, empty-cart refusal, inventory validation, frozen prices, one
   transaction for retry/rollback, concurrent fires and schema health.
   Gated on TEST_DATABASE_URL. */

import { AppError } from "../src/errors/app-error.js";
import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { createOrdersModule } from "../src/modules/orders/orders.module.js";
import { OrdersRepository } from "../src/modules/orders/orders.repository.js";
import { OrdersService } from "../src/modules/orders/orders.service.js";
import type { OrdersEventPublisher } from "../src/modules/orders/orders.types.js";
import { TableRepository } from "../src/modules/table/table.repository.js";
import { TableService } from "../src/modules/table/table.service.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres order checks skipped";

function uniqueCode(prefix: string): string {
  return `${prefix}${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
}

interface Harness {
  manager: DatabaseManager;
  service: OrdersService;
  repository: OrdersRepository;
  module: ReturnType<typeof createOrdersModule>;
  tableId: string;
  token: string;
  otherTableId: string;
  otherToken: string;
  itemId: string;
  otherItemId: string;
  unavailableItemId: string;
  events: Array<Record<string, unknown>>;
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const token = uniqueCode("o");
  const otherToken = uniqueCode("p");
  const first = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [token, `Orders ${token}`],
  );
  const second = await manager.query<{ id: string }>(
    "INSERT INTO restaurant_tables (code, name, status) VALUES ($1, $2, 'empty') RETURNING id",
    [otherToken, `Orders ${otherToken}`],
  );
  const tableId = first.rows[0]?.id;
  const otherTableId = second.rows[0]?.id;
  assert.ok(tableId && otherTableId);

  const menuItem = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 120, 'Main Course', 'Integration order dish')
       RETURNING id`,
    [`Order Dosa ${randomUUID().slice(0, 8)}`],
  );
  const otherItem = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
          VALUES ($1, 40, 'Beverages', 'Integration order drink')
       RETURNING id`,
    [`Order Coffee ${randomUUID().slice(0, 8)}`],
  );
  const unavailableItem = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description, is_available)
          VALUES ($1, 90, 'Main Course', 'Sold out order dish', false)
       RETURNING id`,
    [`Sold Out ${randomUUID().slice(0, 8)}`],
  );

  const itemId = menuItem.rows[0]?.id;
  const otherItemId = otherItem.rows[0]?.id;
  const unavailableItemId = unavailableItem.rows[0]?.id;
  assert.ok(itemId && otherItemId && unavailableItemId);

  const tableService = new TableService({
    repository: new TableRepository(manager),
    issueReadToken: () => null,
  });

  const events: Array<Record<string, unknown>> = [];
  const eventsPort: OrdersEventPublisher = {
    orderCreated: (payload) => events.push({ event: "order.created", ...payload }),
    ticketCreated: (payload) => events.push({ event: "ticket.created", ...payload }),
    orderDenied: (payload) => events.push({ event: "order.denied", ...payload }),
  };

  const repository = new OrdersRepository(manager);
  const service = new OrdersService({
    repository,
    tables: tableService,
    events: eventsPort,
  });
  const module = createOrdersModule({
    db: manager,
    tables: tableService,
    events: eventsPort,
  });

  const harness: Harness = {
    manager,
    service,
    repository,
    module,
    tableId,
    token,
    otherTableId,
    otherToken,
    itemId,
    otherItemId,
    unavailableItemId,
    events,
  };

  try {
    return await fn(harness);
  } finally {
    await manager.query("DELETE FROM cart_items WHERE table_id = ANY($1::uuid[])", [
      [tableId, otherTableId],
    ]);
    await manager.query("DELETE FROM orders WHERE table_id = ANY($1::uuid[])", [
      [tableId, otherTableId],
    ]);
    await manager.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [
      [itemId, otherItemId, unavailableItemId],
    ]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = ANY($1::uuid[])", [
      [tableId, otherTableId],
    ]);
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
          VALUES ($1, $2, $3, '', '', 'Asha')`,
    [tableId, menuItemId, quantity],
  );
}

async function orderCount(manager: DatabaseManager, tableId: string): Promise<number> {
  const res = await manager.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM orders WHERE table_id = $1",
    [tableId],
  );
  return res.rows[0]?.total ?? 0;
}

describe("Orders module — real Postgres", { skip: skipReason }, () => {
  it("reports its tables, function and indexes", async () => {
    await withHarness(async ({ repository }) => {
      const schema = await repository.schemaObjects();
      assert.deepEqual(schema.missing, []);
      assert.deepEqual(schema.present, [
        "orders",
        "order_items",
        "fire_order",
        "orders_one_active_uq",
        "order_items_order_idx",
      ]);
    });
  });

  it("creates one complete order, freezes prices and drains the cart", async () => {
    await withHarness(async ({ manager, service, tableId, token, itemId, otherItemId, events }) => {
      await addCartLine(manager, tableId, itemId, 2);
      await addCartLine(manager, tableId, otherItemId, 1);

      const fired = await service.fireOrder(token);
      assert.equal(fired.status, "pending");
      assert.equal(fired.table_id, tableId);

      const order = await manager.query<{ total: string; status: string }>(
        "SELECT total, status FROM orders WHERE id = $1",
        [fired.order_id],
      );
      assert.equal(order.rows[0]?.status, "pending");
      assert.equal(Number(order.rows[0]?.total), 280);

      const items = await manager.query<{ unit_price: string; added_by: string; quantity: number }>(
        "SELECT unit_price, added_by, quantity FROM order_items WHERE order_id = $1 ORDER BY unit_price DESC",
        [fired.order_id],
      );
      assert.equal(items.rows.length, 2);
      assert.equal(Number(items.rows[0]?.unit_price), 120);
      assert.equal(items.rows[0]?.added_by, "Asha");
      assert.equal(items.rows[0]?.quantity, 2);

      const cart = await manager.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM cart_items WHERE table_id = $1",
        [tableId],
      );
      assert.equal(cart.rows[0]?.total, 0);

      /* A later menu re-price must not rewrite the bill. */
      await manager.query("UPDATE menu_items SET price = 999 WHERE id = $1", [itemId]);
      const history = await service.listOrders({ table_token: token, page: 1, limit: 20 });
      assert.equal(history.data.length, 1);
      assert.equal(history.data[0]?.total, 280);
      assert.equal(
        history.data[0]?.items.find((item) => item.menu_item_id === itemId)?.unit_price,
        120,
      );

      assert.deepEqual(
        events.filter((event) => event.event === "order.created").map((event) => event.itemCount),
        [2],
      );
      assert.equal(events.filter((event) => event.event === "ticket.created").length, 1);
    });
  });

  it("rejects an empty cart without creating an order", async () => {
    await withHarness(async ({ manager, service, tableId, token }) => {
      await assert.rejects(
        () => service.fireOrder(token),
        (err: unknown) => err instanceof AppError && err.code === "EMPTY_CART",
      );
      assert.equal(await orderCount(manager, tableId), 0);
    });
  });

  it("prevents a duplicate submission from the same table", async () => {
    await withHarness(async ({ manager, service, tableId, token, itemId }) => {
      await addCartLine(manager, tableId, itemId, 1);
      const first = await service.fireOrder(token);

      await addCartLine(manager, tableId, itemId, 1);
      await assert.rejects(
        () => service.fireOrder(token),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "DUPLICATE_ORDER" &&
          err.details?.order_id === first.order_id,
      );

      assert.equal(await orderCount(manager, tableId), 1);
      /* The refused fire did not drain the newly added cart line. */
      const cart = await manager.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM cart_items WHERE table_id = $1",
        [tableId],
      );
      assert.equal(cart.rows[0]?.total, 1);
    });
  });

  it("rejects an invalid or archived table session", async () => {
    await withHarness(async ({ manager, service, tableId, token, itemId }) => {
      await addCartLine(manager, tableId, itemId, 1);

      await assert.rejects(
        () => service.fireOrder("missing"),
        (err: unknown) => err instanceof AppError && err.code === "TABLE_NOT_FOUND",
      );

      await manager.query("UPDATE restaurant_tables SET deleted_at = now() WHERE id = $1", [
        tableId,
      ]);
      await assert.rejects(
        () => service.fireOrder(token),
        (err: unknown) => err instanceof AppError && err.code === "TABLE_NOT_FOUND",
      );
      assert.equal(await orderCount(manager, tableId), 0);
    });
  });

  it("refuses a fire that contains a sold-out dish and purges only that line", async () => {
    await withHarness(async ({
      manager,
      service,
      tableId,
      token,
      itemId,
      unavailableItemId,
    }) => {
      await addCartLine(manager, tableId, itemId, 1);
      await addCartLine(manager, tableId, unavailableItemId, 1);

      await assert.rejects(
        () => service.fireOrder(token),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVENTORY_FAILURE" &&
          err.message.includes("sold out") &&
          Array.isArray(err.details?.sold_out),
      );

      assert.equal(await orderCount(manager, tableId), 0);
      const cart = await manager.query<{ menu_item_id: string }>(
        "SELECT menu_item_id FROM cart_items WHERE table_id = $1",
        [tableId],
      );
      assert.deepEqual(
        cart.rows.map((row) => row.menu_item_id),
        [itemId],
      );
    });
  });

  it("serializes concurrent submissions into exactly one order", async () => {
    await withHarness(async ({ manager, service, tableId, token, itemId }) => {
      await addCartLine(manager, tableId, itemId, 2);

      const results = await Promise.allSettled([
        service.fireOrder(token),
        service.fireOrder(token),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0]?.reason as AppError).code, "DUPLICATE_ORDER");

      assert.equal(await orderCount(manager, tableId), 1);
      const orphan = await manager.query<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM orders o
          WHERE o.table_id = $1
            AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)`,
        [tableId],
      );
      assert.equal(orphan.rows[0]?.total, 0);
    });
  });

  it("moves a denied round back to the cart and removes the refused ticket", async () => {
    await withHarness(async ({ manager, service, tableId, token, itemId, otherItemId }) => {
      await addCartLine(manager, tableId, itemId, 2);
      await addCartLine(manager, tableId, otherItemId, 1);
      const fired = await service.fireOrder(token);

      await manager.query(
        "UPDATE orders SET status = 'denied', denial_reason = 'Item went out of stock' WHERE id = $1",
        [fired.order_id],
      );
      await manager.query("UPDATE menu_items SET is_available = false WHERE id = $1", [
        otherItemId,
      ]);

      const requeued = await service.requeueDeniedOrder(fired.order_id, token);
      assert.equal(requeued.moved, 1);
      assert.equal(requeued.omitted.length, 1);

      assert.equal(await orderCount(manager, tableId), 0);
      const cart = await manager.query<{ menu_item_id: string; quantity: number }>(
        "SELECT menu_item_id, quantity FROM cart_items WHERE table_id = $1",
        [tableId],
      );
      assert.deepEqual(cart.rows, [{ menu_item_id: itemId, quantity: 2 }]);
    });
  });

  it("rolls back the whole retry when the replacement fire hits inventory", async () => {
    await withHarness(async ({
      manager,
      service,
      tableId,
      token,
      itemId,
      unavailableItemId,
    }) => {
      await addCartLine(manager, tableId, itemId, 1);
      const fired = await service.fireOrder(token);
      await manager.query(
        "UPDATE orders SET status = 'denied', denial_reason = 'Kitchen refused' WHERE id = $1",
        [fired.order_id],
      );
      /* A sold-out line already sitting in the shared cart is what makes the
         replacement fire fail after the ticket has been moved and deleted. */
      await addCartLine(manager, tableId, unavailableItemId, 1);

      await assert.rejects(
        () => service.retryDeniedOrder(fired.order_id, token),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVENTORY_FAILURE" &&
          err.message.includes("nothing was re-fired"),
      );

      const denied = await manager.query<{ status: string; denial_reason: string }>(
        "SELECT status, denial_reason FROM orders WHERE id = $1",
        [fired.order_id],
      );
      assert.equal(denied.rows[0]?.status, "denied");
      assert.equal(denied.rows[0]?.denial_reason, "Kitchen refused");

      const cart = await manager.query<{ menu_item_id: string }>(
        "SELECT menu_item_id FROM cart_items WHERE table_id = $1 ORDER BY menu_item_id",
        [tableId],
      );
      assert.deepEqual(cart.rows, [{ menu_item_id: unavailableItemId }]);
      assert.equal(await orderCount(manager, tableId), 1);
    });
  });

  it("scopes status and dismissal to the caller's table", async () => {
    await withHarness(async ({
      manager,
      service,
      tableId,
      token,
      otherToken,
      itemId,
    }) => {
      await addCartLine(manager, tableId, itemId, 1);
      const fired = await service.fireOrder(token);

      await assert.rejects(
        () => service.getOrderStatus(fired.order_id, otherToken),
        (err: unknown) => err instanceof AppError && err.code === "ORDER_NOT_FOUND",
      );
      await assert.rejects(
        () => service.dismissDeniedOrder(fired.order_id, otherToken),
        (err: unknown) => err instanceof AppError && err.code === "ORDER_NOT_FOUND",
      );

      await manager.query("UPDATE orders SET status = 'denied' WHERE id = $1", [
        fired.order_id,
      ]);
      const dismissed = await service.dismissDeniedOrder(fired.order_id, token);
      assert.deepEqual(dismissed, { order_id: fired.order_id, dismissed: true });
      assert.equal(await orderCount(manager, tableId), 0);
    });
  });

  it("reports healthy only when its schema is present", async () => {
    await withHarness(async ({ module }) => {
      const health = await module.health();
      assert.equal(health.state, "HEALTHY");
      const selfTest = await module.selfTest();
      assert.equal(selfTest.ok, true);
    });
  });
});
