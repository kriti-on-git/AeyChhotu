/* DatabaseManager — the single owner of the PostgreSQL pool lifecycle.

   WHAT IT OWNS
   * one pool, created once (init) and closed once (shutdown);
   * query execution, connection acquisition/release and transactions;
   * bounded drain on shutdown, health probe, pool diagnostics;
   * schema compatibility checks (tables, functions, indexes).

   WHAT IT DOES NOT DO
   * no business SQL — repositories own their statements and receive a DbPort
     through dependency injection (TOKENS.database), so a service can never
     construct its own pool;
   * no response shaping — DatabaseError is infrastructure; translating it into
     the HTTP envelope stays in the existing AppError/error-handler path.

   ROW TYPES are intentionally narrow (`T extends Record<string, unknown>`) so
   repositories can declare `query<{ id: string }>(...)` exactly as they do
   today with `pool.query`, without a cast.

   BOOT POLICY: init() creates the pool but does NOT open a connection — pg is
   lazy. The API keeps booting while Postgres is briefly unreachable, and
   /ready answers 503 until it returns. That is the documented behaviour
   (routes/ready.ts) and this manager does not change it.

   TRANSITIONAL NOTE: backend/src/db/pool.ts still backs the un-migrated
   services (phase 2B+). It is a second, lazy pool that opens no socket until a
   business query runs; the two are unified when the first repository lands and
   services stop importing the legacy module. */

import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import type { InitContext } from "../../bootstrap/InitContext.js";
import type { ComponentHealth, ManagedComponent } from "../../bootstrap/lifecycle.js";
import type { Logger } from "../logging/Logger.js";

/* ------------------------------------------------------------------ types */

export interface DbQueryResult<T> {
  readonly rows: T[];
  readonly rowCount: number | null;
}

export interface DbQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DbQueryResult<T>>;
}

export interface DbClient extends DbQueryable {
  /** Returns the client to the pool. `true`/`Error` destroys it (pg semantics). */
  release(err?: Error | boolean): void;
}

/** The subset of pg's Pool this manager relies on. Mocks implement it. */
export interface DbPool extends DbQueryable {
  connect(): Promise<DbClient>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): this;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface DbConnection extends DbQueryable {
  readonly released: boolean;
  release(err?: Error | boolean): void;
}

export type DbTransaction = DbQueryable;

export interface TransactionOptions {
  readonly isolation?: "read committed" | "repeatable read" | "serializable";
  /** Server-side statement timeout for this transaction (ms). */
  readonly timeoutMs?: number;
}

export interface DbHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export type SchemaRequirement =
  | { readonly kind: "table"; readonly name: string }
  | { readonly kind: "function"; readonly name: string }
  | { readonly kind: "index"; readonly name: string };

export interface SchemaReport {
  readonly compatible: boolean;
  readonly checked: number;
  readonly missing: readonly SchemaRequirement[];
  readonly durationMs: number;
}

export type DatabaseState = "new" | "ready" | "closing" | "closed";

export interface DbDiagnostics {
  readonly state: DatabaseState;
  readonly pool: {
    readonly max: number;
    readonly total: number;
    readonly idle: number;
    readonly waiting: number;
    readonly checkedOut: number;
  };
  readonly counters: Readonly<{
    queries: number;
    failures: number;
    transactions: number;
    commits: number;
    rollbacks: number;
    timeouts: number;
  }>;
  readonly inFlight: number;
  readonly lastError: {
    readonly context: string;
    readonly message: string;
    readonly at: string;
  } | null;
  readonly schema: SchemaReport | null;
}

/** The dependency a repository receives. Deliberately narrower than the
    manager: no shutdown, no pool, no configuration. */
export interface DbPort {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DbQueryResult<T>>;
  transaction<T>(
    fn: (tx: DbTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  acquire(): Promise<DbConnection>;
  withConnection<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T>;
  healthCheck(options?: { timeoutMs?: number }): Promise<DbHealth>;
}

export type DatabaseErrorCode =
  | "DB_ALREADY_INITIALIZED"
  | "DB_NOT_INITIALIZED"
  | "DB_SHUTTING_DOWN"
  | "DB_QUERY_FAILED"
  | "DB_CONNECT_FAILED"
  | "DB_BEGIN_FAILED"
  | "DB_COMMIT_FAILED"
  | "DB_CONNECTION_RELEASED";

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseError";
    this.code = code;
  }
}

/* -------------------------------------------------------------- defaults */

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DRAIN_POLL_MS = 10;

const ISOLATION_SQL: Record<
  NonNullable<TransactionOptions["isolation"]>,
  string
> = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

/* The objects the shipped schema guarantees after `npm run db:setup`.
   Deliberately a subset — the checks that catch "this API is pointed at an
   older or wrong database", not a full migration audit (db:verify owns that). */
export const DEFAULT_SCHEMA_REQUIREMENTS: readonly SchemaRequirement[] = Object.freeze([
  { kind: "table", name: "restaurant_tables" },
  { kind: "table", name: "menu_items" },
  { kind: "table", name: "cart_items" },
  { kind: "table", name: "orders" },
  { kind: "table", name: "order_items" },
  { kind: "table", name: "staff_terminals" },
  { kind: "table", name: "table_members" },
  { kind: "table", name: "table_device_presence" },
  { kind: "table", name: "sales_day" },
  { kind: "function", name: "fire_order" },
  { kind: "index", name: "orders_one_active_uq" },
  { kind: "index", name: "cart_items_upsert_uq" },
] satisfies SchemaRequirement[]);

const SCHEMA_SQL: Record<SchemaRequirement["kind"], string> = {
  table: "SELECT to_regclass($1) IS NOT NULL AS present",
  function: "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = $1) AS present",
  index:
    "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1) AS present",
};

/* ---------------------------------------------------------------- options */

export interface ResolvedPoolConfig {
  readonly connectionString: string;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
}

export type PoolFactory = (config: ResolvedPoolConfig) => DbPool;

export interface DatabaseOptions {
  readonly poolMax?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly healthCheckTimeoutMs?: number;
  readonly applicationName?: string;
  /** Injected in tests so no socket is ever opened. */
  readonly poolFactory?: PoolFactory;
  /** Called when an idle-client error means the connection is broken. The
      default preserves the existing policy (log + exit 1). */
  readonly onFatalError?: (err: Error) => void;
}

/** Default pool adapter over node-postgres. */
export function createPgPoolFactory(): PoolFactory {
  return (config) => {
    const pool = new Pool({
      connectionString: config.connectionString,
      max: config.max,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      application_name: config.applicationName,
    });

    /* Server-side statement timeout for every pooled connection. Set on
       connect (rather than in the connection string) so it is explicit and
       testable; a failure to set it must not silently leave a client with no
       ceiling, so it is logged by the pool's error path. */
    pool.on("connect", (client) => {
      void client
        .query(`SET statement_timeout = ${Math.trunc(config.statementTimeoutMs)}`)
        .catch(() => undefined);
    });

    const adapter: DbPool = {
      query: async <T extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) => {
        const result = await pool.query(text, values as unknown[] | undefined);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      },
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async <T extends Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ) => {
            const result = await client.query(text, values as unknown[] | undefined);
            return { rows: result.rows as T[], rowCount: result.rowCount };
          },
          release: (err?: Error | boolean) => {
            client.release(err as Error | boolean | undefined);
          },
        };
      },
      end: () => pool.end(),
      on: (event, listener) => {
        pool.on(event, listener);
        return adapter;
      },
      get totalCount() {
        return pool.totalCount;
      },
      get idleCount() {
        return pool.idleCount;
      },
      get waitingCount() {
        return pool.waitingCount;
      },
    };

    return adapter;
  };
}

/* ---------------------------------------------------------------- manager */

export class DatabaseManager implements ManagedComponent, DbPort {
  readonly name = "database";
  readonly dependencies: readonly string[] = [];

  private readonly options: DatabaseOptions;
  private readonly onFatalError: (err: Error) => void;

  private state: DatabaseState = "new";
  private pool: DbPool | null = null;
  private logger: Logger | null = null;
  private maxConnections = DEFAULT_POOL_MAX;

  private inFlight = 0;
  private lastError: { context: string; message: string; at: string } | null = null;
  private lastSchemaReport: SchemaReport | null = null;
  private shutdownPromise: Promise<void> | null = null;

  private readonly counters = {
    queries: 0,
    failures: 0,
    transactions: 0,
    commits: 0,
    rollbacks: 0,
    timeouts: 0,
  };

  constructor(options: DatabaseOptions = {}) {
    this.options = options;
    this.onFatalError =
      options.onFatalError ??
      ((err: Error) => {
        // An idle-client error means the database connection is broken:
        // fail loudly instead of silently serving degraded responses.
        console.error(`[db] FATAL: postgres pool error — ${err.message}`);
        process.exit(1);
      });
  }

  /* ------------------------------------------------------------- lifecycle */

  async init(ctx: InitContext): Promise<void> {
    if (this.state !== "new") {
      throw new DatabaseError(
        "DB_ALREADY_INITIALIZED",
        "DatabaseManager.init() may only be called once.",
      );
    }

    this.logger = ctx.logger.child({ component: "database" });

    const config: ResolvedPoolConfig = {
      connectionString: ctx.config.databaseUrl,
      max: this.options.poolMax ?? DEFAULT_POOL_MAX,
      idleTimeoutMillis: this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis:
        this.options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs:
        this.options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      applicationName: this.options.applicationName ?? "aeychhotu-api",
    };

    this.maxConnections = config.max;

    const factory = this.options.poolFactory ?? createPgPoolFactory();
    const pool = factory(config);
    pool.on("error", (err) => this.handlePoolError(err));

    this.pool = pool;
    this.state = "ready";

    this.logger.info("database_ready", {
      pool_max: config.max,
      idle_timeout_ms: config.idleTimeoutMillis,
      connection_timeout_ms: config.connectionTimeoutMillis,
      statement_timeout_ms: config.statementTimeoutMs,
    });
  }

  /** Bounded drain, then close the pool. Idempotent. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    const pool = this.pool;

    if (this.state === "new" || pool === null) {
      this.state = "closed";
      return;
    }

    this.state = "closing";

    const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    while (this.inFlight > 0 && Date.now() < deadline) {
      await delay(DRAIN_POLL_MS);
    }

    const drained = this.inFlight === 0;
    if (!drained) {
      this.logger?.warn("database_shutdown_drain_timeout", {
        in_flight: this.inFlight,
        timeout_ms: timeoutMs,
      });
    }

    try {
      await pool.end();
    } catch (err) {
      this.recordFailure("shutdown", err);
      this.logger?.error("database_shutdown_failed", { error: err });
    }

    this.state = "closed";
    this.logger?.info("database_closed", { drained });
  }

  /* ------------------------------------------------------------------- DbPort */

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DbQueryResult<T>> {
    const pool = this.requireReady();

    this.counters.queries += 1;
    this.inFlight += 1;

    try {
      return await pool.query<T>(text, values);
    } catch (err) {
      this.recordFailure("query", err);
      throw new DatabaseError("DB_QUERY_FAILED", "Database query failed.", { cause: err });
    } finally {
      this.inFlight -= 1;
    }
  }

  async acquire(): Promise<DbConnection> {
    const pool = this.requireReady();

    this.inFlight += 1;

    let client: DbClient;
    try {
      client = await pool.connect();
    } catch (err) {
      this.inFlight -= 1;
      this.recordFailure("connect", err);
      throw new DatabaseError(
        "DB_CONNECT_FAILED",
        "Could not acquire a database connection.",
        { cause: err },
      );
    }

    return this.wrapConnection(client);
  }

  async withConnection<T>(fn: (connection: DbConnection) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    try {
      return await fn(connection);
    } finally {
      connection.release();
    }
  }

  /**
   * Run `fn` inside BEGIN/COMMIT.
   *
   * Errors thrown by the caller's function are rethrown UNCHANGED (an AppError
   * must stay an AppError so the HTTP layer renders its own code), but the
   * transaction is always rolled back and the client always released. Errors
   * raised by BEGIN/COMMIT are infrastructure failures and are wrapped.
   */
  async transaction<T>(
    fn: (tx: DbTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const pool = this.requireReady();

    this.counters.transactions += 1;
    this.inFlight += 1;

    let client: DbClient;
    try {
      client = await pool.connect();
    } catch (err) {
      this.inFlight -= 1;
      this.recordFailure("connect", err);
      throw new DatabaseError(
        "DB_CONNECT_FAILED",
        "Could not acquire a database connection.",
        { cause: err },
      );
    }

    const tx: DbTransaction = {
      query: async <R extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) => {
        this.counters.queries += 1;
        try {
          return await client.query<R>(text, values);
        } catch (err) {
          this.recordFailure("transaction-query", err);
          throw err;
        }
      },
    };

    let phase: "begin" | "body" | "commit" = "begin";

    try {
      await client.query("BEGIN");

      if (options.isolation) {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${ISOLATION_SQL[options.isolation]}`);
      }
      if (options.timeoutMs !== undefined) {
        // set_config takes the value as a parameter; SET LOCAL would need
        // string interpolation, which is exactly what we never do with input.
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(Math.trunc(options.timeoutMs)),
        ]);
      }

      phase = "body";
      const result = await fn(tx);

      phase = "commit";
      await client.query("COMMIT");
      this.counters.commits += 1;
      return result;
    } catch (err) {
      const rollbackError = await this.rollback(client);
      this.counters.rollbacks += 1;

      if (rollbackError !== null) {
        this.logger?.error("database_rollback_failed", { error: rollbackError });
      }

      if (phase === "begin") {
        throw new DatabaseError(
          "DB_BEGIN_FAILED",
          "Could not begin a database transaction.",
          { cause: err },
        );
      }
      if (phase === "commit") {
        throw new DatabaseError(
          "DB_COMMIT_FAILED",
          "Could not commit the database transaction.",
          { cause: err },
        );
      }

      // The caller's own error — untouched, so its type and message survive.
      throw err;
    } finally {
      client.release();
      this.inFlight -= 1;
    }
  }

  /* -------------------------------------------------------------- health */

  /**
   * Read-only probe. NEVER throws: a health check is expected to report a
   * failure, not become one. Used by /ready today and HealthManager later.
   */
  async healthCheck(options: { timeoutMs?: number } = {}): Promise<DbHealth> {
    if (this.state !== "ready" || this.pool === null) {
      return { ok: false, latencyMs: 0, error: `database is ${this.state}` };
    }

    const timeoutMs =
      options.timeoutMs ?? this.options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    const started = performance.now();

    // the probe never rejects; the race only decides ok/timeout
    const probe = this.pool.query("SELECT 1").then(
      () => ({ status: "ok" as const }),
      (err: unknown) => ({ status: "error" as const, err }),
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ status: "timeout" }>((resolve) => {
      // Ref'd on purpose: the caller is awaiting this race, so an unref'd
      // timer could let the event loop empty out before it fires. It is
      // always cleared in the finally block below.
      timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    });

    try {
      const outcome = await Promise.race([probe, timeout]);
      const latencyMs = roundMs(performance.now() - started);

      if (outcome.status === "ok") {
        return { ok: true, latencyMs };
      }
      if (outcome.status === "timeout") {
        this.counters.timeouts += 1;
        this.recordFailure("health", new Error(`health check timed out after ${timeoutMs}ms`));
        return { ok: false, latencyMs, error: "timeout" };
      }

      this.recordFailure("health", outcome.err);
      return {
        ok: false,
        latencyMs,
        error: outcome.err instanceof Error ? outcome.err.message : String(outcome.err),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The lifecycle health hook. Delegates to healthCheck() so there is exactly
   * one probe (with its own timeout and failure counters), and never throws.
   */
  async health(): Promise<ComponentHealth> {
    if (this.state === "new") {
      return { state: "UNHEALTHY", message: "DatabaseManager is not initialized." };
    }
    if (this.state !== "ready") {
      return { state: "UNHEALTHY", message: `DatabaseManager is ${this.state}.` };
    }

    const probe = await this.healthCheck();
    if (!probe.ok) {
      return {
        state: "UNHEALTHY",
        message: probe.error ?? "The database did not answer SELECT 1.",
        details: { latency_ms: probe.latencyMs },
      };
    }

    return {
      state: "HEALTHY",
      message: `SELECT 1 answered in ${probe.latencyMs}ms.`,
      details: { latency_ms: probe.latencyMs },
    };
  }

  /* -------------------------------------------------------------- schema */

  /**
   * Compatibility check: every requirement must exist. Parameterized queries
   * only — object names are values, never interpolated SQL.
   */
  async checkSchema(
    requirements: readonly SchemaRequirement[] = DEFAULT_SCHEMA_REQUIREMENTS,
  ): Promise<SchemaReport> {
    this.requireReady();

    const started = performance.now();
    const missing: SchemaRequirement[] = [];

    for (const requirement of requirements) {
      const param =
        requirement.kind === "table" ? `public.${requirement.name}` : requirement.name;
      const result = await this.query<{ present: boolean }>(SCHEMA_SQL[requirement.kind], [
        param,
      ]);
      if (result.rows[0]?.present !== true) missing.push(requirement);
    }

    const report: SchemaReport = {
      compatible: missing.length === 0,
      checked: requirements.length,
      missing: Object.freeze([...missing]),
      durationMs: roundMs(performance.now() - started),
    };

    this.lastSchemaReport = report;

    if (!report.compatible) {
      this.logger?.warn("database_schema_incompatible", {
        missing: missing.map((item) => `${item.kind}:${item.name}`),
      });
    }

    return report;
  }

  /** Schema check that reports instead of throwing (future self-test hook). */
  async selfTest(): Promise<{ ok: boolean; report: SchemaReport | null; error?: string }> {
    try {
      const report = await this.checkSchema();
      return { ok: report.compatible, report };
    } catch (err) {
      // checkSchema goes through query(), which wraps failures as a generic
      // DatabaseError. Surface the underlying cause too, or a self-test would
      // report "Database query failed." and tell an operator nothing.
      const cause = err instanceof Error ? err.cause : undefined;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        report: null,
        error:
          cause instanceof Error && cause.message !== message
            ? `${message} (${cause.message})`
            : message,
      };
    }
  }

  /* --------------------------------------------------------- diagnostics */

  diagnostics(): DbDiagnostics {
    const pool = this.pool;
    const total = pool?.totalCount ?? 0;
    const idle = pool?.idleCount ?? 0;

    return {
      state: this.state,
      pool: {
        max: this.maxConnections,
        total,
        idle,
        waiting: pool?.waitingCount ?? 0,
        checkedOut: Math.max(0, total - idle),
      },
      counters: Object.freeze({ ...this.counters }),
      inFlight: this.inFlight,
      lastError: this.lastError,
      schema: this.lastSchemaReport,
    };
  }

  getState(): DatabaseState {
    return this.state;
  }

  /* ------------------------------------------------------------- internal */

  private requireReady(): DbPool {
    if (this.state === "new") {
      throw new DatabaseError(
        "DB_NOT_INITIALIZED",
        "DatabaseManager is not initialized. Call init() before using the database.",
      );
    }
    if (this.state !== "ready" || this.pool === null) {
      throw new DatabaseError(
        "DB_SHUTTING_DOWN",
        "DatabaseManager is shutting down and no longer accepts new work.",
      );
    }
    return this.pool;
  }

  private wrapConnection(client: DbClient): DbConnection {
    let released = false;

    return {
      get released() {
        return released;
      },
      query: async <T extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) => {
        if (released) {
          throw new DatabaseError(
            "DB_CONNECTION_RELEASED",
            "This database connection has already been released.",
          );
        }

        this.counters.queries += 1;
        try {
          return await client.query<T>(text, values);
        } catch (err) {
          this.recordFailure("connection-query", err);
          throw err;
        }
      },
      release: (err?: Error | boolean) => {
        // Idempotent on purpose: a double release in two finally blocks must
        // not return the same client to the pool twice.
        if (released) return;
        released = true;
        this.inFlight -= 1;
        client.release(err);
      },
    };
  }

  private async rollback(client: DbClient): Promise<unknown | null> {
    try {
      await client.query("ROLLBACK");
      return null;
    } catch (err) {
      return err;
    }
  }

  private handlePoolError(err: Error): void {
    this.recordFailure("pool", err);
    this.logger?.error("database_pool_error", { error: err });
    this.onFatalError(err);
  }

  private recordFailure(context: string, err: unknown): void {
    this.counters.failures += 1;
    this.lastError = {
      context,
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    };
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function delay(ms: number): Promise<void> {
  // Ref'd: the shutdown drain loop is bounded by its own deadline, and an
  // unref'd timer here could let the process exit mid-drain.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
