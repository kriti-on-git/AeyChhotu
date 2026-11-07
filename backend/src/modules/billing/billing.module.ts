/* Billing module — lifecycle component.

   It depends on the database, Orders (the frozen lines are an order read
   model) and Table (the release decision). Health/self-test are read-only
   catalog probes; no bill is generated or settled by a check. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { BillingRepository } from "./billing.repository.js";
import { BillingService } from "./billing.service.js";
import type {
  BillingEventPublisher,
  BillingReleasePort,
  BillingServicePort,
} from "./billing.types.js";

export interface BillingModuleOptions {
  readonly db: DbPort;
  readonly release?: BillingReleasePort;
  readonly events?: BillingEventPublisher;
  readonly taxRateBps?: number;
  readonly discountMinor?: number;
  readonly onPublishError?: (err: unknown) => void;
}

export interface BillingModule extends ManagedComponent {
  readonly name: "billing";
  readonly dependencies: readonly string[];
  readonly service: BillingServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createBillingModule(options: BillingModuleOptions): BillingModule {
  const repository = new BillingRepository(options.db);
  const service = new BillingService({
    repository,
    release: options.release,
    events: options.events,
    taxRateBps: options.taxRateBps,
    discountMinor: options.discountMinor,
    onPublishError: options.onPublishError,
  });

  let lastSchema: Awaited<ReturnType<BillingRepository["schemaObjects"]>> | null = null;

  async function readSchema() {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "billing",
    dependencies: ["database", "orders", "table"],
    service,

    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing billing objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: "Billing source tables are present.",
          details: schema,
        };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Existence checks only: generating or settling is never a self-test. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await readSchema();
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Billing schema objects are all present."
              : `Missing billing objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "billing",
        repository: "BillingRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
