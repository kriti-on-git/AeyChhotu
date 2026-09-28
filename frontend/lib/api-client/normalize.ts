/* Normalizers — map contract (docs/7 v2) payloads onto the UI domain types
   in lib/api/types.ts so screen components keep their existing markup and
   Tailwind classes untouched. Also the shared offline detector used by the
   live-with-mock-fallback data hooks. */

import { ApiError } from "./errors";
import type {
  CartLine as ApiCartLine,
  FloorTable as FloorTableResponse,
  KdsTicket,
  OrderHistoryItem,
  OrderItemLine,
  TableSession,
} from "./types";
import type {
  CartLine,
  FloorTableSummary,
  MenuItem,
  Order,
  OrderItem,
  OrderStatus,
  RestaurantTable,
} from "../api/types";
import type { MenuItem as ApiMenuItem } from "./types";

/** True when the request never reached the backend (down / timeout / unconfigured). */
export function isOfflineError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/**
 * May the offline demo store stand in for the live API?
 *
 * Default: ON in development, OFF in a production build. A production
 * deployment must never quietly serve seeded demo data because
 * NEXT_PUBLIC_API_URL points somewhere unreachable — that failure looks
 * exactly like a working restaurant and is invisible from the outside.
 *
 * Set NEXT_PUBLIC_ENABLE_DEMO_FALLBACK=true to opt back in deliberately
 * (e.g. a public demo deployment that intentionally has no backend).
 */
export function demoFallbackEnabled(): boolean {
  const raw = process.env.NEXT_PUBLIC_ENABLE_DEMO_FALLBACK?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * The single predicate every demo/mock path goes through: the request never
 * reached the backend AND the demo store is permitted here. Keeping both
 * conditions in one export means a newly added fallback path cannot forget
 * the production gate.
 */
export function shouldUseDemoFallback(error: unknown): boolean {
  return isOfflineError(error) && demoFallbackEnabled();
}

/** ServiceResult-shaped failure from the mock layer → ApiError for one code path. */
export function apiErrorFromServiceFailure(failure: {
  code: string;
  message: string;
  sold_out?: string[];
}): ApiError {
  const status =
    failure.code === "table_not_found" || failure.code === "invalid_pin"
      ? failure.code === "table_not_found"
        ? 404
        : 401
      : failure.code === "unauthorized"
        ? 401
        : 409;
  return new ApiError(status, failure.code.toUpperCase(), failure.message, {
    sold_out: failure.sold_out ?? [],
  });
}

export function toTable(session: TableSession): RestaurantTable {
  return { id: session.table_id, code: session.code, name: session.name };
}

export function toMenuItem(item: ApiMenuItem): MenuItem {
  return {
    id: item.menu_item_id,
    name: item.name,
    price: item.price,
    category: item.category,
    is_available: item.is_available,
    description: item.description,
    vegetarian: item.vegetarian,
  };
}

export function toCartLine(line: ApiCartLine): CartLine {
  return {
    id: line.id,
    table_id: line.table_id,
    menu_item_id: line.menu_item_id,
    quantity: line.quantity,
    request_note: line.request_note,
    allergy_note: line.allergy_note,
    added_by: line.added_by,
  };
}

function toOrderItems(orderId: string, items: OrderItemLine[]): OrderItem[] {
  return items.map((item, index) => ({
    id: `${orderId}-item-${index}`,
    order_id: orderId,
    menu_item_id: item.menu_item_id,
    name: item.name,
    price: 0,
    quantity: item.quantity,
    request_note: item.request_note,
    allergy_note: item.allergy_note,
    added_by: "",
  }));
}

export function toOrder(
  row: OrderHistoryItem,
  tableCode: string,
): Order {
  return {
    id: row.order_id,
    table_id: row.table_id,
    table_code: tableCode,
    status: row.status as OrderStatus,
    created_at: row.created_at,
    updated_at: row.created_at,
    items: toOrderItems(row.order_id, row.items),
  };
}

/** E17 floor row → the UI's FloorTableSummary, so the floor screen keeps its
    existing markup while reading live data. Mirrors toOrder/toKdsOrder:
    `price` is not part of the floor payload, so it is 0 — the floor card
    shows pacing and allergies, never money. */
export function toFloorSummary(row: FloorTableResponse): FloorTableSummary {
  return {
    table: { id: row.table_id, code: row.code, name: row.name },
    active_order: row.active_order
      ? {
          id: row.active_order.order_id,
          table_id: row.table_id,
          table_code: row.code,
          status: row.active_order.status,
          created_at: row.active_order.created_at,
          updated_at: row.active_order.created_at,
          items: toOrderItems(row.active_order.order_id, row.active_order.items ?? []),
        }
      : null,
    cart_line_count: row.cart_line_count,
  };
}

export function toKdsOrder(ticket: KdsTicket): Order {
  return {
    id: ticket.order_id,
    table_id: ticket.table.id,
    table_code: ticket.table.code,
    status: ticket.status as OrderStatus,
    created_at: ticket.created_at,
    updated_at: ticket.created_at,
    items: toOrderItems(ticket.order_id, ticket.items),
  };
}
