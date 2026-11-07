import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Transaction boundaries for stock writes, proven against the real
   repository over a fake DbPort: the row lock, the count update and the
   movement append share one transaction, and a refusal or append failure
   rolls the update back. No real database. */

import type {
  DbPort,
  DbQueryResult,
  DbTransaction,
} from "../src/infrastructure/database/DatabaseManager.js";
import { AppError } from "../src/errors/app-error.js";
import { InventoryRepository } from "../src/modules/inventory/inventory.repository.js";

type Row = Record<string, unknown>;

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

interface FakeDb {
  readonly db: DbPort;
  readonly log: string[];
  readonly movementValues: unknown[][];
}

function createFakeDb(options: {
  stock: number | null;
  failMovement?: boolean;
}): FakeDb {
  const log: string[] = [];
  const movementValues: unknown[][] = [];

  const handler = (text: string, values?: readonly unknown[]): DbQueryResult<Row> => {
    if (text.startsWith("SELECT id, name, category")) {
      log.push("lock");
      if (values?.[0] !== ITEM_ID) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            id: ITEM_ID,
            name: "Masala Dosa",
            category: "Main Course",
            is_available: true,
            stock_quantity: options.stock,
            low_stock_threshold: 5,
            stock_updated_at: null,
          },
        ],
        rowCount: 1,
      };
    }

    if (text.startsWith("UPDATE menu_items")) {
      log.push("update");
      return {
        rows: [
          {
            id: ITEM_ID,
            name: "Masala Dosa",
            category: "Main Course",
            is_available: true,
            stock_quantity: values?.[1] ?? null,
            low_stock_threshold: values?.[2] ?? 5,
            stock_updated_at: new Date("2026-01-01T11:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }

    if (text.startsWith("INSERT INTO inventory_movements")) {
      log.push("movement");
      if (options.failMovement) throw new Error("movement append failed");
      movementValues.push([...(values ?? [])]);
      return {
        rows: [
          {
            id: "movement-1",
            menu_item_id: values?.[0],
            order_id: values?.[1],
            delta: values?.[2],
            previous_quantity: values?.[3],
            new_quantity: values?.[4],
            reason: values?.[5],
            created_at: new Date("2026-01-01T11:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }

    throw new Error(`unexpected SQL: ${text.slice(0, 40)}`);
  };

  const query = async <T extends Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DbQueryResult<T>> => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      log.push(text);
      return { rows: [], rowCount: null };
    }
    const result = handler(text, values);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  };

  const db: DbPort = {
    query,
    async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
      await query("BEGIN");
      try {
        const result = await fn({ query });
        await query("COMMIT");
        return result;
      } catch (err) {
        await query("ROLLBACK");
        throw err;
      }
    },
    async acquire() {
      throw new Error("not used");
    },
    async withConnection() {
      throw new Error("not used");
    },
    async healthCheck() {
      return { ok: true, latencyMs: 0 };
    },
  };

  return { db, log, movementValues };
}

function repositoryWith(stock: number | null, failMovement = false) {
  const fake = createFakeDb({ stock, failMovement });
  return { ...fake, repository: new InventoryRepository(fake.db) };
}

describe("InventoryRepository — atomic stock writes", () => {
  it("locks, updates and appends a reduction in one commit", async () => {
    const { repository, log, movementValues } = repositoryWith(10);

    const result = await repository.adjustStock(ITEM_ID, {
      delta: -3,
      reason: "wastage",
    });

    assert.equal(result?.item.stock_quantity, 7);
    assert.deepEqual(log, ["BEGIN", "lock", "update", "movement", "COMMIT"]);
    assert.deepEqual(movementValues, [[ITEM_ID, null, -3, 10, 7, "wastage"]]);
  });

  it("rolls back before writing when the reduction would go negative", async () => {
    const { repository, log, movementValues } = repositoryWith(2);

    await assert.rejects(
      repository.adjustStock(ITEM_ID, { delta: -3, reason: "wastage" }),
      (err) => err instanceof AppError && err.code === "NEGATIVE_STOCK",
    );

    assert.deepEqual(log, ["BEGIN", "lock", "ROLLBACK"]);
    assert.deepEqual(movementValues, []);
  });

  it("rolls back when an untracked count is adjusted", async () => {
    const { repository, log } = repositoryWith(null);

    await assert.rejects(
      repository.adjustStock(ITEM_ID, { delta: 1, reason: "delivery" }),
      (err) => err instanceof AppError && err.code === "STOCK_UNTRACKED",
    );

    assert.deepEqual(log, ["BEGIN", "lock", "ROLLBACK"]);
  });

  it("rolls the count update back when the movement cannot be written", async () => {
    const { repository, log } = repositoryWith(10, true);

    await assert.rejects(
      repository.adjustStock(ITEM_ID, { delta: -1, reason: "wastage" }),
      /movement append failed/,
    );

    assert.deepEqual(log, ["BEGIN", "lock", "update", "movement", "ROLLBACK"]);
  });

  it("establishes an absolute count without inventing a delta", async () => {
    const { repository, log, movementValues } = repositoryWith(null);

    const result = await repository.setStock(ITEM_ID, { stock_quantity: 8 });

    assert.equal(result?.item.stock_quantity, 8);
    assert.deepEqual(log, ["BEGIN", "lock", "update", "movement", "COMMIT"]);
    assert.deepEqual(movementValues, [[ITEM_ID, null, null, null, 8, "manual"]]);
  });

  it("updates the low-stock threshold in the same transaction", async () => {
    const { repository, movementValues } = repositoryWith(8);

    const result = await repository.setStock(ITEM_ID, {
      stock_quantity: 8,
      low_stock_threshold: 2,
    });

    assert.equal(result?.item.low_stock_threshold, 2);
    assert.deepEqual(movementValues, [[ITEM_ID, null, null, 8, 8, "manual"]]);
  });

  it("returns null for an unknown item without writing", async () => {
    const { repository, log } = repositoryWith(10);

    const result = await repository.setStock(
      "99999999-9999-4999-8999-999999999999",
      { stock_quantity: 1 },
    );

    assert.equal(result, null);
    assert.deepEqual(log, ["BEGIN", "lock", "COMMIT"]);
  });
});
