/* Conversation module — lifecycle component.

   Health and self-test are read-only catalog probes. They never create a
   conversation, send a message, start a voice interaction or call the AI
   provider, so a check cannot perturb a live table. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { ConversationRepository } from "./conversation.repository.js";
import { ConversationService } from "./conversation.service.js";
import { ConversationToolset } from "./conversation.tools.js";
import type {
  ConversationAiProvider,
  ConversationBusinessPorts,
  ConversationRealtimePort,
  ConversationSchemaPresence,
  ConversationServicePort,
} from "./conversation.types.js";

export interface ConversationModuleOptions {
  readonly db: DbPort;
  readonly realtime: ConversationRealtimePort;
  readonly menu: ConversationBusinessPorts["menu"];
  readonly cart: ConversationBusinessPorts["cart"];
  readonly orders: ConversationBusinessPorts["orders"];
  readonly tables: ConversationBusinessPorts["tables"];
  readonly aiProvider?: ConversationAiProvider | null;
  readonly onPublishError?: (err: unknown) => void;
}

export interface ConversationModule extends ManagedComponent {
  readonly name: "conversation";
  readonly dependencies: readonly string[];
  readonly service: ConversationServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createConversationModule(
  options: ConversationModuleOptions,
): ConversationModule {
  const repository = new ConversationRepository(options.db);
  const tools = new ConversationToolset({
    menu: options.menu,
    cart: options.cart,
    orders: options.orders,
    tables: options.tables,
  });
  const service = new ConversationService({
    repository,
    realtime: options.realtime,
    tools,
    aiProvider: options.aiProvider ?? null,
    onPublishError: options.onPublishError,
  });

  let lastSchema: ConversationSchemaPresence | null = null;

  async function readSchema(): Promise<ConversationSchemaPresence> {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "conversation",
    dependencies: ["database"],
    service,

    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing conversation objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: options.aiProvider
            ? "Conversation storage is present and an AI provider is configured."
            : "Conversation storage is present; the server AI provider is not configured.",
          details: schema,
        };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Existence only: no conversation/message/voice rows are touched. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await readSchema();
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Conversation schema objects are all present."
              : `Missing conversation objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "conversation",
        repository: "ConversationRepository",
        schema: lastSchema,
        ai_provider: options.aiProvider ? "configured" : "not_configured",
      } as const;
    },
  };
}
