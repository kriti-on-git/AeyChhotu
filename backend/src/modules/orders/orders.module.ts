/* Orders module — initialization and lifecycle component.

   Created at the composition root with the database and the Table public
   port already resolved. It owns no timers or sockets, so init/start have
   nothing to acquire; the component exists to expose health and a safe,
   read-only self-test.

   HEALTH IS EXISTENCE ONLY. The self-test contract forbids mutating orders,
   tickets or inventory, so both hooks use catalog lookups: the tables, the
   fire_order() function and the indexes the duplicate guard depends on. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { OrdersRepository } from "./orders.repository.js";
import { OrdersService } from "./orders.service.js";
import type {
  OrdersEventPublisher,
  OrdersSchemaPresence,
  OrdersServicePort,
  OrdersTablePort,
} from "./orders.types.js";

export interface OrdersModuleOptions {
  readonly db: DbPort;
  readonly tables: OrdersTablePort;
  readonly events?: OrdersEventPublisher;
  readonly onPublishError?: (err: unknown) => void;
}

export interface OrdersModule extends ManagedComponent {
  readonly name: "orders";
  readonly dependencies: readonly string[];
  readonly service: OrdersServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createOrdersModule(options: OrdersModuleOptions): OrdersModule {
  const repository = new OrdersRepository(options.db);
  const service = new OrdersService({
    repository,
    tables: options.tables,
    events: options.events,
    onPublishError: options.onPublishError,
  });

  let lastSchema: OrdersSchemaPresence | null = null;

  async function readSchema(): Promise<OrdersSchemaPresence> {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "orders",
    dependencies: ["database"],
    service,

    /** Cheap, read-only: orders cannot serve without their tables/function. */
    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing orders objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: "Orders schema, indexes and fire_order() are present.",
          details: schema,
        };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Existence checks only; safe while orders are being fired. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await readSchema();
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Orders schema objects are all present."
              : `Missing orders objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "orders",
        repository: "OrdersRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
