import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* KDS HTTP behaviour through the real app factory: unchanged paths, shift
   gate, status codes, envelopes and payload keys. The Kitchen service is a
   fake, so this pins HTTP + validation rather than SQL or Socket.IO. */

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { AppError } from "../src/errors/app-error.js";
import { buildMeta } from "../src/lib/util.js";
import { signToken } from "../src/lib/jwt.js";
import type {
  KitchenAdvanceResult,
  KitchenBoard,
  KitchenBoardParams,
  KitchenDenyResult,
  KitchenQueueSummary,
  KitchenServeResult,
  KitchenServicePort,
  ShiftActivation,
} from "../src/modules/kitchen/index.js";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeKitchenService implements KitchenServicePort {
  boardParams: KitchenBoardParams | null = null;
  accepted: string | null = null;
  ready: string | null = null;
  completed: string | null = null;
  denied: { id: string; reason: string } | null = null;
  armed: string | null = null;

  async getBoard(params: KitchenBoardParams): Promise<KitchenBoard> {
    this.boardParams = params;
    return {
      data: [
        {
          ticket_id: TICKET_ID,
          order_id: TICKET_ID,
          table: {
            id: TABLE_ID,
            code: "k7x2p",
            name: "Window",
            serve_requested_at: null,
          },
          status: "pending",
          created_at: "2026-01-01T10:00:00Z",
          items: [
            {
              menu_item_id: "33333333-3333-4333-8333-333333333333",
              name: "Masala Dosa",
              quantity: 2,
              request_note: "crisp",
              allergy_note: "peanut",
              added_by: "Asha",
              unit_price: 120,
            },
          ],
        },
      ],
      meta: buildMeta(params.page, params.limit, 1),
    };
  }

  async queue(): Promise<KitchenQueueSummary> {
    return {
      pending: 1,
      preparing: 0,
      ready: 0,
      active: 1,
      oldest_created_at: "2026-01-01T10:00:00Z",
    };
  }

  async acceptTicket(ticketId: string): Promise<KitchenAdvanceResult> {
    this.accepted = ticketId;
    if (ticketId === ADMIN_ID) {
      throw new AppError(409, "INVALID_STATUS_TRANSITION", "Ticket cannot move from ready to preparing.", {
        current_status: "ready",
        requested_status: "preparing",
      });
    }
    return { ticket_id: ticketId, order_id: ticketId, status: "preparing" };
  }

  async markTicketReady(ticketId: string): Promise<KitchenAdvanceResult> {
    this.ready = ticketId;
    return { ticket_id: ticketId, order_id: ticketId, status: "ready" };
  }

  async completeTicket(ticketId: string): Promise<KitchenServeResult> {
    this.completed = ticketId;
    return {
      ticket_id: ticketId,
      order_id: ticketId,
      status: "served",
      table_cleared: false,
    };
  }

  async denyTicket(ticketId: string, reason: string): Promise<KitchenDenyResult> {
    this.denied = { id: ticketId, reason };
    return {
      ticket_id: ticketId,
      order_id: ticketId,
      status: "denied",
      denial_reason: reason,
      table_cleared: false,
    };
  }

  async handleIncomingTicket(): Promise<void> {
    return undefined;
  }

  activateShift(deviceId: string): ShiftActivation {
    this.armed = deviceId;
    return {
      device_id: deviceId,
      audio_armed: true,
      message: "Audio chimes armed for this device. Incoming tickets will ping.",
    };
  }

  assistantKey(): string | null {
    return "test-live-key";
  }
}

let server: Server;
let baseUrl = "";
const service = new FakeKitchenService();
const now = Math.floor(Date.now() / 1000);

const kitchenToken = signToken(
  { role: "kitchen", terminal_id: null, iat: now, exp: now + 3600 },
  env.kdsTokenSecret,
);
const floorToken = signToken(
  { role: "floor", terminal_id: null, iat: now, exp: now + 3600 },
  env.kdsTokenSecret,
);

before(async () => {
  const app = createApp({ kitchenService: service });
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

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("Kitchen API — shift gate", () => {
  it("refuses the board without a shift token", async () => {
    const result = await call("GET", "/api/v1/kds/tickets");
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, "UNAUTHORIZED");
  });

  it("refuses a floor shift on the kitchen board", async () => {
    const result = await call("GET", "/api/v1/kds/tickets", { token: floorToken });
    assert.equal(result.status, 403);
    assert.equal(result.json.error.code, "FORBIDDEN");
  });
});

describe("Kitchen API — board and workflow", () => {
  it("returns the unchanged board payload", async () => {
    const result = await call("GET", "/api/v1/kds/tickets?status=pending&page=1&limit=20", {
      token: kitchenToken,
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.data[0].order_id, TICKET_ID);
    assert.equal(result.json.data[0].table.code, "k7x2p");
    assert.equal(result.json.data[0].items[0].allergy_note, "peanut");
    assert.equal(result.json.meta.total, 1);
    assert.deepEqual(service.boardParams, { status: "pending", page: 1, limit: 20 });
  });

  it("maps preparing to ticket acceptance with the legacy reply", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/status`, {
      token: kitchenToken,
      body: { status: "preparing" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data, { order_id: TICKET_ID, status: "preparing" });
    assert.equal(service.accepted, TICKET_ID);
  });

  it("maps ready to preparation completion", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/status`, {
      token: kitchenToken,
      body: { status: "ready" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data, { order_id: TICKET_ID, status: "ready" });
    assert.equal(service.ready, TICKET_ID);
  });

  it("completes via prune and reports table release", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/prune`, {
      token: kitchenToken,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data, {
      order_id: TICKET_ID,
      status: "served",
      table_cleared: false,
    });
    assert.equal(service.completed, TICKET_ID);
  });

  it("denies with the trimmed reason", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/deny`, {
      token: kitchenToken,
      body: { reason: "  Paneer ran out  " },
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.data.status, "denied");
    assert.equal(result.json.data.denial_reason, "Paneer ran out");
    assert.deepEqual(service.denied, { id: TICKET_ID, reason: "Paneer ran out" });
  });

  it("returns the 409 envelope for an invalid transition", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${ADMIN_ID}/status`, {
      token: kitchenToken,
      body: { status: "preparing" },
    });

    assert.equal(result.status, 409);
    assert.equal(result.json.error.code, "INVALID_STATUS_TRANSITION");
    assert.equal(result.json.error.current_status, "ready");
  });
});

describe("Kitchen API — validation", () => {
  it("rejects an unknown board column and a malformed ticket id", async () => {
    const status = await call("GET", "/api/v1/kds/tickets?status=served", {
      token: kitchenToken,
    });
    assert.equal(status.status, 400);
    assert.equal(status.json.error.code, "VALIDATION_ERROR");

    const id = await call("PATCH", "/api/v1/kds/tickets/not-a-uuid/status", {
      token: kitchenToken,
      body: { status: "preparing" },
    });
    assert.equal(id.status, 400);
    assert.equal(id.json.error.code, "VALIDATION_ERROR");
  });

  it("rejects a backward target and a blank denial reason", async () => {
    const target = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/status`, {
      token: kitchenToken,
      body: { status: "served" },
    });
    assert.equal(target.status, 400);

    const reason = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/deny`, {
      token: kitchenToken,
      body: { reason: "   " },
    });
    assert.equal(reason.status, 400);
    assert.ok(reason.json.error.fields.reason);
  });
});

describe("Kitchen API — shift and assistant key", () => {
  it("arms the device with the unchanged E13 payload", async () => {
    const result = await call("POST", "/api/v1/kds/shift/activate", {
      token: kitchenToken,
      body: { device_id: "tablet-7" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data, {
      device_id: "tablet-7",
      audio_armed: true,
      message: "Audio chimes armed for this device. Incoming tickets will ping.",
    });
    assert.equal(service.armed, "tablet-7");
  });

  it("releases the assistant key to the kitchen shift", async () => {
    const result = await call("GET", "/api/v1/kds/assistant/key", { token: kitchenToken });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data, { gemini_api_key: "test-live-key" });
  });

  it("refuses the assistant key without a kitchen shift", async () => {
    assert.equal((await call("GET", "/api/v1/kds/assistant/key")).status, 401);
    assert.equal(
      (await call("GET", "/api/v1/kds/assistant/key", { token: floorToken })).status,
      403,
    );
  });
});
