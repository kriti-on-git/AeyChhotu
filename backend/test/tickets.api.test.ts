import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* KDS ticket HTTP behaviour through the real app factory: the shift gate, the
   unchanged paths, status codes and payloads, and the error envelope. The
   service is a fake so this pins HTTP + validation rather than SQL. */

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { AppError } from "../src/errors/app-error.js";
import { buildMeta } from "../src/lib/util.js";
import { signToken } from "../src/lib/jwt.js";
import type {
  TicketDenyResult,
  TicketDetail,
  TicketListParams,
  TicketServeResult,
  TicketServicePort,
  TicketAdvanceResult,
} from "../src/modules/tickets/tickets.types.js";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";

class FakeTicketsService implements TicketServicePort {
  listParams: TicketListParams | null = null;
  advanced: { ticketId: string; target: string } | null = null;
  pruned: string | null = null;
  denied: { ticketId: string; reason: string } | null = null;

  async listTickets(params: TicketListParams) {
    this.listParams = params;
    return {
      data: [
        {
          ticket_id: TICKET_ID,
          order_id: TICKET_ID,
          table: { id: TABLE_ID, code: "k7x2p", name: "Window", serve_requested_at: null },
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

  async getTicket(ticketId: string): Promise<TicketDetail> {
    if (ticketId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
      throw new AppError(404, "ORDER_NOT_FOUND", "That ticket no longer exists.");
    }
    return {
      ticket_id: ticketId,
      order_id: ticketId,
      table: { id: TABLE_ID, code: "k7x2p", name: "Window", serve_requested_at: null },
      status: "pending",
      created_at: "2026-01-01T10:00:00Z",
      items: [],
      denial_reason: "",
    };
  }

  async advanceTicket(ticketId: string, target: "preparing" | "ready"): Promise<TicketAdvanceResult> {
    this.advanced = { ticketId, target };
    if (ticketId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
      throw new AppError(409, "INVALID_STATUS_TRANSITION", "Ticket cannot move from ready to preparing.", {
        current_status: "ready",
        requested_status: target,
      });
    }
    return { ticket_id: ticketId, order_id: ticketId, status: target };
  }

  async pruneTicket(ticketId: string): Promise<TicketServeResult> {
    this.pruned = ticketId;
    return { ticket_id: ticketId, order_id: ticketId, status: "served", table_cleared: false };
  }

  async denyTicket(ticketId: string, reason: string): Promise<TicketDenyResult> {
    this.denied = { ticketId, reason };
    return {
      ticket_id: ticketId,
      order_id: ticketId,
      status: "denied",
      denial_reason: reason,
      table_cleared: false,
    };
  }
}

let server: Server;
let baseUrl = "";
const service = new FakeTicketsService();
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
  const app = createApp({ ticketsService: service });
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

describe("Tickets API — shift gate", () => {
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

describe("Tickets API — board and lifecycle", () => {
  it("returns the active board with the legacy payload", async () => {
    const result = await call("GET", "/api/v1/kds/tickets?status=pending&page=1&limit=20", {
      token: kitchenToken,
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.data[0].order_id, TICKET_ID);
    assert.equal(result.json.data[0].table.code, "k7x2p");
    assert.equal(result.json.data[0].items[0].allergy_note, "peanut");
    assert.equal(result.json.data[0].items[0].unit_price, 120);
    assert.equal(result.json.meta.total, 1);
    assert.deepEqual(service.listParams, { status: "pending", page: 1, limit: 20 });
  });

  it("advances a ticket and answers the unchanged shape", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/status`, {
      token: kitchenToken,
      body: { status: "preparing" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data, { order_id: TICKET_ID, status: "preparing" });
    assert.deepEqual(service.advanced, { ticketId: TICKET_ID, target: "preparing" });
  });

  it("serves a ticket and reports whether the table was cleared", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/prune`, {
      token: kitchenToken,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data, {
      order_id: TICKET_ID,
      status: "served",
      table_cleared: false,
    });
    assert.equal(service.pruned, TICKET_ID);
  });

  it("denies a ticket with a mandatory reason", async () => {
    const result = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/deny`, {
      token: kitchenToken,
      body: { reason: "  Paneer ran out  " },
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.data.status, "denied");
    assert.equal(result.json.data.denial_reason, "Paneer ran out");
    assert.deepEqual(service.denied, { ticketId: TICKET_ID, reason: "Paneer ran out" });
  });

  it("returns the 409 envelope with the current status", async () => {
    const result = await call(
      "PATCH",
      "/api/v1/kds/tickets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/status",
      { token: kitchenToken, body: { status: "preparing" } },
    );

    assert.equal(result.status, 409);
    assert.equal(result.json.error.code, "INVALID_STATUS_TRANSITION");
    assert.equal(result.json.error.current_status, "ready");
  });
});

describe("Tickets API — validation", () => {
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
    assert.equal(target.json.error.code, "VALIDATION_ERROR");

    const reason = await call("PATCH", `/api/v1/kds/tickets/${TICKET_ID}/deny`, {
      token: kitchenToken,
      body: { reason: "   " },
    });
    assert.equal(reason.status, 400);
    assert.equal(reason.json.error.code, "VALIDATION_ERROR");
    assert.ok(reason.json.error.fields.reason);
  });
});
