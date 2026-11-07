import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* Additive Billing HTTP surface through the real app factory: auth, exact
   envelopes, generated-bill payload and settlement result. The service is a
   fake, so this pins HTTP/validation, not SQL. */

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { AppError } from "../src/errors/app-error.js";
import { signToken } from "../src/lib/jwt.js";
import type {
  Bill,
  BillingServicePort,
  SettleBillResult,
} from "../src/modules/billing/index.js";

const TABLE_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

const bill: Bill = {
  bill_id: `${TABLE_ID}:2026-01-01T10:00:00.000Z`,
  table_id: TABLE_ID,
  table: { code: "k7x2p", name: "Window" },
  status: "requested",
  session_started_at: "2026-01-01T10:00:00.000Z",
  bill_requested_at: "2026-01-01T10:00:00.000Z",
  bill_paid_at: null,
  currency: "INR",
  line_items: [
    {
      order_id: ORDER_ID,
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      name: "Masala Dosa",
      quantity: 2,
      unit_price: "120.00",
      unit_price_minor: 12_000,
      line_total: "240.00",
      line_total_minor: 24_000,
      added_by: "Asha",
      allocated_to: "Asha",
      shared: false,
    },
  ],
  allocations: [
    {
      name: "Asha",
      shared: false,
      line_count: 1,
      quantity: 2,
      subtotal_minor: 24_000,
      subtotal: "240.00",
    },
  ],
  totals: {
    subtotal_minor: 24_000,
    tax_minor: 0,
    discount_minor: 0,
    total_minor: 24_000,
    subtotal: "240.00",
    tax: "0.00",
    discount: "0.00",
    total: "240.00",
  },
};

class FakeBillingService implements BillingServicePort {
  getCalls: string[] = [];
  settleCalls: string[] = [];

  async getBill(tableId: string): Promise<Bill> {
    this.getCalls.push(tableId);
    if (tableId === UNKNOWN_ID) {
      throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table id parsed.");
    }
    return bill;
  }

  async settleBill(tableId: string): Promise<SettleBillResult> {
    this.settleCalls.push(tableId);
    return {
      table_id: tableId,
      bill_status: "paid",
      bill_paid_at: "2026-01-01T11:00:00.000Z",
      released: false,
    };
  }
}

let server: Server;
let baseUrl = "";
const service = new FakeBillingService();
const now = Math.floor(Date.now() / 1000);

const floorToken = signToken(
  { role: "floor", terminal_id: null, iat: now, exp: now + 3600 },
  env.kdsTokenSecret,
);
const kitchenToken = signToken(
  { role: "kitchen", terminal_id: null, iat: now, exp: now + 3600 },
  env.kdsTokenSecret,
);
const guestToken = signToken(
  { role: "guest", terminal_id: null, iat: now, exp: now + 3600 },
  env.kdsTokenSecret,
);

before(async () => {
  const app = createApp({ billingService: service });
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

async function call(method: string, path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("Billing API — access", () => {
  it("refuses the bill without a shift token", async () => {
    const result = await call("GET", `/api/v1/billing/tables/${TABLE_ID}`);
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, "UNAUTHORIZED");
  });

  it("refuses a guest token", async () => {
    const result = await call("GET", `/api/v1/billing/tables/${TABLE_ID}`, guestToken);
    assert.equal(result.status, 403);
    assert.equal(result.json.error.code, "FORBIDDEN");
  });
});

describe("Billing API — generated bill", () => {
  it("returns the exact bill envelope for a floor shift", async () => {
    const result = await call("GET", `/api/v1/billing/tables/${TABLE_ID}`, floorToken);

    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.data.bill_id, bill.bill_id);
    assert.equal(result.json.data.table.code, "k7x2p");
    assert.equal(result.json.data.line_items[0].line_total, "240.00");
    assert.equal(result.json.data.allocations[0].name, "Asha");
    assert.equal(result.json.data.totals.total, "240.00");
    assert.deepEqual(service.getCalls, [TABLE_ID]);
  });

  it("lets the kitchen read the same bill", async () => {
    const result = await call("GET", `/api/v1/billing/tables/${TABLE_ID}`, kitchenToken);
    assert.equal(result.status, 200);
    assert.equal(result.json.data.currency, "INR");
  });

  it("rejects a malformed table id before calling the service", async () => {
    const before = service.getCalls.length;
    const result = await call("GET", "/api/v1/billing/tables/not-a-uuid", floorToken);

    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "VALIDATION_ERROR");
    assert.equal(service.getCalls.length, before);
  });

  it("passes through the module's TABLE_NOT_FOUND", async () => {
    const result = await call("GET", `/api/v1/billing/tables/${UNKNOWN_ID}`, floorToken);
    assert.equal(result.status, 404);
    assert.equal(result.json.error.code, "TABLE_NOT_FOUND");
  });
});

describe("Billing API — settlement", () => {
  it("returns the unchanged settle payload", async () => {
    const result = await call("PATCH", `/api/v1/billing/tables/${TABLE_ID}/settle`, floorToken);

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, {
      success: true,
      data: {
        table_id: TABLE_ID,
        bill_status: "paid",
        bill_paid_at: "2026-01-01T11:00:00.000Z",
        released: false,
      },
    });
    assert.deepEqual(service.settleCalls, [TABLE_ID]);
  });
});
