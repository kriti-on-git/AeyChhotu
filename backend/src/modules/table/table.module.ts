/* Table module — initialization and lifecycle component.

   The module is created at the composition root with its dependencies already
   resolved (a DbPort, an event publisher, the read-token issuer). It owns no
   timers or sockets, so init/start have nothing to acquire; it is registered
   with the lifecycle and HealthManager to expose a component health hook and a
   safe, read-only self-test.

   `getDefaultTableService()` is the compatibility seam for the un-migrated
   services (floor, admin, orders, kds) that still import
   services/sessions.service.ts. Production calls `configureTableService()`
   with the module instance from the composition root, so there is ONE service
   and one pool in the running app. */

import type { ComponentHealth, ManagedComponent, SelfTestResult } from "../../bootstrap/lifecycle.js";
import { env } from "../../config/env.js";
import { createLegacyDbPort } from "../../db/legacy-db-port.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type { TableEventPublisher } from "./table.events.js";
import {
  ParticipantTokenStore,
  type ParticipantTokenStorePort,
} from "./table.participant-tokens.js";
import { createReadTokenIssuer } from "./table.read-token.js";
import { TableRepository } from "./table.repository.js";
import { TableService } from "./table.service.js";
import type {
  ReadTokenIssuer,
  SessionCleanupPort,
  TableServicePort,
  TableSessionOutboxPort,
} from "./table.types.js";

export interface TableModuleOptions {
  readonly db: DbPort;
  readonly events?: TableEventPublisher;
  readonly issueReadToken?: ReadTokenIssuer;
  readonly assistantKey?: string | null;
  /** Conversation purge invoked inside the clear transaction. */
  readonly cleanup?: SessionCleanupPort;
  /** Terminal session outbox write invoked inside the clear transaction. */
  readonly outbox?: TableSessionOutboxPort;
  readonly participants?: ParticipantTokenStorePort;
}

export interface TableModule extends ManagedComponent {
  readonly name: "table";
  readonly dependencies: readonly string[];
  readonly service: TableServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createTableModule(options: TableModuleOptions): TableModule {
  const repository = new TableRepository(options.db);
  const participants = options.participants ?? new ParticipantTokenStore(options.db);
  const service = new TableService({
    repository,
    events: options.events,
    issueReadToken: options.issueReadToken ?? createReadTokenIssuer(null),
    assistantKey: options.assistantKey ?? null,
    participants,
    cleanup: options.cleanup,
    outbox: options.outbox,
  });

  let lastSchema: Awaited<ReturnType<TableRepository["schemaObjects"]>> | null = null;

  return {
    name: "table",
    dependencies: ["database"],
    service,

    /** Cheap, read-only: the module cannot serve if its tables are missing. */
    async health(): Promise<ComponentHealth> {
      try {
        const schema = await repository.schemaObjects();
        lastSchema = schema;
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing table objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return { state: "HEALTHY", message: "Table schema is present.", details: schema };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Read-only by construction: existence checks only, no writes, so it is
        safe to run while the app serves traffic. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await repository.schemaObjects();
        lastSchema = schema;
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Table schema objects are all present."
              : `Missing table objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "table",
        repository: "TableRepository",
        schema: lastSchema,
      } as const;
    },
  };
}

/* -------------------------------------------------- compatibility seam */

let defaultService: TableServicePort | null = null;

/** The single service used by the still-unmigrated service modules. Built on
    the legacy pool so importing sessions.service.ts keeps working exactly as
    before; production replaces it during composition. */
export function getDefaultTableService(): TableServicePort {
  if (defaultService === null) {
    const legacyDb = createLegacyDbPort();
    defaultService = new TableService({
      repository: new TableRepository(legacyDb),
      issueReadToken: createReadTokenIssuer(env.supabaseJwtSecret),
      assistantKey: env.geminiApiKey,
      participants: new ParticipantTokenStore(legacyDb),
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureTableService(service: TableServicePort): void {
  defaultService = service;
}
