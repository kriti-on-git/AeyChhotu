/* Normalizers — map contract (docs/7 v2) payloads onto the UI domain types
   in lib/api/types.ts so screen components keep their existing markup and
   Tailwind classes untouched. Also the shared offline detector used by the
   live-with-mock-fallback data hooks. */

import { ApiError } from "./errors";
import type {
  CartLine as ApiCartLine,
  KdsTicket,
  OrderHistoryItem,
  OrderItemLine,
  TableSession,
} from "./types";
import type {
  CartLine,
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
