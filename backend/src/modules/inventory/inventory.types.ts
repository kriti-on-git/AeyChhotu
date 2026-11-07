/* Inventory module — contracts.

   OWNERSHIP: `menu_items` is owned by the Menu module for catalogue content,
   but exactly three columns — `stock_quantity`, `low_stock_threshold` and
   `stock_updated_at` — are owned by Inventory. Only Inventory writes them.
   `is_available` remains Menu's 86 switch (E14) so the existing API contract
   is untouched; Inventory reads it as one input to availability.

   STOCK IS OPTIONAL. NULL means the kitchen keeps no count. It is never
   treated as zero: an untracked dish is availability-valid and cannot be
   decremented until someone establishes a count. A tracked count of zero
   reads as "out", exactly like the admin insights contract already does.

   Every stock write goes through the repository inside one transaction that
   locks the item row, updates the count and appends an inventory_movements
   row. There is no service code that mutates stock outside that boundary. */

export type StockState = "out" | "low" | "ok" | "untracked";

export type StockReason =
  | "manual"
  | "delivery"
  | "wastage"
  | "stocktake"
  | "order"
  | "order_restore";

export type InventoryItemRow = {
  id: string;
  name: string;
  category: string;
  is_available: boolean;
  stock_quantity: number | null;
  low_stock_threshold: number;
  stock_updated_at: Date | null;
};

export type InventoryMovementRow = {
  id: string;
  menu_item_id: string;
  order_id: string | null;
  delta: number | null;
  previous_quantity: number | null;
  new_quantity: number | null;
  reason: string;
  created_at: Date;
};

export type InventoryItem = {
  menu_item_id: string;
  name: string;
  category: string;
  is_available: boolean;
  /** null means untracked, never zero. */
  stock_quantity: number | null;
  low_stock_threshold: number;
  state: StockState;
  stock_updated_at: string | null;
};

export type InventoryMovement = {
  movement_id: string;
  menu_item_id: string;
  order_id: string | null;
  delta: number | null;
  previous_quantity: number | null;
  new_quantity: number | null;
  reason: string;
  created_at: string;
};

export type StockSummary = {
  tracked: number;
  out: number;
  low: number;
  ok: number;
  untracked: number;
};

export type StockList = {
  items: InventoryItem[];
  summary: StockSummary;
};

export type StockListParams = {
  state?: StockState;
};

export type SetStockInput = {
  /** Omitted leaves the count unchanged; null clears tracking. */
  stock_quantity?: number | null;
  low_stock_threshold?: number;
};

export type AdjustStockInput = {
  /** Non-zero signed count; negative is a reduction. */
  delta: number;
  reason: StockReason;
  order_id?: string | null;
};

export type RestoreStockInput = {
  /** Positive count returned to stock. */
  quantity: number;
  order_id?: string | null;
};

export type AvailabilityRequest = {
  menu_item_id: string;
  /** Defaults to 1. */
  quantity?: number;
};

export type AvailabilityRow = {
  menu_item_id: string;
  name: string;
  is_available: boolean;
  stock_quantity: number | null;
};

export type AvailabilityReason =
  | "unavailable"
  | "out_of_stock"
  | "insufficient_stock"
  | "unknown_item";

export type AvailabilityResult = {
  menu_item_id: string;
  name: string | null;
  available: boolean;
  reason: AvailabilityReason | null;
  stock_quantity: number | null;
  requested: number;
};

export type InventorySchemaPresence = {
  readonly present: readonly string[];
  readonly missing: readonly string[];
};

export interface InventoryRepositoryPort {
  listStock(): Promise<InventoryItemRow[]>;
  findItem(menuItemId: string): Promise<InventoryItemRow | null>;
  listMovements(menuItemId: string, limit: number): Promise<InventoryMovementRow[]>;
  /** Atomic: lock → update count → append movement. Null for unknown items. */
  setStock(
    menuItemId: string,
    input: SetStockInput,
  ): Promise<{ item: InventoryItemRow; movement: InventoryMovementRow } | null>;
  /** Atomic. Throws STOCK_UNTRACKED / NEGATIVE_STOCK; null for unknown items. */
  adjustStock(
    menuItemId: string,
    input: AdjustStockInput,
  ): Promise<{ item: InventoryItemRow; movement: InventoryMovementRow } | null>;
  findAvailability(menuItemIds: readonly string[]): Promise<AvailabilityRow[]>;
  schemaObjects(): Promise<InventorySchemaPresence>;
}

export interface InventoryServicePort {
  listStock(params: StockListParams): Promise<StockList>;
  getItem(menuItemId: string): Promise<InventoryItem>;
  listMovements(menuItemId: string, limit: number): Promise<InventoryMovement[]>;
  setStock(menuItemId: string, input: SetStockInput): Promise<InventoryItem>;
  adjustStock(menuItemId: string, input: AdjustStockInput): Promise<InventoryItem>;
  restoreStock(menuItemId: string, input: RestoreStockInput): Promise<InventoryItem>;
  /** Read-only availability check for callers such as Orders/Menu. */
  checkAvailability(
    requests: readonly AvailabilityRequest[],
  ): Promise<AvailabilityResult[]>;
}
