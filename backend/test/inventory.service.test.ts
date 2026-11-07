import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Inventory business rules with an in-memory repository: stock states,
   availability decisions, atomic-write delegation, restoration and movement
   mapping. No database or HTTP here. */

import { AppError } from "../src/errors/app-error.js";
import { InventoryService } from "../src/modules/inventory/inventory.service.js";
import type {
  AdjustStockInput,
  AvailabilityRow,
  InventoryItemRow,
  InventoryMovementRow,
  InventoryRepositoryPort,
  InventorySchemaPresence,
  SetStockInput,
} from "../src/modules/inventory/inventory.types.js";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-01-01T10:00:00.000Z");
const UPDATED = new Date("2026-01-01T11:00:00.000Z");

function row(overrides: Partial<InventoryItemRow> = {}): InventoryItemRow {
  return {
    id: ITEM_ID,
    name: "Masala Dosa",
    category: "Main Course",
    is_available: true,
    stock_quantity: 10,
    low_stock_threshold: 5,
    stock_updated_at: AT,
    ...overrides,
  };
}

class FakeRepository implements InventoryRepositoryPort {
  items: InventoryItemRow[] = [
    row(),
    row({ id: OTHER_ID, name: "Chai", stock_quantity: 3 }),
    row({ id: "33333333-3333-4333-8333-333333333333", name: "Water", stock_quantity: 0 }),
    row({ id: "44444444-4444-4444-8444-444444444444", name: "Lassi", stock_quantity: null }),
  ];
  movements: InventoryMovementRow[] = [];
  adjustCalls = 0;
  setCalls = 0;

  async listStock(): Promise<InventoryItemRow[]> {
    /* Mirrors the repository's SQL order: tracked counts ascending, then
       untracked, then name. */
    return [...this.items].sort((a, b) => {
      const aUntracked = a.stock_quantity === null ? 1 : 0;
      const bUntracked = b.stock_quantity === null ? 1 : 0;
      return (
        aUntracked - bUntracked ||
        (a.stock_quantity ?? 0) - (b.stock_quantity ?? 0) ||
        a.name.localeCompare(b.name)
      );
    });
  }

  async findItem(menuItemId: string): Promise<InventoryItemRow | null> {
    return this.items.find((item) => item.id === menuItemId) ?? null;
  }

  async listMovements(menuItemId: string, limit: number): Promise<InventoryMovementRow[]> {
    return this.movements
      .filter((movement) => movement.menu_item_id === menuItemId)
      .slice(0, limit);
  }

  private replace(menuItemId: string, next: Partial<InventoryItemRow>): InventoryItemRow {
    const index = this.items.findIndex((item) => item.id === menuItemId);
    const current = this.items[index];
    assert.ok(current);
    const updated = { ...current, ...next, stock_updated_at: UPDATED };
    this.items[index] = updated;
    return updated;
  }

  async setStock(
    menuItemId: string,
    input: SetStockInput,
  ): Promise<{ item: InventoryItemRow; movement: InventoryMovementRow } | null> {
    this.setCalls += 1;
    const current = await this.findItem(menuItemId);
    if (!current) return null;

    const nextQuantity =
      input.stock_quantity === undefined ? current.stock_quantity : input.stock_quantity;
    const updated = this.replace(menuItemId, {
      stock_quantity: nextQuantity,
      low_stock_threshold: input.low_stock_threshold ?? current.low_stock_threshold,
    });
    const delta =
      current.stock_quantity === null ||
      nextQuantity === null ||
      nextQuantity === current.stock_quantity
        ? null
        : nextQuantity - current.stock_quantity;
    const movement: InventoryMovementRow = {
      id: `movement-${this.movements.length + 1}`,
      menu_item_id: menuItemId,
      order_id: null,
      delta,
      previous_quantity: current.stock_quantity,
      new_quantity: nextQuantity,
      reason: "manual",
      created_at: UPDATED,
    };
    this.movements.unshift(movement);
    return { item: updated, movement };
  }

  async adjustStock(
    menuItemId: string,
    input: AdjustStockInput,
  ): Promise<{ item: InventoryItemRow; movement: InventoryMovementRow } | null> {
    this.adjustCalls += 1;
    const current = await this.findItem(menuItemId);
    if (!current) return null;
    if (current.stock_quantity === null) {
      throw new AppError(409, "STOCK_UNTRACKED", `${current.name} has no tracked count.`);
    }

    const next = current.stock_quantity + input.delta;
    if (next < 0) {
      throw new AppError(409, "NEGATIVE_STOCK", `Only ${current.stock_quantity} remain.`, {
        available: current.stock_quantity,
        requested: Math.abs(input.delta),
      });
    }

    const updated = this.replace(menuItemId, { stock_quantity: next });
    const movement: InventoryMovementRow = {
      id: `movement-${this.movements.length + 1}`,
      menu_item_id: menuItemId,
      order_id: input.order_id ?? null,
      delta: input.delta,
      previous_quantity: current.stock_quantity,
      new_quantity: next,
      reason: input.reason,
      created_at: UPDATED,
    };
    this.movements.unshift(movement);
    return { item: updated, movement };
  }

  async findAvailability(ids: readonly string[]): Promise<AvailabilityRow[]> {
    return this.items
      .filter((item) => ids.includes(item.id))
      .map((item) => ({
        menu_item_id: item.id,
        name: item.name,
        is_available: item.is_available,
        stock_quantity: item.stock_quantity,
      }));
  }

  async schemaObjects(): Promise<InventorySchemaPresence> {
    return { present: [], missing: [] };
  }
}

function serviceWith(repository = new FakeRepository()) {
  return { service: new InventoryService({ repository }), repository };
}

describe("InventoryService — reads and states", () => {
  it("classifies untracked, out, low and ok without treating NULL as zero", async () => {
    const { service } = serviceWith();
    const stock = await service.listStock({});

    assert.deepEqual(
      stock.items.map((item) => [item.name, item.stock_quantity, item.state]),
      [
        ["Water", 0, "out"],
        ["Chai", 3, "low"],
        ["Masala Dosa", 10, "ok"],
        ["Lassi", null, "untracked"],
      ],
    );
    assert.deepEqual(stock.summary, {
      tracked: 3,
      out: 1,
      low: 1,
      ok: 1,
      untracked: 1,
    });
  });

  it("filters by state while keeping the summary whole", async () => {
    const { service } = serviceWith();
    const stock = await service.listStock({ state: "low" });

    assert.deepEqual(stock.items.map((item) => item.name), ["Chai"]);
    assert.equal(stock.summary.untracked, 1);
    assert.equal(stock.summary.tracked, 3);
  });

  it("returns a single item and maps timestamps", async () => {
    const { service } = serviceWith();
    const item = await service.getItem(ITEM_ID);

    assert.equal(item.menu_item_id, ITEM_ID);
    assert.equal(item.state, "ok");
    assert.equal(item.stock_updated_at, "2026-01-01T10:00:00Z");
  });

  it("returns MENU_ITEM_NOT_FOUND for an unknown dish", async () => {
    const { service } = serviceWith();
    await assert.rejects(service.getItem("99999999-9999-4999-8999-999999999999"), (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "MENU_ITEM_NOT_FOUND");
      return true;
    });
  });
});

describe("InventoryService — stock writes", () => {
  it("sets an absolute count and delegates the movement to the repository", async () => {
    const { service, repository } = serviceWith();
    const item = await service.setStock(ITEM_ID, { stock_quantity: 4 });

    assert.equal(item.stock_quantity, 4);
    assert.equal(item.state, "low");
    assert.equal(repository.setCalls, 1);
    assert.deepEqual(
      repository.movements.map((movement) => [
        movement.delta,
        movement.previous_quantity,
        movement.new_quantity,
        movement.reason,
      ]),
      [[-6, 10, 4, "manual"]],
    );
  });

  it("clears tracking with a null count and records no delta", async () => {
    const { service, repository } = serviceWith();
    const item = await service.setStock(ITEM_ID, { stock_quantity: null });

    assert.equal(item.stock_quantity, null);
    assert.equal(item.state, "untracked");
    assert.equal(repository.movements[0]?.delta, null);
    assert.equal(repository.movements[0]?.new_quantity, null);
  });

  it("applies a signed adjustment and records its reason/order", async () => {
    const { service, repository } = serviceWith();
    const item = await service.adjustStock(ITEM_ID, {
      delta: -2,
      reason: "wastage",
      order_id: OTHER_ID,
    });

    assert.equal(item.stock_quantity, 8);
    assert.deepEqual(repository.movements[0], {
      id: "movement-1",
      menu_item_id: ITEM_ID,
      order_id: OTHER_ID,
      delta: -2,
      previous_quantity: 10,
      new_quantity: 8,
      reason: "wastage",
      created_at: UPDATED,
    });
  });

  it("refuses to drive tracked stock below zero and writes nothing", async () => {
    const { service, repository } = serviceWith();
    await assert.rejects(
      service.adjustStock(ITEM_ID, { delta: -11, reason: "wastage" }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "NEGATIVE_STOCK");
        assert.deepEqual(err.details, { available: 10, requested: 11 });
        return true;
      },
    );
    assert.equal(repository.movements.length, 0);
  });

  it("refuses to adjust an untracked dish", async () => {
    const { service } = serviceWith();
    await assert.rejects(
      service.adjustStock("44444444-4444-4444-8444-444444444444", {
        delta: -1,
        reason: "wastage",
      }),
      (err) => err instanceof AppError && err.code === "STOCK_UNTRACKED",
    );
  });

  it("rejects a zero adjustment before touching the repository", async () => {
    const { service, repository } = serviceWith();
    await assert.rejects(
      service.adjustStock(ITEM_ID, { delta: 0, reason: "manual" }),
      (err) => err instanceof AppError && err.code === "VALIDATION_ERROR",
    );
    assert.equal(repository.adjustCalls, 0);
  });

  it("restores stock as a positive order_restore movement", async () => {
    const { service, repository } = serviceWith();
    const item = await service.restoreStock(ITEM_ID, {
      quantity: 3,
      order_id: OTHER_ID,
    });

    assert.equal(item.stock_quantity, 13);
    assert.equal(repository.movements[0]?.reason, "order_restore");
    assert.equal(repository.movements[0]?.delta, 3);
  });

  it("rejects a non-positive restoration", async () => {
    const { service } = serviceWith();
    await assert.rejects(
      service.restoreStock(ITEM_ID, { quantity: 0 }),
      (err) => err instanceof AppError && err.code === "VALIDATION_ERROR",
    );
  });
});

describe("InventoryService — availability", () => {
  it("explains the precise reason a line cannot be served", async () => {
    const { service, repository } = serviceWith();
    repository.items[2] = row({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Water",
      is_available: false,
      stock_quantity: 0,
    });

    const results = await service.checkAvailability([
      { menu_item_id: ITEM_ID, quantity: 2 }, // 10 in stock
      { menu_item_id: OTHER_ID, quantity: 4 }, // 3 in stock
      { menu_item_id: "33333333-3333-4333-8333-333333333333" }, // 86'd
      { menu_item_id: "44444444-4444-4444-8444-444444444444" }, // untracked
      { menu_item_id: "99999999-9999-4999-8999-999999999999" }, // missing
    ]);

    assert.deepEqual(
      results.map((result) => [result.available, result.reason, result.requested]),
      [
        [true, null, 2],
        [false, "insufficient_stock", 4],
        [false, "unavailable", 1],
        [true, null, 1],
        [false, "unknown_item", 1],
      ],
    );
  });

  it("treats a tracked zero as out of stock", async () => {
    const { service, repository } = serviceWith();
    repository.items[2] = row({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Water",
      stock_quantity: 0,
    });

    const [result] = await service.checkAvailability([
      { menu_item_id: "33333333-3333-4333-8333-333333333333" },
    ]);
    assert.equal(result?.available, false);
    assert.equal(result?.reason, "out_of_stock");
  });
});
