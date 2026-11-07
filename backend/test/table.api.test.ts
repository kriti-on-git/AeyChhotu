import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

/* API contract tests for the Table controller (phase 4).

   The real Express app is booted on an ephemeral port, but the Table service
   is a fake: these tests pin the HTTP surface (status codes, envelope, query
   parsing, validation errors and injected feedback), not SQL. Repository
   behaviour is covered by the integration suite. */

import { createApp } from "../src/app.js";
import type { TableServicePort } from "../src/modules/table/table.types.js";

const GRANTED = {
  table_id: "table-1",
  code: "k7x2p",
  name: "Window table",
  status: "active" as const,
  session_pin: "42",
  session_secret: "abcdefghijklmnopqrst",
  session_started_at: "2026-11-05T10:00:00.000Z",
  bill_status: "unrequested" as const,
  realtime_token: null,
  gemini_api_key: null,
};

class FakeTableService implements TableServicePort {
  readonly calls: Array<{ method: string; args: readonly unknown[] }> = [];

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }

  async requireTable(tableToken: string) {
    this.record("requireTable", [tableToken]);
    return { id: "table-1", code: tableToken, name: GRANTED.name, status: "active" };
  }

  async initializeSession(tableToken: string, options?: unknown) {
    this.record("initializeSession", [tableToken, options]);
    return GRANTED;
  }

  async joinWithPin(input: unknown) {
    this.record("joinWithPin", [input]);
    return GRANTED;
  }

  async joinWithPass(input: unknown) {
    this.record("joinWithPass", [input]);
    return GRANTED;
  }

  async reconnectSession(input: unknown) {
    this.record("reconnectSession", [input]);
    return GRANTED;
  }

  async getTableState(tableToken: string) {
    this.record("getTableState", [tableToken]);
    return {
      table_id: "table-1",
      code: tableToken,
      name: GRANTED.name,
      status: "active" as const,
      bill_status: "unrequested" as const,
      bill_requested_at: null,
      bill_paid_at: null,
      session_started_at: null,
      active_devices: 1,
      active_orders: 0,
    };
  }

  async listTableMembers(tableToken: string) {
    this.record("listTableMembers", [tableToken]);
    return [{ user_id: "u1", name: "Asha", joined_at: "2026-11-05T10:00:00.000Z" }];
  }

  async activeCheck(tableToken: string) {
    this.record("activeCheck", [tableToken]);
    return { has_active_order: false as const, message: "Ready for new order round initialization." };
  }

  async requestTableBill(tableToken: string) {
    this.record("requestTableBill", [tableToken]);
    return { table_id: "table-1", bill_status: "requested" as const, bill_requested_at: null };
  }

  async recordHeartbeat(tableToken: string, deviceId: string) {
    this.record("recordHeartbeat", [tableToken, deviceId]);
    return { table_id: "table-1", device_id: deviceId, last_seen: "2026-11-05T10:00:00.000Z" };
  }

  async removeHeartbeat(tableToken: string, deviceId: string) {
    this.record("removeHeartbeat", [tableToken, deviceId]);
    return { table_id: "table-1", device_id: deviceId, released: true };
  }

  async checkAndAutoReleaseTable(tableId: string) {
    this.record("checkAndAutoReleaseTable", [tableId]);
    return { released: false };
  }

  async clearTableSession(tableId: string, options: unknown) {
    this.record("clearTableSession", [tableId, options]);
    return { outcome: "cleared" as const, bill_status: "paid" as const, active_orders: 0, order_count: 0 };
  }
}

let server: Server;
let baseUrl = "";
let service: FakeTableService;
const feedback: Array<{ token: string; input: unknown }> = [];

before(async () => {
  service = new FakeTableService();
  const app = createApp({
    tableService: service,
    recordFeedback: async (tableToken, input) => {
      feedback.push({ token: tableToken, input });
      return { recorded: true };
    },
  });

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

describe("Table API — session entry points", () => {
  it("POST /initialize returns the granted envelope and forwards scan_time + member", async () => {
    const response = await call("POST", "/api/v1/sessions/initialize", {
      table_token: "k7x2p",
      scan_time: "2026-11-05T10:00:00.000Z",
      user_id: "u1",
      name: "Asha",
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.success, true);
    assert.equal(response.json.data.status, "active");
    assert.equal(response.json.data.code, "k7x2p");

    const callRecord = service.calls.find((entry) => entry.method === "initializeSession");
    assert.deepEqual(callRecord?.args[1], {
      scan_time: "2026-11-05T10:00:00.000Z",
      member: { user_id: "u1", name: "Asha" },
    });
  });

  it("rejects an invalid table token with the 400 VALIDATION_ERROR envelope", async () => {
    const response = await call("POST", "/api/v1/sessions/initialize", {
      table_token: "NOPE",
      name: "Asha",
    });

    assert.equal(response.status, 400);
    assert.equal(response.json.success, false);
    assert.equal(response.json.error.code, "VALIDATION_ERROR");
    assert.ok(response.json.error.fields.table_token);
  });

  it("POST /join-pin and /join-pass validate the credential shape", async () => {
    const pin = await call("POST", "/api/v1/sessions/join-pin", {
      table_token: "k7x2p",
      pin: "42",
      name: "Asha",
    });
    assert.equal(pin.status, 200);

    const badPin = await call("POST", "/api/v1/sessions/join-pin", {
      table_token: "k7x2p",
      pin: "4",
      name: "Asha",
    });
    assert.equal(badPin.status, 400);

    const pass = await call("POST", "/api/v1/sessions/join-pass", {
      table_token: "k7x2p",
      secret: "abcdefghijklmnopqrst",
      name: "Asha",
    });
    assert.equal(pass.status, 200);
  });

  it("POST /reconnect forwards the secret", async () => {
    const response = await call("POST", "/api/v1/sessions/reconnect", {
      table_token: "k7x2p",
      secret: "abcdefghijklmnopqrst",
      name: "Asha",
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.data.session_secret, GRANTED.session_secret);
  });
});

describe("Table API — table state and diner actions", () => {
  it("GET /:token, /members and /active-check answer the documented shapes", async () => {
    const state = await call("GET", "/api/v1/sessions/k7x2p");
    assert.equal(state.status, 200);
    assert.equal(state.json.data.active_devices, 1);

    const members = await call("GET", "/api/v1/sessions/k7x2p/members");
    assert.equal(members.status, 200);
    assert.equal(members.json.data[0].name, "Asha");

    const active = await call("GET", "/api/v1/sessions/k7x2p/active-check");
    assert.equal(active.status, 200);
    assert.equal(active.json.data.has_active_order, false);
  });

  it("bill-request and heartbeat round-trip", async () => {
    const bill = await call("POST", "/api/v1/sessions/k7x2p/bill-request");
    assert.equal(bill.status, 200);
    assert.equal(bill.json.data.bill_status, "requested");

    const beat = await call("POST", "/api/v1/sessions/k7x2p/heartbeat", {
      device_id: "device-1",
    });
    assert.equal(beat.status, 200);
    assert.equal(beat.json.data.device_id, "device-1");

    const release = await call("DELETE", "/api/v1/sessions/k7x2p/heartbeat", {
      device_id: "device-1",
    });
    assert.equal(release.status, 200);
    assert.equal(release.json.data.released, true);
  });

  it("POST /feedback is session-scoped and returns 201", async () => {
    const response = await call("POST", "/api/v1/sessions/k7x2p/feedback", {
      rating: 5,
      comment: "Lovely",
    });

    assert.equal(response.status, 201);
    assert.equal(response.json.success, true);
    assert.deepEqual(feedback.at(-1), {
      token: "k7x2p",
      input: { rating: 5, comment: "Lovely" },
    });
  });
});
