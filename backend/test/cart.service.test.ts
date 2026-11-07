import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Hermetic Cart service checks: shared-cart arithmetic, ownership, note
   merging, validation, clearing and realtime publication. No database and no
   Socket.IO — the repository and publisher are fakes. */

import { AppError } from "../src/errors/app-error.js";
import { buildMeta } from "../src/lib/util.js";
import { CartService } from "../src/modules/cart/cart.service.js";
import type {
  CartLineInsert,
  CartRepositoryPort,
  CartRow,
  CartSchemaPresence,
  CartTransactionPort,
  CartUpdateInput,
} from "../src/modules/cart/cart.types.js";

class FakeCartRepository implements CartRepositoryPort {
  rows: CartRow[] = [];
  private seq = 0;

  private nextId(): string {
    this.seq += 1;
    return `line-${this.seq}`;
  }

  seed(overrides: Partial<CartRow> & Pick<CartRow, "table_id" | "menu_item_id">): CartRow {
    const row: CartRow = {
      id: this.nextId(),
      quantity: 1,
      request_note: "",
      allergy_note: "",
      added_by: "Asha",
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  async countForTable(tableId: string): Promise<number> {
    return this.rows.filter((row) => row.table_id === tableId).length;
  }

  async listForTable(tableId: string, limit: number, offset: number): Promise<CartRow[]> {
    return this.rows
      .filter((row) => row.table_id === tableId)
      .slice(offset, offset + limit);
  }

  async addLine(tableId: string, input: CartLineInsert): Promise<CartRow> {
    const existing = this.rows.find(
      (row) =>
        row.table_id === tableId &&
        row.menu_item_id === input.menuItemId &&
        row.request_note === input.requestNote &&
        row.allergy_note === input.allergyNote,
    );
    if (existing) {
      existing.quantity += input.quantity;
      existing.added_by = input.addedBy;
      return existing;
    }
    return this.seed({
      table_id: tableId,
      menu_item_id: input.menuItemId,
      quantity: input.quantity,
      request_note: input.requestNote,
      allergy_note: input.allergyNote,
      added_by: input.addedBy,
    });
  }

  async findLine(tableId: string, cartItemId: string): Promise<CartRow | null> {
    return (
      this.rows.find((row) => row.id === cartItemId && row.table_id === tableId) ?? null
    );
  }

  async deleteLine(tableId: string, cartItemId: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (row) => !(row.id === cartItemId && row.table_id === tableId),
    );
    return this.rows.length < before;
  }

  async deleteForTable(tableId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.table_id !== tableId);
    return before - this.rows.length;
  }

  async totalForTableItem(tableId: string, menuItemId: string): Promise<number> {
    return this.rows
      .filter((row) => row.table_id === tableId && row.menu_item_id === menuItemId)
      .reduce((total, row) => total + row.quantity, 0);
  }

  async transaction<T>(work: (tx: CartTransactionPort) => Promise<T>): Promise<T> {
    const tx: CartTransactionPort = {
      lockLine: (tableId, cartItemId) => this.findLine(tableId, cartItemId),
      findClashingLine: async (
        tableId,
        menuItemId,
        requestNote,
        allergyNote,
        excludeId,
      ) =>
        this.rows.find(
          (row) =>
            row.table_id === tableId &&
            row.menu_item_id === menuItemId &&
            row.request_note === requestNote &&
            row.allergy_note === allergyNote &&
            row.id !== excludeId,
        ) ?? null,
      mergeLine: async (existingId, addQuantity) => {
        const line = this.rows.find((row) => row.id === existingId);
        if (!line) return null;
        line.quantity = Math.min(line.quantity + addQuantity, 99);
        return line;
      },
      updateLine: async (lineId, tableId, quantity, requestNote, allergyNote) => {
        const line = this.rows.find(
          (row) => row.id === lineId && row.table_id === tableId,
        );
        if (!line) return null;
        line.quantity = quantity;
        line.request_note = requestNote;
        line.allergy_note = allergyNote;
        return line;
      },
      deleteLine: async (lineId) => {
        this.rows = this.rows.filter((row) => row.id !== lineId);
      },
    };
    return work(tx);
  }

  async schemaObjects(): Promise<CartSchemaPresence> {
    return { present: ["cart_items"], missing: [] };
  }
}

class FakeRealtime {
  calls: Array<{ tableId: string; event: string; data: unknown }> = [];
  throwOnPublish = false;

  toTable(tableId: string, event: string, data: unknown) {
    if (this.throwOnPublish) throw new Error("socket closed");
    this.calls.push({ tableId, event, data });
    return { room: `table:${tableId}`, event, recipients: 1, skipped: false };
  }
}

interface Harness {
  service: CartService;
  repository: FakeCartRepository;
  realtime: FakeRealtime;
  publishErrors: unknown[];
}

function harness(options: { validToken?: string } = {}): Harness {
  const repository = new FakeCartRepository();
  const realtime = new FakeRealtime();
  const publishErrors: unknown[] = [];
  const validToken = options.validToken ?? "k7x2p";

  const service = new CartService({
    repository,
    tables: {
      requireTable: async (token) => {
        if (token !== validToken) {
          throw new AppError(404, "TABLE_NOT_FOUND", "That table is not open.");
        }
        return { id: "table-1", code: token, name: "Window", status: "active" };
      },
    },
    menu: {
      findCartItem: async (id) =>
        id === "item-1"
          ? { menu_item_id: id, name: "Masala Dosa", is_available: true }
          : id === "item-86"
            ? { menu_item_id: id, name: "Paneer", is_available: false }
            : null,
    },
    realtime,
    onPublishError: (err) => publishErrors.push(err),
  });

  return { service, repository, realtime, publishErrors };
}

function isError(code: string, status?: number) {
  return (err: unknown): boolean =>
    err instanceof AppError && err.code === code && (status === undefined || err.status === status);
}

describe("CartService — shared table cart", () => {
  it("reads the shared cart with pagination metadata", async () => {
    const { service, repository } = harness();
    repository.seed({ table_id: "table-1", menu_item_id: "item-1", quantity: 2 });
    repository.seed({ table_id: "table-1", menu_item_id: "item-86", quantity: 1 });
    repository.seed({ table_id: "table-2", menu_item_id: "item-1", quantity: 5 });

    const result = await service.listCart({ table_token: "k7x2p", page: 1, limit: 1 });

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.table_id, "table-1");
    assert.deepEqual(result.meta, buildMeta(1, 1, 2));
  });

  it("adds to one shared line and attributes it to the diner", async () => {
    const { service, repository, realtime } = harness();

    const first = await service.addItem({
      table_token: "k7x2p",
      menu_item_id: "item-1",
      quantity: 2,
      added_by: "  Asha  ",
    });
    const second = await service.addItem({
      table_token: "k7x2p",
      menu_item_id: "item-1",
      quantity: 1,
      added_by: "Ravi",
    });

    assert.equal(first.added_by, "Asha");
    assert.equal(second.quantity, 3);
    assert.equal(second.total_table_quantity, 3);
    assert.equal(repository.rows.length, 1);
    assert.equal(second.added_by, "Ravi");
    assert.equal(realtime.calls.length, 2);
    assert.equal(realtime.calls[0]?.event, "cart.item.added");
    assert.deepEqual(realtime.calls[1]?.data, {
      table_id: "table-1",
      action: "added",
      line: second,
    });
  });

  it("refuses unknown and 86'd dishes without touching the cart", async () => {
    const { service, repository } = harness();

    await assert.rejects(
      () =>
        service.addItem({
          table_token: "k7x2p",
          menu_item_id: "missing",
          quantity: 1,
          added_by: "Asha",
        }),
      isError("MENU_ITEM_NOT_FOUND", 404),
    );
    await assert.rejects(
      () =>
        service.addItem({
          table_token: "k7x2p",
          menu_item_id: "item-86",
          quantity: 1,
          added_by: "Asha",
        }),
      isError("ITEM_UNAVAILABLE", 409),
    );
    assert.equal(repository.rows.length, 0);
  });

  it("updates quantity and notes, including absolute and delta modes", async () => {
    const { service, repository, realtime } = harness();
    const line = repository.seed({
      table_id: "table-1",
      menu_item_id: "item-1",
      quantity: 3,
    });

    const absolute = await service.updateItem(line.id, {
      table_token: "k7x2p",
      quantity: 2,
      request_note: "less spicy",
    });
    assert.equal(absolute.quantity, 2);
    assert.equal(absolute.request_note, "less spicy");

    const delta = await service.updateItem(line.id, {
      table_token: "k7x2p",
      quantity_delta: 2,
      allergy_note: "peanuts",
    });
    assert.equal(delta.quantity, 4);
    assert.equal(delta.request_note, "less spicy");
    assert.equal(delta.allergy_note, "peanuts");
    assert.equal(realtime.calls.at(-1)?.event, "cart.item.updated");
  });

  it("rejects invalid resulting quantities and leaves the line untouched", async () => {
    const { service, repository } = harness();
    const line = repository.seed({
      table_id: "table-1",
      menu_item_id: "item-1",
      quantity: 3,
    });

    const patches: Array<Pick<CartUpdateInput, "quantity" | "quantity_delta">> = [
      { quantity_delta: -3 },
      { quantity_delta: 97 },
      { quantity: 0 },
      { quantity: 100 },
    ];
    for (const patch of patches) {
      await assert.rejects(
        () =>
          service.updateItem(line.id, {
            table_token: "k7x2p",
            ...patch,
          }),
        isError("VALIDATION_ERROR", 400),
      );
    }
    assert.equal((await repository.findLine("table-1", line.id))?.quantity, 3);
  });

  it("merges two lines when an edit makes their notes identical", async () => {
    const { service, repository } = harness();
    const edited = repository.seed({
      table_id: "table-1",
      menu_item_id: "item-1",
      quantity: 1,
      request_note: "extra chutney",
    });
    const survivor = repository.seed({
      table_id: "table-1",
      menu_item_id: "item-1",
      quantity: 2,
      request_note: "",
    });

    const result = await service.updateItem(edited.id, {
      table_token: "k7x2p",
      quantity: 1,
      request_note: "",
    });

    assert.equal(result.id, survivor.id);
    assert.equal(result.quantity, 3);
    assert.equal(result.total_table_quantity, 3);
    assert.equal(repository.rows.length, 1);
  });

  it("scopes updates, removes and session validation to the table", async () => {
    const { service, repository } = harness();
    const foreign = repository.seed({
      table_id: "table-2",
      menu_item_id: "item-1",
    });

    await assert.rejects(
      () =>
        service.updateItem(foreign.id, {
          table_token: "k7x2p",
          quantity_delta: 1,
        }),
      isError("CART_ITEM_NOT_FOUND", 404),
    );
    await assert.rejects(
      () => service.removeItem("k7x2p", foreign.id),
      isError("CART_ITEM_NOT_FOUND", 404),
    );
    await assert.rejects(
      () => service.listCart({ table_token: "nope", page: 1, limit: 20 }),
      isError("TABLE_NOT_FOUND", 404),
    );
  });

  it("removes and clears shared lines", async () => {
    const { service, repository, realtime } = harness();
    const line = repository.seed({ table_id: "table-1", menu_item_id: "item-1" });
    repository.seed({ table_id: "table-1", menu_item_id: "item-86" });

    const removed = await service.removeItem("k7x2p", line.id);
    assert.deepEqual(removed, {
      id: line.id,
      message: "Line item purged from table cart.",
    });
    assert.equal(realtime.calls.at(-1)?.event, "cart.item.removed");

    const cleared = await service.clearCart("k7x2p");
    assert.equal(cleared.removed, 1);
    assert.equal(repository.rows.length, 0);
    assert.equal(realtime.calls.at(-1)?.event, "cart.cleared");
  });

  it("never turns a post-commit realtime failure into a failed mutation", async () => {
    const { service, repository, realtime, publishErrors } = harness();
    realtime.throwOnPublish = true;

    const line = await service.addItem({
      table_token: "k7x2p",
      menu_item_id: "item-1",
      quantity: 1,
      added_by: "Asha",
    });

    assert.equal(line.quantity, 1);
    assert.equal(repository.rows.length, 1);
    assert.equal(publishErrors.length, 1);
  });
});
