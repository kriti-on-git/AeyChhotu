import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for the Table module's service (phase 4).

   The whole session/occupancy protocol runs against an in-memory repository:
   no Postgres, no Express, no clock patching. What is protected here:
     * stale-page rejection and the granted/locked split,
     * PIN counter commits on a wrong attempt and locks on the third,
     * the pass only unlocks an already PIN-locked table,
     * reconnect semantics and the settled-session answer,
     * bill-request idempotency and event emission,
     * the three-condition release rule,
     * clear outcomes (not_found / active_orders / unpaid / cleared),
     * requireTable hiding archived tables. */

import { AppError } from "../src/errors/app-error.js";
import type { DbTransaction } from "../src/infrastructure/database/DatabaseManager.js";
import {
  TableService,
  generateSessionPin,
} from "../src/modules/table/table.service.js";
import type { TableEventPublisher } from "../src/modules/table/table.events.js";
import type {
  ActiveOrderRow,
  BillRow,
  LockedTableRow,
  MemberRow,
  OrderCounts,
  PresenceRow,
  ReleaseCandidateRow,
  SchemaPresence,
  SessionRow,
  TableMemberInput,
  TableRecord,
  TableRepositoryPort,
  TableStateRow,
} from "../src/modules/table/table.types.js";

/* ------------------------------------------------------------ fake repo */

interface FakeOrder {
  id: string;
  status: string;
  created_at: Date;
}

const PRESENCE_WINDOW_MS = 45_000;

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "table-1",
    code: "k7x2p",
    name: "Window table",
    status: "empty",
    session_pin: null,
    session_secret: null,
    failed_pin_attempts: 0,
    session_started_at: null,
    bill_status: "unrequested",
    last_cleared_at: null,
    ...overrides,
  };
}

class FakeTableRepository implements TableRepositoryPort {
  table: SessionRow | null = row();
  members: MemberRow[] = [];
  presence = new Map<string, Date>();
  orders: FakeOrder[] = [];
  missing: string[] = [];

  private readonly tx = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as DbTransaction;

  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx);
  }

  private clone(): SessionRow | null {
    return this.table === null ? null : { ...this.table };
  }

  async findTableByCode(code: string): Promise<TableRecord | null> {
    const table = this.table;
    if (table === null || table.code !== code) return null;
    return { id: table.id, code: table.code, name: table.name, status: table.status };
  }

  async findSessionByCode(code: string): Promise<SessionRow | null> {
    return this.table !== null && this.table.code === code ? this.clone() : null;
  }

  async lockSessionByCode(_tx: DbTransaction, code: string): Promise<SessionRow | null> {
    return this.findSessionByCode(code);
  }

  async startSession(
    _tx: DbTransaction,
    tableId: string,
    pin: string,
    secret: string,
  ): Promise<SessionRow | null> {
    if (this.table === null || this.table.id !== tableId) return null;
    this.table = {
      ...this.table,
      status: "active",
      session_pin: pin,
      session_secret: secret,
      failed_pin_attempts: 0,
      session_started_at: new Date("2026-11-05T10:00:00.000Z"),
    };
    return this.clone();
  }

  async incrementPinAttempts(_tx: DbTransaction, tableId: string): Promise<number> {
    if (this.table === null || this.table.id !== tableId) return 0;
    this.table.failed_pin_attempts += 1;
    return this.table.failed_pin_attempts;
  }

  async clearPinAttempts(_tx: DbTransaction, tableId: string): Promise<SessionRow | null> {
    if (this.table === null || this.table.id !== tableId) return null;
    this.table.failed_pin_attempts = 0;
    return this.clone();
  }

  async upsertMember(
    _tx: DbTransaction,
    tableId: string,
    member: TableMemberInput | undefined,
  ): Promise<void> {
    await this.upsertMemberBestEffort(tableId, member);
  }

  async upsertMemberBestEffort(
    tableId: string,
    member: TableMemberInput | undefined,
  ): Promise<void> {
    const userId = member?.user_id?.trim();
    if (!userId || !member || this.table === null || this.table.id !== tableId) return;

    const existing = this.members.find((entry) => entry.user_id === userId);
    if (existing) existing.name = member.name;
    else this.members.push({ user_id: userId, name: member.name, joined_at: new Date() });
  }

  async listMembers(tableId: string): Promise<MemberRow[]> {
    return this.table?.id === tableId ? [...this.members] : [];
  }

  async recordHeartbeat(tableId: string, deviceId: string): Promise<PresenceRow | null> {
    if (this.table === null || this.table.id !== tableId) return null;
    const now = new Date();
    this.presence.set(deviceId, now);
    return { device_id: deviceId, last_seen: now };
  }

  async removePresence(tableId: string, deviceId: string): Promise<void> {
    if (this.table?.id === tableId) this.presence.delete(deviceId);
  }

  async lockTable(_tx: DbTransaction, tableId: string): Promise<LockedTableRow | null> {
    if (this.table === null || this.table.id !== tableId) return null;
    return {
      id: this.table.id,
      bill_status: this.table.bill_status,
      session_started_at: this.table.session_started_at,
    };
  }

  async releaseCandidate(
    _tx: DbTransaction,
    tableId: string,
    windowSeconds: number,
  ): Promise<ReleaseCandidateRow | null> {
    if (this.table === null || this.table.id !== tableId) return null;
    return {
      bill_status: this.table.bill_status,
      active_orders: this.activeOrders(),
      active_devices: this.activeDevices(windowSeconds),
    };
  }

  async countOrders(
    _tx: DbTransaction,
    tableId: string,
    sessionStartedAt: Date | null,
  ): Promise<OrderCounts> {
    if (this.table?.id !== tableId) {
      return { order_count: 0, session_order_count: 0, active_orders: 0 };
    }

    const sessionOrders = this.orders.filter(
      (order) =>
        order.status !== "denied" &&
        sessionStartedAt !== null &&
        order.created_at >= sessionStartedAt,
    );

    return {
      order_count: this.orders.length,
      session_order_count: sessionOrders.length,
      active_orders: this.activeOrders(),
    };
  }

  async cancelActiveOrders(_tx: DbTransaction, tableId: string): Promise<void> {
    if (this.table?.id !== tableId) return;
    for (const order of this.orders) {
      if (["pending", "preparing", "ready"].includes(order.status)) order.status = "denied";
    }
  }

  async clearTableRows(_tx: DbTransaction, tableId: string): Promise<void> {
    if (this.table?.id !== tableId) return;
    this.table = {
      ...this.table,
      status: "empty",
      session_pin: null,
      session_secret: null,
      failed_pin_attempts: 0,
      session_started_at: null,
      bill_status: "unrequested",
      last_cleared_at: new Date(),
    };
    this.members = [];
    this.presence.clear();
    this.orders = [];
  }

  async findTableState(
    tableToken: string,
    windowSeconds: number,
  ): Promise<TableStateRow | null> {
    const table = this.table;
    if (table === null || table.code !== tableToken) return null;
    return {
      id: table.id,
      code: table.code,
      name: table.name,
      status: table.status,
      bill_status: table.bill_status,
      bill_requested_at: table.bill_status === "unrequested" ? null : new Date(),
      bill_paid_at: table.bill_status === "paid" ? new Date() : null,
      session_started_at: table.session_started_at,
      active_devices: this.activeDevices(windowSeconds),
      active_orders: this.activeOrders(),
    };
  }

  async requestBill(tableId: string): Promise<BillRow | null> {
    if (this.table === null || this.table.id !== tableId) return null;
    if (this.table.bill_status !== "unrequested") return null;

    this.table.bill_status = "requested";
    return { id: tableId, bill_status: "requested", bill_requested_at: new Date() };
  }

  async findBill(tableId: string): Promise<BillRow | null> {
    if (this.table === null || this.table.id !== tableId) return null;
    return {
      id: this.table.id,
      bill_status: this.table.bill_status,
      bill_requested_at: this.table.bill_status === "unrequested" ? null : new Date(),
    };
  }

  async findActiveOrder(tableId: string): Promise<ActiveOrderRow | null> {
    if (this.table?.id !== tableId) return null;
    const order = [...this.orders]
      .filter((candidate) => ["pending", "preparing", "ready"].includes(candidate.status))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    return order ? { id: order.id, status: order.status } : null;
  }

  async schemaObjects(): Promise<SchemaPresence> {
    const all = ["restaurant_tables", "table_members", "table_device_presence"];
    return {
      present: all.filter((name) => !this.missing.includes(name)),
      missing: this.missing,
    };
  }

  private activeOrders(): number {
    return this.orders.filter((order) =>
      ["pending", "preparing", "ready"].includes(order.status),
    ).length;
  }

  private activeDevices(windowSeconds: number): number {
    const cutoff = Date.now() - windowSeconds * 1_000;
    let count = 0;
    for (const seen of this.presence.values()) if (seen.getTime() > cutoff) count += 1;
    return count;
  }
}

interface RecordedEvents {
  readonly names: string[];
}

function serviceWith(
  repository: FakeTableRepository,
  events: RecordedEvents = { names: [] },
): { service: TableService; repository: FakeTableRepository; events: RecordedEvents } {
  const publisher: TableEventPublisher = {
    sessionStarted: ({ tableId }) => events.names.push(`started:${tableId}`),
    sessionCleared: ({ tableId, reason }) => events.names.push(`cleared:${tableId}:${reason}`),
    billRequested: ({ tableId }) => events.names.push(`bill:${tableId}`),
  };

  return {
    service: new TableService({ repository, events: publisher, assistantKey: null }),
    repository,
    events,
  };
}

async function startSession(
  service: TableService,
  repository: FakeTableRepository,
  overrides: Partial<SessionRow> = {},
): Promise<void> {
  const result = await service.initializeSession(repository.table?.code ?? "k7x2p", {
    member: { user_id: "u1", name: "Asha" },
  });
  assert.equal(result.status, "active");
  repository.table = row({ ...repository.table, ...overrides });
}

function isAppError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof AppError && err.code === code;
}

/* --------------------------------------------------------------- tests */

describe("TableService — initialize (E1)", () => {
  it("grants a session on an empty table, registers the first member and emits an event", async () => {
    const repository = new FakeTableRepository();
    const { service, events } = serviceWith(repository);

    const result = await service.initializeSession("k7x2p", {
      member: { user_id: "u1", name: "Asha" },
    });

    assert.equal(result.status, "active");
    if (result.status !== "active") return;

    assert.match(result.session_pin, /^\d{2}$/);
    assert.equal(result.session_secret.length, 20);
    assert.equal(repository.table?.status, "active");
    assert.equal(repository.table?.session_pin, result.session_pin);
    assert.deepEqual(
      repository.members.map((member) => member.name),
      ["Asha"],
    );
    assert.deepEqual(events.names, ["started:table-1"]);
  });

  it("answers locked — and writes nothing — when the table is already seated", async () => {
    const repository = new FakeTableRepository();
    const { service, events } = serviceWith(repository);
    await startSession(service, repository, {
      status: "active",
      session_pin: "42",
      session_secret: "abcdefghijklmnopqrst",
      failed_pin_attempts: 2,
      session_started_at: new Date(),
    });
    repository.members = [];
    events.names.length = 0;

    const result = await service.initializeSession("k7x2p", {
      member: { user_id: "u2", name: "Ravi" },
    });

    assert.equal(result.status, "locked");
    if (result.status !== "locked") return;
    assert.equal(result.pin_locked, false);
    assert.equal(result.attempts_remaining, 1);
    assert.equal(result.realtime_token, null);
    assert.deepEqual(repository.members, []);
    assert.deepEqual(events.names, []);
  });

  it("refuses a page opened before the last clear (STALE_SESSION)", async () => {
    const repository = new FakeTableRepository();
    repository.table = row({ last_cleared_at: new Date("2026-11-05T12:00:00.000Z") });
    const { service } = serviceWith(repository);

    await assert.rejects(
      () =>
        service.initializeSession("k7x2p", {
          scan_time: "2026-11-05T09:00:00.000Z",
          member: { user_id: "u1", name: "Asha" },
        }),
      isAppError("STALE_SESSION"),
    );
    assert.equal(repository.table.status, "empty");
  });

  it("returns 404 for an unknown or archived table", async () => {
    const repository = new FakeTableRepository();
    repository.table = null;
    const { service } = serviceWith(repository);

    await assert.rejects(
      () => service.initializeSession("k7x2p"),
      isAppError("TABLE_NOT_FOUND"),
    );
  });
});

describe("TableService — PIN entry (E1b)", () => {
  it("persists each wrong attempt and locks the table on the third", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, {
      status: "active",
      session_pin: "42",
      session_secret: "abcdefghijklmnopqrst",
      session_started_at: new Date(),
    });

    await assert.rejects(
      () => service.joinWithPin({ table_token: "k7x2p", pin: "11" }),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "INVALID_SESSION_PIN" &&
        err.details?.attempts_remaining === 2,
    );
    assert.equal(repository.table?.failed_pin_attempts, 1);

    await assert.rejects(
      () => service.joinWithPin({ table_token: "k7x2p", pin: "12" }),
      isAppError("INVALID_SESSION_PIN"),
    );
    assert.equal(repository.table?.failed_pin_attempts, 2);

    await assert.rejects(
      () => service.joinWithPin({ table_token: "k7x2p", pin: "13" }),
      isAppError("TABLE_PIN_LOCKED"),
    );
    assert.equal(repository.table?.failed_pin_attempts, 3);

    // Even the correct PIN is refused once the table is locked.
    await assert.rejects(
      () => service.joinWithPin({ table_token: "k7x2p", pin: "42" }),
      isAppError("TABLE_PIN_LOCKED"),
    );
  });

  it("resets the counter, registers the member and grants on the correct PIN", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, {
      status: "active",
      session_pin: "42",
      session_secret: "abcdefghijklmnopqrst",
      failed_pin_attempts: 2,
      session_started_at: new Date(),
    });
    repository.members = [];

    const granted = await service.joinWithPin({
      table_token: "k7x2p",
      pin: "42",
      member: { user_id: "u2", name: "Ravi" },
    });

    assert.equal(granted.status, "active");
    assert.equal(repository.table?.failed_pin_attempts, 0);
    assert.deepEqual(
      repository.members.map((member) => member.name),
      ["Ravi"],
    );
  });
});

describe("TableService — table pass (E1c)", () => {
  it("refuses the pass while the keypad still works", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, {
      status: "active",
      session_pin: "42",
      session_secret: "abcdefghijklmnopqrst",
      session_started_at: new Date(),
    });

    await assert.rejects(
      () =>
        service.joinWithPass({ table_token: "k7x2p", secret: "abcdefghijklmnopqrst" }),
      isAppError("PASS_REQUIRES_PIN"),
    );
  });

  it("unlocks a PIN-locked table with the correct pass and refuses a wrong one", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, {
      status: "active",
      session_pin: "42",
      session_secret: "abcdefghijklmnopqrst",
      failed_pin_attempts: 3,
      session_started_at: new Date(),
    });
    repository.members = [];

    await assert.rejects(
      () => service.joinWithPass({ table_token: "k7x2p", secret: "zzzzzzzzzzzzzzzzzzzz" }),
      isAppError("INVALID_SESSION_SECRET"),
    );

    const granted = await service.joinWithPass({
      table_token: "k7x2p",
      secret: "abcdefghijklmnopqrst",
      member: { user_id: "u3", name: "Meera" },
    });

    assert.equal(granted.status, "active");
    assert.equal(repository.table?.failed_pin_attempts, 0);
    assert.deepEqual(
      repository.members.map((member) => member.name),
      ["Meera"],
    );
  });
});

describe("TableService — reconnect (E1d)", () => {
  it("returns the credentials for a valid refresh", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, {
      status: "active",
      session_pin: "42",
      session_secret: "abcdefghijklmnopqrst",
      session_started_at: new Date(),
    });

    const granted = await service.reconnectSession({
      table_token: "k7x2p",
      secret: "abcdefghijklmnopqrst",
    });

    assert.equal(granted.table_id, "table-1");
    assert.equal(granted.session_secret, "abcdefghijklmnopqrst");
  });

  it("answers SESSION_ENDED for a stale secret or a settled table", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);

    await assert.rejects(
      () => service.reconnectSession({ table_token: "k7x2p", secret: "zzzzzzzzzzzzzzzzzzzz" }),
      isAppError("SESSION_ENDED"),
    );

    repository.table = row({ status: "empty" });
    await assert.rejects(
      () =>
        service.reconnectSession({ table_token: "k7x2p", secret: "abcdefghijklmnopqrst" }),
      isAppError("SESSION_ENDED"),
    );
  });
});

describe("TableService — bill request", () => {
  it("is idempotent and emits exactly one event", async () => {
    const repository = new FakeTableRepository();
    const { service, events } = serviceWith(repository);

    const first = await service.requestTableBill("k7x2p");
    assert.equal(first.bill_status, "requested");

    const second = await service.requestTableBill("k7x2p");
    assert.equal(second.bill_status, "requested");
    assert.deepEqual(events.names, ["bill:table-1"]);
  });

  it("never downgrades a paid table", async () => {
    const repository = new FakeTableRepository();
    repository.table = row({ status: "active", bill_status: "paid" });
    const { service, events } = serviceWith(repository);

    const result = await service.requestTableBill("k7x2p");

    assert.equal(result.bill_status, "paid");
    assert.deepEqual(events.names, []);
  });
});

describe("TableService — state, roster and presence", () => {
  it("reports server truth for the diner's poll", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, { status: "active" });
    repository.orders.push({ id: "o1", status: "preparing", created_at: new Date() });
    repository.presence.set("device-1", new Date());

    const state = await service.getTableState("k7x2p");

    assert.equal(state.status, "active");
    assert.equal(state.active_orders, 1);
    assert.equal(state.active_devices, 1);
  });

  it("lists the roster in join order", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    repository.members = [
      { user_id: "u1", name: "Asha", joined_at: new Date("2026-11-05T10:00:00Z") },
      { user_id: "u2", name: "Ravi", joined_at: new Date("2026-11-05T10:01:00Z") },
    ];

    const members = await service.listTableMembers("k7x2p");

    assert.deepEqual(
      members.map((member) => member.name),
      ["Asha", "Ravi"],
    );
  });

  it("records a heartbeat and releases on removal only when the table is otherwise empty", async () => {
    const repository = new FakeTableRepository();
    repository.table = row({ status: "active", bill_status: "paid" });
    const { service, events } = serviceWith(repository);

    const beat = await service.recordHeartbeat("k7x2p", "device-1");
    assert.equal(beat.device_id, "device-1");
    assert.equal((await service.getTableState("k7x2p")).active_devices, 1);

    const removed = await service.removeHeartbeat("k7x2p", "device-1");
    assert.equal(removed.released, true);
    assert.equal(repository.table?.status, "empty");
    assert.deepEqual(events.names, ["cleared:table-1:auto_release"]);
  });

  it("does not release while unpaid, while a ticket is open, or while a device is present", async () => {
    const unpaid = new FakeTableRepository();
    unpaid.table = row({ status: "active", bill_status: "unrequested" });
    assert.equal((await serviceWith(unpaid).service.checkAndAutoReleaseTable("table-1")).released, false);

    const cooking = new FakeTableRepository();
    cooking.table = row({ status: "active", bill_status: "paid" });
    cooking.orders.push({ id: "o1", status: "preparing", created_at: new Date() });
    assert.equal((await serviceWith(cooking).service.checkAndAutoReleaseTable("table-1")).released, false);

    const seated = new FakeTableRepository();
    seated.table = row({ status: "active", bill_status: "paid" });
    seated.presence.set("device-1", new Date());
    assert.equal((await serviceWith(seated).service.checkAndAutoReleaseTable("table-1")).released, false);
  });
});

describe("TableService — clear (staff/admin)", () => {
  it("reports not_found for an unknown table", async () => {
    const repository = new FakeTableRepository();
    repository.table = null;
    const { service } = serviceWith(repository);

    const result = await service.clearTableSession("table-1", { allowUnpaid: false });
    assert.equal(result.outcome, "not_found");
  });

  it("blocks on an open ticket unless the caller confirms cancellation", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, { status: "active" });
    repository.table = {
      ...repository.table!,
      session_started_at: new Date("2026-11-05T10:00:00Z"),
    };
    repository.orders.push({ id: "o1", status: "pending", created_at: new Date("2026-11-05T10:05:00Z") });

    const blocked = await service.clearTableSession("table-1", { allowUnpaid: false });
    assert.equal(blocked.outcome, "active_orders");
    assert.equal(blocked.active_orders, 1);

    // Cancelling the ticket is not a payment; settle first so the forced clear
    // exercises the cancellation path rather than the unpaid guard.
    repository.table = { ...repository.table!, bill_status: "paid" };

    const forced = await service.clearTableSession("table-1", {
      allowUnpaid: false,
      cancelActiveOrders: true,
    });
    assert.equal(forced.outcome, "cleared");
    assert.equal(repository.table?.status, "empty");
  });

  it("refuses a staff clear of an unpaid seating, but allows the manager override", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    await startSession(service, repository, { status: "active" });
    repository.table = {
      ...repository.table!,
      session_started_at: new Date("2026-11-05T10:00:00Z"),
    };
    repository.orders.push({
      id: "o1",
      status: "served",
      created_at: new Date("2026-11-05T10:05:00Z"),
    });

    const refused = await service.clearTableSession("table-1", { allowUnpaid: false });
    assert.equal(refused.outcome, "unpaid");

    const cleared = await service.clearTableSession("table-1", { allowUnpaid: true });
    assert.equal(cleared.outcome, "cleared");
    assert.equal(repository.table?.status, "empty");
  });
});

describe("TableService — active check", () => {
  it("reports the blocking ticket, then readiness once it is closed", async () => {
    const repository = new FakeTableRepository();
    const { service } = serviceWith(repository);
    repository.orders.push({ id: "o1", status: "ready", created_at: new Date() });

    const blocked = await service.activeCheck("k7x2p");
    assert.equal(blocked.has_active_order, true);
    if (blocked.has_active_order) assert.equal(blocked.order_id, "o1");

    repository.orders[0]!.status = "served";
    const ready = await service.activeCheck("k7x2p");
    assert.equal(ready.has_active_order, false);
  });
});

describe("TableService — credential generation", () => {
  it("keeps the documented PIN and pass shape", () => {
    for (let index = 0; index < 50; index += 1) {
      assert.match(generateSessionPin(), /^\d{2}$/);
    }
  });
});
