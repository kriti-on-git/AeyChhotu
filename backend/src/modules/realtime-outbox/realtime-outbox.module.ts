/* Realtime outbox — lifecycle component and the port business modules use.

   Conversation receives `service.enqueueConversationEvent`; Table receives
   `service.suppressConversationEvents` + `service.enqueueSessionEnded`. Both
   are transaction-scoped: the caller passes the exact `DbTransaction` that
   writes the business row, so there is no second connection and no
   post-commit window in which a crash could lose the event.

   The dispatcher is registered before Socket.IO starts and checks
   `publisher.isAvailable()` before claiming a row, so a boot-time poll cannot
   mark an event published while the transport is still coming up. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbTransaction, DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type { Logger } from "../../infrastructure/logging/Logger.js";
import { RealtimeOutboxDispatcher } from "./realtime-outbox.dispatcher.js";
import { RealtimeOutboxRepository } from "./realtime-outbox.repository.js";
import type {
  ConversationOutboxPort,
  OutboxEnqueueInput,
  RealtimeOutboxPublisher,
} from "./realtime-outbox.types.js";
import type { TableSessionOutboxPort } from "../table/table.types.js";
import type { BillStatus } from "../table/table.types.js";

export interface RealtimeOutboxModuleOptions {
  readonly db: DbPort;
  /** Late-bound: Socket.IO is created after the modules but before start(). */
  readonly publisher: () => RealtimeOutboxPublisher | null;
  readonly logger?: Logger;
  readonly pollMs?: number;
  readonly publishTimeoutMs?: number;
  readonly batchSize?: number;
}

export interface RealtimeOutboxService
  extends ConversationOutboxPort,
    TableSessionOutboxPort {}

export interface RealtimeOutboxModule extends ManagedComponent {
  readonly name: "realtime-outbox";
  readonly dependencies: readonly string[];
  readonly service: RealtimeOutboxService;
  readonly repository: RealtimeOutboxRepository;
  readonly dispatcher: RealtimeOutboxDispatcher;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

/** Defence in depth: a payload key that names a credential must never reach
    the outbox, even if a future caller assembles one by accident. */
const FORBIDDEN_KEY = /token|secret|authorization|api[_-]?key|provider[_-]?key/i;

function assertSafePayload(value: unknown, path = "payload"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafePayload(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`The realtime outbox payload may not contain "${path}.${key}".`);
    }
    assertSafePayload(entry, `${path}.${key}`);
  }
}

export function createRealtimeOutboxModule(
  options: RealtimeOutboxModuleOptions,
): RealtimeOutboxModule {
  const repository = new RealtimeOutboxRepository(options.db);
  const dispatcher = new RealtimeOutboxDispatcher({
    db: options.db,
    repository,
    publisher: options.publisher,
    logger: options.logger,
    pollMs: options.pollMs,
    publishTimeoutMs: options.publishTimeoutMs,
    batchSize: options.batchSize,
  });

  let lastSchema: Awaited<ReturnType<RealtimeOutboxRepository["schemaObjects"]>> | null =
    null;

  const service: RealtimeOutboxService = {
    async enqueueConversationEvent(tx: DbTransaction, input: OutboxEnqueueInput) {
      assertSafePayload(input.payload);
      await repository.enqueue(tx, input);
    },
    async suppressConversationEvents(
      tx: DbTransaction,
      tableId: string,
      sessionStartedAt: Date | null,
    ) {
      await repository.suppressConversationEvents(tx, tableId, sessionStartedAt);
    },
    async enqueueSessionEnded(
      tx: DbTransaction,
      input: {
        tableId: string;
        sessionStartedAt: Date | null;
        reason: "auto_release" | "staff_clear" | "admin_clear";
        billStatus: BillStatus;
      },
    ) {
      await repository.enqueueSessionEnded(tx, input);
    },
  };

  return {
    name: "realtime-outbox",
    dependencies: ["database"],
    service,
    repository,
    dispatcher,

    start(): void {
      dispatcher.start();
    },

    async shutdown(): Promise<void> {
      await dispatcher.shutdown();
    },

    async health(): Promise<ComponentHealth> {
      const health = await dispatcher.health();
      return {
        state: health.state === "running" ? "HEALTHY" : "DEGRADED",
        message:
          health.state === "running"
            ? `Outbox dispatcher is running with ${health.pending} pending row(s).`
            : "Outbox dispatcher is not running.",
        details: health,
      };
    },

    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await repository.schemaObjects();
        lastSchema = schema;
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Realtime outbox objects are present."
              : `Missing realtime outbox objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "realtime-outbox",
        schema: lastSchema,
        dispatcher: dispatcher.diagnostics(),
      } as const;
    },
  };
}
