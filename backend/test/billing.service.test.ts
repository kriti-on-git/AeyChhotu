import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Billing rules with fakes: generation, per-guest allocation, shared lines,
   tax/discount/rounding, idempotency, settlement and event publication. No
   database or HTTP here. */

import { AppError } from "../src/errors/app-error.js";
import { BillingService } from "../src/modules/billing/billing.service.js";
import type {
  BillPaidRow,
  BillTableRow,
  BillingEventPublisher,
  BillingOrderRow,
  BillingReleasePort,
  BillingRepositoryPort,
  BillingSchemaPresence,
} from "../src/modules/billing/billing.types.js";

const TABLE_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const DENIED_ID = "33333333-3333-4333-8333-333333333333";
const STARTED = new Date("2026-01-01T10:00:00.000Z");
const PAID_AT = new Date("2026-01-01T11:00:00.000Z");

class FakeRepository implements BillingRepositoryPort {
  table: BillTableRow | null = {
    id: TABLE_ID,
    code: "k7x2p",
    name: "Window",
    bill_status: "requested",
    session_started_at: STARTED,
    bill_requested_at: STARTED,
    bill_paid_at: null,
  };
  orders: BillingOrderRow[] = [
    {
      order_id: ORDER_ID,
      created_at: STARTED,
      total: "290.50",
      status: "pending",
      items: [
        {
          menu_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Masala Dosa",
          quantity: 2,
          unit_price: "120.00",
          added_by: "Asha",
        },
        {
          menu_item_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: "Chai",
          quantity: 1,
          unit_price: "40.50",
          added_by: "Ravi",
        },
        {
          menu_item_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          name: "Water",
          quantity: 1,
          unit_price: "10.00",
          added_by: "",
        },
      ],
    },
  ];
  listCalls = 0;
  markPaidCalls = 0;
  lastSession: Date | null = null;

  async findBill(): Promise<BillTableRow | null> {
    return this.table;
  }

  async listOrders(_tableId: string, sessionStartedAt: Date | null): Promise<BillingOrderRow[]> {
    this.listCalls += 1;
    this.lastSession = sessionStartedAt;
    return this.orders;
  }

  async markPaid(): Promise<BillPaidRow | null> {
    this.markPaidCalls += 1;
    if (!this.table) return null;
    this.table = {
      ...this.table,
      bill_status: "paid",
      bill_paid_at: PAID_AT,
    };
    return { id: TABLE_ID, bill_status: "paid", bill_paid_at: PAID_AT };
  }

  async schemaObjects(): Promise<BillingSchemaPresence> {
    return { present: ["restaurant_tables", "orders", "order_items"], missing: [] };
  }
}

class FakeRelease implements BillingReleasePort {
  released = false;
  calls = 0;
  error: Error | null = null;

  async checkAndAutoReleaseTable(): Promise<{ released: boolean }> {
    this.calls += 1;
    if (this.error) throw this.error;
    return { released: this.released };
  }
}

class FakeEvents implements BillingEventPublisher {
  settled: Array<{ tableId: string; billPaidAt: string }> = [];

  billSettled(payload: { tableId: string; billPaidAt: string }): void {
    this.settled.push({ ...payload });
  }
}

function serviceWith(options: {
  repository?: FakeRepository;
  release?: FakeRelease;
  events?: FakeEvents;
  taxRateBps?: number;
  discountMinor?: number;
} = {}) {
  const repository = options.repository ?? new FakeRepository();
  const release = options.release ?? new FakeRelease();
  const events = options.events ?? new FakeEvents();
  const service = new BillingService({
    repository,
    release,
    events,
    taxRateBps: options.taxRateBps,
    discountMinor: options.discountMinor,
  });
  return { service, repository, release, events };
}

describe("BillingService — generation and allocation", () => {
  it("prices frozen lines exactly and groups them by guest", async () => {
    const { service, repository } = serviceWith();
    const bill = await service.getBill(TABLE_ID);

    assert.equal(bill.bill_id, `${TABLE_ID}:2026-01-01T10:00:00Z`);
    assert.equal(bill.table.code, "k7x2p");
    assert.equal(bill.status, "requested");
    assert.equal(bill.currency, "INR");
    assert.deepEqual(repository.lastSession, STARTED);

    assert.equal(bill.line_items.length, 3);
    assert.deepEqual(
      bill.line_items.map((line) => [line.name, line.line_total, line.allocated_to, line.shared]),
      [
        ["Masala Dosa", "240.00", "Asha", false],
        ["Chai", "40.50", "Ravi", false],
        ["Water", "10.00", null, true],
      ],
    );

    assert.deepEqual(
      bill.allocations.map((entry) => [entry.name, entry.shared, entry.subtotal, entry.line_count]),
      [
        ["Asha", false, "240.00", 1],
        ["Ravi", false, "40.50", 1],
        ["Table", true, "10.00", 1],
      ],
    );
    assert.deepEqual(bill.totals, {
      subtotal_minor: 29_050,
      tax_minor: 0,
      discount_minor: 0,
      total_minor: 29_050,
      subtotal: "290.50",
      tax: "0.00",
      discount: "0.00",
      total: "290.50",
    });
  });

  it("applies integer tax and discount with half-up rounding", async () => {
    const { service } = serviceWith({ taxRateBps: 500, discountMinor: 100 });
    const bill = await service.getBill(TABLE_ID);

    // (290.50 − 1.00) × 5% = 14.475 → 14.48
    assert.equal(bill.totals.subtotal_minor, 29_050);
    assert.equal(bill.totals.discount_minor, 100);
    assert.equal(bill.totals.tax_minor, 1_448);
    assert.equal(bill.totals.total_minor, 30_398);
    assert.equal(bill.totals.total, "303.98");
    // Per-guest item totals are un-taxed and still add up to the subtotal.
    assert.equal(
      bill.allocations.reduce((sum, allocation) => sum + allocation.subtotal_minor, 0),
      bill.totals.subtotal_minor,
    );
  });

  it("never discounts below zero", async () => {
    const { service } = serviceWith({ discountMinor: 50_000 });
    const bill = await service.getBill(TABLE_ID);
    assert.equal(bill.totals.discount_minor, 29_050);
    assert.equal(bill.totals.total_minor, 0);
  });

  it("is idempotent: repeated generation writes nothing and returns the same bill", async () => {
    const { service, repository } = serviceWith();
    const first = await service.getBill(TABLE_ID);
    const second = await service.getBill(TABLE_ID);

    assert.deepEqual(second, first);
    assert.equal(repository.markPaidCalls, 0);
  });

  it("excludes nothing itself but respects the repository's non-denied projection", async () => {
    const repository = new FakeRepository();
    repository.orders = [
      ...repository.orders,
      {
        order_id: DENIED_ID,
        created_at: STARTED,
        total: "999.00",
        status: "denied",
        items: [],
      },
    ];
    const { service } = serviceWith({ repository });
    const bill = await service.getBill(TABLE_ID);

    assert.equal(bill.totals.subtotal_minor, 29_050);
    assert.ok(bill.line_items.every((line) => line.order_id !== DENIED_ID));
  });

  it("returns TABLE_NOT_FOUND for an unknown table", async () => {
    const repository = new FakeRepository();
    repository.table = null;
    const { service } = serviceWith({ repository });

    await assert.rejects(service.getBill(TABLE_ID), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "TABLE_NOT_FOUND");
      return true;
    });
  });
});

describe("BillingService — settlement", () => {
  it("records payment, asks Table for release and emits once", async () => {
    const { service, release, events } = serviceWith();
    release.released = true;

    const result = await service.settleBill(TABLE_ID);
    assert.deepEqual(result, {
      table_id: TABLE_ID,
      bill_status: "paid",
      bill_paid_at: "2026-01-01T11:00:00Z",
      released: true,
    });
    assert.equal(release.calls, 1);
    assert.deepEqual(events.settled, [
      { tableId: TABLE_ID, billPaidAt: "2026-01-01T11:00:00Z" },
    ]);
  });

  it("is idempotent and does not re-announce an already paid bill", async () => {
    const { service, repository, pageEvents } = (() => {
      const repository = new FakeRepository();
      const pageEvents = new FakeEvents();
      const service = new BillingService({ repository, release: new FakeRelease(), events: pageEvents });
      return { service, repository, pageEvents };
    })();

    await service.settleBill(TABLE_ID);
    const second = await service.settleBill(TABLE_ID);

    assert.equal(second.bill_status, "paid");
    assert.equal(repository.markPaidCalls, 2);
    assert.equal(pageEvents.settled.length, 1);
  });

  it("keeps the payment when the release engine fails", async () => {
    const release = new FakeRelease();
    release.error = new Error("release offline");
    const { service, events } = serviceWith({ release });

    const result = await service.settleBill(TABLE_ID);
    assert.equal(result.bill_status, "paid");
    assert.equal(result.released, false);
    assert.equal(events.settled.length, 1);
  });

  it("returns TABLE_NOT_FOUND without marking an unknown table paid", async () => {
    const repository = new FakeRepository();
    repository.table = null;
    const { service } = serviceWith({ repository });

    await assert.rejects(service.settleBill(TABLE_ID), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "TABLE_NOT_FOUND");
      return true;
    });
    assert.equal(repository.markPaidCalls, 0);
  });
});
