/* Test doubles for the DbPool / DbClient contract.

   The manager depends on narrow interfaces (DbPool, DbClient), not on pg's
   classes, so these fakes prove lifecycle behaviour with no socket, no
   Postgres and no timing flakiness. */

import type {
  DbClient,
  DbPool,
  DbQueryResult,
} from "../../src/infrastructure/database/DatabaseManager.js";

type Row = Record<string, unknown>;

export type QueryHandler = (
  text: string,
  values?: readonly unknown[],
) => Promise<DbQueryResult<Row>>;

export type ConnectHandler = () => Promise<DbClient>;

export interface FakeQueryCall {
  readonly text: string;
  readonly values?: readonly unknown[] | undefined;
}

export interface FakePoolOptions {
  readonly query?: QueryHandler;
  readonly connect?: ConnectHandler;
  readonly end?: () => Promise<void>;
  readonly stats?: Partial<{ total: number; idle: number; waiting: number }>;
}

export interface FakePool {
  readonly pool: DbPool;
  readonly queryCalls: readonly FakeQueryCall[];
  readonly connectCalls: number;
  readonly endCalls: number;
  emitError(err: Error): void;
}

export function createFakePool(options: FakePoolOptions = {}): FakePool {
  const queryCalls: FakeQueryCall[] = [];
  const listeners: Array<(err: Error) => void> = [];
  const stats = { total: 0, idle: 0, waiting: 0, ...options.stats };

  let connectCalls = 0;
  let endCalls = 0;

  const pool: DbPool = {
    query: async <T extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      queryCalls.push({ text, values });
      if (options.query) {
        const result = await options.query(text, values);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
    connect: async () => {
      connectCalls += 1;
      return options.connect ? options.connect() : createFakeClient().client;
    },
    end: async () => {
      endCalls += 1;
      if (options.end) await options.end();
    },
    on: (_event, listener) => {
      listeners.push(listener);
      return pool;
    },
    get totalCount() {
      return stats.total;
    },
    get idleCount() {
      return stats.idle;
    },
    get waitingCount() {
      return stats.waiting;
    },
  };

  return {
    pool,
    queryCalls,
    get connectCalls() {
      return connectCalls;
    },
    get endCalls() {
      return endCalls;
    },
    emitError: (err: Error) => {
      for (const listener of listeners) listener(err);
    },
  };
}

export interface FakeClient {
  readonly client: DbClient;
  readonly queries: readonly FakeQueryCall[];
  readonly releases: ReadonlyArray<Error | boolean | undefined>;
}

export function createFakeClient(
  options: { query?: QueryHandler } = {},
): FakeClient {
  const queries: FakeQueryCall[] = [];
  const releases: Array<Error | boolean | undefined> = [];

  const client: DbClient = {
    query: async <T extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      queries.push({ text, values });
      if (options.query) {
        const result = await options.query(text, values);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
    release: (err?: Error | boolean) => {
      releases.push(err);
    },
  };

  return { client, queries, releases };
}
