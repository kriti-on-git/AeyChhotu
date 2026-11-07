import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Ticket service rules with fakes: the state machine is conditional, prune and
   deny are all-or-nothing, events describe committed moves only, and a ticket
   is never assumed to be the same thing as its order. */

import { AppError } from "../src/errors/app-error.js";
import { TicketsService } from "../src/modules/tickets/tickets.service.js";
import type {
  TicketEventPublisher,
  TicketListParams,
  TicketRepositoryPort,
  TicketRow,
  TicketTransactionPort,
  TicketAdvanceTarget,
} from "../src/modules/tickets/tickets.types.js";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";

const table = { id: TABLE_ID, code: "k7x2p", name: "Window", serve_requested_at: null };

function row(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    ticket_id: TICKET_ID,
    order_id: ORDER_ID,
    status: "pending",
    created_at: new Date("2026-01-01T10:00:00.000Z"),
    denial_reason: "",
    table,
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
    ...overrides,
  };
}

class FakeRepository implements TicketRepositoryPort {
  countTotal = 1;
  rows: TicketRow[] = [row()];
  found: TicketRow | null = row();
  orderRef: { order_id: string; table_id: string; status: string; created_at: Date } | null = {
    order_id: ORDER_ID,
    table_id: TABLE_ID,
    status: "pending",
    created_at: new Date("2026-01-01T10:00:00.000Z"),
  };
  advanceResult: { id: string; status: string } | null = { id: TICKET_ID, status: "preparing" };
  lockResult: { id: string; table_id: string; status: string } | null = {
    id: TICKET_ID,
    table_id: TABLE_ID,
    status: "ready",
  };

  readonly calls: string[] = [];
  readonly markedServed: string[] = [];
  readonly markedDenied: Array<{ id: string; reason: string }> = [];
  readonly clearedPings: string[] = [];
  failMarkServed = false;
  failMarkDenied = false;
  readonly countStatuses: Array<string | undefined> = [];
  readonly listParams: Array<{ status?: string; limit: number; offset: number }> = [];
  readonly advanceCalls: Array<{ id: string; from: string; target: TicketAdvanceTarget }> = [];
  orderRefs: Array<typeof this.orderRef> = [];

  async count(status: string | undefined): Promise<number> {
    this.countStatuses.push(status);
    return this.countTotal;
  }

  async list(status: string | undefined, limit: number, offset: number): Promise<TicketRow[]> {
    this.listParams.push({ status, limit, offset });
    return this.rows;
  }

  async find(): Promise<TicketRow | null> {
    return this.found;
  }

  async findOrder(): Promise<typeof this.orderRef> {
    return this.orderRefs.length > 0 ? (this.orderRefs.shift() ?? null) : this.orderRef;
  }

  async advance(
    id: string,
    from: string,
    target: TicketAdvanceTarget,
  ): Promise<{ id: string; status: string } | null> {
    this.advanceCalls.push({ id, from, target });
    return this.advanceResult;
  }

  async transaction<T>(work: (tx: TicketTransactionPort) => Promise<T>): Promise<T> {
    this.calls.push("begin");
    const result = await work({
      lockTicket: async () => this.lockResult,
      markServed: async (ticketId) => {
        if (this.failMarkServed) throw new Error("write failed");
        this.markedServed.push(ticketId);
      },
      markDenied: async (ticketId, reason) => {
        if (this.failMarkDenied) throw new Error("write failed");
        this.markedDenied.push({ id: ticketId, reason });
      },
      clearWaiterPing: async (tableId) => {
        this.clearedPings.push(tableId);
      },
    });
    this.calls.push("commit");
    return result;
  }

  async schemaObjects() {
    return { present: [], missing: [] };
  }
}

function recordingEvents() {
  const seen: Array<Record<string, unknown>> = [];
  const events: TicketEventPublisher = {
    ticketAdvanced: (payload) => seen.push({ event: "advanced", ...payload }),
    ticketServed: (payload) => seen.push({ event: "served", ...payload }),
    ticketDenied: (payload) => seen.push({ event: "denied", ...payload }),
  };
  return { seen, events };
}

function makeService(options: {
  repository: FakeRepository;
  events?: TicketEventPublisher;
  release?: { checkAndAutoReleaseTable(tableId: string): Promise<{ released: boolean }> };
  onPublishError?: (err: unknown) => void;
}) {
  return new TicketsService({
    repository: options.repository,
    events: options.events,
    release: options.release,
    onPublishError: options.onPublishError,
  });
}

function isAppError(code: string, status?: number) {
  return (err: unknown) =>
    err instanceof AppError && err.code === code && (status === undefined || err.status === status);
}

describe("TicketsService — board and identification", () => {
  it("lists the active board with the legacy payload and pagination", async () => {
    const repository = new FakeRepository();
    const params: TicketListParams = { status: "pending", page: 2, limit: 5 };

    const page = await makeService({ repository }).listTickets(params);

    assert.deepEqual(repository.countStatuses, ["pending"]);
    assert.deepEqual(repository.listParams, [{ status: "pending", limit: 5, offset: 5 }]);
    assert.equal(page.meta.page, 2);
    assert.equal(page.meta.limit, 5);
    assert.equal(page.meta.total, 1);

    const ticket = page.data[0];
    assert.ok(ticket);
    assert.equal(ticket.ticket_id, TICKET_ID);
    assert.equal(ticket.order_id, ORDER_ID);
    assert.equal(ticket.created_at, "2026-01-01T10:00:00Z");
    assert.deepEqual(ticket.table, table);
    assert.equal(ticket.items[0]?.name, "Masala Dosa");
    assert.equal(ticket.items[0]?.unit_price, 120);
    assert.ok(!("denial_reason" in ticket), "the board payload must not grow a trail field");
  });

  it("identifies a ticket and keeps its parent order separate", async () => {
    const repository = new FakeRepository();
    repository.found = row({ order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });

    const ticket = await makeService({ repository }).getTicket(TICKET_ID);
    assert.equal(ticket.ticket_id, TICKET_ID);
    assert.notEqual(ticket.order_id, ticket.ticket_id);
    assert.equal(ticket.denial_reason, "");
  });

  it("returns 404 for an unknown ticket id", async () => {
    const repository = new FakeRepository();
    repository.found = null;

    await assert.rejects(
      () => makeService({ repository }).getTicket(TICKET_ID),
      isAppError("ORDER_NOT_FOUND", 404),
    );
  });

  it("supports more than one ticket per order without collapsing them", async () => {
    const repository = new FakeRepository();
    repository.rows = [
      row({ ticket_id: "11111111-1111-4111-8111-111111111111" }),
      row({ ticket_id: "44444444-4444-4444-8444-444444444444" }),
    ];
    repository.countTotal = 2;

    const page = await makeService({ repository }).listTickets({ page: 1, limit: 20 });
    assert.equal(page.data.length, 2);
    assert.equal(page.data[0]?.order_id, page.data[1]?.order_id);
    assert.notEqual(page.data[0]?.ticket_id, page.data[1]?.ticket_id);
  });
});

describe("TicketsService — status transitions", () => {
  it("advances pending→preparing with one conditional update and one event", async () => {
    const repository = new FakeRepository();
    const { seen, events } = recordingEvents();

    const result = await makeService({ repository, events }).advanceTicket(TICKET_ID, "preparing");

    assert.deepEqual(repository.advanceCalls, [
      { id: TICKET_ID, from: "pending", target: "preparing" },
    ]);
    assert.deepEqual(result, {
      ticket_id: TICKET_ID,
      order_id: ORDER_ID,
      status: "preparing",
    });
    assert.deepEqual(seen, [
      { event: "advanced", ticketId: TICKET_ID, orderId: TICKET_ID, status: "preparing" },
    ]);
  });

  it("rejects an unknown ticket before attempting an update", async () => {
    const repository = new FakeRepository();
    repository.orderRef = null;

    await assert.rejects(
      () => makeService({ repository }).advanceTicket(TICKET_ID, "ready"),
      isAppError("ORDER_NOT_FOUND", 404),
    );
    assert.deepEqual(repository.advanceCalls, []);
  });

  it("refuses a skipped or repeated move with the actual current status", async () => {
    for (const current of ["ready", "preparing", "served", "denied"]) {
      const repository = new FakeRepository();
      repository.advanceResult = null;
      repository.orderRef = {
        order_id: ORDER_ID,
        table_id: TABLE_ID,
        status: current,
        created_at: new Date(),
      };

      await assert.rejects(
        () => makeService({ repository }).advanceTicket(TICKET_ID, "preparing"),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.status === 409 &&
          err.details?.current_status === current &&
          err.details?.requested_status === "preparing",
      );
    }
  });

  it("does not emit an event for a refused move", async () => {
    const repository = new FakeRepository();
    repository.advanceResult = null;
    repository.orderRef = {
      order_id: ORDER_ID,
      table_id: TABLE_ID,
      status: "ready",
      created_at: new Date(),
    };
    const { seen, events } = recordingEvents();

    await assert.rejects(
      () => makeService({ repository, events }).advanceTicket(TICKET_ID, "preparing"),
      isAppError("INVALID_STATUS_TRANSITION"),
    );
    assert.deepEqual(seen, []);
  });
});

describe("TicketsService — prune and deny", () => {
  it("serves a ready ticket and clears its waiter ping in one transaction", async () => {
    const repository = new FakeRepository();
    const released: string[] = [];
    const { seen, events } = recordingEvents();

    const result = await makeService({
      repository,
      events,
      release: {
        checkAndAutoReleaseTable: async (tableId) => {
          released.push(tableId);
          return { released: false };
        },
      },
    }).pruneTicket(TICKET_ID);

    assert.deepEqual(repository.markedServed, [TICKET_ID]);
    assert.deepEqual(repository.clearedPings, [TABLE_ID]);
    assert.deepEqual(released, [TABLE_ID]);
    assert.equal(result.status, "served");
    assert.equal(result.table_cleared, false);
    assert.deepEqual(seen, [
      { event: "served", ticketId: TICKET_ID, orderId: TICKET_ID, tableId: TABLE_ID },
    ]);
  });

  it("refuses to prune anything but a ready ticket and writes nothing", async () => {
    for (const status of ["pending", "preparing", "served", "denied"]) {
      const repository = new FakeRepository();
      repository.lockResult = { id: TICKET_ID, table_id: TABLE_ID, status };

      await assert.rejects(
        () => makeService({ repository }).pruneTicket(TICKET_ID),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.status === 409 &&
          err.details?.requested_status === "served",
      );
      assert.deepEqual(repository.markedServed, []);
      assert.deepEqual(repository.clearedPings, []);
    }
  });

  it("denies a live ticket with a trimmed reason and clears the ping", async () => {
    const repository = new FakeRepository();
    repository.lockResult = { id: TICKET_ID, table_id: TABLE_ID, status: "preparing" };
    const { seen, events } = recordingEvents();

    const result = await makeService({ repository, events }).denyTicket(
      TICKET_ID,
      "  prawns ran out  ",
    );

    assert.deepEqual(repository.markedDenied, [
      { id: TICKET_ID, reason: "prawns ran out" },
    ]);
    assert.deepEqual(repository.clearedPings, [TABLE_ID]);
    assert.equal(result.status, "denied");
    assert.equal(result.denial_reason, "prawns ran out");
    assert.deepEqual(seen, [
      {
        event: "denied",
        ticketId: TICKET_ID,
        orderId: TICKET_ID,
        reason: "prawns ran out",
      },
    ]);
  });

  it("rejects a blank reason before opening a transaction", async () => {
    const repository = new FakeRepository();

    await assert.rejects(
      () => makeService({ repository }).denyTicket(TICKET_ID, "   "),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "VALIDATION_ERROR" &&
        err.status === 400 &&
        Boolean((err.details as { fields?: { reason?: string } })?.fields?.reason),
    );
    assert.deepEqual(repository.calls, []);
  });

  it("cannot deny a served or already denied ticket", async () => {
    for (const status of ["served", "denied"]) {
      const repository = new FakeRepository();
      repository.lockResult = { id: TICKET_ID, table_id: TABLE_ID, status };

      await assert.rejects(
        () => makeService({ repository }).denyTicket(TICKET_ID, "late"),
        (err: unknown) =>
          err instanceof AppError &&
          err.code === "INVALID_STATUS_TRANSITION" &&
          err.details?.current_status === status,
      );
      assert.deepEqual(repository.markedDenied, []);
    }
  });

  it("keeps the serve successful when the release engine throws", async () => {
    const repository = new FakeRepository();
    const failures: unknown[] = [];

    const result = await makeService({
      repository,
      release: {
        checkAndAutoReleaseTable: async () => {
          throw new Error("billing down");
        },
      },
      onPublishError: (err) => failures.push(err),
    }).pruneTicket(TICKET_ID);

    assert.equal(result.status, "served");
    assert.equal(result.table_cleared, false);
    assert.equal(failures.length, 1);
  });

  it("never fails a committed move because an event listener broke", async () => {
    const repository = new FakeRepository();
    const failures: unknown[] = [];

    const service = makeService({
      repository,
      events: {
        ticketAdvanced: () => {
          throw new Error("listener down");
        },
        ticketServed: () => undefined,
        ticketDenied: () => undefined,
      },
      onPublishError: (err) => failures.push(err),
    });

    const result = await service.advanceTicket(TICKET_ID, "preparing");
    assert.equal(result.status, "preparing");
    assert.equal(failures.length, 1);
  });
});
