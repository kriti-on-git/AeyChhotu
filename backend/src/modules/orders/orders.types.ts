/* Orders module — contracts.

   The module owns everything that turns a table's cart into a ticket and
   keeps that ticket readable afterwards: order creation (fire), the status
   read, history, refusal, requeue, retry and dismissal.

   CROSS-MODULE BOUNDARY
   * Table is reached through the one method this module needs — resolving a
     table token, which is the single owner of the `deleted_at IS NULL` rule.
   * Cart and Menu are not imported. Their rows are read and drained inside
     the same atomic statement/RPC that creates the order, so there is no
     window where a cart is half-consumed.
   * Inventory validation is the `is_available` check inside `fire_order()`;
     the module sees only its outcome (a list of sold-out names).
   * Domain facts leave through OrdersEventPublisher, never through the
     transport.

   Every row type is a `type` alias, not an interface, so the shared DbPort
   query generic accepts it without a cast. */

import type { PageMeta } from "../../lib/util.js";
import type { DbTransaction } from "../../infrastructure/database/DatabaseManager.js";
import type { OrderWorkflowOutboxPort } from "../order-workflow/order-workflow.types.js";
import type { TableServicePort } from "../table/table.types.js";

/* ----------------------------------------------------------- fire_result */

/** Business outcomes the atomic fire RPC can answer with. */
export type FireResultCode =
  | "OK"
  | "TABLE_NOT_FOUND"
  | "DUPLICATE_ORDER"
  | "EMPTY_CART"
  | "INVENTORY_FAILURE";

/** The jsonb `fire_order()` returns. Business outcomes are values, not
    errors, because the INVENTORY_FAILURE cart purge still commits. */
export type FireResult = {
  code: FireResultCode;
  order_id?: string;
  table_id?: string;
  status?: string;
  created_at?: string;
  sold_out?: string[];
};

/** E8 response body. */
export type FiredOrder = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: string;
  message: string;
};

/* --------------------------------------------------------------- reads */

export type OrderStatus = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: string;
};

export type OrderItem = {
  menu_item_id: string;
  name: string;
  quantity: number;
  request_note: string;
  allergy_note: string;
  /** Who put it in the cart — copied onto the ticket by fire_order(). */
  added_by: string;
  /** Frozen at fire time — never today's menu price. */
  unit_price: number;
};

export type OrderListItem = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: string;
  /** Why the kitchen refused this round; '' for every other status. */
  denial_reason: string;
  items: OrderItem[];
  /** Bill frozen at fire time. */
  total: number;
};

export type OrdersListParams = {
  table_token: string;
  page: number;
  limit: number;
};

export type OrdersPage = {
  data: OrderListItem[];
  meta: PageMeta;
};

/* ------------------------------------------------------------ lifecycle */

export type RequeuedDeniedOrder = {
  order_id: string;
  /** How many lines went back into the shared cart. */
  moved: number;
  /** Names the cart could not take because the kitchen has none left. */
  omitted: string[];
};

export type RetriedDeniedOrder = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: string;
  /** How many lines went on the replacement ticket. */
  moved: number;
  /** Names the kitchen no longer has, left off the replacement ticket. */
  omitted: string[];
};

export type DismissedDeniedOrder = {
  order_id: string;
  dismissed: true;
};

/* ---------------------------------------------------------- storage rows */

export type OrderStatusRow = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: Date;
};

export type OrderListRow = {
  order_id: string;
  table_id: string;
  status: string;
  created_at: Date;
  denial_reason: string;
  total: string | number;
  items: OrderItem[] | null;
};

export type LockedOrderRow = {
  id: string;
  table_id: string;
  status: string;
};

export type DeniedLineRow = {
  menu_item_id: string;
  name: string;
  quantity: number;
  request_note: string;
  allergy_note: string;
  added_by: string;
  is_available: boolean;
};

export type DeniedOrderRef = {
  order_id: string;
  table_id: string;
};

export type CartLineMove = {
  menuItemId: string;
  quantity: number;
  requestNote: string;
  allergyNote: string;
  addedBy: string;
};

export type OrdersSchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

/* ------------------------------------------------------ cross-module ports */

/** Resolving the caller's table is the only Table capability Orders needs. */
export type OrdersTablePort = Pick<TableServicePort, "requireTable">;

/** Internal domain facts. Implemented at the composition root over the
    in-process event bus; a publish failure can never fail the order. */
/** The fire transaction hand-off to the durable order workflow outbox. */
export type OrdersWorkflowPort = Pick<OrderWorkflowOutboxPort, "enqueueOrderCreated">;

export interface OrdersEventPublisher {
  orderCreated(payload: { orderId: string; tableId: string; itemCount: number }): void;
  ticketCreated(payload: { ticketId: string; orderId: string; tableId: string }): void;
  orderDenied(payload: { orderId: string; tableId: string; reason: string }): void;
}

/* ------------------------------------------------------------- repository */

/** The transaction surface the service sees: no SQL, no pg types. */
export interface OrdersTransactionPort {
  /** Locks the order and proves it belongs to the presented table token. */
  lockOrderForTable(orderId: string, tableToken: string): Promise<LockedOrderRow | null>;
  listLines(orderId: string): Promise<DeniedLineRow[]>;
  /** Conflict-safe merge into the shared cart, same key as E5. */
  addCartLine(tableId: string, line: CartLineMove): Promise<void>;
  deleteOrder(orderId: string): Promise<void>;
  /** Runs the atomic fire inside the caller's transaction. */
  fire(tableToken: string): Promise<FireResult | null>;
}

/** Storage contract. Every order/order_items statement lives here. */
export interface OrdersRepositoryPort {
  /** Runs fire_order(); one statement, one transaction on the server. */
  fire(tableToken: string): Promise<FireResult | null>;
  countItems(orderId: string): Promise<number>;
  findOrderForTable(orderId: string, tableId: string): Promise<OrderStatusRow | null>;
  countForTable(tableId: string): Promise<number>;
  listForTable(tableId: string, limit: number, offset: number): Promise<OrderListRow[]>;
  /** Refuses active rounds that hold a dish; returns what it stopped. */
  denyPendingForItem(menuItemId: string, reason: string): Promise<DeniedOrderRef[]>;
  /** Removes one denied round outright (it was never cooked). */
  dismiss(orderId: string): Promise<void>;
  transaction<T>(work: (tx: OrdersTransactionPort) => Promise<T>): Promise<T>;
  schemaObjects(): Promise<OrdersSchemaPresence>;
}

/* ---------------------------------------------------------------- service */

export interface OrdersServicePort {
  /** E8 — create the table's order from its cart, atomically. */
  fireOrder(tableToken: string): Promise<FiredOrder>;
  /** E15 — status polling, scoped to the caller's table. */
  getOrderStatus(orderId: string, tableToken: string): Promise<OrderStatus>;
  /** E16 — newest-first history with frozen prices and totals. */
  listOrders(params: OrdersListParams): Promise<OrdersPage>;
  /** Cross-module capability consumed by Menu when a dish is 86'd. */
  denyPendingOrdersForItem(menuItemId: string, itemName: string): Promise<number>;
  requeueDeniedOrder(orderId: string, tableToken: string): Promise<RequeuedDeniedOrder>;
  retryDeniedOrder(orderId: string, tableToken: string): Promise<RetriedDeniedOrder>;
  dismissDeniedOrder(orderId: string, tableToken: string): Promise<DismissedDeniedOrder>;
}
