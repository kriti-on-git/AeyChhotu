/* Inventory module — business rules.

   Reads are cheap projections of the stock columns. Writes are decisions:
   absolute counts are set, signed adjustments are checked against the tracked
   count, and restoration is a positive adjustment with an audit reason. Every
   write is delegated to the repository's row-locked transaction, so the
   service never computes a new count from a value it did not lock.

   No stock is decremented by the order-fire path in this phase: today
   `fire_order()` validates `is_available` only, and changing that would alter
   an existing business rule (and another module). Inventory exposes
   `checkAvailability()` as the contract Orders can consume when that flow is
   explicitly migrated. Until then stock counts are operator-maintained. */

import { AppError } from "../../errors/app-error.js";
import { iso } from "../../lib/util.js";
import type {
  AdjustStockInput,
  AvailabilityReason,
  AvailabilityRequest,
  AvailabilityResult,
  InventoryItem,
  InventoryItemRow,
  InventoryMovement,
  InventoryMovementRow,
  InventoryRepositoryPort,
  InventoryServicePort,
  RestoreStockInput,
  SetStockInput,
  StockList,
  StockListParams,
  StockState,
  StockSummary,
} from "./inventory.types.js";

export interface InventoryServiceDeps {
  readonly repository: InventoryRepositoryPort;
}

function notFound(): AppError {
  return new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
}

function stateOf(row: InventoryItemRow): StockState {
  if (row.stock_quantity === null) return "untracked";
  if (row.stock_quantity <= 0) return "out";
  if (row.stock_quantity <= row.low_stock_threshold) return "low";
  return "ok";
}

function toItem(row: InventoryItemRow): InventoryItem {
  return {
    menu_item_id: row.id,
    name: row.name,
    category: row.category,
    is_available: row.is_available,
    stock_quantity: row.stock_quantity,
    low_stock_threshold: row.low_stock_threshold,
    state: stateOf(row),
    stock_updated_at: row.stock_updated_at ? iso(row.stock_updated_at) : null,
  };
}

function toMovement(row: InventoryMovementRow): InventoryMovement {
  return {
    movement_id: row.id,
    menu_item_id: row.menu_item_id,
    order_id: row.order_id,
    delta: row.delta,
    previous_quantity: row.previous_quantity,
    new_quantity: row.new_quantity,
    reason: row.reason,
    created_at: iso(row.created_at),
  };
}

function summarize(items: readonly InventoryItem[]): StockSummary {
  const summary: StockSummary = {
    tracked: 0,
    out: 0,
    low: 0,
    ok: 0,
    untracked: 0,
  };

  for (const item of items) {
    if (item.state === "untracked") {
      summary.untracked += 1;
      continue;
    }
    summary.tracked += 1;
    summary[item.state] += 1;
  }

  return summary;
}

export class InventoryService implements InventoryServicePort {
  private readonly repository: InventoryRepositoryPort;

  constructor(deps: InventoryServiceDeps) {
    this.repository = deps.repository;
  }

  async listStock(params: StockListParams): Promise<StockList> {
    const all = (await this.repository.listStock()).map(toItem);
    const items = params.state
      ? all.filter((item) => item.state === params.state)
      : all;
    return { items, summary: summarize(all) };
  }

  async getItem(menuItemId: string): Promise<InventoryItem> {
    const row = await this.repository.findItem(menuItemId);
    if (!row) throw notFound();
    return toItem(row);
  }

  async listMovements(menuItemId: string, limit: number): Promise<InventoryMovement[]> {
    await this.getItem(menuItemId);
    const rows = await this.repository.listMovements(menuItemId, limit);
    return rows.map(toMovement);
  }

  async setStock(menuItemId: string, input: SetStockInput): Promise<InventoryItem> {
    const result = await this.repository.setStock(menuItemId, input);
    if (!result) throw notFound();
    return toItem(result.item);
  }

  async adjustStock(menuItemId: string, input: AdjustStockInput): Promise<InventoryItem> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "A stock adjustment must be a non-zero whole number.", {
        fields: { delta: "Use a positive or negative whole number." },
      });
    }

    const result = await this.repository.adjustStock(menuItemId, input);
    if (!result) throw notFound();
    return toItem(result.item);
  }

  async restoreStock(
    menuItemId: string,
    input: RestoreStockInput,
  ): Promise<InventoryItem> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new AppError(400, "VALIDATION_ERROR", "Restored stock must be a positive whole number.", {
        fields: { quantity: "Use a whole number of at least 1." },
      });
    }

    const result = await this.repository.adjustStock(menuItemId, {
      delta: input.quantity,
      reason: "order_restore",
      order_id: input.order_id ?? null,
    });
    if (!result) throw notFound();
    return toItem(result.item);
  }

  async checkAvailability(
    requests: readonly AvailabilityRequest[],
  ): Promise<AvailabilityResult[]> {
    const ids = [...new Set(requests.map((request) => request.menu_item_id))];
    const rows = await this.repository.findAvailability(ids);
    const byId = new Map(rows.map((row) => [row.menu_item_id, row]));

    return requests.map((request) => {
      const requested = request.quantity ?? 1;
      const row = byId.get(request.menu_item_id);

      if (!row) {
        return {
          menu_item_id: request.menu_item_id,
          name: null,
          available: false,
          reason: "unknown_item" as AvailabilityReason,
          stock_quantity: null,
          requested,
        };
      }

      let reason: AvailabilityReason | null = null;
      if (!row.is_available) reason = "unavailable";
      else if (row.stock_quantity !== null && row.stock_quantity <= 0) reason = "out_of_stock";
      else if (row.stock_quantity !== null && row.stock_quantity < requested) {
        reason = "insufficient_stock";
      }

      return {
        menu_item_id: row.menu_item_id,
        name: row.name,
        available: reason === null,
        reason,
        stock_quantity: row.stock_quantity,
        requested,
      };
    });
  }
}
