/* Billing module — contracts.

   The bill is a READ MODEL over the table session's frozen orders, not a
   second ledger. `orders.total` and `order_items.unit_price` were written at
   fire time (sql/004_hardening.sql), so a later menu re-price cannot rewrite
   a bill.

   ORDER IS NOT TICKET and TICKET IS NOT BILL: this module reads orders only to
   price the seating. Denied rounds are excluded because they were never
   cooked and are not a debt. Table owns the session and the release engine;
   Billing asks for the release decision through a narrow port. */

export type BillStatus = "unrequested" | "requested" | "paid";

export type BillingOrderItemRow = {
  menu_item_id: string;
  name: string;
  quantity: number;
  /** decimal string from numeric(10,2) — never a float */
  unit_price: string;
  added_by: string;
};

export type BillingOrderRow = {
  order_id: string;
  created_at: Date;
  /** decimal string from numeric(10,2) */
  total: string;
  status: string;
  items: BillingOrderItemRow[] | null;
};

export type BillTableRow = {
  id: string;
  code: string;
  name: string;
  bill_status: BillStatus;
  session_started_at: Date | null;
  bill_requested_at: Date | null;
  bill_paid_at: Date | null;
};

export type BillPaidRow = {
  id: string;
  bill_status: "paid";
  bill_paid_at: Date;
};

export type BillingSchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

export interface BillingRepositoryPort {
  findBill(tableId: string): Promise<BillTableRow | null>;
  /** Non-denied orders for this seating, with frozen lines. */
  listOrders(tableId: string, sessionStartedAt: Date | null): Promise<BillingOrderRow[]>;
  /** The settlement write; returns null for an unknown/archived table. */
  markPaid(tableId: string): Promise<BillPaidRow | null>;
  schemaObjects(): Promise<BillingSchemaPresence>;
}

/** Table's release engine, as a narrow port. */
export interface BillingReleasePort {
  checkAndAutoReleaseTable(tableId: string): Promise<{ released: boolean }>;
}

export interface BillingEventPublisher {
  billSettled(payload: {
    readonly tableId: string;
    readonly billPaidAt: string;
  }): void;
}

export type BillLine = {
  order_id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  /** charged at fire time, formatted exactly */
  unit_price: string;
  unit_price_minor: number;
  line_total: string;
  line_total_minor: number;
  added_by: string;
  /** null means the line belongs to the table, not one guest. */
  allocated_to: string | null;
  shared: boolean;
};

export type BillAllocation = {
  /** Guest name, or "Table" for shared lines. */
  name: string;
  shared: boolean;
  line_count: number;
  quantity: number;
  subtotal_minor: number;
  subtotal: string;
};

export type BillTotals = {
  subtotal_minor: number;
  tax_minor: number;
  discount_minor: number;
  total_minor: number;
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
};

export type Bill = {
  /** Deterministic for one seating; repeated generation returns the same id. */
  bill_id: string;
  table_id: string;
  table: { code: string; name: string };
  status: BillStatus;
  session_started_at: string | null;
  bill_requested_at: string | null;
  bill_paid_at: string | null;
  currency: "INR";
  line_items: BillLine[];
  /** Per-guest item totals; shared lines stay under "Table". */
  allocations: BillAllocation[];
  totals: BillTotals;
};

/** The unchanged E17 settle payload. */
export type SettleBillResult = {
  table_id: string;
  bill_status: "paid";
  bill_paid_at: string;
  released: boolean;
};

export interface BillingServicePort {
  /** Bill generation for one seating (idempotent read model). */
  getBill(tableId: string): Promise<Bill>;
  /** Take payment, then ask Table whether the seating can be released. */
  settleBill(tableId: string): Promise<SettleBillResult>;
}
