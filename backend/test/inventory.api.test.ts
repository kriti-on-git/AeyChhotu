import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* Additive Inventory HTTP surface through the real app factory: auth gates,
   exact envelopes, validation-before-service and the three write verbs. The
   service is a fake, so this pins HTTP/validation, not SQL. */

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { AppError } from "../src/errors/app-error.js";
import { signToken } from "../src/lib/jwt.js";
import type {
  AvailabilityRequest,
  AvailabilityResult,
  InventoryItem,
  InventoryMovement,
  InventoryServicePort,
  StockList,
} from "../src/modules/inventory/inventory.types.js";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

const item: InventoryItem = {
  menu_item_id: ITEM_ID,
  name: "Masala Dosa",
  category: "Main Course",
  is_available: true,
  stock_quantity: 4,
  low_stock_threshold: 5,
  state: "low",
  stock_updated_at: "2026-01-01T11:00:00Z",
};

const movement: InventoryMovement = {
  movement_id: "movement-1",
  menu_item_id: ITEM_ID,
  order_id: null,
  delta: -6,
  previous_quantity: 10,
  new_quantity: 4,
  reason: "manual",
  created_at: "2026-01-01T11:00:00Z",
};

class FakeInventoryService implements InventoryServicePort {
  calls: Array<{ method: string; args: readonly unknown[] }> = [];

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }

  async listStock(params: { state?: string }): Promise<StockList> {
    this.record("listStock", [params]);
    return {
      items: [item],
      summary: { tracked: 1, out: 0, low: 1, ok: 0, untracked: 0 },
    };
  }

  async getItem(menuItemId: string): Promise<InventoryItem> {
    this.record("getItem", [menuItemId]);
    if (menuItemId === UNKNOWN_ID) {
      throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
    }
    return item;
  }

  async listMovements(menuItemId: string, limit: number): Promise<InventoryMovement[]> {
    this.record("listMovements", [menuItemId, limit]);
    return [movement];
  }

  async setStock(menuItemId: string, input: unknown): Promise<InventoryItem> {
    this.record("setStock", [menuItemId, input]);
    return item;
  }

  async adjustStock(menuItemId: string, input: unknown): Promise<InventoryItem> {
    this.record("adjustStock", [menuItemId, input]);
    return item;
  }

  async restoreStock(menuItemId: string, input: unknown): Promise<InventoryItem> {
    this.record("restoreStock", [menuItemId, input]);
    return item;
  }

  async checkAvailability(
    requests: readonly AvailabilityRequest[],
  ): Promise<AvailabilityResult[]> {
    return requests.map((request) => ({
      menu_item_id: request.menu_item_id,
      name: "Masala Dosa",
      available: true,
      reason: null,
      stock_quantity: 4,
      requested: request.quantity ?? 1,
    }));
  }
}

let server: Server;
let baseUrl = "";
const service = new FakeInventoryService();
const now = Math.floor(Date.now() / 1000);

function token(role: string): string {
  return signToken(
    { role, terminal_id: null, iat: now, exp: now + 3600 },
    env.kdsTokenSecret,
  );
}

const floorToken = token("floor");
const kitchenToken = token("kitchen");
const adminToken = token("admin");
const guestToken = token("guest");

before(async () => {
  const app = createApp({ inventoryService: service });
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

async function call(method: string, path: string, body?: unknown, auth?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("Inventory API — access", () => {
  it("refuses the stock list without a shift token", async () => {
    const result = await call("GET", "/api/v1/inventory");
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, "UNAUTHORIZED");
  });

  it("refuses a guest token", async () => {
    const result = await call("GET", "/api/v1/inventory", undefined, guestToken);
    assert.equal(result.status, 403);
    assert.equal(result.json.error.code, "FORBIDDEN");
  });

  it("lets the kitchen read stock but not change it", async () => {
    const read = await call("GET", "/api/v1/inventory", undefined, kitchenToken);
    assert.equal(read.status, 200);

    const write = await call(
      "PATCH",
      `/api/v1/inventory/items/${ITEM_ID}`,
      { stock_quantity: 2 },
      kitchenToken,
    );
    assert.equal(write.status, 403);
  });

  it("lets the floor read stock but not change it", async () => {
    const read = await call("GET", "/api/v1/inventory/items/" + ITEM_ID, undefined, floorToken);
    assert.equal(read.status, 200);

    const write = await call(
      "POST",
      `/api/v1/inventory/items/${ITEM_ID}/adjustments`,
      { delta: -1, reason: "wastage" },
      floorToken,
    );
    assert.equal(write.status, 403);
  });
});

describe("Inventory API — reads", () => {
  it("returns the exact stock list envelope", async () => {
    const result = await call("GET", "/api/v1/inventory?state=low", undefined, adminToken);
    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.data.items[0].state, "low");
    assert.equal(result.json.data.summary.low, 1);
    assert.deepEqual(service.calls.at(-1), {
      method: "listStock",
      args: [{ state: "low" }],
    });
  });

  it("returns one item and its movement history", async () => {
    const single = await call("GET", `/api/v1/inventory/items/${ITEM_ID}`, undefined, adminToken);
    assert.equal(single.status, 200);
    assert.equal(single.json.data.menu_item_id, ITEM_ID);

    const history = await call(
      "GET",
      `/api/v1/inventory/items/${ITEM_ID}/movements?limit=5`,
      undefined,
      adminToken,
    );
    assert.equal(history.status, 200);
    assert.equal(history.json.data.count, 1);
    assert.equal(history.json.data.movements[0].delta, -6);
  });

  it("passes through MENU_ITEM_NOT_FOUND", async () => {
    const result = await call("GET", `/api/v1/inventory/items/${UNKNOWN_ID}`, undefined, adminToken);
    assert.equal(result.status, 404);
    assert.equal(result.json.error.code, "MENU_ITEM_NOT_FOUND");
  });

  it("rejects a malformed id before calling the service", async () => {
    const before = service.calls.length;
    const result = await call("GET", "/api/v1/inventory/items/not-a-uuid", undefined, adminToken);
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "VALIDATION_ERROR");
    assert.equal(service.calls.length, before);
  });
});

describe("Inventory API — admin writes", () => {
  it("sets an absolute count", async () => {
    const result = await call(
      "PATCH",
      `/api/v1/inventory/items/${ITEM_ID}`,
      { stock_quantity: 4, low_stock_threshold: 5 },
      adminToken,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(service.calls.at(-1), {
      method: "setStock",
      args: [ITEM_ID, { stock_quantity: 4, low_stock_threshold: 5 }],
    });
  });

  it("applies a signed adjustment", async () => {
    const result = await call(
      "POST",
      `/api/v1/inventory/items/${ITEM_ID}/adjustments`,
      { delta: -2, reason: "wastage", order_id: ORDER_ID },
      adminToken,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(service.calls.at(-1), {
      method: "adjustStock",
      args: [ITEM_ID, { delta: -2, reason: "wastage", order_id: ORDER_ID }],
    });
  });

  it("restores stock", async () => {
    const result = await call(
      "POST",
      `/api/v1/inventory/items/${ITEM_ID}/restore`,
      { quantity: 3 },
      adminToken,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(service.calls.at(-1), {
      method: "restoreStock",
      args: [ITEM_ID, { quantity: 3 }],
    });
  });

  it("rejects a zero adjustment before calling the service", async () => {
    const before = service.calls.length;
    const result = await call(
      "POST",
      `/api/v1/inventory/items/${ITEM_ID}/adjustments`,
      { delta: 0, reason: "manual" },
      adminToken,
    );
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "VALIDATION_ERROR");
    assert.equal(service.calls.length, before);
  });

  it("rejects a negative absolute count", async () => {
    const result = await call(
      "PATCH",
      `/api/v1/inventory/items/${ITEM_ID}`,
      { stock_quantity: -1 },
      adminToken,
    );
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "VALIDATION_ERROR");
  });
});
