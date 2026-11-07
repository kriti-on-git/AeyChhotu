import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* REAL-POSTGRES checks for DatabaseManager (phase 2A — database).

   These run only when TEST_DATABASE_URL points at a dedicated test database:

       TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/aeychhotu_test \
         npm test

   Skipped otherwise, so `npm test` stays hermetic. They cover what mocks
   cannot: pg's own connection handshake, server-side statement_timeout, and
   that the pool really is closed afterwards.

   The database must exist; the schema does not need to (only SELECT 1 and
   intentionally failing statements are used). */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const skipReason = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set — real-Postgres checks skipped";

describe("DatabaseManager — real Postgres", { skip: skipReason }, () => {
  it("connects, reports healthy and runs a query", async () => {
    await withRealDatabase(async (manager) => {
      const health = await manager.healthCheck({ timeoutMs: 3_000 });
      assert.equal(health.ok, true);

      const result = await manager.query<{ one: number }>("SELECT 1 AS one");
      assert.equal(result.rows[0]?.one, 1);
    });
  });

  it("rolls a failed transaction back and leaves the pool usable", async () => {
    await withRealDatabase(async (manager) => {
      await assert.rejects(() =>
        manager.transaction(async (tx) => {
          await tx.query("SELECT * FROM table_that_does_not_exist");
        }),
      );

      // The connection was released cleanly, so the next query still works.
      const after = await manager.query<{ one: number }>("SELECT 1 AS one");
      assert.equal(after.rows[0]?.one, 1);
      assert.equal(manager.diagnostics().counters.rollbacks, 1);
    });
  });

  it("enforces the transaction statement timeout server-side", async () => {
    await withRealDatabase(async (manager) => {
      await assert.rejects(
        () =>
          manager.transaction(
            async (tx) => {
              await tx.query("SELECT pg_sleep(1)");
            },
            { timeoutMs: 50 },
          ),
        /statement timeout|canceling statement/i,
      );
    });
  });

  it("closes the pool on shutdown and refuses new work", async () => {
    const manager = await readyManager();
    try {
      assert.equal((await manager.healthCheck()).ok, true);
    } finally {
      await manager.shutdown();
    }

    assert.equal(manager.getState(), "closed");
    assert.equal((await manager.healthCheck()).ok, false);
  });
});

/* ------------------------------------------------------------- helpers */

async function withRealDatabase<T>(
  fn: (manager: import("../src/infrastructure/database/DatabaseManager.js").DatabaseManager) => Promise<T>,
): Promise<T> {
  const manager = await readyManager();
  try {
    return await fn(manager);
  } finally {
    await manager.shutdown();
  }
}

async function readyManager() {
  const { DatabaseManager } = await import(
    "../src/infrastructure/database/DatabaseManager.js"
  );
  const { initContext } = await import("./helpers/init-context.js");

  const manager = new DatabaseManager({
    shutdownTimeoutMs: 2_000,
    healthCheckTimeoutMs: 3_000,
  });
  await manager.init(initContext({ DATABASE_URL: TEST_DATABASE_URL }));
  return manager;
}
