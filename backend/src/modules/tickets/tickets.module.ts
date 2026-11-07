/* Tickets module — initialization and lifecycle component.

   The module depends on Orders: a ticket is a projection of a fired order, so
   checking ticket health while orders are broken would report a misleading
   green. It owns no timers or sockets.

   HEALTH/SELF-TEST ARE EXISTENCE ONLY. The self-test contract forbids moving
   real tickets, so both hooks inspect the catalog: the order tables, the
   status-transition trigger that enforces the state machine, and the indexes
   behind the board and item projection. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { TicketsRepository } from "./tickets.repository.js";
import { TicketsService } from "./tickets.service.js";
import type {
  TicketEventPublisher,
  TicketOrderPort,
  TicketReleasePort,
  TicketSchemaPresence,
  TicketServicePort,
} from "./tickets.types.js";

export interface TicketsModuleOptions {
  readonly db: DbPort;
  readonly orders?: TicketOrderPort;
  readonly release?: TicketReleasePort;
  readonly events?: TicketEventPublisher;
  readonly onPublishError?: (err: unknown) => void;
}

export interface TicketsModule extends ManagedComponent {
  readonly name: "tickets";
  readonly dependencies: readonly string[];
  readonly service: TicketServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createTicketsModule(options: TicketsModuleOptions): TicketsModule {
  const repository = new TicketsRepository(options.db);
  const service = new TicketsService({
    repository,
    orders: options.orders,
    release: options.release,
    events: options.events,
    onPublishError: options.onPublishError,
  });

  let lastSchema: TicketSchemaPresence | null = null;

  async function readSchema(): Promise<TicketSchemaPresence> {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "tickets",
    dependencies: ["database", "orders"],
    service,

    /** Cheap, read-only: the board cannot serve without its table + trigger. */
    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing ticket objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: "Ticket projection, state-machine trigger and indexes are present.",
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
              ? "Ticket schema objects are all present."
              : `Missing ticket objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "tickets",
        repository: "TicketsRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
