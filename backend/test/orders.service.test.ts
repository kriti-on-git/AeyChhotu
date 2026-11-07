import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Orders service rules, proven with fakes: the atomic fire is the only
   creation path, every business outcome maps to the documented contract, and
   events describe committed orders only. */

import { AppError } from "../src/errors/app-error.js";
import { OrdersService } from "../src/modules/orders/orders.service.js";
import type {
  DeniedLineRow,
  DeniedOrderRef,
  FireResult,
  LockedOrderRow,
  OrdersEventPublisher,
  OrdersRepositoryPort,
  OrdersTransactionPort,
  OrderListRow,
  OrderStatusRow,
} from "../src/modules/orders/orders.types.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";

const OK = {
  code: "OK",
  order_id: ORDER_ID,
  table_id: TABLE_ID,
  status: "pending",
  created_at: "2026-01-01T10:00:00.000Z",
} as const satisfies FireResult;

class FakeRepository implements OrdersRepositoryPort {
  fireResults: Array<FireResult | null> = [];
  readonly fireCalls: string[] = [];
  itemCount = 3;
  statusRow: OrderStatusRow | null = null;
  listRows: OrderListRow[] = [];
  totalForTable = 0;
  deniedRefs: DeniedOrderRef[] = [];
  readonly dismissCalls: string[] = [];
  lockedOrder: LockedOrderRow | null = null;
  lines: DeniedLineRow[] = [];
  fireInTransaction: FireResult | null = null;
  readonly moved: Array<{ tableId: string; line: unknown }> = [];
  readonly deleted: string[] = [];

  async fire(tableToken: string): Promise<FireResult | null> {
    this.fireCalls.push(tableToken);
    return this.fireResults.shift() ?? null;
  }

  async countItems(): Promise<number> {
    return this.itemCount;
  }

  async findOrderForTable(): Promise<OrderStatusRow | null> {
    return this.statusRow;
  }

  async countForTable(): Promise<number> {
    return this.totalForTable;
  }

  async listForTable(): Promise<OrderListRow[]> {
    return this.listRows;
  }

  async denyPendingForItem(): Promise<DeniedOrderRef[]> {
    return this.deniedRefs;
  }

  async dismiss(orderId: string): Promise<void> {
    this.dismissCalls.push(orderId);
  }

  async transaction<T>(work: (tx: OrdersTransactionPort) => Promise<T>): Promise<T> {
    return work({
      lockOrderForTable: async () => this.lockedOrder,
      listLines: async () => this.lines,
      addCartLine: async (tableId, line) => {
        this.moved.push({ tableId, line });
      },
      deleteOrder: async (orderId) => {
        this.deleted.push(orderId);
      },
      fire: async () => this.fireInTransaction,
    });
  }

  async schemaObjects() {
    return { present: [], missing: [] };
  }
}

function recordingEvents() {
  const seen: Array<Record<string, unknown>> = [];
  const events: OrdersEventPublisher = {
    orderCreated: (payload) => seen.push({ event: "order.created", ...payload }),
    ticketCreated: (payload) => seen.push({ event: "ticket.created", ...payload }),
    orderDenied: (payload) => seen.push({ event: "order.denied", ...payload }),
  };
  return { seen, events };
}

const tableRecord = { id: "table-1", code: "k7x2p", name: "Window", status: "active" };

function makeService(options: {
  repository: FakeRepository;
  events?: OrdersEventPublisher;
  requireTable?: (token: string) => Promise<typeof tableRecord>;
}) {
  return new OrdersService({
    repository: options.repository,
    tables: { requireTable: options.requireTable ?? (async () => tableRecord) },
    events: options.events,
  });
}

function isAppError(code: string, status?: number) {
  return (err: unknown) =>
    err instanceof AppError && err.code === code && (status === undefined || err.status === status);
}

describe("OrdersService — creation", () => {
  it("creates an order from the cart, freezes its response and publishes facts", async () => {
    const repository = new FakeRepository();
    repository.fireResults = [OK];
    repository.itemCount = 3;
    const { seen, events } = recordingEvents();

    const service = makeService({ repository, events });
    const fired = await service.fireOrder("k7x2p");

    assert.deepEqual(repository.fireCalls, ["k7x2p"]);
    assert.deepEqual(fired, {
      order_id: OK.order_id,
      table_id: OK.table_id,
      status: "pending",
      created_at: "2026-01-01T10:00:00Z",
      message: "Order successfully routed to KDS line.",
    });
    assert.deepEqual(seen, [
      {
        event: "order.created",
        orderId: OK.order_id,
        tableId: OK.table_id,
        itemCount: 3,
      },
      {
        event: "ticket.created",
        ticketId: OK.order_id,
        orderId: OK.order_id,
        tableId: OK.table_id,
      },
    ]);
  });

  it("rejects an empty cart without creating or announcing anything", async () => {
    const repository = new FakeRepository();
    repository.fireResults = [{ code: "EMPTY_CART" }];
    const { seen, events } = recordingEvents();

    await assert.rejects(
      () => makeService({ repository, events }).fireOrder("k7x2p"),
      isAppError("EMPTY_CART", 409),
    );
    assert.deepEqual(seen, []);
  });

  it("maps a concurrent duplicate submission to 409 with the active ticket", async () => {
    const repository = new FakeRepository();
    repository.fireResults = [
      OK,
      { code: "DUPLICATE_ORDER", order_id: OK.order_id, status: "preparing" },
    ];

    const service = makeService({ repository });
    await service.fireOrder("k7x2p");

    await assert.rejects(
      () => service.fireOrder("k7x2p"),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "DUPLICATE_ORDER" &&
        err.status === 409 &&
        err.details?.order_id === OK.order_id &&
        err.details?.status === "preparing",
    );
    assert.equal(repository.fireCalls.length, 2);
  });

  it("rejects an invalid or archived session before touching orders", async () => {
    const repository = new FakeRepository();
    const service = makeService({
      repository,
      requireTable: async () => {
        throw new AppError(404, "TABLE_NOT_FOUND", "Invalid table token parsed.");
      },
    });

    await assert.rejects(() => service.fireOrder("gone"), isAppError("TABLE_NOT_FOUND", 404));
    assert.deepEqual(repository.fireCalls, []);
  });

  it("reports inventory failures with the sold-out names and creates nothing", async () => {
    const repository = new FakeRepository();
    repository.fireResults = [
      { code: "INVENTORY_FAILURE", sold_out: ["Masala Dosa", "Filter Coffee"] },
    ];
    const { seen, events } = recordingEvents();

    await assert.rejects(
      () => makeService({ repository, events }).fireOrder("k7x2p"),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "INVENTORY_FAILURE" &&
        err.status === 409 &&
        Array.isArray(err.details?.sold_out) &&
        (err.details?.sold_out as string[]).length === 2 &&
        err.message.includes("have sold out"),
    );
    assert.deepEqual(seen, []);
  });

  it("never fails a committed order because an event listener broke", async () => {
    const repository = new FakeRepository();
    repository.fireResults = [OK];
    const failures: unknown[] = [];

    const service = new OrdersService({
      repository,
      tables: { requireTable: async () => tableRecord },
      events: {
        orderCreated: () => {
          throw new Error("listener down");
        },
        ticketCreated: () => undefined,
        orderDenied: () => undefined,
      },
      onPublishError: (err) => failures.push(err),
    });

    const fired = await service.fireOrder("k7x2p");
    assert.equal(fired.order_id, OK.order_id);
    assert.equal(failures.length, 1);
  });

  it("still succeeds when the event-payload count read fails", async () => {
    const repository = new FakeRepository();
    repository.fireResults = [OK];
    repository.countItems = async () => {
      throw new Error("read failed");
    };
    const { seen, events } = recordingEvents();

    const fired = await makeService({ repository, events }).fireOrder("k7x2p");
    assert.equal(fired.order_id, OK.order_id);
    assert.equal(seen[0]?.itemCount, 0);
  });
});

describe("OrdersService — history and price freezing", () => {
  it("returns frozen unit prices and totals instead of recomputing them", async () => {
    const repository = new FakeRepository();
    repository.totalForTable = 1;
    repository.listRows = [
      {
        order_id: OK.order_id,
        table_id: OK.table_id,
        status: "served",
        created_at: new Date("2026-01-01T10:00:00.000Z"),
        denial_reason: "",
        total: "240.00",
        items: [
          {
            menu_item_id: "item-1",
            name: "Masala Dosa",
            quantity: 2,
            request_note: "",
            allergy_note: "",
            added_by: "Asha",
            // Menu price is now 999; this ticket keeps what was charged.
            unit_price: 120,
          },
        ],
      },
    ];

    const page = await makeService({ repository }).listOrders({
      table_token: "k7x2p",
      page: 1,
      limit: 20,
    });

    assert.equal(page.data[0]?.total, 240);
    assert.equal(page.data[0]?.items[0]?.unit_price, 120);
    assert.equal(page.meta.total, 1);
    assert.deepEqual(page.data[0]?.items[0]?.added_by, "Asha");
  });

  it("scopes status polling to the caller's table", async () => {
    const repository = new FakeRepository();
    repository.statusRow = null;

    await assert.rejects(
      () =>
        makeService({ repository }).getOrderStatus(
          "11111111-1111-4111-8111-111111111111",
          "k7x2p",
        ),
      isAppError("ORDER_NOT_FOUND", 404),
    );

    repository.statusRow = {
      order_id: OK.order_id,
      table_id: OK.table_id,
      status: "preparing",
      created_at: new Date("2026-01-01T10:00:00.000Z"),
    };
    const status = await makeService({ repository }).getOrderStatus(OK.order_id, "k7x2p");
    assert.deepEqual(status, {
      order_id: OK.order_id,
      table_id: OK.table_id,
      status: "preparing",
      created_at: "2026-01-01T10:00:00Z",
    });
  });
});

describe("OrdersService — denied rounds", () => {
  const denied: LockedOrderRow = { id: OK.order_id, table_id: OK.table_id, status: "denied" };

  it("requeues available lines and reports sold-out ones", async () => {
    const repository = new FakeRepository();
    repository.lockedOrder = denied;
    repository.lines = [
      {
        menu_item_id: "item-1",
        name: "Dosa",
        quantity: 2,
        request_note: "crisp",
        allergy_note: "",
        added_by: "Asha",
        is_available: true,
      },
      {
        menu_item_id: "item-2",
        name: "Coffee",
        quantity: 1,
        request_note: "",
        allergy_note: "",
        added_by: "Ravi",
        is_available: false,
      },
    ];

    const result = await makeService({ repository }).requeueDeniedOrder(OK.order_id, "k7x2p");

    assert.deepEqual(result, {
      order_id: OK.order_id,
      moved: 1,
      omitted: ["Coffee"],
    });
    assert.deepEqual(repository.moved, [
      {
        tableId: OK.table_id,
        line: {
          menuItemId: "item-1",
          quantity: 2,
          requestNote: "crisp",
          allergyNote: "",
          addedBy: "Asha",
        },
      },
    ]);
    assert.deepEqual(repository.deleted, [OK.order_id]);
  });

  it("keeps a denied ticket when nothing can be moved back", async () => {
    const repository = new FakeRepository();
    repository.lockedOrder = denied;
    repository.lines = [
      {
        menu_item_id: "item-2",
        name: "Coffee",
        quantity: 1,
        request_note: "",
        allergy_note: "",
        added_by: "Ravi",
        is_available: false,
      },
    ];

    const result = await makeService({ repository }).requeueDeniedOrder(OK.order_id, "k7x2p");
    assert.deepEqual(result, { order_id: OK.order_id, moved: 0, omitted: ["Coffee"] });
    assert.deepEqual(repository.deleted, []);
  });

  it("re-fires a denied round in one transaction", async () => {
    const repository = new FakeRepository();
    repository.lockedOrder = denied;
    repository.lines = [
      {
        menu_item_id: "item-1",
        name: "Dosa",
        quantity: 1,
        request_note: "",
        allergy_note: "",
        added_by: "Asha",
        is_available: true,
      },
    ];
    repository.fireInTransaction = OK;

    const result = await makeService({ repository }).retryDeniedOrder(OK.order_id, "k7x2p");
    assert.equal(result.order_id, OK.order_id);
    assert.equal(result.moved, 1);
    assert.deepEqual(result.omitted, []);
    assert.equal(repository.moved.length, 1);
    assert.deepEqual(repository.deleted, [OK.order_id]);
  });

  it("refuses to retry when every line is sold out", async () => {
    const repository = new FakeRepository();
    repository.lockedOrder = denied;
    repository.lines = [
      {
        menu_item_id: "item-2",
        name: "Coffee",
        quantity: 1,
        request_note: "",
        allergy_note: "",
        added_by: "Ravi",
        is_available: false,
      },
    ];

    await assert.rejects(
      () => makeService({ repository }).retryDeniedOrder(OK.order_id, "k7x2p"),
      (err: unknown) =>
        err instanceof AppError && err.code === "NOTHING_TO_RETRY" && err.status === 409,
    );
    assert.deepEqual(repository.moved, []);
    assert.deepEqual(repository.deleted, []);
  });

  it("says nothing was re-fired when the replacement fire hits inventory", async () => {
    const repository = new FakeRepository();
    repository.lockedOrder = denied;
    repository.lines = [
      {
        menu_item_id: "item-1",
        name: "Dosa",
        quantity: 1,
        request_note: "",
        allergy_note: "",
        added_by: "Asha",
        is_available: true,
      },
    ];
    repository.fireInTransaction = { code: "INVENTORY_FAILURE", sold_out: ["Filter Coffee"] };

    await assert.rejects(
      () => makeService({ repository }).retryDeniedOrder(OK.order_id, "k7x2p"),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "INVENTORY_FAILURE" &&
        err.message.includes("nothing was re-fired"),
    );
  });

  it("only lets a denied round be requeued, retried or dismissed", async () => {
    const repository = new FakeRepository();
    repository.lockedOrder = { ...denied, status: "pending" };

    await assert.rejects(
      () => makeService({ repository }).requeueDeniedOrder(OK.order_id, "k7x2p"),
      isAppError("ORDER_NOT_DENIED", 409),
    );

    repository.statusRow = {
      order_id: OK.order_id,
      table_id: OK.table_id,
      status: "served",
      created_at: new Date(),
    };
    await assert.rejects(
      () => makeService({ repository }).dismissDeniedOrder(OK.order_id, "k7x2p"),
      isAppError("ORDER_NOT_DENIED", 409),
    );
    assert.deepEqual(repository.dismissCalls, []);
  });

  it("dismisses a denied round and announces each automatic refusal", async () => {
    const repository = new FakeRepository();
    repository.statusRow = {
      order_id: OK.order_id,
      table_id: OK.table_id,
      status: "denied",
      created_at: new Date(),
    };
    repository.deniedRefs = [{ order_id: OK.order_id, table_id: OK.table_id }];
    const { seen, events } = recordingEvents();
    const service = makeService({ repository, events });

    const dismissed = await service.dismissDeniedOrder(OK.order_id, "k7x2p");
    assert.deepEqual(dismissed, { order_id: OK.order_id, dismissed: true });
    assert.deepEqual(repository.dismissCalls, [OK.order_id]);

    const deniedCount = await service.denyPendingOrdersForItem("item-2", "Filter Coffee");
    assert.equal(deniedCount, 1);
    assert.deepEqual(seen, [
      {
        event: "order.denied",
        orderId: OK.order_id,
        tableId: OK.table_id,
        reason: "Item Filter Coffee went out of stock",
      },
    ]);
  });
});
