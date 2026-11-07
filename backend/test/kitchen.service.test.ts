import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Kitchen orchestration rules with fakes: every move is delegated to the
   Ticket contract, only a committed move is announced, and neither a broken
   socket nor a throwing listener can fail a kitchen action. */

import { AppError } from "../src/errors/app-error.js";
import { KitchenService } from "../src/modules/kitchen/kitchen.service.js";
import {
  KITCHEN_EVENTS,
  KITCHEN_REALTIME_EVENTS,
} from "../src/modules/kitchen/kitchen.events.js";
import type {
  KitchenBoard,
  KitchenBoardParams,
  KitchenEventPublisher,
  KitchenOrderPort,
  KitchenOrderRef,
  KitchenQueueSummary,
  KitchenRealtimePort,
  KitchenTicketPort,
} from "../src/modules/kitchen/kitchen.types.js";
import { buildMeta } from "../src/lib/util.js";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const TABLE_ID = "33333333-3333-4333-8333-333333333333";

const BOARD: KitchenBoard = { data: [], meta: buildMeta(1, 20, 0) };

class FakeTickets implements KitchenTicketPort {
  board: KitchenBoard = BOARD;
  params: KitchenBoardParams | null = null;
  readonly advances: Array<{ id: string; target: string }> = [];
  readonly prunes: string[] = [];
  readonly denials: Array<{ id: string; reason: string }> = [];
  failAdvance: AppError | null = null;

  async listTickets(params: KitchenBoardParams): Promise<KitchenBoard> {
    this.params = params;
    return this.board;
  }

  async advanceTicket(id: string, target: "preparing" | "ready") {
    this.advances.push({ id, target });
    if (this.failAdvance) {
      const error = this.failAdvance;
      this.failAdvance = null;
      throw error;
    }
    return { ticket_id: id, order_id: ORDER_ID, status: target };
  }

  async pruneTicket(id: string) {
    this.prunes.push(id);
    return {
      ticket_id: id,
      order_id: ORDER_ID,
      status: "served" as const,
      table_cleared: true,
    };
  }

  async denyTicket(id: string, reason: string) {
    this.denials.push({ id, reason });
    return {
      ticket_id: id,
      order_id: ORDER_ID,
      status: "denied" as const,
      denial_reason: reason,
      table_cleared: false,
    };
  }
}

class FakeRepository {
  summaryValue: KitchenQueueSummary = {
    pending: 2,
    preparing: 1,
    ready: 1,
    active: 4,
    oldest_created_at: "2026-01-01T10:00:00Z",
  };
  order: KitchenOrderRef | null = {
    order_id: ORDER_ID,
    table_id: TABLE_ID,
    status: "pending",
    created_at: new Date("2026-01-01T10:00:00Z"),
  };
  failOrder = false;

  async summary() {
    return this.summaryValue;
  }

  async findOrder(): Promise<KitchenOrderRef | null> {
    if (this.failOrder) throw new Error("association read failed");
    return this.order;
  }

  async schemaObjects() {
    return { present: [], missing: [] };
  }
}

function fakeRealtime() {
  const calls: Array<{ event: string; data: unknown }> = [];
  const port: KitchenRealtimePort = {
    toKitchen(event, data) {
      calls.push({ event, data });
      return { room: "kitchen", event, recipients: 1, skipped: false };
    },
  };
  return { calls, port };
}

function recordingEvents() {
  const incoming: Array<Record<string, unknown>> = [];
  const completed: Array<Record<string, unknown>> = [];
  const port: KitchenEventPublisher = {
    ticketIncoming: (payload) => incoming.push({ ...payload }),
    ticketCompleted: (payload) => completed.push({ ...payload }),
  };
  return { incoming, completed, port };
}

function makeService(options: {
  tickets?: FakeTickets;
  repository?: FakeRepository;
  orders?: KitchenOrderPort;
  realtime?: KitchenRealtimePort;
  events?: KitchenEventPublisher;
  onPublishError?: (err: unknown) => void;
  assistantKey?: string | null;
} = {}) {
  const tickets = options.tickets ?? new FakeTickets();
  const repository = options.repository ?? new FakeRepository();
  return {
    tickets,
    repository,
    service: new KitchenService({
      tickets,
      repository,
      orders: options.orders,
      realtime: options.realtime,
      events: options.events,
      onPublishError: options.onPublishError,
      assistantKey: options.assistantKey,
    }),
  };
}

describe("KitchenService — board and queue", () => {
  it("reads the board through the Ticket contract without rewriting it", async () => {
    const { tickets, service } = makeService();

    const board = await service.getBoard({ status: "pending", page: 2, limit: 5 });

    assert.equal(board, BOARD);
    assert.deepEqual(tickets.params, { status: "pending", page: 2, limit: 5 });
  });

  it("exposes the read-only queue summary", async () => {
    const { service } = makeService();
    assert.deepEqual(await service.queue(), {
      pending: 2,
      preparing: 1,
      ready: 1,
      active: 4,
      oldest_created_at: "2026-01-01T10:00:00Z",
    });
  });
});

describe("KitchenService — incoming tickets", () => {
  it("announces a fired ticket to the kitchen and the bus", async () => {
    const { service } = makeService();
    const realtime = fakeRealtime();
    const events = recordingEvents();
    const withPorts = new KitchenService({
      tickets: new FakeTickets(),
      repository: new FakeRepository(),
      orders: new FakeRepository(),
      realtime: realtime.port,
      events: events.port,
    });

    await withPorts.handleIncomingTicket({
      ticketId: TICKET_ID,
      orderId: ORDER_ID,
      tableId: "event-table",
    });
    void service;

    assert.deepEqual(realtime.calls, [
      {
        event: KITCHEN_REALTIME_EVENTS.incoming,
        data: {
          ticket_id: TICKET_ID,
          order_id: ORDER_ID,
          table_id: TABLE_ID,
          status: "pending",
        },
      },
    ]);
    assert.deepEqual(events.incoming, [
      { ticketId: TICKET_ID, orderId: ORDER_ID, tableId: TABLE_ID },
    ]);
  });

  it("ignores a stale event whose order no longer exists", async () => {
    const repository = new FakeRepository();
    repository.order = null;
    const realtime = fakeRealtime();
    const events = recordingEvents();
    const { service } = makeService({
      repository,
      orders: repository,
      realtime: realtime.port,
      events: events.port,
    });

    await service.handleIncomingTicket({
      ticketId: TICKET_ID,
      orderId: ORDER_ID,
      tableId: TABLE_ID,
    });

    assert.deepEqual(realtime.calls, []);
    assert.deepEqual(events.incoming, []);
  });

  it("still notifies with the event table id when the association read fails", async () => {
    const repository = new FakeRepository();
    repository.failOrder = true;
    const realtime = fakeRealtime();
    const failures: unknown[] = [];
    const { service } = makeService({
      repository,
      orders: repository,
      realtime: realtime.port,
      onPublishError: (err) => failures.push(err),
    });

    await service.handleIncomingTicket({
      ticketId: TICKET_ID,
      orderId: ORDER_ID,
      tableId: "event-table",
    });

    assert.equal(failures.length, 1);
    assert.deepEqual(realtime.calls[0]?.data, {
      ticket_id: TICKET_ID,
      order_id: ORDER_ID,
      table_id: "event-table",
      status: "pending",
    });
  });
});

describe("KitchenService — acceptance, preparation and completion", () => {
  it("accepts a ticket as pending→preparing through Ticket", async () => {
    const { tickets, service } = makeService();
    const realtime = fakeRealtime();
    const withRealtime = new KitchenService({
      tickets,
      repository: new FakeRepository(),
      orders: new FakeRepository(),
      realtime: realtime.port,
    });

    const result = await withRealtime.acceptTicket(TICKET_ID);
    assert.deepEqual(tickets.advances, [{ id: TICKET_ID, target: "preparing" }]);
    assert.equal(result.status, "preparing");
    assert.deepEqual(realtime.calls, [
      {
        event: KITCHEN_REALTIME_EVENTS.accepted,
        data: {
          ticket_id: TICKET_ID,
          order_id: ORDER_ID,
          table_id: TABLE_ID,
          status: "preparing",
        },
      },
    ]);
  });

  it("marks preparation ready through Ticket", async () => {
    const { tickets, service } = makeService();
    const realtime = fakeRealtime();
    const withRealtime = new KitchenService({
      tickets,
      repository: new FakeRepository(),
      orders: new FakeRepository(),
      realtime: realtime.port,
    });
    void service;

    const result = await withRealtime.markTicketReady(TICKET_ID);
    assert.deepEqual(tickets.advances, [{ id: TICKET_ID, target: "ready" }]);
    assert.equal(result.status, "ready");
    assert.equal(realtime.calls[0]?.event, KITCHEN_REALTIME_EVENTS.ready);
  });

  it("completes a ticket through prune and emits the kitchen fact", async () => {
    const { tickets, service } = makeService();
    const realtime = fakeRealtime();
    const events = recordingEvents();
    const withPorts = new KitchenService({
      tickets,
      repository: new FakeRepository(),
      orders: new FakeRepository(),
      realtime: realtime.port,
      events: events.port,
    });
    void service;

    const result = await withPorts.completeTicket(TICKET_ID);
    assert.deepEqual(tickets.prunes, [TICKET_ID]);
    assert.equal(result.status, "served");
    assert.equal(result.table_cleared, true);
    assert.deepEqual(realtime.calls[0]?.data, {
      ticket_id: TICKET_ID,
      order_id: ORDER_ID,
      table_id: TABLE_ID,
      status: "served",
    });
    assert.deepEqual(events.completed, [
      { ticketId: TICKET_ID, orderId: ORDER_ID },
    ]);
  });

  it("denies through Ticket with the reason intact", async () => {
    const { tickets, service } = makeService();
    const realtime = fakeRealtime();
    const withRealtime = new KitchenService({
      tickets,
      repository: new FakeRepository(),
      orders: new FakeRepository(),
      realtime: realtime.port,
    });
    void service;

    const result = await withRealtime.denyTicket(TICKET_ID, "Paneer ran out");
    assert.deepEqual(tickets.denials, [{ id: TICKET_ID, reason: "Paneer ran out" }]);
    assert.equal(result.denial_reason, "Paneer ran out");
    assert.equal(realtime.calls[0]?.event, KITCHEN_REALTIME_EVENTS.denied);
  });
});

describe("KitchenService — invalid and duplicate updates", () => {
  it("propagates Ticket's 409 and announces nothing", async () => {
    const tickets = new FakeTickets();
    tickets.failAdvance = new AppError(
      409,
      "INVALID_STATUS_TRANSITION",
      "Ticket cannot move from ready to preparing.",
      { current_status: "ready", requested_status: "preparing" },
    );
    const realtime = fakeRealtime();
    const { service } = makeService({ tickets, realtime: realtime.port });

    await assert.rejects(
      () => service.acceptTicket(TICKET_ID),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "INVALID_STATUS_TRANSITION" &&
        err.status === 409 &&
        err.details?.current_status === "ready",
    );
    assert.deepEqual(realtime.calls, []);
  });

  it("announces only the winning move when a duplicate tap is refused", async () => {
    const tickets = new FakeTickets();
    const realtime = fakeRealtime();
    const { service } = makeService({ tickets, realtime: realtime.port });

    await service.acceptTicket(TICKET_ID);

    tickets.failAdvance = new AppError(
      409,
      "INVALID_STATUS_TRANSITION",
      "Ticket cannot move from preparing to preparing.",
      { current_status: "preparing", requested_status: "preparing" },
    );
    await assert.rejects(() => service.acceptTicket(TICKET_ID), /cannot move/);

    assert.equal(tickets.advances.length, 2);
    assert.equal(realtime.calls.length, 1);
  });
});

describe("KitchenService — publication resilience", () => {
  it("keeps a committed move successful when the realtime publisher throws", async () => {
    const failures: unknown[] = [];
    const realtime: KitchenRealtimePort = {
      toKitchen() {
        throw new Error("socket down");
      },
    };
    const { service } = makeService({
      realtime,
      onPublishError: (err) => failures.push(err),
    });

    const result = await service.acceptTicket(TICKET_ID);
    assert.equal(result.status, "preparing");
    assert.equal(failures.length, 1);
  });

  it("keeps a committed completion successful when a listener throws", async () => {
    const failures: unknown[] = [];
    const events: KitchenEventPublisher = {
      ticketIncoming: () => undefined,
      ticketCompleted: () => {
        throw new Error("listener down");
      },
    };
    const { service } = makeService({
      events,
      onPublishError: (err) => failures.push(err),
    });

    const result = await service.completeTicket(TICKET_ID);
    assert.equal(result.status, "served");
    assert.equal(failures.length, 1);
  });
});

describe("KitchenService — shift and key", () => {
  it("arms audio with the unchanged E13 payload", () => {
    const { service } = makeService();
    assert.deepEqual(service.activateShift("tablet-1"), {
      device_id: "tablet-1",
      audio_armed: true,
      message: "Audio chimes armed for this device. Incoming tickets will ping.",
    });
  });

  it("keeps the registry bounded without failing a re-arm", () => {
    const { service } = makeService();
    for (let index = 0; index < 150; index += 1) {
      assert.equal(service.activateShift(`device-${index}`).audio_armed, true);
    }
  });

  it("releases the configured assistant key, including null", () => {
    assert.equal(makeService({ assistantKey: "live-key" }).service.assistantKey(), "live-key");
    assert.equal(makeService().service.assistantKey(), null);
  });
});

describe("Kitchen event names", () => {
  it("keeps internal and realtime names stable", () => {
    assert.equal(KITCHEN_EVENTS.incoming, "kitchen.ticket.incoming");
    assert.equal(KITCHEN_EVENTS.completed, "kitchen.ticket.completed");
    assert.equal(KITCHEN_REALTIME_EVENTS.accepted, "kitchen.ticket.accepted");
    assert.equal(KITCHEN_REALTIME_EVENTS.ready, "kitchen.ticket.ready");
    assert.equal(KITCHEN_REALTIME_EVENTS.served, "kitchen.ticket.served");
    assert.equal(KITCHEN_REALTIME_EVENTS.denied, "kitchen.ticket.denied");
  });
});
