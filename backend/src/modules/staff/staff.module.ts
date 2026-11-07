/* Staff module — lifecycle component.

   It depends only on the database. Health/self-test are READ-ONLY catalog
   probes: a check must never create, deactivate or authenticate a terminal. */

import type {
  ComponentHealth,
  ManagedComponent,
  SelfTestResult,
} from "../../bootstrap/lifecycle.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { StaffRepository } from "./staff.repository.js";
import { StaffService } from "./staff.service.js";
import type {
  StaffSchemaPresence,
  StaffServicePort,
} from "./staff.types.js";

export interface StaffModuleOptions {
  readonly db: DbPort;
  readonly staffPin: string;
  readonly adminPin: string;
  readonly kdsTokenSecret: string;
  readonly supabaseJwtSecret: string | null;
}

export interface StaffModule extends ManagedComponent {
  readonly name: "staff";
  readonly dependencies: readonly string[];
  readonly service: StaffServicePort;
  health(): Promise<ComponentHealth>;
  selfTest(): Promise<SelfTestResult>;
  diagnostics(): unknown;
}

export function createStaffModule(options: StaffModuleOptions): StaffModule {
  const repository = new StaffRepository(options.db);
  const service = new StaffService({
    repository,
    staffPin: options.staffPin,
    adminPin: options.adminPin,
    kdsTokenSecret: options.kdsTokenSecret,
    supabaseJwtSecret: options.supabaseJwtSecret,
  });

  let lastSchema: StaffSchemaPresence | null = null;

  async function readSchema(): Promise<StaffSchemaPresence> {
    const schema = await repository.schemaObjects();
    lastSchema = schema;
    return schema;
  }

  return {
    name: "staff",
    dependencies: ["database"],
    service,

    async health(): Promise<ComponentHealth> {
      try {
        const schema = await readSchema();
        if (schema.missing.length > 0) {
          return {
            state: "UNHEALTHY",
            message: `Missing staff objects: ${schema.missing.join(", ")}.`,
            details: schema,
          };
        }
        return {
          state: "HEALTHY",
          message: "Staff terminal identity table and role constraint are present.",
          details: schema,
        };
      } catch (err) {
        return {
          state: "UNHEALTHY",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /** Existence only: never logs in, creates or deactivates a terminal. */
    async selfTest(): Promise<SelfTestResult> {
      try {
        const schema = await readSchema();
        return {
          ok: schema.missing.length === 0,
          message:
            schema.missing.length === 0
              ? "Staff schema objects are all present."
              : `Missing staff objects: ${schema.missing.join(", ")}.`,
          details: schema,
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    diagnostics(): unknown {
      return {
        module: "staff",
        repository: "StaffRepository",
        schema: lastSchema,
      } as const;
    },
  };
}
