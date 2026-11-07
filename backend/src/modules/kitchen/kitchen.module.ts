/* Kitchen module — lifecycle component.

   It depends on the database and on the Tickets module: the board and every
   move come from Ticket, and the order association is read from the same
   database. It owns no timers, sockets or server handles, so init/start have
   nothing to acquire.

   HEALTH/SELF-TEST ARE EXISTENCE ONLY. Checking the catalog cannot move a
   ticket or disturb a live board. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type { KitchenEventPublisher, KitchenOrderPort, KitchenRealtimePort, KitchenServicePort, KitchenTicketPort } from "./kitchen.types.js";
import { KitchenRepository } from "./kitchen.repository.js";
import { KitchenService } from "./kitchen.service.js";

export interface KitchenModuleOptions {
  readonly db: DbPort;
  readonly tickets: KitchenTicketPort;
  readonly orders?: KitchenOrderPort;
  readonly realtime?: KitchenRealtimePort;
  readonly events?: KitchenEventPublisher;
  readonly assistantKey?: string | null;
  readonly onPublishError?: (err: unknown) => void;
}

export interface KitchenModule extends ManagedComponent {
  readonly name: "kitchen";
  readonly dependencies: readonly string[];
  readonly service: KitchenServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createKitchenModule(options: KitchenModuleOptions): KitchenModule {
  const repository = new KitchenRepository(options.db);
  const service = new KitchenService({
    tickets: options.tickets,
    repository,
    orders: options.orders ?? repository,
    realtime: options.realtime,
    events: options.events,
    assistantKey: options.assistantKey,
    onPublishError: options.onPublishError,
  });

  let lastSchema: Awaited<ReturnType<KitchenRepository["schemaObjects"]>> | null = null;

  async function readSchema() {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "kitchen",
    dependencies: ["database", "tickets"],
    service,

    /** Cheap, read-only: without the order/table schema the board is blind. */
    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing kitchen objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: "Kitchen board, order association and state-machine trigger are present.",
          details: schema,
        };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Existence checks only; safe while the kitchen is moving tickets. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await readSchema();
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Kitchen schema objects are all present."
              : `Missing kitchen objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "kitchen",
        repository: "KitchenRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
