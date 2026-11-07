/* Compatibility DbPort for services that predate module composition.

   Production calls configureLegacyDatabase(database) in the composition root,
   so every legacy service uses the same DatabaseManager (and therefore the
   same single pool) as the modules. Outside a composed app (focused scripts
   and tests) the adapter falls back to the shared pool, preserving the old
   lazy behaviour without creating a second lifecycle in production. */

import type { Pool, PoolClient } from "pg";
import type {
  DbClient,
  DbConnection,
  DbHealth,
  DbPort,
  DbQueryResult,
  DbTransaction,
  TransactionOptions,
} from "../infrastructure/database/DatabaseManager.js";
import { pool as sharedPool } from "./pool.js";

const ISOLATION_SQL: Record<NonNullable<TransactionOptions["isolation"]>, string> = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

const HEALTH_TIMEOUT_MS = 2_000;

let configured: DbPort | null = null;
let fallback: DbPort | null = null;

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

function createPoolDbPort(target: Pool): DbPort {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<DbQueryResult<T>> {
      const result = await target.query(text, values as unknown[] | undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },

    async transaction<T>(
      fn: (tx: DbTransaction) => Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> {
      const client = await target.connect();
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
      return connection(await target.connect());
    },

    async withConnection<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
      const conn = connection(await target.connect());
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
          target.query("SELECT 1").then(
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

/** Called once by the composition root before any request is served. */
export function configureLegacyDatabase(db: DbPort): void {
  configured = db;
}

function resolve(): DbPort {
  if (configured !== null) return configured;
  fallback ??= createPoolDbPort(sharedPool);
  return fallback;
}

/* A stable proxy: service modules capture this at import time, before the
   composition root has run. Every call resolves the current database, so a
   captured port still switches to DatabaseManager when composition configures
   it. */
const lazyPort: DbPort = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DbQueryResult<T>> => resolve().query<T>(text, values),
  transaction: <T>(
    fn: (tx: DbTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> => resolve().transaction(fn, options),
  acquire: (): Promise<DbConnection> => resolve().acquire(),
  withConnection: <T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> =>
    resolve().withConnection(fn),
  healthCheck: (options?: { timeoutMs?: number }): Promise<DbHealth> =>
    resolve().healthCheck(options),
};

export function createLegacyDbPort(): DbPort {
  return lazyPort;
}

export type LegacyDbClient = DbClient;
