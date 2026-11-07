/* Order workflow outbox — single process-local dispatcher.

   GUARANTEES
     * the order and its outbox row commit together;
     * pending rows survive restarts and failed handlers;
     * exponential backoff, capped, for repeated failures;
     * per-table ordering: a later order for a table cannot overtake an earlier
       pending hand-off;
     * at-least-once delivery. The handler is read-only, so a replay cannot
       create another ticket.

   SINGLE-INSTANCE NOTE: one dispatcher per API process, matching the existing
   deployment constraint. Postgres' SKIP LOCKED claim still prevents two
   accidental loops from processing the same row concurrently. */

import type { Logger } from "../../infrastructure/logging/Logger.js";
import type { OrderWorkflowRepository } from "./order-workflow.repository.js";
import type {
  OrderWorkflowHandler,
  OrderWorkflowHealth,
} from "./order-workflow.types.js";

export interface OrderWorkflowDispatcherOptions {
  readonly repository: OrderWorkflowRepository;
  /** Late-bound: Kitchen is created after the Orders enqueue port exists. */
  readonly handler: () => OrderWorkflowHandler | null;
  readonly logger?: Logger;
  readonly pollMs?: number;
  readonly retryBaseMs?: number;
  readonly maxRetryMs?: number;
  readonly batchSize?: number;
}

export type OrderWorkflowDispatchOutcome =
  | "processed"
  | "retried"
  | "idle"
  | "unavailable";

const DEFAULT_POLL_MS = 250;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_RETRY_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const PROCESSED_RETENTION_MS = 24 * 60 * 60_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`order workflow handler timed out after ${timeoutMs}ms`)),
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

export class OrderWorkflowDispatcher {
  private readonly repository: OrderWorkflowRepository;
  private readonly handler: () => OrderWorkflowHandler | null;
  private readonly logger: Logger | null;
  private readonly pollMs: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryMs: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopping: Promise<void> | null = null;
  private inFlight: Promise<void> | null = null;
  private pending = 0;
  private lastProcessedAt: Date | null = null;
  private lastError: string | null = null;
  private lastCleanupAt = 0;

  constructor(options: OrderWorkflowDispatcherOptions) {
    this.repository = options.repository;
    this.handler = options.handler;
    this.logger = options.logger ?? null;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  start(): void {
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

  /** Exposed so tests can step the queue without sleeping on timers. */
  async dispatchOnce(): Promise<OrderWorkflowDispatchOutcome> {
    const handler = this.handler();
    if (handler === null) return "unavailable";

    const row = await this.repository.claimNext();
    if (row === null) return "idle";

    try {
      await withTimeout(
        handler.handleOrderCreated({
          orderId: row.order_id,
          tableId: row.table_id,
          eventId: row.event_id,
        }),
        5_000,
      );
      await this.repository.markProcessed(row.id);
      this.lastProcessedAt = new Date();
      this.lastError = null;
      return "processed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delay = Math.min(
        this.maxRetryMs,
        this.retryBaseMs * 2 ** Math.min(row.attempts - 1, 10),
      );
      await this.repository.markFailed(row.id, message, delay);
      this.lastError = message;
      this.logger?.warn("order_workflow_dispatch_failed", {
        outbox_id: row.id,
        order_id: row.order_id,
        attempts: row.attempts,
        retry_in_ms: delay,
        error: message,
      });
      return "retried";
    }
  }

  async drain(): Promise<number> {
    let processed = 0;
    for (let index = 0; index < this.batchSize; index += 1) {
      const outcome = await this.dispatchOnce();
      if (outcome !== "processed" && outcome !== "retried") break;
      if (outcome === "processed") processed += 1;
    }
    return processed;
  }

  async cleanup(now = new Date()): Promise<number> {
    return this.repository.cleanup(
      new Date(now.getTime() - PROCESSED_RETENTION_MS),
    );
  }

  async health(): Promise<OrderWorkflowHealth> {
    try {
      this.pending = await this.repository.countPending();
    } catch {
      /* Health must not throw; keep the last known count. */
    }
    return {
      state: this.running ? "running" : this.started ? "stopped" : "idle",
      pending: this.pending,
      lastProcessedAt: this.lastProcessedAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  diagnostics(): unknown {
    return {
      running: this.running,
      pending: this.pending,
      last_processed_at: this.lastProcessedAt?.toISOString() ?? null,
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
          this.logger?.warn("order_workflow_cleanup_failed", { error: err });
        });
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger?.error("order_workflow_dispatch_failed", { error: err });
    } finally {
      this.inFlight = null;
      this.schedule(this.pollMs);
    }
  }
}
