/* Menu module — initialization and lifecycle component.

   Created at the composition root with a DbPort and the two cross-module
   contracts (Table for guest scope, Orders for pending-round denial) already
   resolved. No timers or sockets, so init/start have nothing to acquire; the
   module exists on the lifecycle to expose health and a safe self-test. */

import type { ComponentHealth, ManagedComponent, SelfTestResult } from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type { TableServicePort } from "../table/table.types.js";
import { MenuRepository } from "./menu.repository.js";
import { MenuService } from "./menu.service.js";
import type {
  MenuImagePort,
  MenuOrderPort,
  MenuServicePort,
  SchemaPresence,
} from "./menu.types.js";

export interface MenuModuleOptions {
  readonly db: DbPort;
  readonly tables: Pick<TableServicePort, "requireTable">;
  readonly orders: MenuOrderPort;
  readonly images: MenuImagePort;
}

export interface MenuModule extends ManagedComponent {
  readonly name: "menu";
  readonly dependencies: readonly string[];
  readonly service: MenuServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createMenuModule(options: MenuModuleOptions): MenuModule {
  const repository = new MenuRepository(options.db);
  const service = new MenuService({
    repository,
    tables: options.tables,
    orders: options.orders,
    images: options.images,
  });

  let lastSchema: SchemaPresence | null = null;

  return {
    name: "menu",
    dependencies: ["database"],
    service,

    /** Cheap, read-only: the catalogue cannot serve without its tables. */
    async health(): Promise<ComponentHealth> {
      try {
        const schema = await repository.schemaObjects();
        lastSchema = schema;
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing menu objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return { state: "HEALTHY", message: "Menu schema is present.", details: schema };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Read-only by construction: existence checks only, safe under traffic. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await repository.schemaObjects();
        lastSchema = schema;
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Menu schema objects are all present."
              : `Missing menu objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "menu",
        repository: "MenuRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
