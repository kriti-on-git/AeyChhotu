/* Order workflow outbox — lifecycle component. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import type { Logger } from "../../infrastructure/logging/Logger.js";
import { OrderWorkflowDispatcher } from "./order-workflow.dispatcher.js";
import { OrderWorkflowRepository } from "./order-workflow.repository.js";
import type {
  OrderWorkflowHandler,
  OrderWorkflowOutboxPort,
} from "./order-workflow.types.js";

export interface OrderWorkflowModuleOptions {
  readonly db: DbPort;
  /** Late-bound because Kitchen is constructed after Orders. */
  readonly handler: () => OrderWorkflowHandler | null;
  readonly logger?: Logger;
  readonly pollMs?: number;
  readonly batchSize?: number;
}

export interface OrderWorkflowModule extends ManagedComponent {
  readonly name: "order-workflow";
  readonly dependencies: readonly string[];
  readonly service: OrderWorkflowOutboxPort;
  readonly repository: OrderWorkflowRepository;
  readonly dispatcher: OrderWorkflowDispatcher;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createOrderWorkflowModule(
  options: OrderWorkflowModuleOptions,
): OrderWorkflowModule {
  const repository = new OrderWorkflowRepository(options.db);
  const dispatcher = new OrderWorkflowDispatcher({
    repository,
    handler: options.handler,
    logger: options.logger,
    pollMs: options.pollMs,
    batchSize: options.batchSize,
  });

  let lastSchema: Awaited<ReturnType<OrderWorkflowRepository["schemaObjects"]>> | null =
    null;

  const service: OrderWorkflowOutboxPort = {
    async enqueueOrderCreated(tx, input) {
      await repository.enqueueOrderCreated(tx, input);
    },
  };

  return {
    name: "order-workflow",
    dependencies: ["database", "kitchen"],
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
            ? `Order workflow dispatcher is running with ${health.pending} pending row(s).`
            : "Order workflow dispatcher is not running.",
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
              ? "Order workflow outbox objects are present."
              : `Missing order workflow outbox objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "order-workflow",
        schema: lastSchema,
        dispatcher: dispatcher.diagnostics(),
      } as const;
    },
  };
}
