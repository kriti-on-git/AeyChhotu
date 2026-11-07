/* Realtime outbox — single ordered dispatcher.

   GUARANTEES (and their mechanism)
     * one table at a time: the table row is locked FOR SHARE before the
       outbox row FOR UPDATE, in the same order the clear path uses;
     * in-order per table: a row is eligible only when no earlier pending row
       exists for that table, so a terminal event can never overtake an
       earlier conversation event;
     * clear cannot race a publish: clear waits for the dispatcher's table
       SHARE lock, then suppresses whatever is still pending and inserts the
       terminal row;
     * restart-safe: pending rows live in Postgres; nothing is held in
       process memory;
     * bounded retry: failed rows get exponential backoff capped at
       `maxRetryMs`; publishing has a bounded timeout;
     * duplicate-safe: every payload carries the row's stable `event_id`.

   SINGLE-INSTANCE NOTE: this dispatcher is process-local. Two API instances
   would each run one; Postgres still serializes them on the table lock, so
   ordering holds, but throughput is duplicated. The documented deployment is
   a single API instance (the same constraint as the in-process Socket.IO
   adapter). Phase 5.3 owns durable multi-instance workflow delivery. */

import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type { Logger } from "../../infrastructure/logging/Logger.js";
import type { RealtimeOutboxRepository } from "./realtime-outbox.repository.js";
import {
  TERMINAL_SESSION_EVENT,
  type RealtimeOutboxHealth,
  type RealtimeOutboxPublisher,
} from "./realtime-outbox.types.js";

export interface DispatcherOptions {
  readonly db: DbPort;
  readonly repository: RealtimeOutboxRepository;
  readonly publisher: () => RealtimeOutboxPublisher | null;
  readonly logger?: Logger;
  readonly pollMs?: number;
  readonly publishTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly maxRetryMs?: number;
  readonly batchSize?: number;
}

export type DispatchOutcome = "published" | "retried" | "idle" | "unavailable";

const DEFAULT_POLL_MS = 250;
const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_RETRY_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const PUBLISHED_RETENTION_MS = 24 * 60 * 60_000;
const SUPPRESSED_RETENTION_MS = 60 * 60_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`realtime publish timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class RealtimeOutboxDispatcher {
  private readonly db: DbPort;
  private readonly repository: RealtimeOutboxRepository;
  private readonly publisher: () => RealtimeOutboxPublisher | null;
  private readonly logger: Logger | null;
  private readonly pollMs: number;
  private readonly publishTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryMs: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private inFlight: Promise<void> | null = null;
  /** Non-null while shutdown is draining. Blocks a restart that would create
      a second timer alongside the loop that is still finishing. */
  private stopping: Promise<void> | null = null;
  private lastDispatchAt: Date | null = null;
  private lastError: string | null = null;
  private lastCleanupAt = 0;
  private pending = 0;

  constructor(options: DispatcherOptions) {
    this.db = options.db;
    this.repository = options.repository;
    this.publisher = options.publisher;
    this.logger = options.logger ?? null;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  start(): void {
    /* Idempotent: the lifecycle may start the same component twice, and a
       shutdown in progress must finish before a new loop is allowed. */
    if (this.running || this.stopping !== null) return;
    this.started = true;
    this.running = true;
    this.schedule(0);
  }

  shutdown(): Promise<void> {
    if (this.stopping !== null) return this.stopping;

    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const stopping = (async () => {
      if (this.inFlight !== null) {
        await this.inFlight.catch(() => undefined);
        this.inFlight = null;
      }
    })().finally(() => {
      this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  /**
   * One row, in its own transaction. Exposed so tests can step the queue
   * deterministically instead of sleeping on the timer.
   */
  async dispatchOnce(): Promise<DispatchOutcome> {
    const publisher = this.publisher();
    if (publisher === null || !publisher.isAvailable()) return "unavailable";

    return this.db.transaction(async (tx) => {
      const candidate = await this.repository.findNextEligible(tx);
      if (candidate === null) return "idle";

      /* Lock order: table first, outbox row second. Clear takes the same
         table row FOR UPDATE, so the two cannot interleave. */
      if (!(await this.repository.lockTable(tx, candidate.table_id))) {
        return "idle";
      }

      const row = await this.repository.lockRow(tx, candidate.id);
      if (row === null || row.status !== "pending") return "idle";
      if (await this.repository.hasEarlierPending(tx, row.table_id, row.id)) {
        return "idle";
      }

      try {
        const payload = {
          ...row.payload,
          event_id: row.event_id,
          session_started_at:
            row.session_started_at === null
              ? null
              : row.session_started_at.toISOString(),
        };

        await withTimeout(
          Promise.resolve(publisher.toTable(row.table_id, row.event, payload)),
          this.publishTimeoutMs,
        );

        /* Emit terminal first, THEN disconnect the table room. */
        if (row.event === TERMINAL_SESSION_EVENT) {
          publisher.disconnectTable?.(row.table_id);
        }

        await this.repository.markPublished(tx, row.id);
        this.lastDispatchAt = new Date();
        this.lastError = null;
        return "published";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const delay = Math.min(
          this.maxRetryMs,
          this.retryBaseMs * 2 ** Math.min(row.attempts, 10),
        );
        await this.repository.markFailed(tx, row.id, message, delay);
        this.lastError = message;
        this.logger?.warn("realtime_outbox_publish_failed", {
          outbox_id: row.id,
          event: row.event,
          attempts: row.attempts + 1,
          retry_in_ms: delay,
          error: message,
        });
        return "retried";
      }
    });
  }

  /** Drain up to `batchSize` eligible rows. */
  async drain(): Promise<number> {
    let published = 0;
    for (let index = 0; index < this.batchSize; index += 1) {
      const outcome = await this.dispatchOnce();
      if (outcome !== "published" && outcome !== "retried") break;
      if (outcome === "published") published += 1;
    }
    return published;
  }

  async cleanup(now = new Date()): Promise<number> {
    return this.repository.cleanup({
      publishedBefore: new Date(now.getTime() - PUBLISHED_RETENTION_MS),
      suppressedBefore: new Date(now.getTime() - SUPPRESSED_RETENTION_MS),
    });
  }

  async health(): Promise<RealtimeOutboxHealth> {
    try {
      this.pending = await this.repository.countPending();
    } catch {
      /* Keep the last known count; health must not throw. */
    }
    return {
      state: this.running ? "running" : this.started ? "stopped" : "idle",
      pending: this.pending,
      lastDispatchAt: this.lastDispatchAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  diagnostics(): unknown {
    return {
      running: this.running,
      pending: this.pending,
      last_dispatch_at: this.lastDispatchAt?.toISOString() ?? null,
      last_error: this.lastError,
    } as const;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.drain();

      if (Date.now() - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        this.lastCleanupAt = Date.now();
        await this.cleanup().catch((err: unknown) => {
          this.logger?.warn("realtime_outbox_cleanup_failed", { error: err });
        });
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger?.error("realtime_outbox_dispatch_failed", { error: err });
    } finally {
      this.inFlight = null;
      this.schedule(this.pollMs);
    }
  }
}
