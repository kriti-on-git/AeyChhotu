import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for Billing: the session-scoped read model, frozen
   prices, denied-round exclusion, per-guest/shared allocation, tax/discount
   totals, idempotent generation, settlement persistence and its event, schema
   health. Gated on TEST_DATABASE_URL. */

import { AppError } from "../src/errors/app-error.js";
import { DatabaseManager } from "../src/infrastructure/database/DatabaseManager.js";
import { BillingRepository } from "../src/modules/billing/billing.repository.js";
import { BillingService } from "../src/modules/billing/billing.service.js";
import { createBillingModule } from "../src/modules/billing/billing.module.js";
import type {
  BillingEventPublisher,
  BillingReleasePort,
} from "../src/modules/billing/billing.types.js";
import { initContext } from "./helpers/init-context.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres billing checks skipped";

interface Harness {
  manager: DatabaseManager;
  repository: BillingRepository;
  service: BillingService;
  module: ReturnType<typeof createBillingModule>;
  tableId: string;
  menuItemIds: string[];
  orderId: string;
  settled: Array<{ tableId: string; billPaidAt: string }>;
}

async function withHarness<T>(fn: (harness: Harness) => Promise<T>): Promise<T> {
  const manager = new DatabaseManager({ shutdownTimeoutMs: 3_000 });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));

  const code = `b${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
  const table = await manager.query<{ id: string }>(
    `INSERT INTO restaurant_tables
       (code, name, status, session_started_at, bill_status, bill_requested_at)
     VALUES ($1, $2, 'active', now(), 'requested', now())
     RETURNING id`,
    [code, `Billing ${code}`],
  );
  const tableId = table.rows[0]?.id;
  assert.ok(tableId);

  const itemRows = await manager.query<{ id: string }>(
    `INSERT INTO menu_items (name, price, category, description)
     VALUES ($1, 120.00, 'Main Course', 'Billing dosa'),
            ($2, 40.50, 'Beverages', 'Billing chai'),
            ($3, 10.00, 'Beverages', 'Billing water')
     RETURNING id`,
    [
      `Billing Dosa ${randomUUID().slice(0, 8)}`,
      `Billing Chai ${randomUUID().slice(0, 8)}`,
      `Billing Water ${randomUUID().slice(0, 8)}`,
    ],
  );
  const menuItemIds = itemRows.rows.map((row) => row.id);
  assert.equal(menuItemIds.length, 3);

  const order = await manager.query<{ id: string }>(
    `INSERT INTO orders (table_id, status, total)
     VALUES ($1, 'pending', 290.50)
     RETURNING id`,
    [tableId],
  );
  const orderId = order.rows[0]?.id;
  assert.ok(orderId);

  await manager.query(
    `INSERT INTO order_items
       (order_id, menu_item_id, quantity, unit_price, added_by, request_note, allergy_note)
     VALUES ($1, $2, 2, 120.00, 'Asha', '', ''),
            ($1, $3, 1, 40.50, 'Ravi', '', ''),
            ($1, $4, 1, 10.00, '', '', '')`,
    [orderId, menuItemIds[0], menuItemIds[1], menuItemIds[2]],
  );

  // A refused round is not a debt and must not appear on the bill.
  const denied = await manager.query<{ id: string }>(
    `INSERT INTO orders (table_id, status, total, denial_reason)
     VALUES ($1, 'denied', 999.00, 'kitchen unavailable')
     RETURNING id`,
    [tableId],
  );
  const deniedId = denied.rows[0]?.id;
  assert.ok(deniedId);
  await manager.query(
    `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, added_by)
     VALUES ($1, $2, 1, 999.00, 'Asha')`,
    [deniedId, menuItemIds[0]],
  );

  const repository = new BillingRepository(manager);
  const settled: Array<{ tableId: string; billPaidAt: string }> = [];
  const events: BillingEventPublisher = {
    billSettled: (payload) => settled.push({ ...payload }),
  };
  const release: BillingReleasePort = {
    async checkAndAutoReleaseTable() {
      return { released: false };
    },
  };
  const service = new BillingService({
    repository,
    release,
    events,
    taxRateBps: 500,
    discountMinor: 100,
  });
  const module = createBillingModule({ db: manager, release, events });

  const harness: Harness = {
    manager,
    repository,
    service,
    module,
    tableId,
    menuItemIds,
    orderId,
    settled,
  };

  try {
    return await fn(harness);
  } finally {
    await manager.query("DELETE FROM orders WHERE table_id = $1", [tableId]);
    await manager.query("DELETE FROM sales_rollup WHERE menu_item_id = ANY($1::uuid[])", [
      menuItemIds,
    ]);
    await manager.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [menuItemIds]);
    await manager.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
    await manager.shutdown();
  }
}

describe("Billing module — real Postgres", () => {
  it("reads the session bill with frozen prices and excludes denied rounds", async () => {
    await withHarness(async (harness) => {
      const bill = await harness.service.getBill(harness.tableId);

      assert.equal(bill.status, "requested");
      assert.equal(bill.line_items.length, 3);
      // Lines carry no insertion order (order_items has no created_at), so
      // compare them by name rather than by the generated ids' random order.
      assert.deepEqual(
        [...bill.line_items]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((line) => [line.name.startsWith("Billing"), line.quantity, line.unit_price, line.line_total]),
        [
          [true, 1, "40.50", "40.50"], // Chai
          [true, 2, "120.00", "240.00"], // Dosa
          [true, 1, "10.00", "10.00"], // Water
        ],
      );
      assert.ok(bill.line_items.every((line) => line.order_id === harness.orderId));

      assert.deepEqual(
        bill.allocations.map((allocation) => [allocation.name, allocation.subtotal]),
        [
          ["Asha", "240.00"],
          ["Ravi", "40.50"],
          ["Table", "10.00"],
        ],
      );

      // (290.50 − 1.00) × 5% = 14.475 → 14.48
      assert.equal(bill.totals.subtotal_minor, 29_050);
      assert.equal(bill.totals.discount_minor, 100);
      assert.equal(bill.totals.tax_minor, 1_448);
      assert.equal(bill.totals.total_minor, 30_398);
      assert.equal(bill.totals.total, "303.98");

      const rows = await harness.repository.listOrders(
        harness.tableId,
        new Date(bill.session_started_at ?? Date.now()),
      );
      assert.equal(rows.length, 1, "the denied order is not part of the bill");
    });
  });

  it("returns the same bill on repeated generation and writes nothing", async () => {
    await withHarness(async (harness) => {
      const before = await harness.manager.query<{ status: string; paid: boolean }>(
        `SELECT bill_status AS status, bill_paid_at IS NOT NULL AS paid
           FROM restaurant_tables WHERE id = $1`,
        [harness.tableId],
      );

      const first = await harness.service.getBill(harness.tableId);
      const second = await harness.service.getBill(harness.tableId);
      assert.deepEqual(second, first);

      const after = await harness.manager.query<{ status: string; paid: boolean }>(
        `SELECT bill_status AS status, bill_paid_at IS NOT NULL AS paid
           FROM restaurant_tables WHERE id = $1`,
        [harness.tableId],
      );
      assert.deepEqual(after.rows[0], before.rows[0]);
    });
  });

  it("persists settlement and announces the transition only once", async () => {
    await withHarness(async (harness) => {
      const first = await harness.service.settleBill(harness.tableId);
      assert.equal(first.bill_status, "paid");
      assert.equal(first.released, false);

      const row = await harness.manager.query<{ bill_status: string; paid_at: Date | null }>(
        "SELECT bill_status, bill_paid_at AS paid_at FROM restaurant_tables WHERE id = $1",
        [harness.tableId],
      );
      assert.equal(row.rows[0]?.bill_status, "paid");
      assert.ok(row.rows[0]?.paid_at instanceof Date);

      const paidBill = await harness.service.getBill(harness.tableId);
      assert.equal(paidBill.status, "paid");
      assert.ok(paidBill.bill_paid_at);

      await harness.service.settleBill(harness.tableId);
      assert.equal(harness.settled.length, 1);
    });
  });

  it("reports a missing table and leaves unknown ids untouched", async () => {
    await withHarness(async (harness) => {
      const unknown = "99999999-9999-4999-8999-999999999999";
      await assert.rejects(harness.service.getBill(unknown), (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "TABLE_NOT_FOUND");
        return true;
      });
      await assert.rejects(harness.service.settleBill(unknown), (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "TABLE_NOT_FOUND");
        return true;
      });
      assert.equal(await harness.repository.markPaid(unknown), null);
    });
  });

  it("passes its schema health check", async () => {
    await withHarness(async (harness) => {
      assert.deepEqual(await harness.repository.schemaObjects(), {
        present: ["restaurant_tables", "orders", "order_items"],
        missing: [],
      });
      assert.equal((await harness.module.health()).state, "HEALTHY");
      assert.equal((await harness.module.selfTest()).ok, true);
    });
  });
});
