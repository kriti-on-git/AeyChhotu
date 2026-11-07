/* Transitional DbPort over the legacy shared pool.

   The Table module requires a DbPort. Production passes DatabaseManager
   (TOKENS.database); the compatibility seam for services that still import
   sessions.service.ts needs a DbPort before bootstrap has run, and this is
   that adapter. It deliberately implements the same narrow interface and
   disappears when the last `pool.query` caller migrates. */

import type { PoolClient } from "pg";
import type {
  DbClient,
  DbConnection,
  DbHealth,
  DbPort,
  DbQueryResult,
  DbTransaction,
  TransactionOptions,
} from "../infrastructure/database/DatabaseManager.js";
import { pool } from "./pool.js";

const ISOLATION_SQL: Record<NonNullable<TransactionOptions["isolation"]>, string> = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

const HEALTH_TIMEOUT_MS = 2_000;

function queryable(client: PoolClient): DbTransaction {
  return {
    query: async <T extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<DbQueryResult<T>> => {
      const result = await client.query(text, values as unknown[] | undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
  };
}

function connection(client: PoolClient): DbConnection {
  let released = false;
  return {
    get released() {
      return released;
    },
    query: async <T extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<DbQueryResult<T>> => {
      const result = await client.query(text, values as unknown[] | undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    release: (err?: Error | boolean) => {
      if (released) return;
      released = true;
      client.release(err);
    },
  };
}

export function createLegacyDbPort(): DbPort {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<DbQueryResult<T>> {
      const result = await pool.query(text, values as unknown[] | undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },

    async transaction<T>(
      fn: (tx: DbTransaction) => Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (options.isolation) {
          await client.query(`SET TRANSACTION ISOLATION LEVEL ${ISOLATION_SQL[options.isolation]}`);
        }
        if (options.timeoutMs !== undefined) {
          await client.query("SELECT set_config('statement_timeout', $1, true)", [
            String(Math.trunc(options.timeoutMs)),
          ]);
        }
        const result = await fn(queryable(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async acquire(): Promise<DbConnection> {
      return connection(await pool.connect());
    },

    async withConnection<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
      const conn = connection(await pool.connect());
      try {
        return await fn(conn);
      } finally {
        conn.release();
      }
    },

    async healthCheck(): Promise<DbHealth> {
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), HEALTH_TIMEOUT_MS);
      });

      try {
        const outcome = await Promise.race([
          pool.query("SELECT 1").then(
            () => ({ status: "ok" as const }),
            (err: unknown) => ({ status: "error" as const, err }),
          ),
          timeout,
        ]);

        if (outcome.status === "ok") {
          return { ok: true, latencyMs: Date.now() - started };
        }
        if (outcome.status === "timeout") {
          return { ok: false, latencyMs: Date.now() - started, error: "timeout" };
        }
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: outcome.err instanceof Error ? outcome.err.message : String(outcome.err),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

export type LegacyDbClient = DbClient;
