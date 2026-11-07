/* Cart module — initialization and lifecycle component.

   Created at the composition root with the database, the Table and Menu public
   ports and the realtime publisher already resolved. It owns no timers or
   sockets, so lifecycle init/start have nothing to acquire; the component
   exists to expose health and a safe, read-only self-test. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { CartRepository } from "./cart.repository.js";
import { CartService } from "./cart.service.js";
import type {
  CartMenuPort,
  CartRealtimePort,
  CartSchemaPresence,
  CartServicePort,
  CartTablePort,
} from "./cart.types.js";

export interface CartModuleOptions {
  readonly db: DbPort;
  readonly tables: CartTablePort;
  readonly menu: CartMenuPort;
  readonly realtime: CartRealtimePort;
  readonly onPublishError?: (err: unknown) => void;
}

export interface CartModule extends ManagedComponent {
  readonly name: "cart";
  readonly dependencies: readonly string[];
  readonly service: CartServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createCartModule(options: CartModuleOptions): CartModule {
  const repository = new CartRepository(options.db);
  const service = new CartService({
    repository,
    tables: options.tables,
    menu: options.menu,
    realtime: options.realtime,
    onPublishError: options.onPublishError,
  });

  let lastSchema: CartSchemaPresence | null = null;

  async function readSchema(): Promise<CartSchemaPresence> {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "cart",
    dependencies: ["database"],
    service,

    /** Cheap, read-only: the cart cannot serve without its table and indexes. */
    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing cart objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: "Cart schema and indexes are present.",
          details: schema,
        };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Existence checks only; safe while carts are being modified. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await readSchema();
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Cart schema objects are all present."
              : `Missing cart objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "cart",
        repository: "CartRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
