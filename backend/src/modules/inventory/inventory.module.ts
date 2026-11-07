/* Inventory module — lifecycle component.

   It depends on the database (and, semantically, on the Menu-owned
   menu_items rows). Health and self-test are READ-ONLY catalog probes: the
   lifecycle contract forbids mutating inventory in a check, so neither hook
   sets a count or writes a movement. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { InventoryRepository } from "./inventory.repository.js";
import { InventoryService } from "./inventory.service.js";
import type {
  InventorySchemaPresence,
  InventoryServicePort,
} from "./inventory.types.js";

export interface InventoryModuleOptions {
  readonly db: DbPort;
}

export interface InventoryModule extends ManagedComponent {
  readonly name: "inventory";
  readonly dependencies: readonly string[];
  readonly service: InventoryServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createInventoryModule(options: InventoryModuleOptions): InventoryModule {
  const repository = new InventoryRepository(options.db);
  const service = new InventoryService({ repository });

  let lastSchema: InventorySchemaPresence | null = null;

  async function readSchema(): Promise<InventorySchemaPresence> {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "inventory",
    dependencies: ["database", "menu"],
    service,

    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing inventory objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: "Inventory stock columns and movement ledger are present.",
          details: schema,
        };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Existence only: never sets stock or appends a movement. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await readSchema();
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Inventory schema objects are all present."
              : `Missing inventory objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "inventory",
        repository: "InventoryRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
