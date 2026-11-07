/* Billing module — business rules.

   A bill is generated on demand from the frozen order lines of one seating.
   Generation writes nothing, so asking twice is naturally idempotent and can
   never create a duplicate bill row. Settlement is the only write, and it
   keeps the existing response shape while asking the Table module's release
   engine whether the seating can be handed to the next party.

   TAX/DISCOUNT are supported as integer arithmetic but are configured as
   zero until the restaurant defines a rate; this preserves today's totals
   exactly. No client can set a rate or a discount. */

import { AppError } from "../../errors/app-error.js";
import { iso } from "../../lib/util.js";
import { formatMinor, taxMinor, toMinor } from "./billing.money.js";
import type {
  Bill,
  BillAllocation,
  BillLine,
  BillTotals,
  BillingEventPublisher,
  BillingReleasePort,
  BillingRepositoryPort,
  BillingServicePort,
  SettleBillResult,
} from "./billing.types.js";
import { NOOP_BILLING_EVENTS } from "./billing.events.js";

export interface BillingServiceDeps {
  readonly repository: BillingRepositoryPort;
  readonly release?: BillingReleasePort;
  readonly events?: BillingEventPublisher;
  /** Optional rate in basis points; defaults to no tax. */
  readonly taxRateBps?: number;
  /** Optional fixed bill discount in paise; defaults to none. */
  readonly discountMinor?: number;
  readonly onPublishError?: (err: unknown) => void;
}

function notFound(): AppError {
  return new AppError(404, "TABLE_NOT_FOUND", "Invalid table id parsed.");
}

export class BillingService implements BillingServicePort {
  private readonly repository: BillingRepositoryPort;
  private readonly release?: BillingReleasePort;
  private readonly events: BillingEventPublisher;
  private readonly taxRateBps: number;
  private readonly discountMinor: number;
  private readonly onPublishError?: (err: unknown) => void;

  constructor(deps: BillingServiceDeps) {
    this.repository = deps.repository;
    this.release = deps.release;
    this.events = deps.events ?? NOOP_BILLING_EVENTS;
    this.taxRateBps = deps.taxRateBps ?? 0;
    this.discountMinor = deps.discountMinor ?? 0;
    this.onPublishError = deps.onPublishError;

    if (!Number.isInteger(this.taxRateBps) || this.taxRateBps < 0 || this.taxRateBps > 10_000) {
      throw new Error("taxRateBps must be an integer between 0 and 10000.");
    }
    if (!Number.isInteger(this.discountMinor) || this.discountMinor < 0) {
      throw new Error("discountMinor must be a non-negative integer.");
    }
  }

  /* ----------------------------------------------------------- generation */

  async getBill(tableId: string): Promise<Bill> {
    const table = await this.repository.findBill(tableId);
    if (!table) throw notFound();

    const orders = await this.repository.listOrders(tableId, table.session_started_at);

    const lines: BillLine[] = [];
    for (const order of orders) {
      for (const item of order.items ?? []) {
        const unitMinor = toMinor(item.unit_price);
        const lineMinor = unitMinor * item.quantity;
        const addedBy = item.added_by.trim();
        const shared = addedBy === "";

        lines.push({
          order_id: order.order_id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          quantity: item.quantity,
          unit_price: formatMinor(unitMinor),
          unit_price_minor: unitMinor,
          line_total: formatMinor(lineMinor),
          line_total_minor: lineMinor,
          added_by: addedBy,
          allocated_to: shared ? null : addedBy,
          shared,
        });
      }
    }

    const totals = this.totalsFor(lines);
    const billId = `${table.id}:${table.session_started_at ? iso(table.session_started_at) : "open"}`;

    return {
      bill_id: billId,
      table_id: table.id,
      table: { code: table.code, name: table.name },
      status: table.bill_status,
      session_started_at: table.session_started_at ? iso(table.session_started_at) : null,
      bill_requested_at: table.bill_requested_at ? iso(table.bill_requested_at) : null,
      bill_paid_at: table.bill_paid_at ? iso(table.bill_paid_at) : null,
      currency: "INR",
      line_items: lines,
      allocations: this.allocationsFor(lines),
      totals,
    };
  }

  /* ---------------------------------------------------------- settlement */

  async settleBill(tableId: string): Promise<SettleBillResult> {
    const before = await this.repository.findBill(tableId);
    if (!before) throw notFound();

    const paid = await this.repository.markPaid(tableId);
    if (!paid) throw notFound();

    /* A release-engine failure must not turn a recorded payment into an HTTP
       error: the money is already recorded, and the periodic sweeper will
       re-evaluate the seating. */
    let released = false;
    if (this.release) {
      try {
        const outcome = await this.release.checkAndAutoReleaseTable(tableId);
        released = outcome.released === true;
      } catch (err) {
        this.onPublishError?.(err);
      }
    }

    const paidAt = iso(paid.bill_paid_at);
    if (before.bill_status !== "paid") {
      this.publish(() => this.events.billSettled({ tableId, billPaidAt: paidAt }));
    }

    return {
      table_id: paid.id,
      bill_status: "paid",
      bill_paid_at: paidAt,
      released,
    };
  }

  /* ------------------------------------------------------------ internals */

  private totalsFor(lines: readonly BillLine[]): BillTotals {
    const subtotalMinor = lines.reduce((sum, line) => sum + line.line_total_minor, 0);
    const discountMinor = Math.min(this.discountMinor, subtotalMinor);
    const taxableMinor = subtotalMinor - discountMinor;
    const tax = taxMinor(taxableMinor, this.taxRateBps);
    const totalMinor = taxableMinor + tax;

    return {
      subtotal_minor: subtotalMinor,
      tax_minor: tax,
      discount_minor: discountMinor,
      total_minor: totalMinor,
      subtotal: formatMinor(subtotalMinor),
      tax: formatMinor(tax),
      discount: formatMinor(discountMinor),
      total: formatMinor(totalMinor),
    };
  }

  /** Groups by the person who added each line. `added_by === ""` means the
      dish is shared and stays under the table's own allocation. */
  private allocationsFor(lines: readonly BillLine[]): BillAllocation[] {
    const guests = new Map<string, BillAllocation>();
    let shared: BillAllocation | null = null;

    for (const line of lines) {
      if (line.shared) {
        shared ??= {
          name: "Table",
          shared: true,
          line_count: 0,
          quantity: 0,
          subtotal_minor: 0,
          subtotal: "0.00",
        };
        shared.line_count += 1;
        shared.quantity += line.quantity;
        shared.subtotal_minor += line.line_total_minor;
        continue;
      }

      const name = line.allocated_to ?? "Table";
      const entry = guests.get(name) ?? {
        name,
        shared: false,
        line_count: 0,
        quantity: 0,
        subtotal_minor: 0,
        subtotal: "0.00",
      };
      entry.line_count += 1;
      entry.quantity += line.quantity;
      entry.subtotal_minor += line.line_total_minor;
      guests.set(name, entry);
    }

    const result = [...guests.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (shared) result.push(shared);
    for (const allocation of result) {
      allocation.subtotal = formatMinor(allocation.subtotal_minor);
    }
    return result;
  }

  private publish(work: () => void): void {
    try {
      work();
    } catch (err) {
      this.onPublishError?.(err);
    }
  }
}
