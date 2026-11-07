/* Foundation tokens.

   Only infrastructure is registered here today. Business modules will register
   their own tokens in their module folder (phase 2B+), which keeps this file
   free of business knowledge. */

import type { Clock } from "../infrastructure/clock/Clock.js";
import type { AppConfig } from "../infrastructure/config/ConfigManager.js";
import type { DbPort } from "../infrastructure/database/DatabaseManager.js";
import type { HealthPort } from "../infrastructure/health/HealthManager.js";
import type { Logger } from "../infrastructure/logging/Logger.js";
import { createToken } from "./Container.js";

export const TOKENS = {
  config: createToken<AppConfig>("config"),
  logger: createToken<Logger>("logger"),
  clock: createToken<Clock>("clock"),
  /** What a repository receives. Deliberately the narrow DbPort, not the
      manager: no shutdown, no pool, no configuration. */
  database: createToken<DbPort>("database"),
  /** Readiness, deep diagnostics and self-tests. Deliberately the narrow
      HealthPort, not the manager: a route can observe, never initialize or
      shut the registry down. */
  health: createToken<HealthPort>("health"),
} as const;
