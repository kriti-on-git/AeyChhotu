/* Cart module — contracts.

   One shared cart per table session. The repository port is storage only;
   the service port is the behaviour controllers and the compatibility seam
   consume. Table and Menu are reached through narrow public ports, and
   realtime through the existing RealtimePublisher surface, never Socket.IO. */

import type { PageMeta } from "../../lib/util.js";
import type { RealtimePublisher } from "../../infrastructure/realtime/RealtimePublisher.js";
import type { MenuServicePort } from "../menu/menu.types.js";
import type { TableServicePort } from "../table/table.types.js";

/** E4 row. Kept a type alias so the DbPort query generic accepts it. */
export type CartRow = {
  id: string;
  table_id: string;
  menu_item_id: string;
  quantity: number;
  request_note: string;
  allergy_note: string;
  added_by: string;
};

export type CartLineWithTotal = CartRow & {
  total_table_quantity: number;
};

export type CartListParams = {
  table_token: string;
  page: number;
  limit: number;
};

export type CartAddInput = {
  table_token: string;
  menu_item_id: string;
  quantity: number;
  allergy_note?: string;
  request_note?: string;
  /** The diner's name, as collected by the session gate. */
  added_by: string;
};

export type CartUpdateInput = {
  table_token: string;
  quantity?: number;
  /** +/- stepper intent, applied atomically as quantity = quantity + delta. */
  quantity_delta?: number;
  request_note?: string;
  allergy_note?: string;
};

export type CartRemovalResult = {
  id: string;
  message: string;
};

export type CartClearResult = {
  removed: number;
};

export type CartLineInsert = {
  menuItemId: string;
  quantity: number;
  requestNote: string;
  allergyNote: string;
  addedBy: string;
};

export type CartSchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

/** Cross-module contracts, narrowed to the one method each needs. */
export type CartTablePort = Pick<TableServicePort, "requireTable">;
export type CartMenuPort = Pick<MenuServicePort, "findCartItem">;
export type CartRealtimePort = Pick<RealtimePublisher, "toTable">;

export type CartRealtimeAction = "added" | "updated" | "removed" | "cleared";

export type CartRealtimePayload = {
  table_id: string;
  action: CartRealtimeAction;
  /** Present for added/updated, null for removed/cleared. */
  line: CartLineWithTotal | null;
};

/** The transaction surface the service sees. No SQL and no pg types. */
export interface CartTransactionPort {
  lockLine(tableId: string, cartItemId: string): Promise<CartRow | null>;
  findClashingLine(
    tableId: string,
    menuItemId: string,
    requestNote: string,
    allergyNote: string,
    excludeId: string,
  ): Promise<CartRow | null>;
  mergeLine(existingId: string, addQuantity: number): Promise<CartRow | null>;
  updateLine(
    lineId: string,
    tableId: string,
    quantity: number,
    requestNote: string,
    allergyNote: string,
  ): Promise<CartRow | null>;
  deleteLine(lineId: string): Promise<void>;
}

/** Storage contract. Every statement for cart_items lives here. */
export interface CartRepositoryPort {
  countForTable(tableId: string): Promise<number>;
  listForTable(tableId: string, limit: number, offset: number): Promise<CartRow[]>;
  addLine(tableId: string, input: CartLineInsert): Promise<CartRow>;
  findLine(tableId: string, cartItemId: string): Promise<CartRow | null>;
  deleteLine(tableId: string, cartItemId: string): Promise<boolean>;
  deleteForTable(tableId: string): Promise<number>;
  totalForTableItem(tableId: string, menuItemId: string): Promise<number>;
  transaction<T>(work: (tx: CartTransactionPort) => Promise<T>): Promise<T>;
  schemaObjects(): Promise<CartSchemaPresence>;
}

export interface CartServicePort {
  listCart(params: CartListParams): Promise<{ data: CartRow[]; meta: PageMeta }>;
  addItem(input: CartAddInput): Promise<CartLineWithTotal>;
  updateItem(cartItemId: string, input: CartUpdateInput): Promise<CartLineWithTotal>;
  removeItem(tableToken: string, cartItemId: string): Promise<CartRemovalResult>;
  /** Internal capability (settle/fire drains through SQL); no public route. */
  clearCart(tableToken: string): Promise<CartClearResult>;
}
