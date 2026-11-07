import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Transaction boundaries for the denied-round lifecycle, proven against the
   real repository over a fake DbPort: a failed re-fire must ROLLBACK the cart
   move and the ticket deletion, so no partially created order can survive. */

import type {
  DbPort,
  DbQueryResult,
  DbTransaction,
} from "../src/infrastructure/database/DatabaseManager.js";
import { AppError } from "../src/errors/app-error.js";
import { OrdersRepository } from "../src/modules/orders/orders.repository.js";
import { OrdersService } from "../src/modules/orders/orders.service.js";
import type { FireResult } from "../src/modules/orders/orders.types.js";

type Row = Record<string, unknown>;

interface FakeDb {
  readonly db: DbPort;
  readonly log: string[];
}

/** A DbPort whose transaction really rolls back on a thrown error and records
 *  BEGIN/COMMIT/ROLLBACK, so the test observes the boundary, not a mock. */
function createFakeDb(handler: (text: string, values?: readonly unknown[]) => DbQueryResult<Row>): FakeDb {
  const log: string[] = [];

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

  return { db, log };
}

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";

const tableRecord = { id: TABLE_ID, code: "k7x2p", name: "Window", status: "active" };

function makeService(db: DbPort): OrdersService {
  return new OrdersService({
    repository: new OrdersRepository(db),
    tables: { requireTable: async () => tableRecord },
  });
}

function routeFireFailure(soldOut: string[]) {
  return (text: string): DbQueryResult<Row> => {
    if (text.includes("SELECT o.id, o.table_id, o.status")) {
      return { rows: [{ id: ORDER_ID, table_id: TABLE_ID, status: "denied" }], rowCount: 1 };
    }
    if (text.includes("FROM order_items oi")) {
      return {
        rows: [
          {
            menu_item_id: "33333333-3333-4333-8333-333333333333",
            name: "Dosa",
            quantity: 1,
            request_note: "",
            allergy_note: "",
            added_by: "Asha",
            is_available: true,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.startsWith("SELECT fire_order")) {
      const result: FireResult = { code: "INVENTORY_FAILURE", sold_out: soldOut };
      return { rows: [{ result }], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  };
}

describe("OrdersRepository — transaction rollback", () => {
  it("rolls back the cart move and the ticket deletion when the re-fire fails", async () => {
    const { db, log } = createFakeDb(routeFireFailure(["Filter Coffee"]));

    await assert.rejects(
      () => makeService(db).retryDeniedOrder(ORDER_ID, "k7x2p"),
      (err: unknown) => err instanceof AppError && err.code === "INVENTORY_FAILURE",
    );

    assert.deepEqual(log, ["BEGIN", "ROLLBACK"]);
  });

  it("commits a successful retry exactly once", async () => {
    const { db, log } = createFakeDb((text) => {
      if (text.includes("SELECT o.id, o.table_id, o.status")) {
        return { rows: [{ id: ORDER_ID, table_id: TABLE_ID, status: "denied" }], rowCount: 1 };
      }
      if (text.includes("FROM order_items oi")) {
        return {
          rows: [
            {
              menu_item_id: "33333333-3333-4333-8333-333333333333",
              name: "Dosa",
              quantity: 1,
              request_note: "",
              allergy_note: "",
              added_by: "Asha",
              is_available: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.startsWith("SELECT fire_order")) {
        return {
          rows: [
            {
              result: {
                code: "OK",
                order_id: ORDER_ID,
                table_id: TABLE_ID,
                status: "pending",
                created_at: "2026-01-01T10:00:00.000Z",
              } satisfies FireResult,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: null };
    });

    const result = await makeService(db).retryDeniedOrder(ORDER_ID, "k7x2p");
    assert.equal(result.status, "pending");
    assert.deepEqual(log, ["BEGIN", "COMMIT"]);
  });

  it("commits a requeue that moved nothing (no writes to undo)", async () => {
    const { db, log } = createFakeDb((text) => {
      if (text.includes("SELECT o.id, o.table_id, o.status")) {
        return { rows: [{ id: ORDER_ID, table_id: TABLE_ID, status: "denied" }], rowCount: 1 };
      }
      if (text.includes("FROM order_items oi")) {
        return {
          rows: [
            {
              menu_item_id: "33333333-3333-4333-8333-333333333333",
              name: "Coffee",
              quantity: 1,
              request_note: "",
              allergy_note: "",
              added_by: "Ravi",
              is_available: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: null };
    });

    const result = await makeService(db).requeueDeniedOrder(ORDER_ID, "k7x2p");
    assert.deepEqual(result, { order_id: ORDER_ID, moved: 0, omitted: ["Coffee"] });
    assert.deepEqual(log, ["BEGIN", "COMMIT"]);
  });
});
