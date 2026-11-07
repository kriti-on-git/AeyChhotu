import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Transaction boundaries for ticket lifecycle writes, proven against the real
   repository over a fake DbPort: if clearing the waiter ping fails, the status
   move must roll back too — no served ticket with a stale "waiter coming". */

import type {
  DbPort,
  DbQueryResult,
  DbTransaction,
} from "../src/infrastructure/database/DatabaseManager.js";
import { AppError } from "../src/errors/app-error.js";
import { TicketsRepository } from "../src/modules/tickets/tickets.repository.js";
import { TicketsService } from "../src/modules/tickets/tickets.service.js";

type Row = Record<string, unknown>;

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const TABLE_ID = "22222222-2222-4222-8222-222222222222";

interface FakeDb {
  readonly db: DbPort;
  readonly log: string[];
}

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
    log.push(shorten(text));
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

function shorten(sql: string): string {
  if (sql.startsWith("SELECT id, table_id, status")) return "lock";
  if (sql.startsWith("UPDATE orders SET status = 'served'")) return "serve";
  if (sql.startsWith("UPDATE orders") && sql.includes("denial_reason")) return "deny";
  if (sql.startsWith("UPDATE restaurant_tables")) return "ping";
  return "other";
}

function service(db: DbPort): TicketsService {
  return new TicketsService({ repository: new TicketsRepository(db) });
}

function handler(options: { pingFails?: boolean; status?: string }) {
  return (text: string): DbQueryResult<Row> => {
    if (text.startsWith("SELECT id, table_id, status")) {
      return {
        rows: [{ id: TICKET_ID, table_id: TABLE_ID, status: options.status ?? "ready" }],
        rowCount: 1,
      };
    }
    if (text.startsWith("UPDATE restaurant_tables") && options.pingFails) {
      throw new Error("ping clear failed");
    }
    return { rows: [], rowCount: null };
  };
}

describe("TicketsRepository — transaction rollback", () => {
  it("rolls back the serve when the waiter-ping clear fails", async () => {
    const { db, log } = createFakeDb(handler({ pingFails: true }));

    await assert.rejects(
      () => service(db).pruneTicket(TICKET_ID),
      /ping clear failed/,
    );

    assert.deepEqual(log, ["BEGIN", "lock", "serve", "ROLLBACK"]);
  });

  it("rolls back a denial when the waiter-ping clear fails", async () => {
    const { db, log } = createFakeDb(handler({ pingFails: true, status: "preparing" }));

    await assert.rejects(
      () => service(db).denyTicket(TICKET_ID, "ran out"),
      /ping clear failed/,
    );

    assert.deepEqual(log, ["BEGIN", "lock", "deny", "ROLLBACK"]);
  });

  it("commits serve + ping clear exactly once", async () => {
    const { db, log } = createFakeDb(handler({ status: "ready" }));

    const result = await service(db).pruneTicket(TICKET_ID);
    assert.equal(result.status, "served");
    assert.deepEqual(log, ["BEGIN", "lock", "serve", "ping", "COMMIT"]);
  });

  it("commits deny + ping clear exactly once", async () => {
    const { db, log } = createFakeDb(handler({ status: "pending" }));

    const result = await service(db).denyTicket(TICKET_ID, "out of stock");
    assert.equal(result.denial_reason, "out of stock");
    assert.deepEqual(log, ["BEGIN", "lock", "deny", "ping", "COMMIT"]);
  });

  it("refuses a non-ready prune without opening writes", async () => {
    const { db, log } = createFakeDb(handler({ status: "pending" }));

    await assert.rejects(
      () => service(db).pruneTicket(TICKET_ID),
      (err: unknown) => err instanceof AppError && err.code === "INVALID_STATUS_TRANSITION",
    );

    assert.deepEqual(log, ["BEGIN", "lock", "ROLLBACK"]);
  });
});
