import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* Orders HTTP behaviour through the real app factory: paths, methods, status
   codes and envelopes are pinned to the legacy contract. The service is a
   fake, so this pins HTTP + validation rather than SQL. */

import { createApp } from "../src/app.js";
import { AppError } from "../src/errors/app-error.js";
import { buildMeta } from "../src/lib/util.js";
import type {
  DismissedDeniedOrder,
  FiredOrder,
  OrdersListParams,
  OrdersServicePort,
  OrderStatus,
  RequeuedDeniedOrder,
  RetriedDeniedOrder,
} from "../src/modules/orders/orders.types.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";

class FakeOrdersService implements OrdersServicePort {
  fired: string | null = null;
  listParams: OrdersListParams | null = null;
  statusArgs: { orderId: string; tableToken: string } | null = null;
  requeued: { orderId: string; tableToken: string } | null = null;
  retried: { orderId: string; tableToken: string } | null = null;
  dismissed: { orderId: string; tableToken: string } | null = null;

  async fireOrder(tableToken: string): Promise<FiredOrder> {
    this.fired = tableToken;
    if (tableToken === "dupe") {
      throw new AppError(409, "DUPLICATE_ORDER", "Order already sent", {
        order_id: ORDER_ID,
        status: "pending",
      });
    }
    if (tableToken === "none") {
      throw new AppError(409, "EMPTY_CART", "The table cart is empty — nothing to fire.");
    }
    return {
      order_id: ORDER_ID,
      table_id: TABLE_ID,
      status: "pending",
      created_at: "2026-01-01T10:00:00Z",
      message: "Order successfully routed to KDS line.",
    };
  }

  async getOrderStatus(orderId: string, tableToken: string): Promise<OrderStatus> {
    this.statusArgs = { orderId, tableToken };
    return {
      order_id: orderId,
      table_id: TABLE_ID,
      status: "preparing",
      created_at: "2026-01-01T10:00:00Z",
    };
  }

  async listOrders(params: OrdersListParams) {
    this.listParams = params;
    return {
      data: [
        {
          order_id: ORDER_ID,
          table_id: TABLE_ID,
          status: "served",
          created_at: "2026-01-01T10:00:00Z",
          denial_reason: "",
          total: 240,
          items: [
            {
              menu_item_id: "33333333-3333-4333-8333-333333333333",
              name: "Dosa",
              quantity: 2,
              request_note: "",
              allergy_note: "",
              added_by: "Asha",
              unit_price: 120,
            },
          ],
        },
      ],
      meta: buildMeta(params.page, params.limit, 1),
    };
  }

  async denyPendingOrdersForItem(): Promise<number> {
    return 0;
  }

  async requeueDeniedOrder(orderId: string, tableToken: string): Promise<RequeuedDeniedOrder> {
    this.requeued = { orderId, tableToken };
    return { order_id: orderId, moved: 1, omitted: [] };
  }

  async retryDeniedOrder(orderId: string, tableToken: string): Promise<RetriedDeniedOrder> {
    this.retried = { orderId, tableToken };
    return {
      order_id: orderId,
      table_id: TABLE_ID,
      status: "pending",
      created_at: "2026-01-01T10:00:00Z",
      moved: 1,
      omitted: [],
    };
  }

  async dismissDeniedOrder(orderId: string, tableToken: string): Promise<DismissedDeniedOrder> {
    this.dismissed = { orderId, tableToken };
    return { order_id: orderId, dismissed: true };
  }
}

let server: Server;
let baseUrl = "";
const service = new FakeOrdersService();

before(async () => {
  const app = createApp({ ordersService: service });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("Orders API — fire", () => {
  it("creates an order from a valid table token", async () => {
    const result = await call("POST", "/api/v1/orders/fire", { table_token: "k7x2p" });

    assert.equal(result.status, 201);
    assert.equal(result.json.success, true);
    assert.equal(result.json.data.order_id, ORDER_ID);
    assert.equal(result.json.data.status, "pending");
    assert.equal(service.fired, "k7x2p");
  });

  it("returns 409 DUPLICATE_ORDER with the active ticket", async () => {
    const result = await call("POST", "/api/v1/orders/fire", { table_token: "dupe" });

    assert.equal(result.status, 409);
    assert.equal(result.json.success, false);
    assert.equal(result.json.error.code, "DUPLICATE_ORDER");
    assert.equal(result.json.error.order_id, ORDER_ID);
  });

  it("returns 409 EMPTY_CART", async () => {
    const result = await call("POST", "/api/v1/orders/fire", { table_token: "none" });

    assert.equal(result.status, 409);
    assert.equal(result.json.error.code, "EMPTY_CART");
  });

  it("rejects a malformed token before the service", async () => {
    const result = await call("POST", "/api/v1/orders/fire", { table_token: "BAD TOKEN" });

    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "VALIDATION_ERROR");
    assert.ok(result.json.error.fields.table_token);
  });
});

describe("Orders API — history, status and denied rounds", () => {
  it("lists history with pagination metadata", async () => {
    const result = await call("GET", "/api/v1/orders?table_token=k7x2p&page=1&limit=20");

    assert.equal(result.status, 200);
    assert.equal(result.json.data[0].items[0].unit_price, 120);
    assert.equal(result.json.meta.total, 1);
    assert.deepEqual(service.listParams, { table_token: "k7x2p", page: 1, limit: 20 });
  });

  it("polls status scoped to the caller's table", async () => {
    const result = await call(
      "GET",
      `/api/v1/orders/${ORDER_ID}/status?table_token=k7x2p`,
    );

    assert.equal(result.status, 200);
    assert.equal(result.json.data.status, "preparing");
    assert.deepEqual(service.statusArgs, { orderId: ORDER_ID, tableToken: "k7x2p" });
  });

  it("requeues, retries and dismisses with the documented codes", async () => {
    const requeue = await call(
      "POST",
      `/api/v1/orders/${ORDER_ID}/requeue?table_token=k7x2p`,
    );
    assert.equal(requeue.status, 200);
    assert.deepEqual(requeue.json.data, { order_id: ORDER_ID, moved: 1, omitted: [] });

    const retry = await call("POST", `/api/v1/orders/${ORDER_ID}/retry?table_token=k7x2p`);
    assert.equal(retry.status, 201);
    assert.equal(retry.json.data.status, "pending");

    const dismiss = await call(
      "POST",
      `/api/v1/orders/${ORDER_ID}/dismiss?table_token=k7x2p`,
    );
    assert.equal(dismiss.status, 200);
    assert.deepEqual(dismiss.json.data, { order_id: ORDER_ID, dismissed: true });

    assert.deepEqual(service.requeued, { orderId: ORDER_ID, tableToken: "k7x2p" });
    assert.deepEqual(service.retried, { orderId: ORDER_ID, tableToken: "k7x2p" });
    assert.deepEqual(service.dismissed, { orderId: ORDER_ID, tableToken: "k7x2p" });
  });

  it("rejects a non-UUID order id and a missing token", async () => {
    const badId = await call("GET", "/api/v1/orders/not-a-uuid/status?table_token=k7x2p");
    assert.equal(badId.status, 400);
    assert.equal(badId.json.error.code, "VALIDATION_ERROR");

    const noToken = await call("GET", `/api/v1/orders/${ORDER_ID}/status`);
    assert.equal(noToken.status, 400);
    assert.equal(noToken.json.error.code, "VALIDATION_ERROR");
  });
});
