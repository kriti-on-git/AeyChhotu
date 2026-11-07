import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* Unit tests for DatabaseManager (phase 2A — database).

   Everything runs against the fake pool/client in helpers/fake-db.ts, so the
   tests pin the LIFECYCLE and ERROR behaviour without a database:
     * a single pool per manager, one init;
     * query / acquire / release (including idempotent double release);
     * transactions: commit, rollback of any throwable, caller errors preserved,
       isolation + statement timeout, always-released clients;
     * health checks that report instead of throwing, including timeout;
     * pool diagnostics and the fatal idle-error hook;
     * schema compatibility checks (parameterized, never interpolated);
     * bounded, idempotent shutdown that drains then closes. */

import { AppError } from "../src/errors/app-error.js";
import {
  DatabaseError,
  DatabaseManager,
  DEFAULT_SCHEMA_REQUIREMENTS,
  type DatabaseOptions,
  type DbPool,
} from "../src/infrastructure/database/DatabaseManager.js";
import { createFakeClient, createFakePool } from "./helpers/fake-db.js";
import { initContext } from "./helpers/init-context.js";

function newManager(pool: DbPool, options: DatabaseOptions = {}): DatabaseManager {
  return new DatabaseManager({
    poolFactory: () => pool,
    onFatalError: () => undefined,
    ...options,
  });
}

function isDatabaseError(code: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof DatabaseError, `expected DatabaseError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  };
}

describe("DatabaseManager — pool lifecycle", () => {
  it("creates exactly one pool and becomes ready", async () => {
    let factoryCalls = 0;
    const fake = createFakePool();
    const manager = new DatabaseManager({
      poolFactory: () => {
        factoryCalls += 1;
        return fake.pool;
      },
      onFatalError: () => undefined,
    });

    await manager.init(initContext());

    assert.equal(factoryCalls, 1);
    assert.equal(manager.getState(), "ready");
  });

  it("refuses a second init (single controlled lifecycle)", async () => {
    const manager = newManager(createFakePool().pool);
    await manager.init(initContext());

    await assert.rejects(
      () => manager.init(initContext()),
      isDatabaseError("DB_ALREADY_INITIALIZED"),
    );
  });

  it("rejects queries before init", async () => {
    const manager = new DatabaseManager();

    await assert.rejects(
      () => manager.query("SELECT 1"),
      isDatabaseError("DB_NOT_INITIALIZED"),
    );
  });

  it("passes values as parameters, never interpolated", async () => {
    const fake = createFakePool({
      query: async () => ({ rows: [{ id: "row-1" }], rowCount: 1 }),
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const result = await manager.query<{ id: string }>(
      "SELECT id FROM menu_items WHERE id = $1",
      ["row-1"],
    );

    assert.deepEqual(result.rows, [{ id: "row-1" }]);
    assert.equal(result.rowCount, 1);
    assert.equal(fake.queryCalls[0]?.text, "SELECT id FROM menu_items WHERE id = $1");
    assert.deepEqual(fake.queryCalls[0]?.values, ["row-1"]);
  });

  it("wraps a query failure with a code and keeps the cause", async () => {
    const cause = new Error('relation "nope" does not exist');
    const fake = createFakePool({
      query: async () => {
        throw cause;
      },
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await assert.rejects(
      () => manager.query("SELECT * FROM nope"),
      (err: unknown) => {
        assert.ok(err instanceof DatabaseError);
        assert.equal(err.code, "DB_QUERY_FAILED");
        assert.equal(err.cause, cause);
        return true;
      },
    );

    assert.equal(manager.diagnostics().counters.failures, 1);
    assert.equal(manager.diagnostics().lastError?.context, "query");
  });
});

describe("DatabaseManager — connection acquisition and release", () => {
  it("acquires a connection and releases it exactly once", async () => {
    const fakeClient = createFakeClient({
      query: async () => ({ rows: [{ ok: true }], rowCount: 1 }),
    });
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const connection = await manager.acquire();
    assert.equal(connection.released, false);

    const result = await connection.query<{ ok: boolean }>("SELECT true AS ok");
    assert.deepEqual(result.rows, [{ ok: true }]);

    connection.release();
    connection.release(); // idempotent: must not return the client twice

    assert.equal(connection.released, true);
    assert.equal(fakeClient.releases.length, 1);
    await assert.rejects(
      () => connection.query("SELECT 1"),
      isDatabaseError("DB_CONNECTION_RELEASED"),
    );
  });

  it("releases even when the caller throws (withConnection)", async () => {
    const fakeClient = createFakeClient();
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await assert.rejects(() =>
      manager.withConnection(async () => {
        throw new Error("handler exploded");
      }),
    );

    assert.equal(fakeClient.releases.length, 1);
  });

  it("maps a connect failure to DB_CONNECT_FAILED", async () => {
    const fake = createFakePool({
      connect: async () => {
        throw new Error("timeout exceeded when trying to connect");
      },
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await assert.rejects(
      () => manager.acquire(),
      isDatabaseError("DB_CONNECT_FAILED"),
    );
  });
});

describe("DatabaseManager — transactions", () => {
  it("commits, returns the value and releases once", async () => {
    const fakeClient = createFakeClient();
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const value = await manager.transaction(async (tx) => {
      await tx.query("INSERT INTO orders (id) VALUES ($1)", ["o-1"]);
      return 42;
    });

    assert.equal(value, 42);
    assert.deepEqual(
      fakeClient.queries.map((query) => query.text),
      ["BEGIN", "INSERT INTO orders (id) VALUES ($1)", "COMMIT"],
    );
    assert.equal(fakeClient.releases.length, 1);

    const diagnostics = manager.diagnostics();
    assert.equal(diagnostics.counters.transactions, 1);
    assert.equal(diagnostics.counters.commits, 1);
    assert.equal(diagnostics.counters.rollbacks, 0);
  });

  it("rolls back and rethrows a caller AppError UNCHANGED", async () => {
    const fakeClient = createFakeClient();
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const failure = new AppError(409, "DUPLICATE_ORDER", "Order already sent");

    await assert.rejects(
      () =>
        manager.transaction(async (tx) => {
          await tx.query("SELECT 1");
          throw failure;
        }),
      (err: unknown) => {
        // Identity, not just shape: the HTTP layer must render this exact error.
        assert.equal(err, failure);
        return true;
      },
    );

    assert.deepEqual(
      fakeClient.queries.map((query) => query.text),
      ["BEGIN", "SELECT 1", "ROLLBACK"],
    );
    assert.equal(fakeClient.releases.length, 1);
    assert.equal(manager.diagnostics().counters.rollbacks, 1);
    assert.equal(manager.diagnostics().counters.commits, 0);
  });

  it("rolls back a non-Error throw", async () => {
    const fakeClient = createFakeClient();
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await assert.rejects(() =>
      manager.transaction(async () => {
        throw "a thrown string";
      }),
    );

    assert.equal(
      fakeClient.queries.some((query) => query.text === "ROLLBACK"),
      true,
    );
    assert.equal(fakeClient.releases.length, 1);
  });

  it("rolls back when a body query fails", async () => {
    const fakeClient = createFakeClient({
      query: async (text) => {
        if (text === "SELECT bad") throw new Error("syntax error");
        return { rows: [], rowCount: 0 };
      },
    });
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await assert.rejects(
      () =>
        manager.transaction(async (tx) => {
          await tx.query("SELECT bad");
        }),
      /syntax error/,
    );

    assert.deepEqual(
      fakeClient.queries.map((query) => query.text),
      ["BEGIN", "SELECT bad", "ROLLBACK"],
    );
  });

  it("applies isolation and a server-side statement timeout inside the transaction", async () => {
    const fakeClient = createFakeClient();
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await manager.transaction(async () => undefined, {
      isolation: "serializable",
      timeoutMs: 250,
    });

    const texts = fakeClient.queries.map((query) => query.text);
    assert.equal(texts.includes("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"), true);

    const timeoutQuery = fakeClient.queries.find((query) =>
      query.text.includes("set_config('statement_timeout'"),
    );
    assert.ok(timeoutQuery);
    assert.deepEqual(timeoutQuery.values, ["250"]);
  });

  it("wraps a BEGIN failure as DB_BEGIN_FAILED", async () => {
    const fakeClient = createFakeClient({
      query: async (text) => {
        if (text === "BEGIN") throw new Error("cannot begin");
        return { rows: [], rowCount: 0 };
      },
    });
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await assert.rejects(
      () => manager.transaction(async () => undefined),
      isDatabaseError("DB_BEGIN_FAILED"),
    );
    assert.equal(fakeClient.releases.length, 1);
  });

  it("still releases the client when ROLLBACK itself fails", async () => {
    const fakeClient = createFakeClient({
      query: async (text) => {
        if (text === "ROLLBACK") throw new Error("connection already closed");
        if (text === "SELECT bad") throw new Error("body failure");
        return { rows: [], rowCount: 0 };
      },
    });
    const fake = createFakePool({ connect: async () => fakeClient.client });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await assert.rejects(
      () =>
        manager.transaction(async (tx) => {
          await tx.query("SELECT bad");
        }),
      /body failure/,
    );

    assert.equal(fakeClient.releases.length, 1);
  });
});

describe("DatabaseManager — health checks", () => {
  it("reports ok with a latency and probes with SELECT 1", async () => {
    const fake = createFakePool({
      query: async () => ({ rows: [{ "?column?": 1 }], rowCount: 1 }),
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const health = await manager.healthCheck();

    assert.equal(health.ok, true);
    assert.equal(typeof health.latencyMs, "number");
    assert.equal(fake.queryCalls[0]?.text, "SELECT 1");
  });

  it("reports a failure instead of throwing", async () => {
    const fake = createFakePool({
      query: async () => {
        throw new Error("database is starting up");
      },
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const health = await manager.healthCheck();

    assert.equal(health.ok, false);
    assert.match(health.error ?? "", /starting up/);
  });

  it("reports a timeout when the probe never answers", async () => {
    const fake = createFakePool({ query: () => new Promise(() => undefined) });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const health = await manager.healthCheck({ timeoutMs: 10 });

    assert.equal(health.ok, false);
    assert.equal(health.error, "timeout");
    assert.equal(manager.diagnostics().counters.timeouts, 1);
  });

  it("reports not-ready before init", async () => {
    const manager = new DatabaseManager();

    const health = await manager.healthCheck();

    assert.equal(health.ok, false);
    assert.match(health.error ?? "", /new/);
  });
});

describe("DatabaseManager — schema compatibility", () => {
  it("passes when every required object exists", async () => {
    const fake = createFakePool({
      query: async () => ({ rows: [{ present: true }], rowCount: 1 }),
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const report = await manager.checkSchema();

    assert.equal(report.compatible, true);
    assert.equal(report.checked, DEFAULT_SCHEMA_REQUIREMENTS.length);
    assert.deepEqual(report.missing, []);
    assert.equal(typeof report.durationMs, "number");
  });

  it("reports a missing object and passes names as parameters", async () => {
    const fake = createFakePool({
      query: async () => ({ rows: [{ present: false }], rowCount: 1 }),
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const report = await manager.checkSchema([
      { kind: "table", name: "restaurant_tables" },
    ]);

    assert.equal(report.compatible, false);
    assert.deepEqual(report.missing, [{ kind: "table", name: "restaurant_tables" }]);
    assert.deepEqual(fake.queryCalls[0]?.values, ["public.restaurant_tables"]);
    assert.equal(manager.diagnostics().schema?.compatible, false);
  });

  it("selfTest reports instead of throwing when the probe fails", async () => {
    const fake = createFakePool({
      query: async () => {
        throw new Error("connection terminated");
      },
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const result = await manager.selfTest();

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /connection terminated/);
  });
});

describe("DatabaseManager — diagnostics and pool errors", () => {
  it("reports pool stats, counters and in-flight work", async () => {
    const fake = createFakePool({
      stats: { total: 3, idle: 2, waiting: 1 },
      query: async () => ({ rows: [], rowCount: 0 }),
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());
    await manager.query("SELECT 1");

    const diagnostics = manager.diagnostics();

    assert.equal(diagnostics.state, "ready");
    assert.equal(diagnostics.pool.max, 10);
    assert.equal(diagnostics.pool.total, 3);
    assert.equal(diagnostics.pool.idle, 2);
    assert.equal(diagnostics.pool.waiting, 1);
    assert.equal(diagnostics.pool.checkedOut, 1);
    assert.equal(diagnostics.counters.queries, 1);
    assert.equal(diagnostics.inFlight, 0);
  });

  it("records an idle-client error and calls the fatal hook", async () => {
    const fake = createFakePool();
    const fatalErrors: Error[] = [];
    const manager = newDatabaseManagerWithFatal(fake.pool, (err) => {
      fatalErrors.push(err);
    });
    await manager.init(initContext());

    fake.emitError(new Error("terminating connection due to administrator command"));

    assert.equal(fatalErrors.length, 1);
    assert.equal(manager.diagnostics().lastError?.context, "pool");
    assert.match(
      manager.diagnostics().lastError?.message ?? "",
      /terminating connection/,
    );
  });
});

describe("DatabaseManager — shutdown", () => {
  it("closes the pool once and is idempotent", async () => {
    const fake = createFakePool();
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await manager.shutdown();
    await manager.shutdown();

    assert.equal(fake.endCalls, 1);
    assert.equal(manager.getState(), "closed");
  });

  it("rejects new work once shutting down", async () => {
    const fake = createFakePool();
    const manager = newManager(fake.pool);
    await manager.init(initContext());
    await manager.shutdown();

    await assert.rejects(
      () => manager.query("SELECT 1"),
      isDatabaseError("DB_SHUTTING_DOWN"),
    );
  });

  it("waits for in-flight work before closing the pool", async () => {
    let finishQuery: () => void = () => undefined;
    const fake = createFakePool({
      query: () =>
        new Promise((resolve) => {
          finishQuery = () => resolve({ rows: [], rowCount: 0 });
        }),
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    const pending = manager.query("SELECT pg_sleep(1)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = manager.shutdown();

    assert.equal(fake.endCalls, 0);
    assert.equal(manager.diagnostics().inFlight, 1);

    finishQuery();
    await pending;
    await closing;

    assert.equal(fake.endCalls, 1);
  });

  it("gives up draining after its timeout and still closes", async () => {
    const fake = createFakePool({ query: () => new Promise(() => undefined) });
    const manager = newManager(fake.pool, { shutdownTimeoutMs: 20 });
    await manager.init(initContext());

    void manager.query("SELECT pg_sleep(60)");

    await manager.shutdown();

    assert.equal(fake.endCalls, 1);
    assert.equal(manager.getState(), "closed");
  });

  it("is a no-op when never initialized", async () => {
    const manager = new DatabaseManager();

    await manager.shutdown();

    assert.equal(manager.getState(), "closed");
  });

  it("never throws when pool.end() fails", async () => {
    const fake = createFakePool({
      end: async () => {
        throw new Error("socket already gone");
      },
    });
    const manager = newManager(fake.pool);
    await manager.init(initContext());

    await manager.shutdown();

    assert.equal(manager.getState(), "closed");
    assert.equal(manager.diagnostics().lastError?.context, "shutdown");
  });
});

function newDatabaseManagerWithFatal(
  pool: DbPool,
  onFatalError: (err: Error) => void,
): DatabaseManager {
  return new DatabaseManager({ poolFactory: () => pool, onFatalError });
}
